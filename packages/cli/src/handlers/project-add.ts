import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { getGitRoot } from "@phantompane/git";
import { ProjectRegistryStore } from "@phantompane/projects";
import { exitCodes, exitWithError, exitWithSuccess } from "../errors.ts";
import { output } from "../output.ts";
import { parseArgsOrExit } from "../parse-args.ts";

export async function projectAddHandler(args: string[] = []): Promise<void> {
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

  if (positionals.length > 1) {
    exitWithError(
      "Usage: phantom project add [path] [--json]",
      exitCodes.validationError,
    );
  }

  const rootPath = await resolveProjectRootPath(
    positionals[0] ?? process.cwd(),
  );
  const { project, added } = await new ProjectRegistryStore().add(rootPath);

  if (values.json) {
    output.log(
      JSON.stringify(
        {
          status: added ? "added" : "existing",
          project,
        },
        null,
        2,
      ),
    );
  } else if (added) {
    output.log(`Added project '${project.name}' (${project.rootPath})`);
  } else {
    output.log(
      `Project '${project.name}' is already registered (${project.rootPath})`,
    );
  }

  exitWithSuccess();
}

export async function resolveProjectRootPath(
  inputPath: string,
): Promise<string> {
  const resolvedPath = await realpath(resolve(inputPath));
  const gitRoot = await getGitRoot({ cwd: resolvedPath });
  return await realpath(gitRoot);
}
