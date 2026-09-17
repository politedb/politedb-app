use std::time::Duration;

use clickhouse::Client as HttpClient;
use klickhouse::{Client as NativeClient, ClientOptions};

use crate::types::{ClickhouseConnectInput, ClickhouseProtocol};

pub fn resolved_protocol(input: &ClickhouseConnectInput) -> ClickhouseProtocol {
    if let Some(p) = input.protocol {
        return p;
    }
    // Legacy profiles saved before `protocol` existed.
    let port = input.port;
    if port == 8123 || port == 8443 {
        ClickhouseProtocol::Http
    } else {
        ClickhouseProtocol::Native
    }
}

pub fn uses_http(input: &ClickhouseConnectInput) -> bool {
    resolved_protocol(input) == ClickhouseProtocol::Http
}

pub fn default_port_for_protocol(protocol: ClickhouseProtocol) -> u16 {
    match protocol {
        ClickhouseProtocol::Native => 9000,
        ClickhouseProtocol::Http => 8123,
    }
}

pub fn effective_port(input: &ClickhouseConnectInput) -> u16 {
    if input.port != 0 {
        input.port
    } else {
        default_port_for_protocol(resolved_protocol(input))
    }
}

pub fn build_http_url(input: &ClickhouseConnectInput) -> String {
    let host = input.host.trim();
    let port = effective_port(input);
    let scheme = match input.ssl_mode.as_deref() {
        Some("require") | Some("verify-ca") | Some("verify-full") => "https",
        _ => "http",
    };
    format!("{scheme}://{host}:{port}")
}

pub fn build_http_client(input: &ClickhouseConnectInput, password: &str) -> HttpClient {
    let database = input.database.trim();
    let user = input.user.trim();

    let mut client = HttpClient::default()
        .with_url(build_http_url(input))
        .with_user(user)
        .with_password(password);

    if !database.is_empty() {
        client = client.with_database(database);
    }

    client
}

pub fn build_native_address(input: &ClickhouseConnectInput) -> String {
    let host = input.host.trim();
    let port = effective_port(input);
    format!("{host}:{port}")
}

pub fn build_native_options(input: &ClickhouseConnectInput, password: &str) -> ClientOptions {
    ClientOptions {
        username: input.user.trim().to_string(),
        password: password.to_string(),
        default_database: input.database.trim().to_string(),
        ..Default::default()
    }
}

pub async fn connect_native(
    input: &ClickhouseConnectInput,
    password: &str,
) -> Result<NativeClient, String> {
    let address = build_native_address(input);
    let options = build_native_options(input, password);
    let timeout_ms = input
        .connect_timeout_ms
        .unwrap_or(15_000)
        .clamp(500, 60_000);
    let timeout = Duration::from_millis(timeout_ms);

    let fut = NativeClient::connect(&address, options);
    tokio::time::timeout(timeout, fut)
        .await
        .map_err(|_| format!("CLICKHOUSE_CONNECT_TIMEOUT after {timeout_ms}ms"))?
        .map_err(|e| format!("CLICKHOUSE_CONNECT_FAILED: {e}"))
}
