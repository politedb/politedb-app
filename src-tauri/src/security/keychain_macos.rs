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
    kCFStringEncodingUTF8, CFStringGetCString, CFStringGetLength, CFStringGetMaximumSizeForEncoding,
};

use security_framework_sys::base::{errSecDuplicateItem, errSecItemNotFound, errSecSuccess};
use security_framework_sys::item::{
    kSecAttrAccount, kSecAttrLabel, kSecAttrService, kSecAttrSynchronizable, kSecClass,
    kSecClassGenericPassword, kSecMatchLimit, kSecReturnAttributes, kSecReturnData, kSecValueData,
};
use security_framework_sys::keychain_item::{
    SecItemAdd, SecItemCopyMatching, SecItemDelete, SecItemUpdate,
};

const ERR_SEC_MISSING_ENTITLEMENT: OSStatus = -34018;

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecAttrAccessible: CFStringRef;
    static kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly: CFStringRef;
    static kSecUseDataProtectionKeychain: CFStringRef;
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

fn build_query_service(service: &str, data_protection: bool) -> CFMutableDictionary {
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
        if data_protection {
            d.add(
                &k_str(kSecUseDataProtectionKeychain),
                &(CFBoolean::true_value().as_concrete_TypeRef() as CFTypeRef),
            );
        }

        d
    }
}

fn build_query(service: &str, account: &str, data_protection: bool) -> CFMutableDictionary {
    let account_cf = cfstr(account);
    let mut d = build_query_service(service, data_protection);
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

fn add_label(attrs: &mut CFMutableDictionary, label: Option<&str>) {
    if let Some(label) = label {
        let label_cf = cfstr(label);
        attrs.add(
            &unsafe { k_str(kSecAttrLabel) },
            &(label_cf.as_concrete_TypeRef() as CFTypeRef),
        );
    }
}

/* =============================================================================
 * Public API
 * ============================================================================= */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AddResult {
    Added,
    Duplicate,
}

fn add_password_in(
    service: &str,
    account: &str,
    value: &str,
    label: Option<&str>,
    data_protection: bool,
) -> Result<AddResult, String> {
    let mut attrs = build_query(service, account, data_protection);
    add_label(&mut attrs, label);

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
        return Ok(AddResult::Added);
    }
    if status == errSecDuplicateItem {
        return Ok(AddResult::Duplicate);
    }

    Err(os_err(status, "KEYCHAIN_ADD_FAILED"))
}

fn set_password_in(
    service: &str,
    account: &str,
    value: &str,
    label: Option<&str>,
    data_protection: bool,
) -> Result<(), String> {
    match add_password_in(service, account, value, label, data_protection)? {
        AddResult::Added => Ok(()),
        // Duplicate => update (label is refreshed too)
        AddResult::Duplicate => update_password_in(service, account, value, label, data_protection),
    }
}

fn validate_set_input(service: &str, account: &str, value: &str) -> Result<(), String> {
    if service.trim().is_empty() {
        return Err("SECRET_SERVICE_EMPTY".into());
    }
    if account.trim().is_empty() {
        return Err("SECRET_KEY_EMPTY".into());
    }
    if value.is_empty() {
        return Err("SECRET_VALUE_EMPTY".into());
    }
    Ok(())
}

/// Create or update; `label` (Keychain Access "Name") is set on create and update.
pub fn set_password_labeled(
    service: &str,
    account: &str,
    value: &str,
    label: Option<&str>,
) -> Result<(), String> {
    validate_set_input(service, account, value)?;

    match set_password_in(service, account, value, label, true) {
        Err(error) if is_missing_entitlement_error(&error) => {
            set_password_in(service, account, value, label, false)
        }
        result => result,
    }
}

/// Create only. Returns `Ok(false)` when the item already exists (left untouched).
pub fn add_password_if_absent(
    service: &str,
    account: &str,
    value: &str,
    label: Option<&str>,
) -> Result<bool, String> {
    validate_set_input(service, account, value)?;

    let result = match add_password_in(service, account, value, label, true) {
        Err(error) if is_missing_entitlement_error(&error) => {
            add_password_in(service, account, value, label, false)
        }
        result => result,
    }?;
    Ok(result == AddResult::Added)
}

