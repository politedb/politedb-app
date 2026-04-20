use futures_util::TryStreamExt;
use mongodb::bson::{self, Bson, Document};
use mongodb::options::FindOptions;
use serde::Deserialize;
use serde_json::Value as JsonValue;
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

#[derive(serde::Serialize)]
pub struct MongoIndexInfo {
    pub index_name: String,
    pub index_algorithm: String,
    pub is_unique: bool,
    pub is_primary: bool,
    pub column_name: String,
    pub index_definition: String,
}

#[derive(serde::Serialize)]
pub struct MongoCollectionSizeInfo {
    pub total_size_bytes: u64,
    pub data_size_bytes: u64,
    pub index_size_bytes: u64,
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
        Bson::Binary(v) => CellValue::Json(
            serde_json::json!({
                "$binary": {
                    "subType": format!("{:02x}", u8::from(v.subtype)),
                    "base64": base64::engine::general_purpose::STANDARD.encode(&v.bytes),
                }
            })
            .to_string(),
        ),
        Bson::ObjectId(v) => CellValue::Str(v.to_hex()),
        Bson::DateTime(v) => CellValue::Str(v.to_string()),
        other => CellValue::Json(bson::to_bson(other).unwrap_or(Bson::Null).to_string()),
    }
}

fn derive_columns(docs: &[Document]) -> Vec<ColumnMeta> {
    use std::collections::BTreeMap;

    let mut type_by_key: BTreeMap<String, String> = BTreeMap::new();

    for doc in docs {
        for (key, value) in doc.iter() {
            type_by_key
                .entry(key.to_string())
                .or_insert_with(|| bson_type_name(value).to_string());
        }
    }

    let mut columns = Vec::new();
    let id_type = type_by_key
        .remove("_id")
        .unwrap_or_else(|| "object_id".to_string());
    columns.push(ColumnMeta {
        name: "_id".into(),
        db_type: id_type,
    });

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

fn mongo_index_algorithm(keys: &Document) -> String {
    let mut kinds: Vec<String> = Vec::new();

    for (_k, v) in keys.iter() {
        let kind = match v {
            Bson::Int32(1) | Bson::Int64(1) | Bson::Double(1.0) => "BTREE_ASC",
            Bson::Int32(-1) | Bson::Int64(-1) | Bson::Double(-1.0) => "BTREE_DESC",
            Bson::String(s) => match s.as_str() {
                "text" => "TEXT",
                "hashed" => "HASHED",
                "2dsphere" => "2DSPHERE",
                "2d" => "2D",
                "geoHaystack" => "GEO_HAYSTACK",
                _ => "CUSTOM",
            },
            _ => "CUSTOM",
        };
        kinds.push(kind.to_string());
    }

    if kinds.is_empty() {
        return "UNKNOWN".into();
    }

    kinds.sort();
    kinds.dedup();
    if kinds.len() == 1 {
        kinds[0].clone()
    } else {
        "COMPOUND".into()
    }
}

fn json_to_mongo_doc(value: JsonValue) -> Result<Document, String> {
    let obj = value
        .as_object()
        .ok_or("MONGO_INSERT_DOCUMENT_MUST_BE_OBJECT")?;

    let mut out = Document::new();
    for (k, v) in obj.iter() {
        if k == "__rowKey" {
            continue;
        }

        if k == "_id" {
            if v.is_null() {
                continue;
            }
            if let Some(s) = v.as_str() {
                let t = s.trim();
                if t.is_empty() {
                    continue;
                }
                if let Ok(oid) = mongodb::bson::oid::ObjectId::parse_str(t) {
                    out.insert("_id", Bson::ObjectId(oid));
                } else {
                    out.insert("_id", Bson::String(t.to_string()));
                }
                continue;
            }
        }

        let bson_v =
            bson::to_bson(v).map_err(|e| format!("MONGO_INSERT_INVALID_VALUE({k}): {e}"))?;
        out.insert(k, bson_v);
    }

    Ok(out)
}

fn json_to_bson_id(value: &JsonValue) -> Result<Bson, String> {
    match value {
        JsonValue::Null => Err("MONGO_ID_REQUIRED".into()),
        JsonValue::Bool(v) => Ok(Bson::Boolean(*v)),
        JsonValue::Number(n) => {
            if let Some(v) = n.as_i64() {
                return Ok(Bson::Int64(v));
            }
            if let Some(v) = n.as_u64() {
                if v <= i64::MAX as u64 {
                    return Ok(Bson::Int64(v as i64));
                }
                return Ok(Bson::Double(v as f64));
            }
            if let Some(v) = n.as_f64() {
                return Ok(Bson::Double(v));
            }
            Err("MONGO_ID_INVALID_NUMBER".into())
        }
        JsonValue::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                return Err("MONGO_ID_REQUIRED".into());
            }
            if let Ok(oid) = mongodb::bson::oid::ObjectId::parse_str(t) {
                Ok(Bson::ObjectId(oid))
            } else {
                Ok(Bson::String(t.to_string()))
            }
        }
        other => bson::to_bson(other).map_err(|e| format!("MONGO_ID_INVALID: {e}")),
    }
}

