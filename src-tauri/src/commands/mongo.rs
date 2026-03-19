use futures_util::TryStreamExt;
use mongodb::bson::{self, Bson, Document};
use mongodb::options::FindOptions;
use tauri::State;
use uuid::Uuid;

use crate::engines::EngineConnection;
use crate::state::AppState;
use crate::types::{CellValue, ColumnMeta};
use base64::Engine;

#[derive(serde::Serialize)]
pub struct MongoCollectionOverview {
    pub columns: Vec<ColumnMeta>,
    pub row_count: u64,
}

#[derive(serde::Serialize)]
pub struct MongoQueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<CellValue>>,
    pub row_count: u64,
}

fn mongo_conn<'a>(
    state: &'a AppState,
    connection_id: Uuid,
) -> Result<dashmap::mapref::one::Ref<'a, Uuid, EngineConnection>, String> {
    let conn = state
        .connections
        .get(&connection_id)
        .ok_or("CONNECTION_NOT_FOUND")?;

    match conn.value() {
        EngineConnection::Mongo(_) => Ok(conn),
        _ => Err("ENGINE_NOT_SUPPORTED".into()),
    }
}

fn as_mongo_client(
    conn: &dashmap::mapref::one::Ref<'_, Uuid, EngineConnection>,
) -> Result<(mongodb::Client, Option<String>), String> {
    match conn.value() {
        EngineConnection::Mongo(mongo) => {
            Ok((mongo.client.clone(), mongo.default_database.clone()))
        }
        _ => Err("ENGINE_NOT_SUPPORTED".into()),
    }
}

fn normalize_database_arg(
    database: Option<String>,
    default_database: Option<String>,
) -> Result<String, String> {
    database
        .or(default_database)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or("MONGO_DATABASE_REQUIRED".into())
}

fn bson_type_name(value: &Bson) -> &'static str {
    match value {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Array(_) => "array",
        Bson::Document(_) => "document",
        Bson::Boolean(_) => "bool",
        Bson::Null => "null",
        Bson::Int32(_) => "int32",
        Bson::Int64(_) => "int64",
        Bson::ObjectId(_) => "object_id",
        Bson::DateTime(_) => "datetime",
        Bson::Binary(_) => "binary",
        Bson::RegularExpression(_) => "regex",
        Bson::Decimal128(_) => "decimal128",
        Bson::Timestamp(_) => "timestamp",
        _ => "json",
    }
}

fn bson_to_cell(value: &Bson) -> CellValue {
    match value {
        Bson::Null => CellValue::Null,
        Bson::Boolean(v) => CellValue::Bool(*v),
        Bson::Int32(v) => CellValue::I64(*v as i64),
        Bson::Int64(v) => CellValue::I64(*v),
        Bson::Double(v) => CellValue::F64(*v),
        Bson::String(v) => CellValue::Str(v.clone()),
        Bson::Binary(v) => {
            CellValue::BytesB64(base64::engine::general_purpose::STANDARD.encode(&v.bytes))
        }
        Bson::ObjectId(v) => CellValue::Str(v.to_hex()),
        Bson::DateTime(v) => CellValue::Str(v.to_string()),
        other => CellValue::Json(bson::to_bson(other).unwrap_or(Bson::Null).to_string()),
    }
}

fn derive_columns(docs: &[Document]) -> Vec<ColumnMeta> {
    use std::collections::BTreeMap;

    let mut type_by_key: BTreeMap<String, String> = BTreeMap::new();
    let mut has_id = false;

    for doc in docs {
        for (key, value) in doc.iter() {
            if key == "_id" {
                has_id = true;
            }
            type_by_key
                .entry(key.to_string())
                .or_insert_with(|| bson_type_name(value).to_string());
        }
    }

    let mut columns = Vec::new();
    if has_id {
        let db_type = type_by_key
            .remove("_id")
            .unwrap_or_else(|| "object_id".to_string());
        columns.push(ColumnMeta {
            name: "_id".into(),
            db_type,
        });
    }

    columns.extend(
        type_by_key
            .into_iter()
            .map(|(name, db_type)| ColumnMeta { name, db_type }),
    );
    columns
}

