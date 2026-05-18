import { basename } from "node:path";
import { parseArgs } from "node:util";
import {
  createRecordId,
  createTimestamp,
  ServeStateStore,
  touchProject,
  type ProjectRecord,
} from "@phantompane/state";
import { exitWithSuccess } from "../errors.ts";
import { output } from "../output.ts";
import { resolveProjectRootPath } from "./project-utils.ts";

export async function projectAddHandler(args: string[] = []): Promise<void> {
  const { positionals, values } = parseArgs({
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

  if (values.json) {
    output.log(JSON.stringify({ project }, null, 2));
  } else {
    output.log(`Added project '${project!.name}' (${project!.rootPath})`);
  }

  exitWithSuccess();
}
