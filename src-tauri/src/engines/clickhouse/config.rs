use clickhouse::Client;

use crate::types::ClickhouseConnectInput;

pub fn build_url(input: &ClickhouseConnectInput) -> String {
    let host = input.host.trim();
    let port = if input.port == 0 { 8123 } else { input.port };
    let scheme = match input.ssl_mode.as_deref() {
        Some("require") | Some("verify-ca") | Some("verify-full") => "https",
        _ => "http",
    };
    format!("{scheme}://{host}:{port}")
}

pub fn build_client(input: &ClickhouseConnectInput, password: &str) -> Client {
    let database = input.database.trim();
    let user = input.user.trim();

    let mut client = Client::default()
        .with_url(build_url(input))
        .with_user(user)
        .with_password(password);

    if !database.is_empty() {
        client = client.with_database(database);
    }

    client
}