#[derive(Debug, Deserialize)]
pub struct MongoUpdateDocumentInput {
    pub id: JsonValue,
    pub set: JsonValue,
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
    coll.find(mongodb::bson::doc! {})
        .with_options(options)
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
        .list_database_names()
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
        .list_collection_names()
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
        .estimated_document_count()
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
        .estimated_document_count()
        .await
        .map_err(|e| format!("MONGO_COUNT_FAILED: {e}"))?;

    Ok(MongoQueryResult {
        columns,
        rows,
        row_count,
    })
}

#[tauri::command]
pub async fn mongo_list_indexes(
    state: State<'_, AppState>,
    connection_id: Uuid,
    database: Option<String>,
    collection: String,
) -> Result<Vec<MongoIndexInfo>, String> {
    let conn = mongo_conn(&state, connection_id)?;
    let (client, default_database) = as_mongo_client(&conn)?;
    let database = normalize_database_arg(database, default_database)?;

    let coll = client
        .database(&database)
        .collection::<Document>(&collection);
    let indexes = coll
        .list_indexes()
        .await
        .map_err(|e| format!("MONGO_LIST_INDEXES_FAILED: {e}"))?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|e| format!("MONGO_LIST_INDEXES_FAILED: {e}"))?;

    let out = indexes
        .into_iter()
        .map(|idx| {
            let keys = idx.keys.clone();
            let key_names: Vec<String> = keys.iter().map(|(k, _)| k.clone()).collect();
            let column_name = key_names.join(", ");

            let index_name = idx
                .options
                .as_ref()
                .and_then(|o| o.name.clone())
                .unwrap_or_else(|| {
                    if key_names.is_empty() {
                        "unnamed_index".into()
                    } else {
                        key_names.join("_")
                    }
                });

            let is_unique = idx.options.as_ref().and_then(|o| o.unique).unwrap_or(false);
            let is_primary = index_name == "_id_" || key_names.iter().any(|k| k == "_id");
            let index_algorithm = mongo_index_algorithm(&keys);
            let index_definition = keys.to_string();

            MongoIndexInfo {
                index_name,
                index_algorithm,
                is_unique,
                is_primary,
                column_name,
                index_definition,
            }
        })
        .collect::<Vec<_>>();

    Ok(out)
}

#[tauri::command]
pub async fn mongo_collection_size_info(
    state: State<'_, AppState>,
    connection_id: Uuid,
    database: Option<String>,
    collection: String,
) -> Result<MongoCollectionSizeInfo, String> {
    let conn = mongo_conn(&state, connection_id)?;
    let (client, default_database) = as_mongo_client(&conn)?;
    let database = normalize_database_arg(database, default_database)?;

    let stats = client
        .database(&database)
        .run_command(mongodb::bson::doc! { "collStats": &collection, "scale": 1 })
        .await
        .map_err(|e| format!("MONGO_COLLECTION_STATS_FAILED: {e}"))?;

    let read_u64 = |key: &str| -> u64 {
        match stats.get(key) {
            Some(Bson::Int32(v)) => (*v).max(0) as u64,
            Some(Bson::Int64(v)) => (*v).max(0) as u64,
            Some(Bson::Double(v)) => (*v).max(0.0) as u64,
            _ => 0,
        }
    };

    let storage_size = read_u64("storageSize");
    let data_size = read_u64("size");
    let index_size = read_u64("totalIndexSize");

    Ok(MongoCollectionSizeInfo {
        total_size_bytes: storage_size.saturating_add(index_size),
        data_size_bytes: data_size,
        index_size_bytes: index_size,
    })
}

