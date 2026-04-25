import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type CodexNotificationHandler = (message: CodexMessage) => void;
export type CodexServerRequestHandler = (message: CodexMessage) => void;
export type CodexProcessExitHandler = (error: Error) => void;

export interface CodexMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message: string;
    data?: unknown;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type SpawnCodexProcess = typeof spawn;

function getCodexBin(): string {
  return process.env.PHANTOM_SERVE_CODEX_BIN ?? "codex";
}

function createUserInput(text: string): Array<Record<string, unknown>> {
  return [
    {
      type: "text",
      text,
      text_elements: [],
    },
  ];
}

export class CodexBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private initialized: Promise<void> | null = null;
  private nextId = 1;
  private stderr = "";
  private readonly pendingRequests = new Map<number | string, PendingRequest>();
  private readonly serverRequests = new Map<number | string, CodexMessage>();
  private readonly notificationHandlers = new Set<CodexNotificationHandler>();
  private readonly serverRequestHandlers = new Set<CodexServerRequestHandler>();
  private readonly processExitHandlers = new Set<CodexProcessExitHandler>();

  constructor(
    private readonly codexBin = getCodexBin(),
    private readonly spawnCodexProcess: SpawnCodexProcess = spawn,
  ) {}

  onNotification(handler: CodexNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(handler: CodexServerRequestHandler): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  onProcessExit(handler: CodexProcessExitHandler): () => void {
    this.processExitHandlers.add(handler);
    return () => this.processExitHandlers.delete(handler);
  }

  async ensureStarted(): Promise<void> {
    if (this.initialized) {
      return this.initialized;
    }

    this.initialized = this.start();
    return this.initialized;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.ensureStarted();
    return this.sendRequest(method, params);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.ensureStarted();
    this.write({ method, params: params ?? {} });
  }

  respondToServerRequest(requestId: number | string, result: unknown): void {
    const serverRequestId = this.resolveServerRequestId(requestId);
    if (serverRequestId === null) {
      throw new Error(`Codex server request '${requestId}' was not found`);
    }
    this.serverRequests.delete(serverRequestId);
    this.write({ id: serverRequestId, result });
  }

  async readAccount(): Promise<unknown> {
    return this.request("account/read", { refreshToken: false });
  }

  async listModels(): Promise<unknown> {
    return this.request("model/list", {
      limit: 50,
      includeHidden: false,
    });
  }

  async startThread(cwd: string): Promise<unknown> {
    return this.request("thread/start", {
      cwd,
      serviceName: "phantom_serve",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
  }

  async resumeThread(threadId: string, cwd: string): Promise<unknown> {
    return this.request("thread/resume", {
      threadId,
      cwd,
      excludeTurns: true,
      persistExtendedHistory: true,
    });
  }

  async startTurn(
    threadId: string,
    text: string,
    cwd: string,
  ): Promise<unknown> {
    return this.request("turn/start", {
      threadId,
      cwd,
      input: createUserInput(text),
    });
  }

  async steerTurn(
    threadId: string,
    turnId: string,
    text: string,
  ): Promise<unknown> {
    return this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: createUserInput(text),
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    return this.request("turn/interrupt", {
      threadId,
      turnId,
    });
  }

  private async start(): Promise<void> {
    this.stderr = "";
    this.proc = this.spawnCodexProcess(this.codexBin, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const proc = this.proc;

    proc.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
      if (this.stderr.length > 8000) {
        this.stderr = this.stderr.slice(-8000);
      }
    });

    proc.on("error", (error) => {
      this.handleProcessExit(proc, error);
    });

    proc.on("exit", (code, signal) => {
      const suffix = this.stderr.trim() ? `: ${this.stderr.trim()}` : "";
      this.handleProcessExit(
        proc,
        new Error(
          `Codex App Server exited with ${
            signal ? `signal ${signal}` : `code ${code ?? 0}`
          }${suffix}`,
        ),
      );
    });

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    await this.sendRequest("initialize", {
      clientInfo: {
        name: "phantom_serve",
        title: "Phantom Serve",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.write({ method: "initialized", params: {} });
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });
    this.write({ id, method, params });
    return promise;
  }

  private write(message: CodexMessage): void {
    if (!this.proc?.stdin.writable) {
      throw new Error("Codex App Server is not running");
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private resolveServerRequestId(
    requestId: number | string,
  ): number | string | null {
    if (this.serverRequests.has(requestId)) {
      return requestId;
    }

    if (typeof requestId === "number") {
      return null;
    }

    const numericRequestId = Number(requestId);
    if (
      Number.isFinite(numericRequestId) &&
      this.serverRequests.has(numericRequestId)
    ) {
      return numericRequestId;
    }

    return null;
  }

  private handleLine(line: string): void {
    let message: CodexMessage;
    try {
      message = JSON.parse(line) as CodexMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.serverRequests.set(message.id, message);
      for (const handler of this.serverRequestHandlers) {
        handler(message);
      }
      return;
    }

    for (const handler of this.notificationHandlers) {
      handler(message);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private handleProcessExit(
    proc: ChildProcessWithoutNullStreams,
    error: Error,
  ): void {
    if (this.proc !== proc) {
      return;
    }

    this.rejectPending(error);
    this.serverRequests.clear();
    this.proc = null;
    this.initialized = null;
    for (const handler of this.processExitHandlers) {
      handler(error);
    }
  }
}
