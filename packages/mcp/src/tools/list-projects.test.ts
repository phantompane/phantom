import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { beforeEach, describe, it, vi } from "vitest";
import { z } from "zod";

const listProjectCatalogMock = vi.fn();
const loadPreferencesMock = vi.fn();

vi.doMock("@phantompane/preferences", () => ({
  loadPreferences: loadPreferencesMock,
}));

vi.doMock("@phantompane/projects", () => ({
  PROJECT_LIST_VERSION: 2,
  listProjectCatalog: listProjectCatalogMock,
}));

const { listProjectsTool } = await import("./list-projects.ts");

const handlerExtra = {} as never;

function getTextContent(result: {
  content: Array<{ type: "text"; text: string } | { type: string }>;
}) {
  const [content] = result.content;
  strictEqual(content.type, "text");

  if (content.type !== "text") {
    throw new Error("Expected text content");
  }

  return (content as { type: "text"; text: string }).text;
}

describe("listProjectsTool", () => {
  beforeEach(() => {
    listProjectCatalogMock.mockReset();
    loadPreferencesMock.mockReset();
    loadPreferencesMock.mockResolvedValue({});
  });

  it("has project discovery metadata and an empty input schema", () => {
    strictEqual(listProjectsTool.name, "phantom_list_projects");
    strictEqual(
      listProjectsTool.description,
      "List registered and discovered Git projects",
    );
    strictEqual(listProjectsTool.inputSchema instanceof z.ZodObject, true);
    deepStrictEqual(Object.keys(listProjectsTool.inputSchema.shape), []);
    strictEqual(listProjectsTool.outputSchema instanceof z.ZodObject, true);
    deepStrictEqual(Object.keys(listProjectsTool.outputSchema.shape), [
      "schemaVersion",
      "version",
      "projects",
      "warnings",
      "note",
    ]);
  });

  it("returns the versioned project catalog", async () => {
    const projects = [
      {
        source: "registry",
        id: "proj_00000000-0000-4000-8000-000000000001",
        name: "alpha",
        rootPath: "/repos/alpha",
        createdAt: "2026-07-20T00:00:00.000Z",
      },
      {
        source: "ghq",
        name: "beta",
        rootPath: "/repos/beta",
      },
    ];
    listProjectCatalogMock.mockResolvedValue({
      version: 2,
      projects,
      warnings: [],
    });

    const result = await listProjectsTool.handler({}, handlerExtra);

    deepStrictEqual(listProjectCatalogMock.mock.calls, [
      [{ includeGhq: true }],
    ]);
    const expected = {
      schemaVersion: 1,
      version: 2,
      projects,
      warnings: [],
      note: "Use rootPath to identify a project.",
    };
    deepStrictEqual(JSON.parse(getTextContent(result)), expected);
    deepStrictEqual(result.structuredContent, expected);
    strictEqual(
      listProjectsTool.outputSchema.safeParse(expected).success,
      true,
    );
  });

  it("honors the ghq discovery preference", async () => {
    loadPreferencesMock.mockResolvedValue({ ghqDiscovery: false });
    listProjectCatalogMock.mockResolvedValue({
      version: 2,
      projects: [],
      warnings: [],
    });

    await listProjectsTool.handler({}, handlerExtra);

    deepStrictEqual(listProjectCatalogMock.mock.calls, [
      [{ includeGhq: false }],
    ]);
  });

  it("returns ghq discovery warnings without failing", async () => {
    listProjectCatalogMock.mockResolvedValue({
      version: 2,
      projects: [],
      warnings: ["Failed to discover ghq repositories: command failed"],
    });

    const result = await listProjectsTool.handler({}, handlerExtra);

    deepStrictEqual(JSON.parse(getTextContent(result)).warnings, [
      "Failed to discover ghq repositories: command failed",
    ]);
  });

  it("propagates native project registry failures", async () => {
    listProjectCatalogMock.mockRejectedValue(
      new Error("Failed to read project registry"),
    );

    await rejects(
      async () => await listProjectsTool.handler({}, handlerExtra),
      /Failed to read project registry/,
    );
  });
});
