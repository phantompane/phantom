import { basename } from "node:path";
import { parseArgs } from "node:util";
import {
  createRecordId,
  createTimestamp,
  ServeStateStore,
  touchProject,
  type ProjectRecord,
} from "@phantompane/state";
import { exitCodes, exitWithError, exitWithSuccess } from "../errors.ts";
import { output } from "../output.ts";
import { resolveProjectRootPath } from "./project-utils.ts";

export async function projectAddHandler(args: string[] = []): Promise<void> {
  const { positionals } = parseArgs({
    args,
    options: {},
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length > 1) {
    exitWithError(
      "Usage: phantom project add [path]",
      exitCodes.validationError,
    );
  }

  const targetPath = positionals[0] ?? process.cwd();
  const rootPath = await resolveProjectRootPath(targetPath);
  let project: ProjectRecord | null = null;

  await new ServeStateStore().update((state) => {
    const existingProject = state.projects.find(
      (candidate) => candidate.rootPath === rootPath,
    );
    if (existingProject) {
      project = touchProject(existingProject);
      return {
        ...state,
        projects: state.projects.map((candidate) =>
          candidate.id === existingProject.id ? project! : candidate,
        ),
        selectedProjectId: existingProject.id,
      };
    }

    const timestamp = createTimestamp();
    project = {
      id: createRecordId("proj"),
      name: basename(rootPath),
      rootPath,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastOpenedAt: timestamp,
    };
    return {
      ...state,
      projects: [...state.projects, project],
      selectedProjectId: project.id,
    };
  });

  output.log(`Added project '${project!.name}' (${project!.rootPath})`);

  exitWithSuccess();
}
