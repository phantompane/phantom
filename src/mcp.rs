use std::borrow::Cow;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::tool_handler;
use rmcp::{tool, tool_router, Json, ServerHandler, ServiceExt};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::context;
use crate::error::Error;
use crate::git;
use crate::github;
use crate::preferences;
use crate::projects;
use crate::worktree::{self, Logger};

pub struct PhantomServer;

/// Optional JSON Schema string: absent is allowed, null is not part of the schema.
#[derive(Debug, Default, Deserialize)]
#[serde(transparent)]
struct OptionalString(#[serde(deserialize_with = "present_string")] Option<String>);

impl OptionalString {
    fn as_deref(&self) -> Option<&str> {
        self.0.as_deref()
    }
}

impl JsonSchema for OptionalString {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        Cow::Borrowed("string")
    }

    fn schema_id() -> Cow<'static, str> {
        Cow::Borrowed("phantom::OptionalString")
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        String::json_schema(generator)
    }

    fn _schemars_private_is_option() -> bool {
        true
    }
}

/// Optional JSON Schema boolean: absent is allowed, null is not part of the schema.
#[derive(Debug, Default, Deserialize)]
#[serde(transparent)]
struct OptionalBool(#[serde(deserialize_with = "present_bool")] Option<bool>);

impl OptionalBool {
    fn value(&self) -> Option<bool> {
        self.0
    }
}

impl JsonSchema for OptionalBool {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        Cow::Borrowed("boolean")
    }

    fn schema_id() -> Cow<'static, str> {
        Cow::Borrowed("phantom::OptionalBool")
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        bool::json_schema(generator)
    }

    fn _schemars_private_is_option() -> bool {
        true
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CreateArgs {
    /// Name for the worktree (also used as the branch name)
    name: String,
    /// Base branch to create from (optional)
    #[serde(default, rename = "baseBranch")]
    base_branch: OptionalString,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct DeleteArgs {
    /// Name of the worktree to delete
    name: String,
    /// Force deletion even if there are uncommitted changes
    #[serde(default)]
    force: OptionalBool,
    /// Keep the branch after deleting the worktree
    #[serde(default, rename = "keepBranch")]
    keep_branch: OptionalBool,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CheckoutArgs {
    /// Issue or pull request number to checkout
    number: String,
    /// Base branch for issues (not applicable for pull requests)
    #[serde(default)]
    base: OptionalString,
}

fn present_string<'de, D>(deserializer: D) -> std::result::Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

fn present_bool<'de, D>(deserializer: D) -> std::result::Result<Option<bool>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    bool::deserialize(deserializer).map(Some)
}

fn schema_version(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "const": 1 })
}

fn catalog_version(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "const": 2 })
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(tag = "source", rename_all = "camelCase")]
enum ListedProject {
    #[serde(rename = "registry")]
    Registry {
        id: String,
        name: String,
        /// Canonical absolute Git repository path
        #[serde(rename = "rootPath")]
        root_path: String,
        /// ISO 8601 registration timestamp
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "ghq")]
    Ghq {
        name: String,
        /// Canonical absolute Git repository path
        #[serde(rename = "rootPath")]
        root_path: String,
    },
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ListProjectsOutput {
    #[schemars(schema_with = "schema_version")]
    schema_version: u8,
    #[schemars(schema_with = "catalog_version")]
    version: u32,
    projects: Vec<ListedProject>,
    /// Non-fatal project discovery warnings
    warnings: Vec<String>,
    note: String,
}