#[tauri::command]
pub async fn mongo_insert_documents(
    state: State<'_, AppState>,
    connection_id: Uuid,
    database: Option<String>,
    collection: String,
    documents: Vec<JsonValue>,
) -> Result<u64, String> {
    let conn = mongo_conn(&state, connection_id)?;
    let (client, default_database) = as_mongo_client(&conn)?;
    let database = normalize_database_arg(database, default_database)?;

    if documents.is_empty() {
        return Ok(0);
    }

    let docs: Vec<Document> = documents
        .into_iter()
        .map(json_to_mongo_doc)
        .collect::<Result<Vec<_>, _>>()?;

    let result = client
        .database(&database)
        .collection::<Document>(&collection)
        .insert_many(docs)
        .await
        .map_err(|e| format!("MONGO_INSERT_FAILED: {e}"))?;

    Ok(result.inserted_ids.len() as u64)
}

#[tauri::command]
pub async fn mongo_update_documents(
    state: State<'_, AppState>,
    connection_id: Uuid,
    database: Option<String>,
    collection: String,
    updates: Vec<MongoUpdateDocumentInput>,
) -> Result<u64, String> {
    let conn = mongo_conn(&state, connection_id)?;
    let (client, default_database) = as_mongo_client(&conn)?;
    let database = normalize_database_arg(database, default_database)?;

    if updates.is_empty() {
        return Ok(0);
    }

    let coll = client
        .database(&database)
        .collection::<Document>(&collection);
    let mut modified_total: u64 = 0;

    for (idx, item) in updates.into_iter().enumerate() {
        let id = json_to_bson_id(&item.id)?;
        let set_obj = item
            .set
            .as_object()
            .ok_or_else(|| format!("MONGO_UPDATE_SET_MUST_BE_OBJECT_AT_INDEX_{idx}"))?;

        let mut set_doc = Document::new();
        for (k, v) in set_obj.iter() {
            if k == "_id" || k == "__rowKey" {
                continue;
            }
            let bson_v = bson::to_bson(v)
                .map_err(|e| format!("MONGO_UPDATE_INVALID_VALUE({k})_AT_INDEX_{idx}: {e}"))?;
            set_doc.insert(k, bson_v);
        }

        if set_doc.is_empty() {
            continue;
        }

        let result = coll
            .update_one(
                mongodb::bson::doc! { "_id": id },
                mongodb::bson::doc! { "$set": set_doc },
            )
            .await
            .map_err(|e| format!("MONGO_UPDATE_FAILED_AT_INDEX_{idx}: {e}"))?;

        modified_total += result.modified_count;
    }

    Ok(modified_total)
}

#[tauri::command]
pub async fn mongo_delete_documents(
    state: State<'_, AppState>,
    connection_id: Uuid,
    database: Option<String>,
    collection: String,
    ids: Vec<JsonValue>,
) -> Result<u64, String> {
    let conn = mongo_conn(&state, connection_id)?;
    let (client, default_database) = as_mongo_client(&conn)?;
    let database = normalize_database_arg(database, default_database)?;

    if ids.is_empty() {
        return Ok(0);
    }

    let bson_ids: Vec<Bson> = ids
        .iter()
        .map(json_to_bson_id)
        .collect::<Result<Vec<_>, _>>()?;

    let result = client
        .database(&database)
        .collection::<Document>(&collection)
        .delete_many(mongodb::bson::doc! { "_id": { "$in": bson_ids } })
        .await
        .map_err(|e| format!("MONGO_DELETE_FAILED: {e}"))?;

    Ok(result.deleted_count)
}
