//! Native macOS services that previously shelled out to `swift`, `sw_vers`,
//! `osascript`, `ioreg`, `hostname` and `open` (plan Phase 2). Spawning those tools
//! is blocked or unreliable inside the App Store sandbox, and `swift` also required
//! the Xcode command-line tools on the user's Mac.

use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSAlert, NSAlertStyle, NSWorkspace};
use objc2_foundation::{NSError, NSProcessInfo, NSString, NSURL};
use objc2_local_authentication::{LAContext, LAPolicy};

/// `(major, minor, patch)` of the running macOS (`NSProcessInfo`).
pub fn os_version() -> (u32, u32, u32) {
    let version = NSProcessInfo::processInfo().operatingSystemVersion();
    (
        version.majorVersion as u32,
        version.minorVersion as u32,
        version.patchVersion as u32,
    )
}

/// Modal critical alert with a single OK button. Must run on the main thread; does
/// nothing otherwise (the caller still aborts startup).
pub fn show_critical_alert(title: &str, message: &str) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Critical);
    alert.setMessageText(&NSString::from_str(title));
    alert.setInformativeText(&NSString::from_str(message));
    alert.addButtonWithTitle(&NSString::from_str("OK"));
    alert.runModal();
}

/// Opens `url` with the default handler (`NSWorkspace`).
pub fn open_url(url: &str) -> Result<(), String> {
    let Some(ns_url) = NSURL::URLWithString(&NSString::from_str(url)) else {
        return Err("FAILED_TO_OPEN_URL: invalid url".into());
    };
    if NSWorkspace::sharedWorkspace().openURL(&ns_url) {
        Ok(())
    } else {
        Err("FAILED_TO_OPEN_URL: no handler".into())
    }
}

/// Hardware UUID (`IOPlatformUUID` of `IOPlatformExpertDevice`), the same value
/// `ioreg -rd1 -c IOPlatformExpertDevice` printed, so license device ids are unchanged.
pub fn platform_uuid() -> Option<String> {
    iokit::platform_uuid()
}

/// Host name as `gethostname(3)` reports it (what the `hostname` tool printed).
pub fn host_name() -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: buffer and length match; gethostname NUL-terminates on success.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    let name = String::from_utf8_lossy(&buf[..end]).trim().to_string();
    (!name.is_empty()).then_some(name)
}

/// `LAContext` handle that can cross an `.await`. After the evaluation starts we only
/// call `invalidate` (on timeout) and release it; both may run on another Tokio worker.
/// LocalAuthentication itself delivers the reply on a private queue, i.e. the context
/// is already used across threads by the framework.
struct AuthContext(Retained<LAContext>);

// SAFETY: see above; the context is never used concurrently from two threads here.
unsafe impl Send for AuthContext {}

impl Drop for AuthContext {
    /// Dismisses the system prompt whenever the wait ends without an answer: timeout,
    /// or the awaiting future was dropped (run cancelled, tool timed out). After an
    /// answer this is a no-op for the user.
    fn drop(&mut self) {
        unsafe { self.0.invalidate() };
    }
}

type AuthResult = Result<(), String>;

/// Starts the system prompt. The reply block is copied by LocalAuthentication, so our
/// handle to it can be dropped before awaiting the result.
fn start_owner_authentication(
    reason: &str,
) -> Result<(AuthContext, tokio::sync::oneshot::Receiver<AuthResult>), String> {
    let context = unsafe { LAContext::new() };
    let policy = LAPolicy::DeviceOwnerAuthentication;
    if let Err(error) = unsafe { context.canEvaluatePolicy_error(policy) } {
        return Err(failure(Some(&error)));
    }

    let (tx, rx) = tokio::sync::oneshot::channel::<AuthResult>();
    let tx = std::sync::Mutex::new(Some(tx));
    let reply = RcBlock::new(move |success: Bool, error: *mut NSError| {
        let outcome = if success.as_bool() {
            Ok(())
        } else {
            // SAFETY: LocalAuthentication passes either null or a valid NSError.
            Err(failure(unsafe { error.as_ref() }))
        };
        if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = tx.send(outcome);
        }
    });
    unsafe {
        context.evaluatePolicy_localizedReason_reply(policy, &NSString::from_str(reason), &reply);
    }
    Ok((AuthContext(context), rx))
}

