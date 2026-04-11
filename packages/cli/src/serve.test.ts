import { rejects, strictEqual } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { resolveServeServerEntry } from "./serve.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "phantom-serve-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("resolveServeServerEntry", () => {
  it("finds the bundled app server entry from the source CLI entrypoint", async () => {
    const directory = await createTemporaryDirectory();
    const cliEntry = join(
      directory,
      "packages",
      "cli",
      "src",
      "bin",
      "phantom.ts",
    );
    const serverEntry = join(
      directory,
      "packages",
      "cli",
      "dist",
      "app",
      ".output",
      "server",
      "index.mjs",
    );

    await mkdir(join(directory, "packages", "cli", "src", "bin"), {
      recursive: true,
    });
    await mkdir(
      join(directory, "packages", "cli", "dist", "app", ".output", "server"),
      {
        recursive: true,
      },
    );
    await writeFile(cliEntry, "");
    await writeFile(serverEntry, "");

    strictEqual(await resolveServeServerEntry(cliEntry), serverEntry);
  });

  it("finds the app server entry from the bundled CLI entrypoint", async () => {
    const directory = await createTemporaryDirectory();
    const cliEntry = join(directory, "packages", "cli", "dist", "phantom.js");
    const serverEntry = join(
      directory,
      "packages",
      "cli",
      "dist",
      "app",
      ".output",
      "server",
      "index.mjs",
    );

    await mkdir(
      join(directory, "packages", "cli", "dist", "app", ".output", "server"),
      {
        recursive: true,
      },
    );
    await writeFile(cliEntry, "");
    await writeFile(serverEntry, "");

    strictEqual(await resolveServeServerEntry(cliEntry), serverEntry);
  });

  it("throws when the bundled server entry is missing", async () => {
    const directory = await createTemporaryDirectory();
    const cliEntry = join(directory, "packages", "cli", "dist", "phantom.js");

    await mkdir(join(directory, "packages", "cli", "dist"), {
      recursive: true,
    });
    await writeFile(cliEntry, "");

    await rejects(
      resolveServeServerEntry(cliEntry),
      /Could not find Phantom server assets/,
    );
  });
});
