import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { CodexBridge, type CodexMessage } from "./codex-bridge";

type WrittenMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
};

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: WrittenMessage[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        if (line) {
          this.writes.push(JSON.parse(line) as WrittenMessage);
        }
      }
    });
  }

  send(message: CodexMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  failWithStderr(message: string): void {
    this.stderr.write(message);
    this.emit("exit", 1, null);
  }
}

function createBridge(): {
  bridge: CodexBridge;
  proc: FakeCodexProcess;
  spawnCodexProcess: ReturnType<typeof vi.fn>;
} {
  const proc = new FakeCodexProcess();
  const spawnCodexProcess = vi.fn(
    () => proc as unknown as ChildProcessWithoutNullStreams,
  );
  const bridge = new CodexBridge(
    "fake-codex",
    spawnCodexProcess as unknown as typeof import("node:child_process").spawn,
  );

  return { bridge, proc, spawnCodexProcess };
}

function findWrite(
  proc: FakeCodexProcess,
  method: string,
): WrittenMessage | undefined {
  return proc.writes.find((message) => message.method === method);
}

async function initializeBridge(bridge: CodexBridge, proc: FakeCodexProcess) {
  const started = bridge.ensureStarted();
  await vi.waitFor(() => expect(findWrite(proc, "initialize")).toBeDefined());
  proc.send({ id: 1, result: { protocolVersion: 2 } });
  await started;
}

describe("CodexBridge", () => {
  it("starts one app-server process and correlates JSON-RPC responses", async () => {
    const { bridge, proc, spawnCodexProcess } = createBridge();

    const models = bridge.listModels();
    await vi.waitFor(() => expect(findWrite(proc, "initialize")).toBeDefined());

    expect(spawnCodexProcess).toHaveBeenCalledWith(
      "fake-codex",
      ["app-server"],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    proc.send({ id: 1, result: { protocolVersion: 2 } });
    await vi.waitFor(() => expect(findWrite(proc, "model/list")).toBeDefined());

    const request = findWrite(proc, "model/list");
    proc.send({ id: request?.id, result: { models: [{ id: "gpt-5.2" }] } });

    await expect(models).resolves.toEqual({ models: [{ id: "gpt-5.2" }] });
    expect(findWrite(proc, "initialized")).toEqual({
      method: "initialized",
      params: {},
    });
  });

  it("fans out notifications and server approval requests", async () => {
    const { bridge, proc } = createBridge();
    const notifications: CodexMessage[] = [];
    const serverRequests: CodexMessage[] = [];

    bridge.onNotification((message) => notifications.push(message));
    bridge.onServerRequest((message) => serverRequests.push(message));

    await initializeBridge(bridge, proc);

    proc.send({
      method: "thread/updated",
      params: { threadId: "thread_1" },
    });
    proc.send({
      id: 99,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread_1" },
    });

    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    await vi.waitFor(() => expect(serverRequests).toHaveLength(1));

    bridge.respondToServerRequest("99", { decision: "accept" });

    expect(notifications[0]?.method).toBe("thread/updated");
    expect(serverRequests[0]?.method).toBe(
      "item/commandExecution/requestApproval",
    );
    expect(proc.writes).toContainEqual({
      id: 99,
      result: { decision: "accept" },
    });
  });

  it("propagates app-server exits to pending requests", async () => {
    const { bridge, proc } = createBridge();

    const models = bridge.listModels();
    await vi.waitFor(() => expect(findWrite(proc, "initialize")).toBeDefined());
    proc.failWithStderr("boom");

    await expect(models).rejects.toThrow(
      "Codex App Server exited with code 1: boom",
    );
  });

  it("does not serialize active turns across different threads", async () => {
    const { bridge, proc } = createBridge();
    await initializeBridge(bridge, proc);

    const first = bridge.startTurn("thread_a", "hello a", "/repo/a");
    const second = bridge.startTurn("thread_b", "hello b", "/repo/b");

    await vi.waitFor(() => {
      expect(
        proc.writes.filter((message) => message.method === "turn/start"),
      ).toHaveLength(2);
    });

    const turns = proc.writes.filter(
      (message) => message.method === "turn/start",
    );
    expect(
      turns.map((message) => (message.params as { threadId: string }).threadId),
    ).toEqual(["thread_a", "thread_b"]);

    proc.send({ id: turns[0]?.id, result: { turn: { id: "turn_a" } } });
    proc.send({ id: turns[1]?.id, result: { turn: { id: "turn_b" } } });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { turn: { id: "turn_a" } },
      { turn: { id: "turn_b" } },
    ]);
  });
});