#[tool_router]
impl PhantomServer {
    #[tool(
        name = "phantom_create_worktree",
        description = "Create a new Git worktree (phantom)"
    )]
    fn phantom_create_worktree(
        &self,
        Parameters(args): Parameters<CreateArgs>,
    ) -> std::result::Result<String, String> {
        let git_root = git::git_root(&std::env::current_dir().map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        let context = context::create(&git_root).map_err(|error| error.to_string())?;
        let files = copy_files(&context);
        let commands = post_commands(&context);
        let created = worktree::create_worktree(
            &context,
            &args.name,
            args.base_branch.as_deref().unwrap_or("HEAD"),
            &files,
            &commands,
            &Logger::off(),
        )
        .map_err(|error| error.to_string())?;
        Ok(pretty(&json!({
            "success": true,
            "message": format!("Worktree '{}' created successfully.", args.name),
            "path": created.path,
            "note": format!("You can now switch to the worktree using 'cd {}'", created.path.display()),
        })))
    }

    #[tool(
        name = "phantom_list_worktrees",
        description = "List all Git worktrees (phantoms)"
    )]
    fn phantom_list_worktrees(&self) -> std::result::Result<String, String> {
        let git_root = git::git_root(&std::env::current_dir().map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        let worktrees =
            worktree::list_worktrees(&git_root, false, false).map_err(|error| error.to_string())?;
        let listed = worktrees
            .iter()
            .map(|worktree| {
                json!({
                    "name": worktree.name,
                    "path": worktree.path,
                    "branch": worktree.branch,
                    "isClean": worktree.is_clean,
                })
            })
            .collect::<Vec<_>>();
        Ok(pretty(&json!({
            "worktrees": listed,
            "note": "You can switch to a worktree using 'cd <path>'",
        })))
    }

    #[tool(
        name = "phantom_delete_worktree",
        description = "Delete a Git worktree (phantom)"
    )]
    fn phantom_delete_worktree(
        &self,
        Parameters(args): Parameters<DeleteArgs>,
    ) -> std::result::Result<String, String> {
        let git_root = git::git_root(&std::env::current_dir().map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        let context = context::create(&git_root).map_err(|error| error.to_string())?;
        let keep_branch = args
            .keep_branch
            .value()
            .or(context.preferences.keep_branch)
            .unwrap_or(false);
        worktree::delete_worktree(
            &context,
            &args.name,
            args.force.value().unwrap_or(false),
            keep_branch,
            None,
        )
        .map_err(|error| error.to_string())?;
        Ok(pretty(&json!({
            "success": true,
            "message": format!("Worktree '{}' deleted successfully", args.name),
        })))
    }

    #[tool(
        name = "phantom_github_checkout",
        description = "Checkout a GitHub issue or pull request by number into a new worktree"
    )]
    fn phantom_github_checkout(
        &self,
        Parameters(args): Parameters<CheckoutArgs>,
    ) -> std::result::Result<String, String> {
        let checkout = github::checkout(&args.number, args.base.as_deref())
            .map_err(|error| error.to_string())?;
        let message = if checkout.already_exists {
            format!("Worktree '{}' already exists.", checkout.worktree)
        } else {
            format!(
                "Successfully checked out #{} to worktree '{}'.",
                args.number, checkout.worktree
            )
        };
        Ok(pretty(&json!({
            "success": true,
            "message": message,
            "worktree": checkout.worktree,
            "path": checkout.path,
            "note": format!("You can now switch to the worktree using 'cd {}'", checkout.path.display()),
        })))
    }

    #[tool(
        name = "phantom_list_projects",
        description = "List registered and discovered Git projects",
        annotations(read_only_hint = true)
    )]
    fn phantom_list_projects(&self) -> std::result::Result<Json<ListProjectsOutput>, String> {
        let loaded = preferences::load_preferences().map_err(|error| error.to_string())?;
        let catalog = projects::list_catalog(loaded.ghq_discovery != Some(false))
            .map_err(|error| error.to_string())?;
        let projects = catalog
            .projects
            .into_iter()
            .map(|project| match project {
                projects::ProjectListEntry::Registry {
                    id,
                    name,
                    root_path,
                    created_at,
                } => ListedProject::Registry {
                    id,
                    name,
                    root_path,
                    created_at,
                },
                projects::ProjectListEntry::Ghq { name, root_path } => {
                    ListedProject::Ghq { name, root_path }
                }
            })
            .collect();
        Ok(Json(ListProjectsOutput {
            schema_version: 1,
            version: catalog.version,
            projects,
            warnings: catalog.warnings,
            note: "Use rootPath to identify a project.".to_string(),
        }))
    }
}

