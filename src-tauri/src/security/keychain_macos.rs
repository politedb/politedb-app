#![cfg(target_os = "macos")]

use core_foundation::base::CFTypeRef;
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFMutableDictionary;
use core_foundation::string::{CFString, CFStringRef};
use core_foundation_sys::base::OSStatus;

use security_framework_sys::base::{errSecDuplicateItem, errSecItemNotFound, errSecSuccess};
use security_framework_sys::keychain_item::{
    SecItemAdd, SecItemCopyMatching, SecItemDelete, SecItemUpdate,
};

use security_framework_sys::item::{
    kSecAttrAccount, kSecAttrService, kSecClass, kSecClassGenericPassword, kSecMatchLimit,
    kSecReturnData, kSecValueData,
};

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecAttrAccessible: CFStringRef;
    static kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly: CFStringRef;
    static kSecMatchLimitOne: CFStringRef;
}

#[inline]
unsafe fn k_str(k: CFStringRef) -> CFTypeRef {
    k as CFTypeRef
}

fn cfstr(s: &str) -> CFString {
    CFString::new(s)
}
fn cfdata(s: &str) -> CFData {
    CFData::from_buffer(s.as_bytes())
}

fn os_err(code: OSStatus, ctx: &str) -> String {
    if code == errSecItemNotFound {
        format!("{ctx}: KEYCHAIN_ITEM_NOT_FOUND")
    } else {
        format!("{ctx}: OSSTATUS={code}")
    }
}

fn build_query(service: &str, account: &str) -> CFMutableDictionary {
    let service_cf = cfstr(service);
    let account_cf = cfstr(account);

    unsafe {
        CFMutableDictionary::from_CFType_pairs(&[
            (k_str(kSecClass), k_str(kSecClassGenericPassword)),
            (
                k_str(kSecAttrService),
                service_cf.as_concrete_TypeRef() as CFTypeRef,
            ),
            (
                k_str(kSecAttrAccount),
                account_cf.as_concrete_TypeRef() as CFTypeRef,
            ),
        ])
    }
}

pub fn set_password(service: &str, account: &str, value: &str) -> Result<(), String> {
    if service.trim().is_empty() {
        return Err("SECRET_SERVICE_EMPTY".into());
    }
    if account.trim().is_empty() {
        return Err("SECRET_KEY_EMPTY".into());
    }
    if value.is_empty() {
        return Err("SECRET_VALUE_EMPTY".into());
    }

    match update_password(service, account, value) {
        Ok(()) => Ok(()),
        Err(e) if e.contains("KEYCHAIN_ITEM_NOT_FOUND") => add_password(service, account, value),
        Err(e) => Err(e),
    }
}

pub fn add_password(service: &str, account: &str, value: &str) -> Result<(), String> {
    let mut attrs = build_query(service, account);

    // value
    attrs.add(&unsafe { k_str(kSecValueData) }, &{
        cfdata(value).as_concrete_TypeRef() as CFTypeRef
    });

    // ✅ accessible key/value (no prompt policy)
    unsafe {
        attrs.add(
            &k_str(kSecAttrAccessible),
            &k_str(kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly),
        );
    }

    let status = unsafe { SecItemAdd(attrs.as_concrete_TypeRef(), std::ptr::null_mut()) };
    if status == errSecSuccess {
        return Ok(());
    }
    if status == errSecDuplicateItem {
        return update_password(service, account, value);
    }
    Err(os_err(status, "KEYCHAIN_ADD_FAILED"))
}

pub fn update_password(service: &str, account: &str, value: &str) -> Result<(), String> {
    let query = build_query(service, account);

    let mut attrs = CFMutableDictionary::new();
    attrs.add(&unsafe { k_str(kSecValueData) }, &{
        cfdata(value).as_concrete_TypeRef() as CFTypeRef
    });
    unsafe {
        attrs.add(
            &k_str(kSecAttrAccessible),
            &k_str(kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly),
        );
    }

    let status = unsafe { SecItemUpdate(query.as_concrete_TypeRef(), attrs.as_concrete_TypeRef()) };
    if status == errSecSuccess {
        Ok(())
    } else {
        Err(os_err(status, "KEYCHAIN_UPDATE_FAILED"))
    }
}

pub fn get_password(service: &str, account: &str) -> Result<String, String> {
    let mut query = build_query(service, account);

    query.add(&unsafe { k_str(kSecReturnData) }, &{
        CFBoolean::true_value().as_concrete_TypeRef() as CFTypeRef
    });
    query.add(&unsafe { k_str(kSecMatchLimit) }, &unsafe {
        k_str(kSecMatchLimitOne)
    });

    let mut out: CFTypeRef = std::ptr::null_mut();
    let status = unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut out) };

    if status == errSecSuccess {
        if out.is_null() {
            return Err("KEYCHAIN_GET_FAILED: NULL_RESULT".into());
        }
        let data = unsafe { CFData::wrap_under_create_rule(out as *const _) };
        String::from_utf8(data.bytes().to_vec()).map_err(|_| "KEYCHAIN_VALUE_NOT_UTF8".into())
    } else if status == errSecItemNotFound {
        Err("KEYCHAIN_ITEM_NOT_FOUND".into())
    } else {
        Err(os_err(status, "KEYCHAIN_GET_FAILED"))
    }
}

pub fn delete_password(service: &str, account: &str) -> Result<(), String> {
    let query = build_query(service, account);
    let status = unsafe { SecItemDelete(query.as_concrete_TypeRef()) };

    if status == errSecSuccess || status == errSecItemNotFound {
        Ok(())
    } else {
        Err(os_err(status, "KEYCHAIN_DELETE_FAILED"))
    }
}
