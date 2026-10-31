use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use crate::profiles::types::ConnectionProfile;
use crate::types::ConnectionCreateInput;

use crate::file_storage as storage;

const PROFILE_VERSION: u32 = 1;

pub fn profile_file_version() -> u32 {
    PROFILE_VERSION
}

/* ============================================================================
 * File format
 * ============================================================================
 */

#[derive(Debug, Serialize, Deserialize)]
struct ProfileFile {
    version: u32,
    profiles: Vec<ConnectionProfile>,
}

/* ============================================================================
 * Helpers
 * ============================================================================
 */

/// One lock for every read-modify-write of the profile file, its revision
/// backfill included: a load that writes and a mutation can never interleave
/// and restore old settings. Never held across network or Keychain work.
fn store_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The current revision of every stored profile, as last read or written
/// under the store lock. A runtime opened from another revision is stale.
fn revisions() -> &'static RwLock<HashMap<Uuid, String>> {
    static REVISIONS: OnceLock<RwLock<HashMap<Uuid, String>>> = OnceLock::new();
    REVISIONS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn publish_revisions(profiles: &[ConnectionProfile]) {
    let map = profiles
        .iter()
        .map(|p| (p.id, p.revision.clone()))
        .collect();
    *revisions()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = map;
}

/// The stored revision of a profile, or `None` when it no longer exists.
/// Lock-free with respect to the store: admission never takes the store lock.
pub fn current_revision(profile_id: Uuid) -> Option<String> {
    revisions()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&profile_id)
        .cloned()
}

/// A new revision: issued on every create, update and import, never taken
/// from the caller or an imported file.
fn new_revision() -> String {
    Uuid::new_v4().to_string()
}

fn now_epoch_sec() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Reads the profile file; profiles saved before revisions existed get one,
/// persisted before they are returned. Call with the store lock held.
fn load_at(path: &Path) -> Result<Vec<ConnectionProfile>, String> {
    let raw_opt = storage::text_read_if_exists(path)?;
    let Some(raw) = raw_opt else {
        return Ok(Vec::new());
    };

    let file: ProfileFile =
        serde_json::from_str(&raw).map_err(|e| format!("PROFILE_JSON_INVALID: {e}"))?;

    if file.version != PROFILE_VERSION {
        return Err(format!(
            "PROFILE_VERSION_MISMATCH: expected {}, got {}",
            PROFILE_VERSION, file.version
        ));
    }

    let mut profiles = file.profiles;
    let mut backfilled = false;
    for profile in profiles.iter_mut().filter(|p| p.revision.trim().is_empty()) {
        profile.revision = new_revision();
        backfilled = true;
    }
    if backfilled {
        save_at(path, &profiles)?;
    }
    Ok(profiles)
}

/// Replaces the profile file in one step: a failed write leaves the previous
/// file as it was. Call with the store lock held.
fn save_at(path: &Path, profiles: &[ConnectionProfile]) -> Result<(), String> {
    let file = ProfileFile {
        version: PROFILE_VERSION,
        profiles: profiles.to_vec(),
    };
    storage::json_replace_preserving(path, &file).map_err(|e| format!("PROFILE_SAVE_FAILED: {e}"))
}

fn load_published(path: &Path) -> Result<Vec<ConnectionProfile>, String> {
    let profiles = load_at(path)?;
    publish_revisions(&profiles);
    Ok(profiles)
}

fn save_published(path: &Path, profiles: &[ConnectionProfile]) -> Result<(), String> {
    save_at(path, profiles)?;
    publish_revisions(profiles);
    Ok(())
}

/* ============================================================================
 * Public API (used by commands)
 * ============================================================================
 */

pub fn profile_list(app: &AppHandle) -> Result<Vec<ConnectionProfile>, String> {
    list_at(&storage::path_profiles(app)?)
}

pub fn profile_get(app: &AppHandle, profile_id: Uuid) -> Result<ConnectionProfile, String> {
    list_at(&storage::path_profiles(app)?)?
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| "PROFILE_NOT_FOUND".to_string())
}