fn update_password_in(
    service: &str,
    account: &str,
    value: &str,
    label: Option<&str>,
    data_protection: bool,
) -> Result<(), String> {
    let query = build_query(service, account, data_protection);

    let mut attrs = CFMutableDictionary::new();
    attrs.add(
        &unsafe { k_str(kSecValueData) },
        &(cfdata(value).as_concrete_TypeRef() as CFTypeRef),
    );
    add_label(&mut attrs, label);

    let status = unsafe { SecItemUpdate(query.as_concrete_TypeRef(), attrs.as_concrete_TypeRef()) };

    if status == errSecSuccess {
        Ok(())
    } else {
        Err(os_err(status, "KEYCHAIN_UPDATE_FAILED"))
    }
}

fn is_missing_entitlement_error(error: &str) -> bool {
    error.ends_with(&format!("OSSTATUS={ERR_SEC_MISSING_ENTITLEMENT}"))
}

fn get_password_from(
    service: &str,
    account: &str,
    data_protection: bool,
) -> Result<String, String> {
    let mut query = build_query(service, account, data_protection);

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

/// Read from the data-protection keychain, then the legacy file keychain.
/// When `upgrade_storage` is true, a value found only in the file keychain is
/// copied into the data-protection keychain (with `label`, if any).
pub fn get_password_with(
    service: &str,
    account: &str,
    upgrade_storage: bool,
    label: Option<&str>,
) -> Result<String, String> {
    match get_password_from(service, account, true) {
        Ok(value) => Ok(value),
        Err(error) if is_missing_entitlement_error(&error) => {
            get_password_from(service, account, false)
        }
        Err(error) if error == "KEYCHAIN_ITEM_NOT_FOUND" => {
            let value = get_password_from(service, account, false)?;
            if upgrade_storage {
                // Legacy items can show the macOS ACL prompt once. Copying the
                // authorized value makes future reads use the signed app access group.
                let _ = set_password_labeled(service, account, &value, label);
            }
            Ok(value)
        }
        Err(error) => Err(error),
    }
}

fn delete_password_from(service: &str, account: &str, data_protection: bool) -> Result<(), String> {
    let query = build_query(service, account, data_protection);
    let status = unsafe { SecItemDelete(query.as_concrete_TypeRef()) };

    if status == errSecSuccess || status == errSecItemNotFound {
        Ok(())
    } else {
        Err(os_err(status, "KEYCHAIN_DELETE_FAILED"))
    }
}

pub fn delete_password(service: &str, account: &str) -> Result<(), String> {
    let protected_result = match delete_password_from(service, account, true) {
        Err(error) if is_missing_entitlement_error(&error) => Ok(()),
        result => result,
    };
    let legacy_result = delete_password_from(service, account, false);
    protected_result.and(legacy_result)
}

fn list_accounts_from(service: &str, data_protection: bool) -> Result<Vec<String>, String> {
    if service.trim().is_empty() {
        return Err("SECRET_SERVICE_EMPTY".into());
    }

    let mut query = build_query_service(service, data_protection);
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

pub fn list_accounts(service: &str) -> Result<Vec<String>, String> {
    let mut keys = match list_accounts_from(service, true) {
        Err(error) if is_missing_entitlement_error(&error) => Vec::new(),
        result => result?,
    };
    keys.extend(list_accounts_from(service, false)?);
    keys.sort();
    keys.dedup();
    Ok(keys)
}

/* =============================================================================
 * Port adapter
 * ============================================================================= */

/// macOS Security-framework adapter for [`crate::security::credential_store::KeychainPort`].
pub struct MacKeychain;

impl crate::security::credential_store::KeychainPort for MacKeychain {
    fn get(
        &self,
        service: &str,
        account: &str,
        upgrade_storage: bool,
        label: Option<&str>,
    ) -> Result<String, String> {
        get_password_with(service, account, upgrade_storage, label)
    }

    fn set(
        &self,
        service: &str,
        account: &str,
        value: &str,
        label: Option<&str>,
    ) -> Result<(), String> {
        set_password_labeled(service, account, value, label)
    }

    fn add_if_absent(
        &self,
        service: &str,
        account: &str,
        value: &str,
        label: Option<&str>,
    ) -> Result<crate::security::credential_store::AddOutcome, String> {
        use crate::security::credential_store::AddOutcome;
        Ok(if add_password_if_absent(service, account, value, label)? {
            AddOutcome::Added
        } else {
            AddOutcome::AlreadyExists
        })
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        delete_password(service, account)
    }

    fn list(&self, service: &str) -> Result<Vec<String>, String> {
        list_accounts(service)
    }
}

#[cfg(test)]
mod native_smoke {
    //! Disposable native smoke test. Run explicitly on macOS:
    //! `cargo test --locked native_branded_credential_smoke -- --ignored`
    //! Uses a fresh random profile UUID and a throwaway value; never touches
    //! existing credentials.
    use std::process::Command;

    use crate::security::credential_identity::{
        BRANDED_LABEL, BRANDED_SERVICE, LEGACY_SERVICE, PREVIOUS_BRANDED_SERVICE,
    };
    use crate::security::credential_store::{CredentialStore, KEYCHAIN_ITEM_NOT_FOUND};

    use super::MacKeychain;

    fn attributes(account: &str) -> Option<String> {
        attributes_in(BRANDED_SERVICE, account)
    }

    fn attributes_in(service: &str, account: &str) -> Option<String> {
        let out = Command::new("security")
            .args(["find-generic-password", "-s", service, "-a", account])
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Removes the throwaway item even when an assertion fails.
    struct Cleanup(String);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            for service in [BRANDED_SERVICE, PREVIOUS_BRANDED_SERVICE, LEGACY_SERVICE] {
                let _ = super::delete_password(service, &self.0);
            }
        }
    }

    #[test]
    #[ignore]
    fn native_branded_credential_smoke() {
        let id = uuid::Uuid::new_v4();
        let key = format!("politedb/profile/{id}/postgres/db_password");
        let account = format!("{}_profile", id.hyphenated().to_string().to_uppercase());
        let _cleanup = Cleanup(account.clone());
        let port = MacKeychain;
        let store = CredentialStore::new(&port);

        store.set(&key, "smoke-value-1").unwrap();
        let attrs = attributes(&account).expect("branded item should exist");
        assert!(
            attrs.contains(&format!("0x00000007 <blob>=\"{BRANDED_LABEL}\"")),
            "{attrs}"
        );
        assert!(
            attrs.contains(&format!("\"svce\"<blob>=\"{BRANDED_SERVICE}\"")),
            "{attrs}"
        );
        assert!(
            attrs.contains(&format!("\"acct\"<blob>=\"{account}\"")),
            "{attrs}"
        );
        assert!(attrs.contains("class: \"genp\""), "{attrs}");
        assert_eq!(store.get(&key).unwrap(), "smoke-value-1");

        store.set(&key, "smoke-value-2").unwrap();
        assert_eq!(store.get(&key).unwrap(), "smoke-value-2");
        let attrs = attributes(&account).expect("branded item should still exist");
        assert!(
            attrs.contains(&format!("0x00000007 <blob>=\"{BRANDED_LABEL}\"")),
            "{attrs}"
        );

        store.delete(&key).unwrap();
        assert!(attributes(&account).is_none());
        assert_eq!(store.get(&key), Err(KEYCHAIN_ITEM_NOT_FOUND.into()));
    }

    #[test]
    #[ignore]
    fn native_previous_service_migration_smoke() {
        let id = uuid::Uuid::new_v4();
        let key = format!("politedb/profile/{id}/postgres/db_password");
        let account = format!("{}_profile", id.hyphenated().to_string().to_uppercase());
        let _cleanup = Cleanup(account.clone());
        let port = MacKeychain;
        let store = CredentialStore::new(&port);

        // An item written by a build before the rename, plus a custom key under
        // the legacy service that differs from the new service only by case.
        super::set_password_labeled(
            PREVIOUS_BRANDED_SERVICE,
            &account,
            "previous-value",
            Some(BRANDED_LABEL),
        )
        .unwrap();
        super::set_password_labeled(LEGACY_SERVICE, &account, "custom-value", None).unwrap();

        assert_eq!(store.get(&key).unwrap(), "previous-value");
        let attrs = attributes(&account).expect("migrated item should exist");
        assert!(
            attrs.contains(&format!("\"svce\"<blob>=\"{BRANDED_SERVICE}\"")),
            "{attrs}"
        );
        assert!(
            attrs.contains(&format!("0x00000007 <blob>=\"{BRANDED_LABEL}\"")),
            "{attrs}"
        );
        assert!(attributes_in(PREVIOUS_BRANDED_SERVICE, &account).is_none());
        assert_eq!(store.get(&account).unwrap(), "custom-value");

        store.delete(&key).unwrap();
        assert!(attributes(&account).is_none());
        assert_eq!(store.get(&key), Err(KEYCHAIN_ITEM_NOT_FOUND.into()));
        assert_eq!(store.get(&account).unwrap(), "custom-value");
    }
}
