//! Profile-credential naming + legacy compatibility on top of a keychain port.
//!
//! Recognized profile keys (see [`credential_identity`]) are stored in one
//! branded item per profile + purpose. Pre-branding items under
//! [`LEGACY_SERVICE`] keep working:
//!
//! - get: branded item (`<UUID>_profile|_ssh`) first; only on genuine
//!   not-found the exact legacy alias. A legacy hit is copied to the branded
//!   item (add-only, never overwriting a newer branded value). The legacy item
//!   is retained, so a failed or partial migration never loses the credential.
//!   If the add finds a branded item created concurrently, that item is
//!   authoritative: its re-read value or error is returned, never the older
//!   legacy value. If it vanished again before the re-read (concurrent
//!   delete), not-found is returned without re-adding, so a delete cannot be
//!   undone by a stale legacy copy.
//! - delete: the branded item and every recognized legacy alias, so fallback
//!   cannot resurrect a stale password. Failures are surfaced.
//! - list: one deterministic logical key per credential
//!   (`politedb/profile/<uuid>/credential/<purpose>`) plus unmapped custom
//!   keys under their own names.
//!
//! Unmapped keys keep their legacy physical name and behavior. That includes
//! pre-existing custom keys spelled like a branded account (`<UUID>_profile`,
//! `<UUID>_ssh`): they stay in the legacy namespace and never alias a profile
//! credential.

use std::collections::BTreeSet;

use super::credential_identity::{
    map_key, parse_branded_account, parse_legacy_profile_key, KeyForm, MappedKey,
    ProfileCredential, BRANDED_LABEL, BRANDED_SERVICE, LEGACY_SERVICE,
};

pub const KEYCHAIN_ITEM_NOT_FOUND: &str = "KEYCHAIN_ITEM_NOT_FOUND";

pub fn is_not_found(error: &str) -> bool {
    error == KEYCHAIN_ITEM_NOT_FOUND || error.ends_with(": KEYCHAIN_ITEM_NOT_FOUND")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddOutcome {
    Added,
    AlreadyExists,
}

/// Narrow keychain port (implemented by the macOS adapter; faked in tests).
pub trait KeychainPort {
    /// Read a value. Must return [`KEYCHAIN_ITEM_NOT_FOUND`] (exactly or as a
    /// `ctx: KEYCHAIN_ITEM_NOT_FOUND` suffix) only when the item is absent;
    /// access denied / locked / entitlement / OS failures are other errors.
    /// `upgrade_storage` allows the adapter's existing storage-backend upgrade
    /// copy (legacy file keychain -> data-protection keychain).
    fn get(
        &self,
        service: &str,
        account: &str,
        upgrade_storage: bool,
        label: Option<&str>,
    ) -> Result<String, String>;

    /// Create or update. `label` is applied at creation and on update.
    fn set(
        &self,
        service: &str,
        account: &str,
        value: &str,
        label: Option<&str>,
    ) -> Result<(), String>;

    /// Create only; an existing item is left untouched.
    fn add_if_absent(
        &self,
        service: &str,
        account: &str,
        value: &str,
        label: Option<&str>,
    ) -> Result<AddOutcome, String>;

    /// Delete; an absent item is success.
    fn delete(&self, service: &str, account: &str) -> Result<(), String>;

    /// Account names for a service (attributes only; never reads values).
    fn list(&self, service: &str) -> Result<Vec<String>, String>;
}

pub struct CredentialStore<'a, P: KeychainPort> {
    port: &'a P,
}

impl<'a, P: KeychainPort> CredentialStore<'a, P> {
    pub fn new(port: &'a P) -> Self {
        Self { port }
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        match map_key(key) {
            Some(mapped) => self.port.set(
                BRANDED_SERVICE,
                &mapped.credential.branded_account(),
                value,
                Some(BRANDED_LABEL),
            ),
            None => self.port.set(LEGACY_SERVICE, key, value, None),
        }
    }

    pub fn get(&self, key: &str) -> Result<String, String> {
        let Some(mapped) = map_key(key) else {
            return self.port.get(LEGACY_SERVICE, key, true, None);
        };

        let account = mapped.credential.branded_account();
        match self
            .port
            .get(BRANDED_SERVICE, &account, true, Some(BRANDED_LABEL))
        {
            Ok(value) => Ok(value),
            Err(error) if is_not_found(&error) => self.get_legacy_and_migrate(key, &mapped),
            Err(error) => Err(error),
        }
    }

