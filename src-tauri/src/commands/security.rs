#[tauri::command]
pub async fn security_touch_id_authenticate(reason: Option<String>) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        let prompt =
            reason.unwrap_or_else(|| "Authenticate with Touch ID to continue.".to_string());

        // Use native LocalAuthentication via a tiny Swift snippet.
        // This allows proper Touch ID prompt on macOS.
        let swift_script = r#"
import Foundation
import LocalAuthentication

let reason = ProcessInfo.processInfo.environment["POLITEDB_TOUCH_ID_REASON"] ?? "Authenticate with Touch ID to continue."
let ctx = LAContext()
var authError: NSError?

guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authError) else {
  let msg = authError?.localizedDescription ?? "Local authentication is not available on this device."
  FileHandle.standardError.write(Data(msg.utf8))
  exit(2)
}

let sem = DispatchSemaphore(value: 0)
var ok = false
var errMsg = "Authentication failed."

ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
  ok = success
  if let e = error {
    errMsg = e.localizedDescription
  }
  sem.signal()
}

_ = sem.wait(timeout: .now() + 30)

if ok {
  print("ok")
  exit(0)
} else {
  FileHandle.standardError.write(Data(errMsg.utf8))
  exit(1)
}
"#;

        let out = Command::new("/usr/bin/swift")
            .args(["-e", swift_script])
            .env("POLITEDB_TOUCH_ID_REASON", prompt)
            .output()
            .map_err(|e| format!("TOUCH_ID_EXEC_FAILED: {e}"))?;

        if out.status.success() {
            Ok(true)
        } else {
            let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if msg.is_empty() {
                Err("TOUCH_ID_AUTH_FAILED".to_string())
            } else {
                Err(format!("TOUCH_ID_AUTH_FAILED: {msg}"))
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = reason;
        Err("TOUCH_ID_UNSUPPORTED_PLATFORM".to_string())
    }
}
