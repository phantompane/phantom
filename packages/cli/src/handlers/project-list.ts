import {
  PROJECT_REGISTRY_VERSION,
  ProjectRegistryStore,
  type ProjectRecord,
} from "@phantompane/projects";
import { exitCodes, exitWithError, exitWithSuccess } from "../errors.ts";
import { output } from "../output.ts";
import { parseArgsOrExit } from "../parse-args.ts";

export async function projectListHandler(args: string[] = []): Promise<void> {
  const { values } = parseArgsOrExit({
    args,
    options: {
      json: {
        type: "boolean",
        default: false,
      },
      names: {
        type: "boolean",
        default: false,
      },
      paths: {
        type: "boolean",
        default: false,
      },
    },
    strict: true,
    allowPositionals: false,
  });

  const outputModes = [values.json, values.names, values.paths].filter(Boolean);
  if (outputModes.length > 1) {
    exitWithError(
      "Only one of --json, --names, or --paths can be specified",
      exitCodes.validationError,
    );
  }

  const projects = sortProjects(await new ProjectRegistryStore().list());

  if (values.json) {
    output.log(
      JSON.stringify(
        {
          version: PROJECT_REGISTRY_VERSION,
          projects,
        },
        null,
        2,
      ),
    );
    exitWithSuccess();
  }

  if (projects.length === 0) {
    if (!values.names && !values.paths) {
      output.log("No projects found.");
    }
    exitWithSuccess();
  }

  for (const project of projects) {
    if (values.names) {
      output.log(project.name);
    } else if (values.paths) {
      output.log(project.rootPath);
    } else {
      output.log(`${project.name} (${project.rootPath}) [${project.id}]`);
    }
  }

  exitWithSuccess();
}

function sortProjects(projects: ProjectRecord[]): ProjectRecord[] {
  return [...projects].sort((left, right) => {
    const nameComparison = compareStrings(left.name, right.name);
    return nameComparison || compareStrings(left.rootPath, right.rootPath);
  });
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
