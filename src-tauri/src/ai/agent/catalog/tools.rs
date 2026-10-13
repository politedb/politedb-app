//! The metadata tools offered to the model (plan ai-agent R3): `list_schemas`,
//! `list_tables`, `describe_table`. Arguments are validated strictly (types, lengths,
//! no extra fields) before anything reaches an executor.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::{cap, CatalogExecutor, MAX_SCHEMAS, MAX_TABLES};
use crate::ai::agent::protocol::ToolSpec;
use crate::ai::agent::run::{AgentTool, ToolContext, ToolOutput, ToolRegistry};

/// Longest accepted identifier or search text.
pub const MAX_ARG_CHARS: usize = 128;

/// Whether the runtime connection still exists; checked before every call.
pub type Alive = Arc<dyn Fn() -> bool + Send + Sync>;

/// What the tools may send besides names and types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MetadataPolicy {
    /// Column comments and default expressions (free text that can hold sensitive
    /// values). Excluded before the result is encoded, so it never reaches the model.
    pub column_details: bool,
}

pub fn registry(
    executor: Arc<dyn CatalogExecutor>,
    alive: Alive,
    policy: MetadataPolicy,
) -> ToolRegistry {
    ToolRegistry::new(vec![
        Arc::new(ListSchemas {
            executor: executor.clone(),
            alive: alive.clone(),
        }),
        Arc::new(ListTables {
            executor: executor.clone(),
            alive: alive.clone(),
        }),
        Arc::new(DescribeTable {
            executor,
            alive,
            policy,
        }),
    ])
}

fn json_output(value: Value, truncated: bool) -> ToolOutput {
    ToolOutput {
        content: value.to_string(),
        truncated,
    }
}

fn string_param(description: &str) -> Value {
    json!({ "type": "string", "description": description, "maxLength": MAX_ARG_CHARS })
}

/// Validates `arguments` against a flat object of optional/required strings.
fn parse_args<'a>(
    arguments: &Value,
    fields: &[(&'a str, bool)],
) -> Result<HashMap<&'a str, String>, String> {
    let object = arguments
        .as_object()
        .ok_or_else(|| "arguments must be an object".to_string())?;
    if let Some(unknown) = object
        .keys()
        .find(|key| !fields.iter().any(|(name, _)| name == key))
    {
        // The unknown name comes from the model; keep it out of the message.
        let _ = unknown;
        return Err("unexpected argument".into());
    }
    let mut out = HashMap::new();
    for (name, required) in fields {
        match object.get(*name) {
            None | Some(Value::Null) if !required => {}
            None | Some(Value::Null) => return Err(format!("missing argument: {name}")),
            Some(Value::String(text)) => {
                let text = text.trim();
                let chars = text.chars().count();
                if chars == 0 && *required {
                    return Err(format!("empty argument: {name}"));
                }
                if chars > MAX_ARG_CHARS || text.chars().any(char::is_control) {
                    return Err(format!("invalid argument: {name}"));
                }
                if chars > 0 {
                    out.insert(*name, text.to_string());
                }
            }
            Some(_) => return Err(format!("argument must be a string: {name}")),
        }
    }
    Ok(out)
}

fn ensure_alive(alive: &Alive) -> Result<(), String> {
    if alive() {
        Ok(())
    } else {
        Err("the database connection was closed".into())
    }
}

struct ListSchemas {
    executor: Arc<dyn CatalogExecutor>,
    alive: Alive,
}

#[async_trait]
impl AgentTool for ListSchemas {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "list_schemas".into(),
            description: format!(
                "List the schemas (namespaces) in the connected {} database.",
                self.executor.dialect()
            ),
            parameters: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        }
    }

    async fn run(&self, arguments: Value, ctx: &ToolContext) -> Result<ToolOutput, String> {
        parse_args(&arguments, &[])?;
        ensure_alive(&self.alive)?;
        let (schemas, truncated) = cap(self.executor.list_schemas(ctx).await?, MAX_SCHEMAS);
        Ok(json_output(
            json!({ "schemas": schemas, "truncated": truncated }),
            truncated,
        ))
    }
}

struct ListTables {
    executor: Arc<dyn CatalogExecutor>,
    alive: Alive,
}

