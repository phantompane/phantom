import { deepStrictEqual, strictEqual } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { ServeStateStore, createEmptyState } from "./storage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "phantom-serve-state-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("ServeStateStore", () => {
  it("loads missing state as an empty state", async () => {
    const store = new ServeStateStore(await createTemporaryDirectory());

    deepStrictEqual(await store.load(), createEmptyState());
  });

  it("persists updates atomically", async () => {
    const directory = await createTemporaryDirectory();
    const store = new ServeStateStore(directory);

    await store.update((state) => ({
      ...state,
      projects: [
        {
          id: "proj_1",
          name: "repo",
          rootPath: "/repo",
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:00:00.000Z",
          lastOpenedAt: "2026-04-25T00:00:00.000Z",
        },
      ],
    }));

    const reloaded = await new ServeStateStore(directory).load();
    strictEqual(reloaded.projects[0]?.rootPath, "/repo");
  });

  it("rejects malformed state", async () => {
    const directory = await createTemporaryDirectory();
    await writeFile(join(directory, "state.json"), '{"version":1}');
    const store = new ServeStateStore(directory);

    strictEqual(
      await store.load().then(
        () => "resolved",
        (error: Error) => error.message,
      ),
      "Serve state has an invalid shape",
    );
  });
});
