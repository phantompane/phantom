import { parseArgs } from "node:util";
import { ServeStateStore } from "@phantompane/state";
import { exitCodes, exitWithError, exitWithSuccess } from "../errors.ts";
import { output } from "../output.ts";
import { sortProjects } from "./project-utils.ts";

export async function projectListHandler(args: string[] = []): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
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

  if (values.names && values.paths) {
    exitWithError(
      "Only one of --names or --paths can be specified",
      exitCodes.validationError,
    );
  }

  const state = await new ServeStateStore().load();
  const projects = sortProjects(state.projects);

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
