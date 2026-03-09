#![cfg(target_os = "macos")]

use std::ffi::CStr;

use core_foundation::base::{CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFMutableDictionary;
use core_foundation::string::{CFString, CFStringRef};
use core_foundation_sys::array::{
    CFArrayGetCount, CFArrayGetTypeID, CFArrayGetValueAtIndex, CFArrayRef,
};
use core_foundation_sys::base::OSStatus;
use core_foundation_sys::base::{CFGetTypeID, CFRelease};
use core_foundation_sys::dictionary::{
    CFDictionaryGetTypeID, CFDictionaryGetValueIfPresent, CFDictionaryRef,
};
use core_foundation_sys::string::{
    CFStringGetCString, CFStringGetLength, CFStringGetMaximumSizeForEncoding,
    kCFStringEncodingUTF8,
};

use security_framework_sys::base::{errSecDuplicateItem, errSecItemNotFound, errSecSuccess};
use security_framework_sys::item::{
    kSecAttrAccount, kSecAttrService, kSecAttrSynchronizable, kSecClass, kSecClassGenericPassword,
    kSecMatchLimit, kSecReturnAttributes, kSecReturnData, kSecValueData,
};
use security_framework_sys::keychain_item::{
    SecItemAdd, SecItemCopyMatching, SecItemDelete, SecItemUpdate,
};

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecAttrAccessible: CFStringRef;
    static kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly: CFStringRef;
    static kSecMatchLimitOne: CFStringRef;
    static kSecMatchLimitAll: CFStringRef;
}

/* =============================================================================
 * Helpers
 * ============================================================================= */

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

/* =============================================================================
 * Query builder (stable, TablePlus-like)
 * ============================================================================= */

fn build_query_service(service: &str) -> CFMutableDictionary {
    let service_cf = cfstr(service);

    unsafe {
        let mut d = CFMutableDictionary::from_CFType_pairs(&[
            (k_str(kSecClass), k_str(kSecClassGenericPassword)),
            (
                k_str(kSecAttrService),
                service_cf.as_concrete_TypeRef() as CFTypeRef,
            ),
        ]);

        // Avoid iCloud Keychain sync oddities
        d.add(
            &k_str(kSecAttrSynchronizable),
            &(CFBoolean::false_value().as_concrete_TypeRef() as CFTypeRef),
        );

        d
    }
}

fn build_query(service: &str, account: &str) -> CFMutableDictionary {
    let account_cf = cfstr(account);
    let mut d = build_query_service(service);
    d.add(
        &unsafe { k_str(kSecAttrAccount) },
        &(account_cf.as_concrete_TypeRef() as CFTypeRef),
    );
    d
}

fn cfstring_to_string(value: CFStringRef) -> Option<String> {
    if value.is_null() {
        return None;
    }

    let len = unsafe { CFStringGetLength(value) };
    let max = unsafe { CFStringGetMaximumSizeForEncoding(len, kCFStringEncodingUTF8) + 1 };
    if max <= 1 {
        return Some(String::new());
    }

    let mut buf = vec![0i8; max as usize];
    let ok = unsafe { CFStringGetCString(value, buf.as_mut_ptr(), max, kCFStringEncodingUTF8) };
    if ok == 0 {
        return None;
    }

    let s = unsafe { CStr::from_ptr(buf.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    Some(s)
}

fn extract_account_from_dict(dict: CFDictionaryRef) -> Option<String> {
    if dict.is_null() {
        return None;
    }

    let mut value: CFTypeRef = std::ptr::null_mut();
    let found = unsafe {
        CFDictionaryGetValueIfPresent(dict, kSecAttrAccount as CFTypeRef, &mut value as *mut _)
    };
    if found == 0 || value.is_null() {
        return None;
    }
    cfstring_to_string(value as CFStringRef)
}

/* =============================================================================
 * Public API
 * ============================================================================= */

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

    let mut attrs = build_query(service, account);

    // value
    attrs.add(
        &unsafe { k_str(kSecValueData) },
        &(cfdata(value).as_concrete_TypeRef() as CFTypeRef),
    );

    // accessible (set at CREATE time)
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

    // Duplicate => update
    if status == errSecDuplicateItem {
        return update_password(service, account, value);
    }

    Err(os_err(status, "KEYCHAIN_ADD_FAILED"))
}

pub fn update_password(service: &str, account: &str, value: &str) -> Result<(), String> {
    let query = build_query(service, account);

    let mut attrs = CFMutableDictionary::new();
    attrs.add(
        &unsafe { k_str(kSecValueData) },
        &(cfdata(value).as_concrete_TypeRef() as CFTypeRef),
    );

    let status = unsafe { SecItemUpdate(query.as_concrete_TypeRef(), attrs.as_concrete_TypeRef()) };

    if status == errSecSuccess {
        Ok(())
    } else {
        Err(os_err(status, "KEYCHAIN_UPDATE_FAILED"))
    }
}

pub fn get_password(service: &str, account: &str) -> Result<String, String> {
    let mut query = build_query(service, account);

    query.add(
        &unsafe { k_str(kSecReturnData) },
        &(CFBoolean::true_value().as_concrete_TypeRef() as CFTypeRef),
    );
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

pub fn list_accounts(service: &str) -> Result<Vec<String>, String> {
    if service.trim().is_empty() {
        return Err("SECRET_SERVICE_EMPTY".into());
    }

    let mut query = build_query_service(service);
    query.add(
        &unsafe { k_str(kSecReturnAttributes) },
        &(CFBoolean::true_value().as_concrete_TypeRef() as CFTypeRef),
    );
    query.add(&unsafe { k_str(kSecMatchLimit) }, &unsafe {
        k_str(kSecMatchLimitAll)
    });

    let mut out: CFTypeRef = std::ptr::null_mut();
    let status = unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut out) };

    if status == errSecItemNotFound {
        return Ok(Vec::new());
    }
    if status != errSecSuccess {
        return Err(os_err(status, "KEYCHAIN_LIST_FAILED"));
    }
    if out.is_null() {
        return Ok(Vec::new());
    }

    let mut keys: Vec<String> = Vec::new();
    let out_type = unsafe { CFGetTypeID(out) };
    if out_type == unsafe { CFArrayGetTypeID() } {
        let arr = out as CFArrayRef;
        let count = unsafe { CFArrayGetCount(arr) };
        for i in 0..count {
            let item = unsafe { CFArrayGetValueAtIndex(arr, i) };
            if item.is_null() {
                continue;
            }
            if let Some(account) = extract_account_from_dict(item as CFDictionaryRef) {
                keys.push(account);
            }
        }
    } else if out_type == unsafe { CFDictionaryGetTypeID() } {
        if let Some(account) = extract_account_from_dict(out as CFDictionaryRef) {
            keys.push(account);
        }
    }

    unsafe { CFRelease(out) };

    keys.sort();
    keys.dedup();
    Ok(keys)
}
