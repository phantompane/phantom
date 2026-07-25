import { loadPreferences } from "@phantompane/preferences";
import { listProjectCatalog } from "@phantompane/projects";
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

  const preferences = await loadPreferences();
  const catalog = await listProjectCatalog({
    includeGhq: preferences.ghqDiscovery !== false,
  });

  for (const warning of catalog.warnings) {
    output.warn(`Warning: ${warning}`);
  }

  if (values.json) {
    output.log(
      JSON.stringify(
        {
          version: catalog.version,
          projects: catalog.projects,
        },
        null,
        2,
      ),
    );
    exitWithSuccess();
  }

  if (catalog.projects.length === 0) {
    if (!values.names && !values.paths) {
      output.log("No projects found.");
    }
    exitWithSuccess();
  }

  for (const project of catalog.projects) {
    if (values.names) {
      output.log(project.name);
    } else if (values.paths) {
      output.log(project.rootPath);
    } else if (project.source === "ghq") {
      output.log(`${project.name} (${project.rootPath}) [ghq]`);
    } else {
      output.log(`${project.name} (${project.rootPath}) [${project.id}]`);
    }
  }

  exitWithSuccess();
}
