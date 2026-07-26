import { loadPreferences } from "@phantompane/preferences";
import {
  listProjectCatalog,
  PROJECT_LIST_VERSION,
} from "@phantompane/projects";
import { z } from "zod";
import type { StructuredTool } from "./types.ts";

const schema = z.object({});

const registryProjectSchema = z
  .object({
    source: z.literal("registry"),
    id: z.string(),
    name: z.string(),
    rootPath: z.string().describe("Canonical absolute Git repository path"),
    createdAt: z.string().describe("ISO 8601 registration timestamp"),
  })
  .strict();

const ghqProjectSchema = z
  .object({
    source: z.literal("ghq"),
    name: z.string(),
    rootPath: z.string().describe("Canonical absolute Git repository path"),
  })
  .strict();

export const listProjectsOutputSchema = z
  .object({
    version: z.literal(PROJECT_LIST_VERSION),
    projects: z.array(
      z.discriminatedUnion("source", [registryProjectSchema, ghqProjectSchema]),
    ),
    warnings: z
      .array(z.string())
      .describe("Non-fatal project discovery warnings"),
    note: z.string(),
  })
  .strict();

export const listProjectsTool: StructuredTool<
  typeof schema,
  typeof listProjectsOutputSchema
> = {
  name: "phantom_list_projects",
  description: "List registered and discovered Git projects",
  inputSchema: schema,
  outputSchema: listProjectsOutputSchema,
  handler: async () => {
    const preferences = await loadPreferences();
    const catalog = await listProjectCatalog({
      includeGhq: preferences.ghqDiscovery !== false,
    });
    const structuredContent = {
      version: catalog.version,
      projects: catalog.projects,
      warnings: catalog.warnings,
      note: "Use rootPath to identify a project.",
    } satisfies z.infer<typeof listProjectsOutputSchema>;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(structuredContent, null, 2),
        },
      ],
      structuredContent,
    };
  },
};
