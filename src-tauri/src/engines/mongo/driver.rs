use async_trait::async_trait;
use mongodb::Client;
use tauri::AppHandle;
use uuid::Uuid;

use crate::engines::driver::EngineDriver;
use crate::engines::merge::{inline_db_pw, merge_secret_ref_for_test, merge_ssh_for_test};
use crate::engines::mongo::connection::MongoConn;
use crate::engines::EngineConnection;
use crate::types::{
    ConnectionCreateInput, ConnectionTestSecrets, EngineKind, MongoConnectInput, SecretRef,
    SecretRefKind,
};

pub struct MongoDriver;

#[async_trait]
impl EngineDriver for MongoDriver {
    fn kind(&self) -> EngineKind {
        EngineKind::Mongo
    }

    async fn connect(
        &self,
        app: &AppHandle,
        conn_id: Uuid,
        label: String,
        input: ConnectionCreateInput,
    ) -> Result<EngineConnection, String> {
        let mongo = input.mongo.ok_or("MONGO_CONFIG_MISSING")?;
        let client = connect_mongo(app, &mongo).await?;

        Ok(EngineConnection::Mongo(MongoConn {
            id: conn_id,
            label,
            client,
            default_database: sanitize_opt(&mongo.database),
        }))
    }

    async fn test(
        &self,
        app: &AppHandle,
        input: ConnectionCreateInput,
        secrets_opt: Option<ConnectionTestSecrets>,
    ) -> Result<(), String> {
        let mongo = input.mongo.ok_or("MONGO_CONFIG_MISSING")?;
        test_mongo_direct(app, mongo, secrets_opt).await
    }

    fn merge_for_test(
        &self,
        mut base: ConnectionCreateInput,
        ov: ConnectionCreateInput,
        secrets: Option<ConnectionTestSecrets>,
    ) -> Result<ConnectionCreateInput, String> {
        base = merge_ssh_for_test(base, &ov, &secrets);

        let mut b = base.mongo.ok_or("MONGO_CONFIG_MISSING")?;

        if let Some(ov_mongo) = ov.mongo {
            b.host = ov_mongo.host;
            b.port = ov_mongo.port;
            b.database = ov_mongo.database;
            b.user = ov_mongo.user;
            b.ssl_mode = ov_mongo.ssl_mode;
            b.connect_timeout_ms = ov_mongo.connect_timeout_ms;

            let inline = inline_db_pw(&secrets);
            merge_secret_ref_for_test(&mut b.password, &ov_mongo.password, inline.as_ref());
        } else if let Some(pw) = inline_db_pw(&secrets) {
            b.password = SecretRef {
                kind: SecretRefKind::Inline,
                value: pw,
            };
        }

        base.mongo = Some(b);
        Ok(base)
    }
    fn persist_profile_secrets(
        &self,
        app: &AppHandle,
        profile_id: uuid::Uuid,
        persist_secrets: bool,
        mut input: ConnectionCreateInput,
    ) -> Result<ConnectionCreateInput, String> {
        let mongo = input.mongo.as_mut().ok_or("MONGO_CONFIG_MISSING")?;
        crate::engines::profile_secrets::persist_secret_ref(
            app,
            profile_id,
            EngineKind::Mongo,
            persist_secrets,
            &mut mongo.password,
        )?;
        Ok(input)
    }
}

