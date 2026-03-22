use mongodb::Client;
use uuid::Uuid;

#[derive(Clone)]
pub struct MongoConn {
    pub id: Uuid,
    pub label: String,
    pub client: Client,
    pub default_database: Option<String>,
}