#[async_trait]
impl AgentTool for ListTables {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "list_tables".into(),
            description: "List tables and views, optionally in one schema and/or whose name \
                contains a text (case-insensitive)."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "schema": string_param("Only this schema"),
                    "name_contains": string_param("Only names containing this text"),
                },
                "additionalProperties": false
            }),
        }
    }

    async fn run(&self, arguments: Value, ctx: &ToolContext) -> Result<ToolOutput, String> {
        let args = parse_args(&arguments, &[("schema", false), ("name_contains", false)])?;
        ensure_alive(&self.alive)?;
        let tables = self
            .executor
            .list_tables(
                args.get("schema").map(String::as_str),
                args.get("name_contains").map(String::as_str),
                ctx,
            )
            .await?;
        let (tables, truncated) = cap(tables, MAX_TABLES);
        Ok(json_output(
            json!({ "tables": tables, "truncated": truncated }),
            truncated,
        ))
    }
}

struct DescribeTable {
    executor: Arc<dyn CatalogExecutor>,
    alive: Alive,
    policy: MetadataPolicy,
}

#[async_trait]
impl AgentTool for DescribeTable {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "describe_table".into(),
            description: "Columns (type, nullable, default, primary key, comment), foreign \
                keys and indexes of one table or view."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "schema": string_param("Schema of the table (from list_tables)"),
                    "table": string_param("Table or view name (from list_tables)"),
                },
                "required": ["schema", "table"],
                "additionalProperties": false
            }),
        }
    }

    async fn run(&self, arguments: Value, ctx: &ToolContext) -> Result<ToolOutput, String> {
        let args = parse_args(&arguments, &[("schema", true), ("table", true)])?;
        ensure_alive(&self.alive)?;
        let mut description = self
            .executor
            .describe_table(&args["schema"], &args["table"], ctx)
            .await?;
        if !self.policy.column_details {
            for column in &mut description.columns {
                column.default = None;
                column.comment = None;
            }
        }
        let content = serde_json::to_string(&description)
            .map_err(|_| "could not encode the result".to_string())?;
        Ok(ToolOutput {
            content,
            truncated: description.truncated,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::agent::catalog::{Column, TableDescription, TableRef};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use tokio_util::sync::CancellationToken;
    use tokio_util::task::TaskTracker;

    #[derive(Default)]
    struct FakeCatalog {
        calls: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl CatalogExecutor for FakeCatalog {
        fn dialect(&self) -> &'static str {
            "PostgreSQL"
        }
        fn sql_engine(&self) -> &'static str {
            "postgres"
        }
        async fn only_builtin_code(&self, _: &ToolContext) -> Result<bool, String> {
            Ok(false)
        }
        async fn list_schemas(&self, _ctx: &ToolContext) -> Result<Vec<String>, String> {
            self.calls.lock().unwrap().push("schemas".into());
            Ok((0..MAX_SCHEMAS + 3).map(|i| format!("s{i}")).collect())
        }
        async fn list_tables(
            &self,
            schema: Option<&str>,
            contains: Option<&str>,
            _ctx: &ToolContext,
        ) -> Result<Vec<TableRef>, String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("tables {schema:?} {contains:?}"));
            Ok(vec![TableRef {
                schema: "public".into(),
                name: "orders".into(),
                kind: "table".into(),
            }])
        }
        async fn describe_table(
            &self,
            schema: &str,
            table: &str,
            _ctx: &ToolContext,
        ) -> Result<TableDescription, String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("describe {schema} {table}"));
            Ok(TableDescription {
                schema: schema.into(),
                name: table.into(),
                columns: vec![Column {
                    name: "id".into(),
                    data_type: "integer".into(),
                    nullable: false,
                    default: Some("'SENTINEL_DEFAULT'".into()),
                    primary_key: true,
                    comment: Some("SENTINEL_COMMENT".into()),
                }],
                foreign_keys: vec![],
                indexes: vec![],
                truncated: table == "wide",
            })
        }
    }

    fn ctx() -> ToolContext {
        ToolContext {
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
        }
    }

    const DETAILS: MetadataPolicy = MetadataPolicy {
        column_details: true,
    };

    fn tools_with(alive: bool, policy: MetadataPolicy) -> (Arc<FakeCatalog>, ToolRegistry) {
        let catalog = Arc::new(FakeCatalog::default());
        let flag = Arc::new(AtomicBool::new(alive));
        let registry = registry(
            catalog.clone(),
            Arc::new(move || flag.load(Ordering::SeqCst)),
            policy,
        );
        (catalog, registry)
    }

    fn tools(alive: bool) -> (Arc<FakeCatalog>, ToolRegistry) {
        tools_with(alive, DETAILS)
    }

    async fn output(
        registry: &ToolRegistry,
        name: &str,
        args: Value,
    ) -> Result<ToolOutput, String> {
        registry.find(name).unwrap().run(args, &ctx()).await
    }

    async fn call(registry: &ToolRegistry, name: &str, args: Value) -> Result<String, String> {
        output(registry, name, args).await.map(|out| out.content)
    }

    #[tokio::test]
    async fn tools_call_the_executor_with_validated_arguments() {
        let (catalog, registry) = tools(true);
        let out = call(&registry, "list_schemas", json!({})).await.unwrap();
        let value: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value["schemas"].as_array().unwrap().len(), MAX_SCHEMAS);
        assert_eq!(value["truncated"], true);

        call(
            &registry,
            "list_tables",
            json!({ "schema": " public ", "name_contains": "ord" }),
        )
        .await
        .unwrap();
        call(&registry, "list_tables", json!({ "schema": null }))
            .await
            .unwrap();
        let out = call(
            &registry,
            "describe_table",
            json!({ "schema": "public", "table": "orders" }),
        )
        .await
        .unwrap();
        assert!(out.contains("\"primary_key\":true"));
        assert_eq!(
            *catalog.calls.lock().unwrap(),
            vec![
                "schemas".to_string(),
                "tables Some(\"public\") Some(\"ord\")".into(),
                "tables None None".into(),
                "describe public orders".into(),
            ]
        );
    }

    #[tokio::test]
    async fn bad_arguments_never_reach_the_executor() {
        let (catalog, registry) = tools(true);
        for (tool, args) in [
            ("list_schemas", json!({ "x": 1 })),
            ("list_tables", json!({ "schema": 5 })),
            (
                "list_tables",
                json!({ "schema": "a".repeat(MAX_ARG_CHARS + 1) }),
            ),
            ("list_tables", json!({ "name_contains": "a\nb" })),
            ("list_tables", json!({ "drop": "x" })),
            ("describe_table", json!({ "schema": "public" })),
            (
                "describe_table",
                json!({ "schema": "public", "table": "  " }),
            ),
            (
                "describe_table",
                json!({ "schema": "public", "table": ["x"] }),
            ),
        ] {
            assert!(
                call(&registry, tool, args.clone()).await.is_err(),
                "{tool} {args}"
            );
        }
        assert!(catalog.calls.lock().unwrap().is_empty());
        // Unknown argument names are not echoed back.
        let err = call(&registry, "list_tables", json!({ "secret_name": "x" }))
            .await
            .unwrap_err();
        assert!(!err.contains("secret_name"));
    }

    #[tokio::test]
    async fn a_closed_connection_stops_every_tool() {
        let (catalog, registry) = tools(false);
        let err = call(&registry, "list_schemas", json!({}))
            .await
            .unwrap_err();
        assert!(err.contains("closed"));
        assert!(catalog.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn specs_are_strict_objects() {
        let (_, registry) = tools(true);
        for spec in registry.specs() {
            assert_eq!(spec.parameters["type"], "object");
            assert_eq!(spec.parameters["additionalProperties"], false);
        }
    }

    #[tokio::test]
    async fn list_caps_are_reported_as_truncated_steps() {
        let (_, registry) = tools(true);
        let schemas = output(&registry, "list_schemas", json!({})).await.unwrap();
        assert!(schemas.truncated);
        let tables = output(&registry, "list_tables", json!({})).await.unwrap();
        assert!(!tables.truncated);
        let wide = output(
            &registry,
            "describe_table",
            json!({ "schema": "public", "table": "wide" }),
        )
        .await
        .unwrap();
        assert!(wide.truncated);
    }

    #[tokio::test]
    async fn column_details_can_be_kept_out_of_results() {
        let args = json!({ "schema": "public", "table": "orders" });
        let (_, with) = tools_with(true, DETAILS);
        let out = call(&with, "describe_table", args.clone()).await.unwrap();
        assert!(out.contains("SENTINEL_COMMENT") && out.contains("SENTINEL_DEFAULT"));

        let (_, without) = tools_with(
            true,
            MetadataPolicy {
                column_details: false,
            },
        );
        let out = call(&without, "describe_table", args).await.unwrap();
        assert!(!out.contains("SENTINEL"), "{out}");
        assert!(out.contains("\"primary_key\":true"));
    }
}
