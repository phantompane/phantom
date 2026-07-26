import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { it, vi } from "vitest";

const listProjectCatalogMock = vi.fn();
const loadPreferencesMock = vi.fn();

vi.doMock("@phantompane/preferences", () => ({
  loadPreferences: loadPreferencesMock,
}));

vi.doMock("@phantompane/projects", () => ({
  PROJECT_LIST_VERSION: 2,
  listProjectCatalog: listProjectCatalogMock,
}));

const { createMcpServer } = await import("./index.ts");

it("exposes and returns the structured project catalog over MCP", async () => {
  const expected = {
    version: 2,
    projects: [
      {
        source: "ghq",
        name: "phantom",
        rootPath: "/repos/phantom",
      },
    ],
    warnings: [],
    note: "Use rootPath to identify a project.",
  };
  loadPreferencesMock.mockResolvedValue({});
  listProjectCatalogMock.mockResolvedValue({
    version: expected.version,
    projects: expected.projects,
    warnings: expected.warnings,
  });

  const server = createMcpServer();
  const client = new Client({
    name: "phantom-mcp-test-client",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const listedTools = await client.listTools();
    const listedTool = listedTools.tools.find(
      (tool) => tool.name === "phantom_list_projects",
    );
    ok(listedTool);
    strictEqual(listedTool.annotations?.readOnlyHint, true);
    strictEqual(listedTool.outputSchema?.type, "object");
    deepStrictEqual(listedTool.outputSchema?.required, [
      "version",
      "projects",
      "warnings",
      "note",
    ]);

    const result = await client.callTool({
      name: "phantom_list_projects",
      arguments: {},
    });
    deepStrictEqual(result.structuredContent, expected);

    if (!("content" in result) || !Array.isArray(result.content)) {
      throw new Error("Expected immediate tool content");
    }
    const [content] = result.content;
    ok(content);
    strictEqual(content.type, "text");
    if (content.type !== "text") {
      throw new Error("Expected text content");
    }
    deepStrictEqual(JSON.parse(content.text), expected);
  } finally {
    await client.close();
    await server.close();
  }
});