fn docs_to_rows(docs: &[Document], columns: &[ColumnMeta]) -> Vec<Vec<CellValue>> {
    docs.iter()
        .map(|doc| {
            columns
                .iter()
                .map(|col| {
                    doc.get(&col.name)
                        .map(bson_to_cell)
                        .unwrap_or(CellValue::Null)
                })
                .collect()
        })
        .collect()
}

async fn sample_documents(
    client: &mongodb::Client,
    database: &str,
    collection: &str,
    limit: i64,
    skip: u64,
) -> Result<Vec<Document>, String> {
    let coll = client.database(database).collection::<Document>(collection);
    let options = FindOptions::builder().limit(limit).skip(skip).build();
    coll.find(None, options)
        .await
        .map_err(|e| format!("MONGO_QUERY_FAILED: {e}"))?
        .try_collect::<Vec<Document>>()
        .await
        .map_err(|e| format!("MONGO_QUERY_FAILED: {e}"))
}

#[tauri::command]
pub async fn mongo_list_databases(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> Result<Vec<String>, String> {
    let conn = mongo_conn(&state, connection_id)?;
    let (client, default_database) = as_mongo_client(&conn)?;

    let mut names: Vec<String> = client
        .list_database_names(None, None)
        .await
        .map_err(|e| format!("MONGO_LIST_DATABASES_FAILED: {e}"))?;

    if let Some(db) = default_database
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        if let Some(idx) = names.iter().position(|name| name == &db) {
            if idx > 0 {
                names.remove(idx);
                names.insert(0, db);
            }
        }
    }

    Ok(names)
}

#[tauri::command]
pub async fn mongo_list_collections(
    state: State<'_, AppState>,
    connection_id: Uuid,
    database: Option<String>,
) -> Result<Vec<String>, String> {
    let conn = mongo_conn(&state, connection_id)?;
    let (client, default_database) = as_mongo_client(&conn)?;
    let database = normalize_database_arg(database, default_database)?;

    client
        .database(&database)
        .list_collection_names(None)
        .await
        .map_err(|e| format!("MONGO_LIST_COLLECTIONS_FAILED: {e}"))
}

#[tauri::command]
pub async fn mongo_collection_overview(
    state: State<'_, AppState>,
    connection_id: Uuid,
    database: Option<String>,
    collection: String,
    sample_size: Option<u32>,
) -> Result<MongoCollectionOverview, String> {
    let conn = mongo_conn(&state, connection_id)?;
    let (client, default_database) = as_mongo_client(&conn)?;
    let database = normalize_database_arg(database, default_database)?;
    let sample_size = sample_size.unwrap_or(100).clamp(1, 500) as i64;

    let docs = sample_documents(&client, &database, &collection, sample_size, 0).await?;
    let columns = derive_columns(&docs);
    let row_count = client
        .database(&database)
        .collection::<Document>(&collection)
        .estimated_document_count(None)
        .await
        .map_err(|e| format!("MONGO_COUNT_FAILED: {e}"))?;

    Ok(MongoCollectionOverview { columns, row_count })
}

#[tauri::command]
pub async fn mongo_find_documents(
    state: State<'_, AppState>,
    connection_id: Uuid,
    database: Option<String>,
    collection: String,
    limit: Option<u32>,
    offset: Option<u64>,
) -> Result<MongoQueryResult, String> {
    let conn = mongo_conn(&state, connection_id)?;
    let (client, default_database) = as_mongo_client(&conn)?;
    let database = normalize_database_arg(database, default_database)?;
    let limit = limit.unwrap_or(300).clamp(1, 5_000) as i64;
    let offset = offset.unwrap_or(0);

    let docs = sample_documents(&client, &database, &collection, limit, offset).await?;
    let columns = derive_columns(&docs);
    let rows = docs_to_rows(&docs, &columns);
    let row_count = client
        .database(&database)
        .collection::<Document>(&collection)
        .estimated_document_count(None)
        .await
        .map_err(|e| format!("MONGO_COUNT_FAILED: {e}"))?;

    Ok(MongoQueryResult {
        columns,
        rows,
        row_count,
    })
}