/// Asks the user to authenticate as the device owner (Touch ID or password) via
/// LocalAuthentication. Errors keep the `TOUCH_ID_AUTH_FAILED: <reason>` shape the
/// previous Swift helper produced.
pub async fn authenticate_device_owner(reason: &str, timeout: Duration) -> Result<bool, String> {
    // evaluatePolicy throws NSInvalidArgumentException for an empty reason; never
    // let that reach the native call (it would abort the app instead of erroring).
    if reason.trim().is_empty() {
        return Err(failure(None));
    }
    // Held (not `_`) so it lives until the wait ends; its Drop dismisses the prompt.
    let (_context, rx) = start_owner_authentication(reason)?;
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(Ok(()))) => Ok(true),
        Ok(Ok(Err(message))) => Err(message),
        Ok(Err(_)) => Err(failure(None)),
        // Dropping `context` dismisses the system prompt instead of leaving it on screen.
        Err(_) => Err(failure(None)),
    }
}

fn failure(error: Option<&NSError>) -> String {
    let message = error
        .map(|e| e.localizedDescription().to_string())
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| "Authentication failed.".to_string());
    format!("TOUCH_ID_AUTH_FAILED: {message}")
}

mod iokit {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::string::CFString;
    use core_foundation_sys::base::{kCFAllocatorDefault, CFAllocatorRef, CFTypeRef};
    use core_foundation_sys::dictionary::CFMutableDictionaryRef;
    use core_foundation_sys::string::CFStringRef;
    use std::ffi::{c_char, CString};

    type IoObject = u32;
    /// `kIOMainPortDefault` / `kIOMasterPortDefault`.
    const MAIN_PORT_DEFAULT: u32 = 0;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOServiceMatching(name: *const c_char) -> CFMutableDictionaryRef;
        fn IOServiceGetMatchingService(
            main_port: u32,
            matching: CFMutableDictionaryRef,
        ) -> IoObject;
        fn IORegistryEntryCreateCFProperty(
            entry: IoObject,
            key: CFStringRef,
            allocator: CFAllocatorRef,
            options: u32,
        ) -> CFTypeRef;
        fn IOObjectRelease(object: IoObject) -> i32;
    }

    pub fn platform_uuid() -> Option<String> {
        let class = CString::new("IOPlatformExpertDevice").ok()?;
        // SAFETY: IOServiceMatching returns a +1 dictionary that
        // IOServiceGetMatchingService consumes; the service is released below.
        let service = unsafe {
            IOServiceGetMatchingService(MAIN_PORT_DEFAULT, IOServiceMatching(class.as_ptr()))
        };
        if service == 0 {
            return None;
        }
        let key = CFString::from_static_string("IOPlatformUUID");
        // SAFETY: valid service and key; the returned value follows the create rule.
        let value = unsafe {
            IORegistryEntryCreateCFProperty(
                service,
                key.as_concrete_TypeRef(),
                kCFAllocatorDefault,
                0,
            )
        };
        unsafe { IOObjectRelease(service) };
        if value.is_null() {
            return None;
        }
        // SAFETY: non-null CF object obtained under the create rule.
        let value = unsafe { CFType::wrap_under_create_rule(value) };
        let uuid = value.downcast::<CFString>()?.to_string();
        let uuid = uuid.trim().to_string();
        (!uuid.is_empty()).then_some(uuid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_reason_is_rejected_before_the_native_call() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        for reason in ["", "  \n"] {
            let result =
                runtime.block_on(authenticate_device_owner(reason, Duration::from_secs(1)));
            assert_eq!(
                result,
                Err("TOUCH_ID_AUTH_FAILED: Authentication failed.".into())
            );
        }
    }

    #[test]
    fn reports_a_plausible_os_version() {
        let (major, _minor, _patch) = os_version();
        assert!(major >= 11, "unexpected macOS major version {major}");
    }

    #[test]
    fn platform_uuid_matches_ioreg() {
        let native = platform_uuid().expect("IOPlatformUUID");
        let output = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout);
        let ioreg = text
            .lines()
            .find(|line| line.contains("IOPlatformUUID"))
            .and_then(|line| line.split('=').nth(1))
            .map(|value| value.trim().trim_matches('"').to_string())
            .unwrap();
        assert_eq!(
            native, ioreg,
            "device ids must not change for existing activations"
        );
    }

    #[test]
    fn host_name_matches_hostname_tool() {
        let native = host_name().expect("host name");
        let output = std::process::Command::new("hostname").output().unwrap();
        assert_eq!(native, String::from_utf8_lossy(&output.stdout).trim());
    }
}
