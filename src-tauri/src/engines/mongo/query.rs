use mongodb::bson::oid::ObjectId;
use mongodb::bson::{Bson, Document};
use serde_json::Value as JsonValue;

pub fn json_to_document(value: Option<&JsonValue>) -> Result<Document, String> {
    let Some(value) = value else {
        return Ok(Document::new());
    };
    if value.is_null() {
        return Ok(Document::new());
    }
    if !value.is_object() {
        return Err("MONGO_FILTER_MUST_BE_OBJECT".into());
    }
    let bson = mongodb::bson::to_bson(value).map_err(|e| format!("MONGO_FILTER_INVALID: {e}"))?;
    match rewrite_bson(bson) {
        Bson::Document(doc) => Ok(doc),
        Bson::Null => Ok(Document::new()),
        _ => Err("MONGO_FILTER_MUST_BE_OBJECT".into()),
    }
}

pub fn json_to_sort_document(value: Option<&JsonValue>) -> Result<Option<Document>, String> {
    let doc = json_to_document(value)?;
    if doc.is_empty() {
        return Ok(None);
    }
    Ok(Some(doc))
}

fn rewrite_bson(value: Bson) -> Bson {
    match value {
        Bson::Document(doc) => rewrite_document(doc),
        Bson::Array(items) => Bson::Array(items.into_iter().map(rewrite_bson).collect()),
        other => other,
    }
}

fn rewrite_document(doc: Document) -> Bson {
    if doc.len() == 1 {
        if let Some(Bson::String(oid)) = doc.get("$oid") {
            if let Ok(id) = ObjectId::parse_str(oid) {
                return Bson::ObjectId(id);
            }
        }
    }

    let mut out = Document::new();
    for (key, value) in doc {
        out.insert(key, rewrite_bson(value));
    }
    Bson::Document(out)
}

#[cfg(test)]
mod tests {
    use super::{json_to_document, json_to_sort_document};
    use mongodb::bson::Bson;
    use serde_json::json;

    #[test]
    fn empty_and_null_become_empty_document() {
        assert!(json_to_document(None).unwrap().is_empty());
        assert!(json_to_document(Some(&json!(null))).unwrap().is_empty());
        assert!(json_to_document(Some(&json!({}))).unwrap().is_empty());
    }

    #[test]
    fn rewrites_extended_json_object_id() {
        let doc = json_to_document(Some(&json!({
            "_id": { "$oid": "507f1f77bcf86cd799439011" }
        })))
        .unwrap();
        match doc.get("_id") {
            Some(Bson::ObjectId(id)) => {
                assert_eq!(id.to_hex(), "507f1f77bcf86cd799439011");
            }
            other => panic!("expected ObjectId, got {other:?}"),
        }
    }

    #[test]
    fn rewrites_oid_inside_in_list() {
        let doc = json_to_document(Some(&json!({
            "_id": { "$in": [{ "$oid": "507f1f77bcf86cd799439011" }, "507f1f77bcf86cd799439011"] }
        })))
        .unwrap();
        let inner = doc.get("_id").unwrap().as_document().unwrap();
        let values = inner.get("$in").unwrap().as_array().unwrap();
        assert!(matches!(values[0], Bson::ObjectId(_)));
        assert!(matches!(values[1], Bson::String(_)));
    }

    #[test]
    fn sort_document_maps_direction() {
        let sort = json_to_sort_document(Some(&json!({ "createdAt": -1 })))
            .unwrap()
            .unwrap();
        let n = sort.get("createdAt").and_then(Bson::as_i64).or_else(|| {
            sort.get("createdAt")
                .and_then(Bson::as_i32)
                .map(|v| v as i64)
        });
        assert_eq!(n, Some(-1));
    }
}