pub fn profile_update(
    app: &AppHandle,
    profile_id: Uuid,
    input: ConnectionCreateInput,
) -> Result<ConnectionProfile, String> {
    update_at(&storage::path_profiles(app)?, profile_id, input)
}

pub fn profile_remove(app: &AppHandle, profile_id: Uuid) -> Result<(), String> {
    remove_at(&storage::path_profiles(app)?, profile_id)
}

pub fn profile_upsert_many(
    app: &AppHandle,
    incoming: Vec<ConnectionProfile>,
) -> Result<(usize, usize, Vec<ConnectionProfile>), String> {
    upsert_many_at(&storage::path_profiles(app)?, incoming)
}

pub fn profile_create_with_id(
    app: &AppHandle,
    id: Uuid,
    input: ConnectionCreateInput,
) -> Result<ConnectionProfile, String> {
    create_at(&storage::path_profiles(app)?, id, input)
}

/* ============================================================================
 * Store operations on a profile file (each under the store lock)
 * ============================================================================
 */

fn list_at(path: &Path) -> Result<Vec<ConnectionProfile>, String> {
    let _store = store_lock();
    load_published(path)
}

fn update_at(
    path: &Path,
    profile_id: Uuid,
    input: ConnectionCreateInput,
) -> Result<ConnectionProfile, String> {
    let _store = store_lock();
    let mut profiles = load_published(path)?;
    let now = now_epoch_sec();

    let p = profiles
        .iter_mut()
        .find(|p| p.id == profile_id)
        .ok_or("PROFILE_NOT_FOUND")?;

    p.engine = input.engine;
    p.label = input.label.clone();
    p.input = input;
    p.updated_at = now;
    p.revision = new_revision();

    let updated = p.clone();
    save_published(path, &profiles)?;
    Ok(updated)
}

fn remove_at(path: &Path, profile_id: Uuid) -> Result<(), String> {
    let _store = store_lock();
    let mut profiles = load_published(path)?;
    let before = profiles.len();

    profiles.retain(|p| p.id != profile_id);

    if profiles.len() == before {
        return Err("PROFILE_NOT_FOUND".into());
    }

    save_published(path, &profiles)?;
    Ok(())
}

fn upsert_many_at(
    path: &Path,
    incoming: Vec<ConnectionProfile>,
) -> Result<(usize, usize, Vec<ConnectionProfile>), String> {
    let _store = store_lock();
    let current = load_published(path)?;
    let mut by_id: BTreeMap<Uuid, ConnectionProfile> =
        current.into_iter().map(|p| (p.id, p)).collect();

    let mut created = 0usize;
    let mut updated = 0usize;

    for mut profile in incoming {
        // An imported revision is never trusted.
        profile.revision = new_revision();
        if by_id.insert(profile.id, profile).is_some() {
            updated += 1;
        } else {
            created += 1;
        }
    }

    let profiles: Vec<ConnectionProfile> = by_id.into_values().collect();
    save_published(path, &profiles)?;
    Ok((created, updated, profiles))
}

