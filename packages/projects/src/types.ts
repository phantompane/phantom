import { basename, isAbsolute, resolve } from "node:path";
import { z } from "zod";

export const PROJECT_REGISTRY_VERSION = 1 as const;

const isoTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    "Expected a valid ISO timestamp",
  );

export const projectRecordSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^proj_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    name: z.string().min(1),
    rootPath: z
      .string()
      .min(1)
      .refine(isAbsolute, "Expected an absolute path")
      .refine(
        (rootPath) => resolve(rootPath) === rootPath,
        "Expected a canonical path",
      )
      .refine(
        (rootPath) => basename(rootPath).length > 0,
        "Expected a named path",
      ),
    createdAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((project, context) => {
    if (project.name !== basename(project.rootPath)) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "Expected name to match the root path basename",
      });
    }
  });

export const projectRegistryStateSchema = z
  .object({
    version: z.literal(PROJECT_REGISTRY_VERSION),
    projects: z.array(projectRecordSchema),
  })
  .strict()
  .superRefine((state, context) => {
    const ids = new Set<string>();
    const rootPaths = new Set<string>();

    for (const [index, project] of state.projects.entries()) {
      if (ids.has(project.id)) {
        context.addIssue({
          code: "custom",
          path: ["projects", index, "id"],
          message: "Duplicate project id",
        });
      }
      if (rootPaths.has(project.rootPath)) {
        context.addIssue({
          code: "custom",
          path: ["projects", index, "rootPath"],
          message: "Duplicate project root path",
        });
      }
      ids.add(project.id);
      rootPaths.add(project.rootPath);
    }
  });

export type ProjectRecord = z.infer<typeof projectRecordSchema>;
export type ProjectRegistryState = z.infer<typeof projectRegistryStateSchema>;
