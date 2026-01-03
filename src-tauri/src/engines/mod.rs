pub mod postgres;

use uuid::Uuid;

#[derive(Clone)]
pub enum EngineConnection {
    Postgres(postgres::PgConn),
}

impl EngineConnection {
    pub fn engine_name(&self) -> &'static str {
        match self {
            Self::Postgres(_) => "postgres",
        }
    }

    pub fn id(&self) -> Uuid {
        match self {
            Self::Postgres(c) => c.id,
        }
    }
}
