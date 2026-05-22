use clickhouse::Client as HttpClient;
use klickhouse::Client as NativeClient;
use uuid::Uuid;

#[derive(Clone)]
pub enum ClickhouseClient {
    Native(NativeClient),
    Http(HttpClient),
}

#[derive(Clone)]
pub struct ClickhouseConn {
    pub id: Uuid,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
    pub ssl_mode: Option<String>,
    pub connect_timeout_ms: Option<u64>,
    pub default_statement_timeout_ms: Option<u64>,
    pub client: ClickhouseClient,
}

impl ClickhouseConn {
    pub fn uses_http(&self) -> bool {
        matches!(self.client, ClickhouseClient::Http(_))
    }
}
