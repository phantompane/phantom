use rmcp::handler::server::wrapper::Parameters;
use rmcp::tool_handler;
use rmcp::{tool, tool_router, ServerHandler, ServiceExt};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::context;
use crate::error::Error;
use crate::git;
use crate::github;
use crate::preferences;
use crate::projects;
use crate::worktree::{self, Logger};

pub struct PhantomServer;

#[derive(Debug, Deserialize, JsonSchema)]
struct CreateArgs {
    /// Name for the worktree (also used as the branch name)
    name: String,
    /// Base branch to create from (optional)
    #[serde(default, rename = "baseBranch")]
    base_branch: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct DeleteArgs {
    /// Name of the worktree to delete
    name: String,
    /// Force deletion even if there are uncommitted changes
    #[serde(default)]
    force: Option<bool>,
    /// Keep the branch after deleting the worktree
    #[serde(default, rename = "keepBranch")]
    keep_branch: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CheckoutArgs {
    /// Issue or pull request number to checkout
    number: String,
    /// Base branch for issues (not applicable for pull requests)
    #[serde(default)]
    base: Option<String>,
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
            .or(context.preferences.keep_branch)
            .unwrap_or(false);
        worktree::delete_worktree(
            &context,
            &args.name,
            args.force.unwrap_or(false),
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
        description = "List registered and discovered Git projects"
    )]
    fn phantom_list_projects(&self) -> std::result::Result<String, String> {
        let loaded = preferences::load_preferences().map_err(|error| error.to_string())?;
        let catalog = projects::list_catalog(loaded.ghq_discovery != Some(false))
            .map_err(|error| error.to_string())?;
        let projects = catalog
            .projects
            .iter()
            .map(project_json)
            .collect::<Vec<_>>();
        Ok(pretty(&json!({
            "schemaVersion": 1,
            "version": catalog.version,
            "projects": projects,
            "warnings": catalog.warnings,
            "note": "Use rootPath to identify a project.",
        })))
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

fn project_json(entry: &projects::ProjectListEntry) -> Value {
    match entry {
        projects::ProjectListEntry::Registry {
            id,
            name,
            root_path,
            created_at,
        } => json!({
            "source": "registry",
            "id": id,
            "name": name,
            "rootPath": root_path,
            "createdAt": created_at,
        }),
        projects::ProjectListEntry::Ghq { name, root_path } => json!({
            "source": "ghq",
            "name": name,
            "rootPath": root_path,
        }),
    }
}
