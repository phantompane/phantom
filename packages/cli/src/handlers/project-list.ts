import { parseArgs } from "node:util";
import { ServeStateStore } from "@phantompane/state";
import { exitCodes, exitWithError, exitWithSuccess } from "../errors.ts";
import { output } from "../output.ts";
import { sortProjects } from "./project-utils.ts";

export async function projectListHandler(args: string[] = []): Promise<void> {
  const { values } = parseArgs({
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

  if ([values.json, values.names, values.paths].filter(Boolean).length > 1) {
    exitWithError(
      "Only one of --json, --names, or --paths can be specified",
      exitCodes.validationError,
    );
  }

  const state = await new ServeStateStore().load();
  const projects = sortProjects(state.projects);

  if (values.json) {
    output.log(JSON.stringify({ projects }, null, 2));
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
