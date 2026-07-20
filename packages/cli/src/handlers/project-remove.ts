import {
  ProjectRegistryStore,
  type ProjectRecord,
} from "@phantompane/projects";
import { exitCodes, exitWithError, exitWithSuccess } from "../errors.ts";
import { output } from "../output.ts";
import { parseArgsOrExit } from "../parse-args.ts";
import { resolveProjectRootPath } from "./project-add.ts";

export async function projectRemoveHandler(args: string[] = []): Promise<void> {
  const { positionals, values } = parseArgsOrExit({
    args,
    options: {
      json: {
        type: "boolean",
        default: false,
      },
    },
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length !== 1) {
    exitWithError(
      "Usage: phantom project remove <id|name|path> [--json]",
      exitCodes.validationError,
    );
  }

  const identifier = positionals[0];
  const store = new ProjectRegistryStore();
  const projects = await store.list();
  const project = await findProject(projects, identifier);

  if (!project) {
    exitWithError(`Project '${identifier}' not found`, exitCodes.notFound);
  }

  const removedProject = await store.remove(project.id);
  if (!removedProject) {
    exitWithError(`Project '${identifier}' not found`, exitCodes.notFound);
  }

  if (values.json) {
    output.log(
      JSON.stringify(
        {
          status: "removed",
          project: removedProject,
        },
        null,
        2,
      ),
    );
  } else {
    output.log(
      `Removed project '${removedProject.name}' (${removedProject.rootPath})`,
    );
  }

  exitWithSuccess();
}

async function findProject(
  projects: ProjectRecord[],
  identifier: string,
): Promise<ProjectRecord | null> {
  const idMatch = projects.find((project) => project.id === identifier);
  if (idMatch) {
    return idMatch;
  }

  const pathMatch = projects.find((project) => project.rootPath === identifier);
  if (pathMatch) {
    return pathMatch;
  }

  const nameMatches = projects.filter((project) => project.name === identifier);
  if (nameMatches.length === 1) {
    return nameMatches[0]!;
  }

  if (nameMatches.length > 1) {
    exitWithError(
      `Project '${identifier}' is ambiguous; use its id or path`,
      exitCodes.validationError,
    );
  }

  try {
    const rootPath = await resolveProjectRootPath(identifier);
    return projects.find((project) => project.rootPath === rootPath) ?? null;
  } catch {
    return null;
  }
}