#[tool_handler(name = "Phantom MCP Server", version = "6.3.2")]
impl ServerHandler for PhantomServer {}

pub fn serve() -> crate::error::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| Error::msg(error.to_string()))?;
    runtime.block_on(async {
        let service = PhantomServer
            .serve(rmcp::transport::stdio())
            .await
            .map_err(|error| Error::msg(error.to_string()))?;
        service
            .waiting()
            .await
            .map_err(|error| Error::msg(error.to_string()))?;
        Ok(())
    })
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn copy_files(context: &context::Context) -> Vec<String> {
    context
        .config
        .as_ref()
        .and_then(|config| config.post_create.as_ref())
        .and_then(|post| post.copy_files.clone())
        .unwrap_or_default()
}

fn post_commands(context: &context::Context) -> Vec<String> {
    context
        .config
        .as_ref()
        .and_then(|config| config.post_create.as_ref())
        .and_then(|post| post.commands.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::handler::server::tool::IntoCallToolResult;

    fn property_type(schema: &Value, name: &str) -> Value {
        schema["properties"][name]["type"].clone()
    }

    #[test]
    fn optional_tool_params_are_plain_optional_types() {
        let tools = PhantomServer::tool_router().list_all();
        let create = tools
            .iter()
            .find(|tool| tool.name == "phantom_create_worktree")
            .expect("create");
        let schema = serde_json::to_value(&create.input_schema).expect("schema");
        assert_eq!(
            property_type(&schema, "baseBranch"),
            json!("string"),
            "schema {schema}"
        );
        assert!(schema["properties"]["baseBranch"].get("default").is_none());
        let required = schema["required"].as_array().expect("required");
        assert!(required.iter().any(|name| name == "name"));
        assert!(!required.iter().any(|name| name == "baseBranch"));

        let delete = tools
            .iter()
            .find(|tool| tool.name == "phantom_delete_worktree")
            .expect("delete");
        let schema = serde_json::to_value(&delete.input_schema).expect("schema");
        assert_eq!(property_type(&schema, "force"), json!("boolean"));
        assert_eq!(property_type(&schema, "keepBranch"), json!("boolean"));
        assert!(schema["properties"]["force"].get("default").is_none());
        let required = schema["required"].as_array().expect("required");
        assert!(!required
            .iter()
            .any(|name| name == "force" || name == "keepBranch"));

        let checkout = tools
            .iter()
            .find(|tool| tool.name == "phantom_github_checkout")
            .expect("checkout");
        let schema = serde_json::to_value(&checkout.input_schema).expect("schema");
        assert_eq!(property_type(&schema, "base"), json!("string"));
        assert!(schema["properties"]["base"].get("default").is_none());
    }

    #[test]
    fn list_projects_exposes_output_schema_and_structured_content() {
        let tools = PhantomServer::tool_router().list_all();
        let tool = tools
            .iter()
            .find(|tool| tool.name == "phantom_list_projects")
            .expect("list projects");
        assert_eq!(
            tool.annotations
                .as_ref()
                .and_then(|annotations| annotations.read_only_hint),
            Some(true)
        );
        let schema = serde_json::to_value(tool.output_schema.as_ref().expect("output schema"))
            .expect("schema json");
        assert!(schema["properties"]["schemaVersion"].get("const").is_some());
        assert!(schema["properties"]["warnings"]["description"]
            .as_str()
            .unwrap_or("")
            .contains("Non-fatal"));
        let required = schema["required"].as_array().expect("required");
        for name in ["schemaVersion", "version", "projects", "warnings", "note"] {
            assert!(required.iter().any(|item| item == name), "{schema}");
        }

        let result = PhantomServer
            .phantom_list_projects()
            .expect("list")
            .into_call_tool_result()
            .expect("result");
        let structured = result.structured_content.expect("structured content");
        assert_eq!(structured["schemaVersion"], 1);
        assert_eq!(structured["version"], 2);
        assert_eq!(structured["note"], "Use rootPath to identify a project.");
        assert!(structured["projects"].is_array());
        assert!(!result.content.is_empty());
    }
}