fn create_at(
    path: &Path,
    id: Uuid,
    input: ConnectionCreateInput,
) -> Result<ConnectionProfile, String> {
    let _store = store_lock();
    let mut profiles = load_published(path)?;
    let now = now_epoch_sec();

    let profile = ConnectionProfile {
        id,
        engine: input.engine,
        label: input.label.clone(),
        tags: input.tags.clone(),
        indicator_color: input.indicator_color.clone(),
        input,
        created_at: now,
        updated_at: now,
        revision: new_revision(),
    };

    profiles.push(profile.clone());
    save_published(path, &profiles)?;
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The revision map is process-wide: these tests run one at a time.
    fn serial() -> MutexGuard<'static, ()> {
        static TESTS: OnceLock<Mutex<()>> = OnceLock::new();
        TESTS
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn temp_file() -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("pdb-profiles-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (dir.join("profiles.json"), dir)
    }

    fn input(label: &str, database: &str) -> ConnectionCreateInput {
        serde_json::from_value(json!({
            "engine": "postgres",
            "label": label,
            "postgres": {
                "host": "h", "port": 5432, "database": database, "user": "u",
                "password": { "kind": "keychain", "value": "k" }
            }
        }))
        .unwrap()
    }

    /// A profile file as saved before revisions existed.
    fn legacy_file(path: &Path, ids: &[Uuid]) {
        let profiles: Vec<serde_json::Value> = ids
            .iter()
            .map(|id| {
                json!({
                    "id": id, "engine": "postgres", "label": "p",
                    "input": serde_json::to_value(input("p", "a")).unwrap(),
                    "created_at": 1, "updated_at": 1
                })
            })
            .collect();
        std::fs::write(
            path,
            json!({ "version": 1, "profiles": profiles }).to_string(),
        )
        .unwrap();
    }

    #[test]
    fn every_change_issues_a_new_revision() {
        let _serial = serial();
        let (path, dir) = temp_file();
        let id = Uuid::new_v4();
        let created = create_at(&path, id, input("p", "a")).unwrap();
        assert!(!created.revision.is_empty());
        // Two updates within the same second still differ.
        let first = update_at(&path, id, input("p", "b")).unwrap();
        let second = update_at(&path, id, input("p", "b")).unwrap();
        assert_ne!(created.revision, first.revision);
        assert_ne!(first.revision, second.revision);
        assert_eq!(current_revision(id), Some(second.revision.clone()));

        // An imported profile keeps nothing of its own revision.
        let mut imported = second.clone();
        imported.revision = "from-a-file".into();
        let (_, updated, all) = upsert_many_at(&path, vec![imported]).unwrap();
        assert_eq!(updated, 1);
        let replaced = all.iter().find(|p| p.id == id).unwrap();
        assert_ne!(replaced.revision, "from-a-file");
        assert_ne!(replaced.revision, second.revision);

        remove_at(&path, id).unwrap();
        assert_eq!(current_revision(id), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_profiles_get_one_persisted_revision() {
        let _serial = serial();
        let (path, dir) = temp_file();
        let ids = [Uuid::new_v4(), Uuid::new_v4()];
        legacy_file(&path, &ids);
        // Concurrent first loads backfill once: every load sees the same ids.
        let seen: Vec<Vec<String>> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| list_at(&path).unwrap()))
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap().into_iter().map(|p| p.revision).collect())
                .collect()
        });
        assert!(seen.iter().all(|r| r == &seen[0]), "{seen:?}");
        assert!(seen[0].iter().all(|r| !r.is_empty()));
        // Persisted: a later load keeps them.
        let again: Vec<String> = list_at(&path)
            .unwrap()
            .into_iter()
            .map(|p| p.revision)
            .collect();
        assert_eq!(again, seen[0]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_backfill_never_restores_old_settings() {
        let _serial = serial();
        let (path, dir) = temp_file();
        let id = Uuid::new_v4();
        legacy_file(&path, &[id]);
        std::thread::scope(|scope| {
            let update = scope.spawn(|| update_at(&path, id, input("p", "new")).unwrap());
            let loads: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| list_at(&path).unwrap()))
                .collect();
            let updated = update.join().unwrap();
            for load in loads {
                load.join().unwrap();
            }
            let now = list_at(&path).unwrap();
            assert_eq!(now[0].input.postgres.as_ref().unwrap().database, "new");
            assert_eq!(now[0].revision, updated.revision);
        });
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_write_keeps_the_file() {
        let _serial = serial();
        use std::os::unix::fs::PermissionsExt;
        let (path, dir) = temp_file();
        let id = Uuid::new_v4();
        create_at(&path, id, input("p", "a")).unwrap();
        let before = std::fs::read(&path).unwrap();
        let revision = current_revision(id);
        // The directory refuses new files: the replacement cannot be written.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = update_at(&path, id, input("p", "b"));
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(current_revision(id), revision);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Live checks of plan tab-database-reconnect against a disposable
    /// PostgreSQL (never a customer database), through the same steps
    /// `profile_connect` takes (stored profile → override → identity →
    /// published runtime → admission), without a Tauri app handle:
    /// `TAB_TARGET_PG_URL=postgres://user:pass@127.0.0.1:55440/postgres \
    ///  cargo test tab_target_live -- --ignored`
    /// Creates and drops the databases `zz_tab_a` and `zz_tab_b`.
    #[cfg(feature = "engine-postgres")]
    #[tokio::test]
    #[ignore]
    // The revision map is process-wide: held for the whole (single-task) run.
    #[allow(clippy::await_holding_lock)]
    async fn tab_target_live() {
        use crate::commands::connection::lifecycle::publish_runtime;
        use crate::engines::postgres::config::build_pg_config;
        use crate::engines::postgres::connection::PgConn;
        use crate::engines::runtime::admission::admit_runtime;
        use crate::engines::{registry::EngineRegistry, EngineConnection};
        use crate::profiles::target_override::{apply_override, target_identity};
        use crate::state::app_state::AppState;
        use deadpool_postgres::{Manager, ManagerConfig, Pool};
        use tokio_postgres::NoTls;

        let _guard = serial();
        let admin: tokio_postgres::Config = std::env::var("TAB_TARGET_PG_URL")
            .expect("set TAB_TARGET_PG_URL")
            .parse()
            .expect("valid TAB_TARGET_PG_URL");
        let password = String::from_utf8(admin.get_password().unwrap().to_vec()).unwrap();
        let (host, port) = match (&admin.get_hosts()[0], admin.get_ports()[0]) {
            (tokio_postgres::config::Host::Tcp(h), p) => (h.clone(), p),
            _ => panic!("TCP host expected"),
        };
        let user = admin.get_user().unwrap().to_string();

        let pool_of = |cfg: tokio_postgres::Config| {
            Pool::builder(Manager::from_config(cfg, NoTls, ManagerConfig::default()))
                .max_size(2)
                .build()
                .unwrap()
        };
        let admin_pool = pool_of(admin.clone());
        let sql = |stmt: &'static str| {
            let pool = admin_pool.clone();
            async move {
                pool.get().await.unwrap().batch_execute(stmt).await.unwrap();
            }
        };
        sql("DROP DATABASE IF EXISTS zz_tab_a WITH (FORCE)").await;
        sql("DROP DATABASE IF EXISTS zz_tab_b WITH (FORCE)").await;
        sql("CREATE DATABASE zz_tab_a").await;
        sql("CREATE DATABASE zz_tab_b").await;
        for db in ["zz_tab_a", "zz_tab_b"] {
            let mut cfg = admin.clone();
            cfg.dbname(db);
            let client = pool_of(cfg).get().await.unwrap();
            client
                .batch_execute(&format!(
                    "CREATE TABLE sentinel (db text, n int); INSERT INTO sentinel VALUES ('{db}', 0)"
                ))
                .await
                .unwrap();
        }

        // A saved profile on zz_tab_a (its password is given to the driver
        // directly: no keychain here).
        let (path, dir) = temp_file();
        let profile_input: ConnectionCreateInput = serde_json::from_value(json!({
            "engine": "postgres",
            "label": "live",
            "postgres": {
                "host": host, "port": port, "database": "zz_tab_a", "user": user,
                "password": { "kind": "keychain", "value": "not-used" },
                "ssl_mode": "disable"
            }
        }))
        .unwrap();
        let profile = create_at(&path, Uuid::new_v4(), profile_input).unwrap();

        let state = AppState::new(EngineRegistry::new(vec![]));
        let open = |database: Option<&str>, profile: &ConnectionProfile| {
            let input = match database {
                Some(db) => apply_override(&profile.input, db).unwrap(),
                None => profile.input.clone(),
            };
            let target = target_identity(Some(profile), database.map(str::to_string), &input);
            let cfg = build_pg_config(input.postgres.as_ref().unwrap(), &password).unwrap();
            (cfg, target)
        };
        let publish = |cfg: tokio_postgres::Config, target| {
            let id = Uuid::new_v4();
            let conn = EngineConnection::Postgres(PgConn {
                id,
                label: "live".into(),
                pool: pool_of(cfg.clone()),
                config: cfg,
            });
            publish_runtime(&state, id, conn, target);
            id
        };
        async fn query_one(state: &AppState, id: Uuid, stmt: &str) -> Result<String, String> {
            let conn = admit_runtime(state, id)?;
            let EngineConnection::Postgres(pg) = conn else {
                panic!("postgres")
            };
            let client = pg.pool.get().await.map_err(|e| e.to_string())?;
            let row = client
                .query_one(stmt, &[])
                .await
                .map_err(|e| e.to_string())?;
            Ok(row.get::<_, String>(0))
        }

        // Default and override runtimes each run on their own database.
        let (cfg_a, target_a) = open(None, &profile);
        let (cfg_b, target_b) = open(Some("zz_tab_b"), &profile);
        assert_eq!(target_b.database_override.as_deref(), Some("zz_tab_b"));
        let rt_a = publish(cfg_a, target_a);
        let rt_b = publish(cfg_b, target_b);
        assert_eq!(
            query_one(&state, rt_a, "SELECT current_database()::text")
                .await
                .unwrap(),
            "zz_tab_a"
        );
        assert_eq!(
            query_one(&state, rt_b, "SELECT current_database()::text")
                .await
                .unwrap(),
            "zz_tab_b"
        );

        // A harmless write through B lands in B only.
        assert_eq!(
            query_one(&state, rt_b, "UPDATE sentinel SET n = n + 1 RETURNING db")
                .await
                .unwrap(),
            "zz_tab_b"
        );
        assert_eq!(
            query_one(&state, rt_a, "SELECT n::text FROM sentinel")
                .await
                .unwrap(),
            "0"
        );
        assert_eq!(
            query_one(&state, rt_b, "SELECT n::text FROM sentinel")
                .await
                .unwrap(),
            "1"
        );

        // The stored profile still names its own database.
        let stored = list_at(&path).unwrap();
        assert_eq!(
            stored[0].input.postgres.as_ref().unwrap().database,
            "zz_tab_a"
        );

        // Save-only: every runtime of the profile is refused; a new connect
        // on the saved settings is admitted.
        let saved = update_at(&path, profile.id, stored[0].input.clone()).unwrap();
        for id in [rt_a, rt_b] {
            assert_eq!(
                query_one(&state, id, "SELECT 'x'").await.unwrap_err(),
                "RUNTIME_STALE"
            );
        }
        let (cfg_b2, target_b2) = open(Some("zz_tab_b"), &saved);
        let rt_b2 = publish(cfg_b2, target_b2);
        assert_eq!(
            query_one(&state, rt_b2, "SELECT current_database()::text")
                .await
                .unwrap(),
            "zz_tab_b"
        );

        // The override database is dropped: reopening it fails, and never
        // falls back to the profile's own database.
        drop(crate::commands::connection::lifecycle::unpublish_runtime(
            &state, rt_b2,
        ));
        drop(crate::commands::connection::lifecycle::unpublish_runtime(
            &state, rt_b,
        ));
        sql("DROP DATABASE zz_tab_b WITH (FORCE)").await;
        let (cfg_gone, _) = open(Some("zz_tab_b"), &saved);
        let Err(err) = pool_of(cfg_gone).get().await else {
            panic!("connected to a dropped database");
        };
        let code = match &err {
            deadpool_postgres::PoolError::Backend(e) => e.code().cloned(),
            _ => None,
        };
        assert_eq!(
            code,
            Some(tokio_postgres::error::SqlState::INVALID_CATALOG_NAME),
            "connect error: {err:?}"
        );

        // A removed profile's runtimes are refused.
        let (cfg_a2, target_a2) = open(None, &saved);
        let rt_a2 = publish(cfg_a2, target_a2);
        assert!(query_one(&state, rt_a2, "SELECT 'x'").await.is_ok());
        remove_at(&path, profile.id).unwrap();
        assert_eq!(
            query_one(&state, rt_a2, "SELECT 'x'").await.unwrap_err(),
            "RUNTIME_STALE"
        );

        drop(crate::commands::connection::lifecycle::unpublish_runtime(
            &state, rt_a2,
        ));
        drop(crate::commands::connection::lifecycle::unpublish_runtime(
            &state, rt_a,
        ));
        sql("DROP DATABASE IF EXISTS zz_tab_a WITH (FORCE)").await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