    pub fn delete(&self, key: &str) -> Result<(), String> {
        let Some(mapped) = map_key(key) else {
            return self.port.delete(LEGACY_SERVICE, key);
        };

        let mut first_error: Option<String> = None;
        let mut record = |result: Result<(), String>| {
            if let Err(error) = result {
                first_error.get_or_insert(error);
            }
        };

        record(
            self.port
                .delete(BRANDED_SERVICE, &mapped.credential.branded_account()),
        );

        let mut aliases: BTreeSet<String> = BTreeSet::new();
        if mapped.form == KeyForm::Legacy {
            aliases.insert(key.to_string());
        }
        match self.legacy_aliases(&mapped.credential) {
            Ok(found) => aliases.extend(found),
            Err(error) => record(Err(error)),
        }
        for alias in &aliases {
            record(self.port.delete(LEGACY_SERVICE, alias));
        }

        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    pub fn list(&self) -> Result<Vec<String>, String> {
        let branded = self.port.list(BRANDED_SERVICE)?;
        let legacy = self.port.list(LEGACY_SERVICE)?;

        let mut keys: BTreeSet<String> = BTreeSet::new();
        // Only well-formed branded accounts are listed, under their logical
        // key; the set collapses them with their legacy aliases.
        keys.extend(
            branded
                .iter()
                .filter_map(|account| parse_branded_account(account))
                .map(|credential| credential.branded_logical_key()),
        );
        for account in legacy {
            match parse_legacy_profile_key(&account) {
                Some(credential) => keys.insert(credential.branded_logical_key()),
                // Custom keys (including branded-account-shaped ones) are
                // listed as-is and round-trip to the legacy service.
                None => keys.insert(account),
            };
        }
        Ok(keys.into_iter().collect())
    }

    /// Fallback after a genuine not-found on the branded item. Real errors from
    /// the legacy read are returned, never treated as not-found.
    fn get_legacy_and_migrate(&self, key: &str, mapped: &MappedKey) -> Result<String, String> {
        let candidates: Vec<String> = match mapped.form {
            KeyForm::Legacy => vec![key.to_string()],
            KeyForm::Branded => self.legacy_aliases(&mapped.credential)?,
        };

        for candidate in candidates {
            // No storage-upgrade copy here: the branded item is the upgrade target.
            match self.port.get(LEGACY_SERVICE, &candidate, false, None) {
                Ok(value) => return self.migrate(&mapped.credential, value),
                Err(error) if is_not_found(&error) => continue,
                Err(error) => return Err(error),
            }
        }
        Err(KEYCHAIN_ITEM_NOT_FOUND.into())
    }

    /// Copy a legacy-service value into the branded item without overwriting a
    /// newer one. The legacy item is never deleted here.
    ///
    /// - Added: the legacy value is now persisted in the branded item.
    /// - AlreadyExists: another writer created the branded item after our
    ///   not-found read, so it is authoritative. Its re-read value is returned;
    ///   access-denied / locked / OS errors are propagated, never masked by the
    ///   legacy value.
    /// - AlreadyExists, then not-found on re-read: a concurrent delete removed
    ///   it. Bounded handling: no retry and no re-add from the legacy value
    ///   (which could resurrect a deleted credential); not-found is returned.
    /// - Add failed: persistence failed, the legacy item is retained and its
    ///   value returned so the credential remains usable.
    fn migrate(
        &self,
        credential: &ProfileCredential,
        legacy_value: String,
    ) -> Result<String, String> {
        let account = credential.branded_account();
        match self.port.add_if_absent(
            BRANDED_SERVICE,
            &account,
            &legacy_value,
            Some(BRANDED_LABEL),
        ) {
            Ok(AddOutcome::Added) => Ok(legacy_value),
            Ok(AddOutcome::AlreadyExists) => {
                match self
                    .port
                    .get(BRANDED_SERVICE, &account, true, Some(BRANDED_LABEL))
                {
                    Ok(value) => Ok(value),
                    Err(error) if is_not_found(&error) => {
                        tracing::warn!(
                            "keychain: branded credential removed during migration; not re-adding"
                        );
                        Err(KEYCHAIN_ITEM_NOT_FOUND.into())
                    }
                    Err(error) => Err(error),
                }
            }
            Err(_) => {
                tracing::warn!(
                    "keychain: branded credential migration failed; legacy item retained"
                );
                Ok(legacy_value)
            }
        }
    }

    fn legacy_aliases(&self, credential: &ProfileCredential) -> Result<Vec<String>, String> {
        let mut aliases: Vec<String> = self
            .port
            .list(LEGACY_SERVICE)?
            .into_iter()
            .filter(|account| parse_legacy_profile_key(account).as_ref() == Some(credential))
            .collect();
        aliases.sort();
        aliases.dedup();
        Ok(aliases)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::{BTreeMap, HashMap};

    const ID: &str = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const ID_UPPER: &str = "0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D";
    const ACCESS_DENIED: &str = "KEYCHAIN_GET_FAILED: OSSTATUS=-25293";
    /// errSecInteractionNotAllowed: keychain locked / no UI allowed.
    const LOCKED: &str = "KEYCHAIN_GET_FAILED: OSSTATUS=-25308";

    type Hook = Box<dyn FnOnce(&FakeKeychain)>;

    #[derive(Clone, Debug, PartialEq)]
    struct Item {
        value: String,
        label: Option<String>,
    }

    #[derive(Default)]
    struct FakeKeychain {
        items: RefCell<BTreeMap<(String, String), Item>>,
        get_errors: RefCell<HashMap<(String, String), String>>,
        delete_errors: RefCell<HashMap<(String, String), String>>,
        list_errors: RefCell<HashMap<String, String>>,
        add_error: RefCell<Option<String>>,
        reads: RefCell<Vec<(String, String, bool)>>,
        add_calls: RefCell<usize>,
        /// Runs inside add_if_absent before the existence check, simulating a
        /// concurrent writer between our not-found read and the add.
        before_add: RefCell<Option<Hook>>,
        /// Runs after add_if_absent returns, simulating a concurrent change
        /// between the add and the authoritative re-read.
        after_add: RefCell<Option<Hook>>,
    }

    fn k(service: &str, account: &str) -> (String, String) {
        (service.to_string(), account.to_string())
    }

    impl FakeKeychain {
        fn put(&self, service: &str, account: &str, value: &str) {
            self.items.borrow_mut().insert(
                k(service, account),
                Item {
                    value: value.into(),
                    label: None,
                },
            );
        }
        fn item(&self, service: &str, account: &str) -> Option<Item> {
            self.items.borrow().get(&k(service, account)).cloned()
        }
    }

    impl KeychainPort for FakeKeychain {
        fn get(
            &self,
            service: &str,
            account: &str,
            upgrade_storage: bool,
            _label: Option<&str>,
        ) -> Result<String, String> {
            self.reads
                .borrow_mut()
                .push((service.into(), account.into(), upgrade_storage));
            if let Some(error) = self.get_errors.borrow().get(&k(service, account)) {
                return Err(error.clone());
            }
            self.item(service, account)
                .map(|item| item.value)
                .ok_or_else(|| KEYCHAIN_ITEM_NOT_FOUND.to_string())
        }

        fn set(
            &self,
            service: &str,
            account: &str,
            value: &str,
            label: Option<&str>,
        ) -> Result<(), String> {
            self.items.borrow_mut().insert(
                k(service, account),
                Item {
                    value: value.into(),
                    label: label.map(str::to_string),
                },
            );
            Ok(())
        }

        fn add_if_absent(
            &self,
            service: &str,
            account: &str,
            value: &str,
            label: Option<&str>,
        ) -> Result<AddOutcome, String> {
            *self.add_calls.borrow_mut() += 1;
            if let Some(error) = self.add_error.borrow().clone() {
                return Err(error);
            }
            let before = self.before_add.borrow_mut().take();
            if let Some(hook) = before {
                hook(self);
            }
            let outcome = if self.item(service, account).is_some() {
                AddOutcome::AlreadyExists
            } else {
                self.set(service, account, value, label)?;
                AddOutcome::Added
            };
            let after = self.after_add.borrow_mut().take();
            if let Some(hook) = after {
                hook(self);
            }
            Ok(outcome)
        }

        fn delete(&self, service: &str, account: &str) -> Result<(), String> {
            if let Some(error) = self.delete_errors.borrow().get(&k(service, account)) {
                return Err(error.clone());
            }
            self.items.borrow_mut().remove(&k(service, account));
            Ok(())
        }

        fn list(&self, service: &str) -> Result<Vec<String>, String> {
            if let Some(error) = self.list_errors.borrow().get(service) {
                return Err(error.clone());
            }
            Ok(self
                .items
                .borrow()
                .keys()
                .filter(|(s, _)| s == service)
                .map(|(_, a)| a.clone())
                .collect())
        }
    }

    fn fe_db() -> String {
        format!("politedb/profile/{ID}/postgres/db_password")
    }
    fn be_db() -> String {
        format!("profile:{ID}:postgres:password")
    }
    fn fe_ssh() -> String {
        format!("politedb/profile/{ID}/ssh_password")
    }
    /// Physical branded account for the database credential.
    fn branded_db() -> String {
        format!("{ID_UPPER}_profile")
    }
    fn branded_ssh() -> String {
        format!("{ID_UPPER}_ssh")
    }
    /// Logical key list() returns for the branded DB / SSH items.
    fn logical_db() -> String {
        format!("politedb/profile/{ID}/credential/database")
    }
    fn logical_ssh() -> String {
        format!("politedb/profile/{ID}/credential/ssh")
    }

    #[test]
    fn set_profile_key_writes_branded_item_with_label() {
        let kc = FakeKeychain::default();
        CredentialStore::new(&kc).set(&fe_db(), "pw").unwrap();
        assert_eq!(
            kc.item(BRANDED_SERVICE, &branded_db()),
            Some(Item {
                value: "pw".into(),
                label: Some(BRANDED_LABEL.into())
            })
        );
        assert!(kc.item(LEGACY_SERVICE, &fe_db()).is_none());
    }

    #[test]
    fn set_ssh_key_writes_separate_branded_item() {
        let kc = FakeKeychain::default();
        let store = CredentialStore::new(&kc);
        store.set(&fe_db(), "db").unwrap();
        store.set(&fe_ssh(), "ssh").unwrap();
        assert_eq!(kc.item(BRANDED_SERVICE, &branded_db()).unwrap().value, "db");
        assert_eq!(
            kc.item(BRANDED_SERVICE, &branded_ssh()).unwrap().value,
            "ssh"
        );
    }

    #[test]
    fn custom_keys_keep_legacy_physical_name() {
        let kc = FakeKeychain::default();
        let store = CredentialStore::new(&kc);
        store.set("politedb:ai:openai:api_key", "sk").unwrap();
        assert_eq!(
            kc.item(LEGACY_SERVICE, "politedb:ai:openai:api_key"),
            Some(Item {
                value: "sk".into(),
                label: None
            })
        );
        assert_eq!(store.get("politedb:ai:openai:api_key").unwrap(), "sk");
        store.delete("politedb:ai:openai:api_key").unwrap();
        assert!(kc.items.borrow().is_empty());
    }

    #[test]
    fn get_new_only_reads_branded_without_legacy_lookup() {
        let kc = FakeKeychain::default();
        kc.put(BRANDED_SERVICE, &branded_db(), "new");
        assert_eq!(CredentialStore::new(&kc).get(&be_db()).unwrap(), "new");
        assert!(kc
            .reads
            .borrow()
            .iter()
            .all(|(s, _, _)| s == BRANDED_SERVICE));
    }

    #[test]
    fn get_legacy_only_migrates_and_retains_legacy() {
        let kc = FakeKeychain::default();
        kc.put(LEGACY_SERVICE, &fe_db(), "old");
        assert_eq!(CredentialStore::new(&kc).get(&fe_db()).unwrap(), "old");
        assert_eq!(
            kc.item(BRANDED_SERVICE, &branded_db()),
            Some(Item {
                value: "old".into(),
                label: Some(BRANDED_LABEL.into())
            })
        );
        assert_eq!(kc.item(LEGACY_SERVICE, &fe_db()).unwrap().value, "old");
        // Legacy read must not trigger the storage-upgrade copy under the legacy service.
        assert!(kc
            .reads
            .borrow()
            .iter()
            .any(|(s, a, upgrade)| s == LEGACY_SERVICE && a == &fe_db() && !upgrade));
    }

    #[test]
    fn get_both_prefers_branded_and_never_overwrites_it() {
        let kc = FakeKeychain::default();
        kc.put(BRANDED_SERVICE, &branded_db(), "new");
        kc.put(LEGACY_SERVICE, &fe_db(), "old");
        assert_eq!(CredentialStore::new(&kc).get(&fe_db()).unwrap(), "new");
        assert_eq!(
            kc.item(BRANDED_SERVICE, &branded_db()).unwrap().value,
            "new"
        );
    }

    #[test]
    fn migration_race_returns_authoritative_branded_value() {
        // Branded read misses, then a concurrent writer creates it before our add.
        let kc = FakeKeychain::default();
        kc.put(LEGACY_SERVICE, &fe_db(), "old");
        *kc.before_add.borrow_mut() = Some(Box::new(|kc: &FakeKeychain| {
            kc.put(BRANDED_SERVICE, &branded_db(), "newer");
        }));
        let value = CredentialStore::new(&kc).get(&fe_db()).unwrap();
        assert_eq!(value, "newer");
        assert_eq!(
            kc.item(BRANDED_SERVICE, &branded_db()).unwrap().value,
            "newer"
        );
        assert_eq!(kc.item(LEGACY_SERVICE, &fe_db()).unwrap().value, "old");
        let branded_reads = kc
            .reads
            .borrow()
            .iter()
            .filter(|(s, a, _)| s == BRANDED_SERVICE && a == &branded_db())
            .count();
        assert_eq!(branded_reads, 2, "initial miss + authoritative re-read");
    }

    fn assert_reread_error_propagates(error: &'static str) {
        let kc = FakeKeychain::default();
        kc.put(LEGACY_SERVICE, &fe_db(), "old");
        *kc.before_add.borrow_mut() = Some(Box::new(move |kc: &FakeKeychain| {
            kc.put(BRANDED_SERVICE, &branded_db(), "newer");
            kc.get_errors
                .borrow_mut()
                .insert(k(BRANDED_SERVICE, &branded_db()), error.into());
        }));
        assert_eq!(
            CredentialStore::new(&kc).get(&fe_db()),
            Err(error.to_string()),
            "re-read error must propagate, not fall back to the legacy value"
        );
        assert_eq!(
            kc.item(BRANDED_SERVICE, &branded_db()).unwrap().value,
            "newer"
        );
        assert_eq!(kc.item(LEGACY_SERVICE, &fe_db()).unwrap().value, "old");
        assert_eq!(*kc.add_calls.borrow(), 1);
    }

    #[test]
    fn migration_race_propagates_access_denied_reread() {
        assert_reread_error_propagates(ACCESS_DENIED);
    }

    #[test]
    fn migration_race_propagates_locked_reread() {
        assert_reread_error_propagates(LOCKED);
    }

    #[test]
    fn migration_race_concurrent_delete_returns_not_found_without_readding() {
        // Another writer creates the branded item, then a delete removes the
        // credential (branded + legacy) before our authoritative re-read.
        let kc = FakeKeychain::default();
        kc.put(LEGACY_SERVICE, &fe_db(), "old");
        *kc.before_add.borrow_mut() = Some(Box::new(|kc: &FakeKeychain| {
            kc.put(BRANDED_SERVICE, &branded_db(), "newer");
        }));
        *kc.after_add.borrow_mut() = Some(Box::new(|kc: &FakeKeychain| {
            kc.items.borrow_mut().clear();
        }));
        let store = CredentialStore::new(&kc);
        assert_eq!(store.get(&fe_db()), Err(KEYCHAIN_ITEM_NOT_FOUND.into()));
        assert_eq!(*kc.add_calls.borrow(), 1, "bounded: no retry");
        assert!(
            kc.items.borrow().is_empty(),
            "deleted credential not resurrected"
        );
        assert_eq!(store.get(&fe_db()), Err(KEYCHAIN_ITEM_NOT_FOUND.into()));
    }

    #[test]
    fn migration_write_failure_returns_value_and_retains_legacy() {
        let kc = FakeKeychain::default();
        kc.put(LEGACY_SERVICE, &fe_ssh(), "ssh-old");
        *kc.add_error.borrow_mut() = Some("KEYCHAIN_ADD_FAILED: OSSTATUS=-25308".into());
        assert_eq!(CredentialStore::new(&kc).get(&fe_ssh()).unwrap(), "ssh-old");
        assert!(kc.item(BRANDED_SERVICE, &branded_ssh()).is_none());
        assert_eq!(kc.item(LEGACY_SERVICE, &fe_ssh()).unwrap().value, "ssh-old");
    }

    #[test]
    fn repeated_migration_is_idempotent() {
        let kc = FakeKeychain::default();
        kc.put(LEGACY_SERVICE, &fe_db(), "old");
        let store = CredentialStore::new(&kc);
        assert_eq!(store.get(&fe_db()).unwrap(), "old");
        let reads_after_first = kc.reads.borrow().len();
        assert_eq!(store.get(&fe_db()).unwrap(), "old");
        let second: Vec<_> = kc.reads.borrow()[reads_after_first..].to_vec();
        assert_eq!(second.len(), 1, "second read hits only the branded item");
        assert_eq!(second[0].0, BRANDED_SERVICE);
        assert_eq!(kc.items.borrow().len(), 2);
    }

    #[test]
    fn access_denied_on_branded_is_not_treated_as_not_found() {
        let kc = FakeKeychain::default();
        kc.put(LEGACY_SERVICE, &fe_db(), "old");
        kc.get_errors
            .borrow_mut()
            .insert(k(BRANDED_SERVICE, &branded_db()), ACCESS_DENIED.into());
        assert_eq!(
            CredentialStore::new(&kc).get(&fe_db()),
            Err(ACCESS_DENIED.into())
        );
        assert!(kc
            .reads
            .borrow()
            .iter()
            .all(|(s, a, _)| s == BRANDED_SERVICE && a == &branded_db()));
        assert!(kc.item(BRANDED_SERVICE, &branded_db()).is_none());
    }

    #[test]
    fn access_denied_on_legacy_is_surfaced() {
        let kc = FakeKeychain::default();
        kc.get_errors
            .borrow_mut()
            .insert(k(LEGACY_SERVICE, &fe_db()), ACCESS_DENIED.into());
        assert_eq!(
            CredentialStore::new(&kc).get(&fe_db()),
            Err(ACCESS_DENIED.into())
        );
    }

    #[test]
    fn missing_everywhere_returns_exact_not_found() {
        let kc = FakeKeychain::default();
        let store = CredentialStore::new(&kc);
        assert_eq!(store.get(&fe_db()), Err(KEYCHAIN_ITEM_NOT_FOUND.into()));
        assert_eq!(
            store.get(&logical_db()),
            Err(KEYCHAIN_ITEM_NOT_FOUND.into())
        );
        assert_eq!(
            store.get(&branded_db()),
            Err(KEYCHAIN_ITEM_NOT_FOUND.into())
        );
        assert_eq!(store.get("custom"), Err(KEYCHAIN_ITEM_NOT_FOUND.into()));
    }

    #[test]
    fn legacy_fallback_uses_exact_alias_only() {
        // A backend-form key must not read a frontend-form legacy item implicitly.
        let kc = FakeKeychain::default();
        kc.put(LEGACY_SERVICE, &fe_db(), "old");
        assert_eq!(
            CredentialStore::new(&kc).get(&be_db()),
            Err(KEYCHAIN_ITEM_NOT_FOUND.into())
        );
    }

    #[test]
    fn list_merges_branded_and_legacy_without_duplicates() {
        let kc = FakeKeychain::default();
        kc.put(BRANDED_SERVICE, &branded_db(), "new");
        kc.put(LEGACY_SERVICE, &fe_db(), "old");
        kc.put(LEGACY_SERVICE, &be_db(), "old2");
        kc.put(LEGACY_SERVICE, &fe_ssh(), "ssh");
        kc.put(LEGACY_SERVICE, "politedb:ai:openai:api_key", "sk");
        kc.put(BRANDED_SERVICE, "unexpected", "x");
        let listed = CredentialStore::new(&kc).list().unwrap();
        assert_eq!(
            listed,
            vec![
                logical_db(),
                logical_ssh(),
                "politedb:ai:openai:api_key".to_string(),
            ]
        );
    }

    #[test]
    fn listed_legacy_only_entry_can_be_read_and_deleted() {
        let kc = FakeKeychain::default();
        kc.put(LEGACY_SERVICE, &fe_ssh(), "ssh");
        let store = CredentialStore::new(&kc);
        let listed = store.list().unwrap();
        assert_eq!(listed, vec![logical_ssh()]);
        assert_eq!(store.get(&listed[0]).unwrap(), "ssh");
        store.delete(&listed[0]).unwrap();
        assert!(kc.items.borrow().is_empty());
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn delete_removes_branded_and_all_legacy_aliases_no_resurrection() {
        let kc = FakeKeychain::default();
        kc.put(BRANDED_SERVICE, &branded_db(), "new");
        kc.put(LEGACY_SERVICE, &fe_db(), "old");
        kc.put(LEGACY_SERVICE, &be_db(), "old2");
        kc.put(LEGACY_SERVICE, &fe_ssh(), "ssh");
        let store = CredentialStore::new(&kc);
        store.delete(&fe_db()).unwrap();
        assert_eq!(store.get(&fe_db()), Err(KEYCHAIN_ITEM_NOT_FOUND.into()));
        assert_eq!(store.get(&be_db()), Err(KEYCHAIN_ITEM_NOT_FOUND.into()));
        // SSH credential of the same profile is untouched.
        assert_eq!(store.get(&fe_ssh()).unwrap(), "ssh");
    }

    #[test]
    fn delete_surfaces_failures_and_still_attempts_other_items() {
        let kc = FakeKeychain::default();
        kc.put(BRANDED_SERVICE, &branded_db(), "new");
        kc.put(LEGACY_SERVICE, &fe_db(), "old");
        kc.delete_errors.borrow_mut().insert(
            k(BRANDED_SERVICE, &branded_db()),
            "KEYCHAIN_DELETE_FAILED: OSSTATUS=-25293".into(),
        );
        let result = CredentialStore::new(&kc).delete(&fe_db());
        assert_eq!(
            result,
            Err("KEYCHAIN_DELETE_FAILED: OSSTATUS=-25293".into())
        );
        assert!(kc.item(LEGACY_SERVICE, &fe_db()).is_none());
    }

    #[test]
    fn delete_surfaces_legacy_list_failure() {
        let kc = FakeKeychain::default();
        kc.put(BRANDED_SERVICE, &branded_db(), "new");
        kc.list_errors.borrow_mut().insert(
            LEGACY_SERVICE.into(),
            "KEYCHAIN_LIST_FAILED: OSSTATUS=-25293".into(),
        );
        let result = CredentialStore::new(&kc).delete(&logical_db());
        assert!(result.is_err());
        assert!(kc.item(BRANDED_SERVICE, &branded_db()).is_none());
    }

    #[test]
    fn delete_missing_is_success() {
        let kc = FakeKeychain::default();
        CredentialStore::new(&kc).delete(&fe_db()).unwrap();
    }

    #[test]
    fn create_edit_reconnect_cycle_keeps_logical_ref_usable() {
        let kc = FakeKeychain::default();
        let store = CredentialStore::new(&kc);
        // create
        store.set(&fe_db(), "v1").unwrap();
        store.set(&fe_ssh(), "s1").unwrap();
        // edit
        store.set(&fe_db(), "v2").unwrap();
        // reconnect resolves the same logical SecretRef values
        assert_eq!(store.get(&fe_db()).unwrap(), "v2");
        assert_eq!(store.get(&fe_ssh()).unwrap(), "s1");
        // backend alias of the same profile DB credential resolves the same item
        assert_eq!(store.get(&be_db()).unwrap(), "v2");
    }

    #[test]
    fn listed_branded_entry_round_trips_through_logical_key() {
        let kc = FakeKeychain::default();
        let store = CredentialStore::new(&kc);
        store.set(&fe_db(), "pw").unwrap();
        let listed = store.list().unwrap();
        assert_eq!(listed, vec![logical_db()]);
        assert_eq!(store.get(&listed[0]).unwrap(), "pw");
        store.set(&listed[0], "pw2").unwrap();
        assert_eq!(store.get(&fe_db()).unwrap(), "pw2");
        store.delete(&listed[0]).unwrap();
        assert!(kc.items.borrow().is_empty());
    }

    #[test]
    fn legacy_custom_uuid_shaped_account_alone_round_trips_in_legacy_namespace() {
        let kc = FakeKeychain::default();
        kc.put(LEGACY_SERVICE, &branded_db(), "custom");
        let store = CredentialStore::new(&kc);

        let listed = store.list().unwrap();
        assert_eq!(listed, vec![branded_db()]);
        assert_eq!(store.get(&listed[0]).unwrap(), "custom");
        assert!(kc
            .reads
            .borrow()
            .iter()
            .all(|(s, a, _)| s == LEGACY_SERVICE && a == &branded_db()));

        store.set(&listed[0], "custom2").unwrap();
        assert_eq!(
            kc.item(LEGACY_SERVICE, &branded_db()).unwrap().value,
            "custom2"
        );
        assert!(kc.item(BRANDED_SERVICE, &branded_db()).is_none());

        store.delete(&listed[0]).unwrap();
        assert!(kc.items.borrow().is_empty());
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn legacy_custom_uuid_shaped_accounts_coexist_with_profile_credentials() {
        let kc = FakeKeychain::default();
        kc.put(LEGACY_SERVICE, &branded_db(), "custom-db");
        kc.put(LEGACY_SERVICE, &branded_ssh(), "custom-ssh");
        let store = CredentialStore::new(&kc);
        store.set(&fe_db(), "profile-db").unwrap();
        store.set(&fe_ssh(), "profile-ssh").unwrap();

        // list exposes all four independently.
        assert_eq!(
            store.list().unwrap(),
            vec![branded_db(), branded_ssh(), logical_db(), logical_ssh()]
        );

        // get resolves each to its own item.
        assert_eq!(store.get(&branded_db()).unwrap(), "custom-db");
        assert_eq!(store.get(&branded_ssh()).unwrap(), "custom-ssh");
        assert_eq!(store.get(&logical_db()).unwrap(), "profile-db");
        assert_eq!(store.get(&fe_db()).unwrap(), "profile-db");
        assert_eq!(store.get(&logical_ssh()).unwrap(), "profile-ssh");

        // set on the custom key never overwrites the profile credential and vice versa.
        store.set(&branded_db(), "custom-db2").unwrap();
        assert_eq!(store.get(&fe_db()).unwrap(), "profile-db");
        store.set(&logical_db(), "profile-db2").unwrap();
        assert_eq!(store.get(&branded_db()).unwrap(), "custom-db2");
        assert_eq!(store.get(&fe_db()).unwrap(), "profile-db2");

        // delete on the custom key leaves the profile credential, and vice versa.
        store.delete(&branded_db()).unwrap();
        assert_eq!(
            store.get(&branded_db()),
            Err(KEYCHAIN_ITEM_NOT_FOUND.into())
        );
        assert_eq!(store.get(&fe_db()).unwrap(), "profile-db2");
        store.delete(&fe_ssh()).unwrap();
        assert_eq!(store.get(&fe_ssh()), Err(KEYCHAIN_ITEM_NOT_FOUND.into()));
        assert_eq!(store.get(&branded_ssh()).unwrap(), "custom-ssh");

        assert_eq!(store.list().unwrap(), vec![branded_ssh(), logical_db()]);
    }

    #[test]
    fn legacy_custom_uuid_shaped_account_coexists_with_legacy_profile_items() {
        // Pre-branding: both a profile item and a UUID-shaped custom item under
        // the legacy service. Migration must not merge them.
        let kc = FakeKeychain::default();
        kc.put(LEGACY_SERVICE, &fe_db(), "profile-old");
        kc.put(LEGACY_SERVICE, &branded_db(), "custom");
        let store = CredentialStore::new(&kc);
        assert_eq!(store.list().unwrap(), vec![branded_db(), logical_db()]);
        assert_eq!(store.get(&logical_db()).unwrap(), "profile-old");
        assert_eq!(
            kc.item(BRANDED_SERVICE, &branded_db()).unwrap().value,
            "profile-old"
        );
        assert_eq!(store.get(&branded_db()).unwrap(), "custom");
        store.delete(&logical_db()).unwrap();
        assert_eq!(store.get(&branded_db()).unwrap(), "custom");
        assert_eq!(store.list().unwrap(), vec![branded_db()]);
    }

    // --- Only `_profile` / `_ssh` physical accounts are supported ---

    #[test]
    fn database_suffix_under_branded_service_is_ignored() {
        // `<UUID>_database` is not a supported branded account: it is never
        // read, migrated, listed or deleted (no bulk Keychain cleanup).
        let unsupported = format!("{ID_UPPER}_database");
        let kc = FakeKeychain::default();
        kc.put(BRANDED_SERVICE, &unsupported, "unsupported");
        let store = CredentialStore::new(&kc);
        for key in [fe_db(), be_db(), logical_db()] {
            assert_eq!(
                store.get(&key),
                Err(KEYCHAIN_ITEM_NOT_FOUND.into()),
                "{key}"
            );
        }
        assert!(kc.reads.borrow().iter().all(|(_, a, _)| a != &unsupported));
        assert_eq!(*kc.add_calls.borrow(), 0);
        assert!(store.list().unwrap().is_empty());
        store.delete(&logical_db()).unwrap();
        assert_eq!(
            kc.item(BRANDED_SERVICE, &unsupported).unwrap().value,
            "unsupported"
        );
    }

    #[test]
    fn legacy_custom_database_and_profile_spellings_stay_independent() {
        // Custom `<UUID>_database` / `<UUID>_profile` keys under `politedb`
        // coexist with the profile credential.
        let custom_database = format!("{ID_UPPER}_database");
        let kc = FakeKeychain::default();
        kc.put(LEGACY_SERVICE, &custom_database, "custom-database");
        kc.put(LEGACY_SERVICE, &branded_db(), "custom-profile");
        let store = CredentialStore::new(&kc);
        store.set(&fe_db(), "profile").unwrap();

        assert_eq!(
            store.list().unwrap(),
            vec![custom_database.clone(), branded_db(), logical_db()]
        );
        assert_eq!(store.get(&custom_database).unwrap(), "custom-database");
        assert_eq!(store.get(&branded_db()).unwrap(), "custom-profile");
        assert_eq!(store.get(&fe_db()).unwrap(), "profile");

        store.set(&custom_database, "custom-database2").unwrap();
        store.set(&branded_db(), "custom-profile2").unwrap();
        assert_eq!(store.get(&fe_db()).unwrap(), "profile");

        store.delete(&logical_db()).unwrap();
        assert_eq!(store.get(&custom_database).unwrap(), "custom-database2");
        assert_eq!(store.get(&branded_db()).unwrap(), "custom-profile2");
        assert_eq!(
            store.list().unwrap(),
            vec![custom_database.clone(), branded_db()]
        );

        store.delete(&custom_database).unwrap();
        store.delete(&branded_db()).unwrap();
        assert!(kc.items.borrow().is_empty());
    }
}
