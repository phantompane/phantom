import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import packageJson from "../package.json" with { type: "json" };
import { createWorktreeTool } from "./tools/create-worktree.ts";
import { deleteWorktreeTool } from "./tools/delete-worktree.ts";
import { githubCheckoutTool } from "./tools/github-checkout.ts";
import { listProjectsTool } from "./tools/list-projects.ts";
import { listWorktreesTool } from "./tools/list-worktrees.ts";

export function createMcpServer() {
  const server = new McpServer({
    name: "Phantom MCP Server",
    version: packageJson.version,
  });

  server.registerTool(
    listProjectsTool.name,
    {
      description: listProjectsTool.description,
      inputSchema: listProjectsTool.inputSchema.shape,
      outputSchema: listProjectsTool.outputSchema.shape,
      annotations: {
        readOnlyHint: true,
      },
    },
    listProjectsTool.handler,
  );

  const tools = [
    createWorktreeTool,
    listWorktreesTool,
    deleteWorktreeTool,
    githubCheckoutTool,
  ];

  for (const tool of tools) {
    server.tool(
      tool.name,
      tool.description,
      tool.inputSchema.shape,
      tool.handler,
    );
  }

  return server;
}

export async function serve() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await server.close();
    process.exit(0);
  });
}