fn sanitize_opt(v: &Option<String>) -> Option<String> {
    v.as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn encode_uri_component(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}

/// Port-forward / SSH bind addresses advertise replica-set members the client
/// cannot reach (internal K8s DNS). Direct connection stays on the seed host.
fn should_use_direct_connection(host: &str) -> bool {
    let host = host
        .trim()
        .trim_matches(|c| c == '[' || c == ']')
        .to_ascii_lowercase();
    matches!(
        host.as_str(),
        "127.0.0.1" | "localhost" | "localhost." | "::1" | "0.0.0.0"
    )
}

fn mongo_uri(input: &MongoConnectInput, password: &str) -> String {
    let host = input.host.trim();
    let port = input.port;
    let user = sanitize_opt(&input.user);
    let database = sanitize_opt(&input.database);

    let mut uri = String::from("mongodb://");

    if let Some(user) = user {
        uri.push_str(&encode_uri_component(&user));
        if !password.is_empty() {
            uri.push(':');
            uri.push_str(&encode_uri_component(password));
        }
        uri.push('@');
    }

    uri.push_str(host);
    uri.push(':');
    uri.push_str(&port.to_string());
    uri.push('/');
    uri.push_str(&database.as_deref().unwrap_or(""));

    let mut params: Vec<String> = Vec::new();

    // Default to admin database for authentication
    params.push("authSource=admin".to_string());
    // Avoid driver creating sessions on config.system.sessions, which can fail
    // with Unauthorized for restricted users.
    params.push("retryWrites=false".to_string());

    if should_use_direct_connection(host) {
        params.push("directConnection=true".to_string());
    }

    if matches!(
        input.ssl_mode.as_deref(),
        Some("require") | Some("verify-ca") | Some("verify-full")
    ) {
        params.push("tls=true".to_string());
    }

    if let Some(ms) = input.connect_timeout_ms {
        let ms = ms.clamp(200, 60_000);
        params.push(format!("connectTimeoutMS={ms}"));
        params.push(format!("serverSelectionTimeoutMS={ms}"));
    }

    if !params.is_empty() {
        uri.push('?');
        uri.push_str(&params.join("&"));
    }

    uri
}

async fn resolve_mongo_password(
    app: &AppHandle,
    secret_ref: &SecretRef,
    override_plain: Option<&str>,
) -> Result<String, String> {
    if let Some(pw) = override_plain {
        return Ok(pw.to_string());
    }

    match secret_ref.kind {
        SecretRefKind::Inline => Ok(secret_ref.value.clone()),
        SecretRefKind::Keychain => {
            let key = secret_ref.value.trim();
            if key.is_empty() {
                return Ok(String::new());
            }
            crate::security::secrets::keychain_get(app, key).map_err(|e| {
                if e == "KEYCHAIN_ITEM_NOT_FOUND" {
                    "CREDENTIALS_INVALID".to_string()
                } else {
                    e
                }
            })
        }
    }
}

async fn smoke_mongo(client: &Client) -> Result<(), String> {
    client
        .list_database_names()
        .await
        .map(|_| ())
        .map_err(|e| format!("MONGO_CONNECT_FAILED: {e}"))
}

async fn connect_mongo(app: &AppHandle, input: &MongoConnectInput) -> Result<Client, String> {
    let password = resolve_mongo_password(app, &input.password, None).await?;
    let uri = mongo_uri(input, &password);
    let client = Client::with_uri_str(uri)
        .await
        .map_err(|e| format!("MONGO_CONNECT_FAILED: {e}"))?;
    smoke_mongo(&client).await?;
    Ok(client)
}

async fn test_mongo_direct(
    app: &AppHandle,
    input: MongoConnectInput,
    secrets_opt: Option<ConnectionTestSecrets>,
) -> Result<(), String> {
    let override_plain = secrets_opt
        .as_ref()
        .and_then(|s| s.db_password.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let password = resolve_mongo_password(app, &input.password, override_plain).await?;
    let uri = mongo_uri(&input, &password);
    let client = Client::with_uri_str(uri)
        .await
        .map_err(|e| format!("MONGO_TEST_FAILED: {e}"))?;
    smoke_mongo(&client).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{mongo_uri, should_use_direct_connection};
    use crate::types::{MongoConnectInput, SecretRef, SecretRefKind};

    fn input(host: &str) -> MongoConnectInput {
        MongoConnectInput {
            host: host.to_string(),
            port: 27017,
            database: Some("tracking".to_string()),
            user: Some("root".to_string()),
            password: SecretRef {
                kind: SecretRefKind::Inline,
                value: "secret".to_string(),
            },
            ssl_mode: None,
            connect_timeout_ms: None,
        }
    }

    #[test]
    fn loopback_hosts_use_direct_connection() {
        assert!(should_use_direct_connection("127.0.0.1"));
        assert!(should_use_direct_connection("localhost"));
        assert!(should_use_direct_connection("::1"));
        assert!(mongo_uri(&input("127.0.0.1"), "secret").contains("directConnection=true"));
    }

    #[test]
    fn remote_hosts_keep_replica_set_discovery() {
        assert!(!should_use_direct_connection(
            "mongodb-0.mongodb-headless.tracking.svc.app.zz"
        ));
        assert!(!mongo_uri(&input("cluster0.abc.mongodb.net"), "secret")
            .contains("directConnection=true"));
    }
}
