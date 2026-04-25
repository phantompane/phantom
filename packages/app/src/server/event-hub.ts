import type { PhantomEvent } from "./types";

type Listener = {
  filter: (event: PhantomEvent) => boolean;
  send: (event: PhantomEvent) => void;
};

const DEFAULT_REPLAY_LIMIT = 300;
const HEARTBEAT_MS = 15000;

function encodeSseEvent(event: PhantomEvent): string {
  return [
    `id: ${event.id}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ].join("\n");
}

export class EventHub {
  private nextId = 1;
  private readonly events: PhantomEvent[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(private readonly replayLimit = DEFAULT_REPLAY_LIMIT) {}

  emit(
    type: string,
    data: unknown,
    options: { chatId?: string; scope?: "global" | "chat" } = {},
  ): PhantomEvent {
    const event: PhantomEvent = {
      id: this.nextId++,
      type,
      scope: options.scope ?? (options.chatId ? "chat" : "global"),
      chatId: options.chatId,
      data,
      createdAt: new Date().toISOString(),
    };

    this.events.push(event);
    if (this.events.length > this.replayLimit) {
      this.events.shift();
    }

    for (const listener of this.listeners) {
      if (listener.filter(event)) {
        listener.send(event);
      }
    }

    return event;
  }

  subscribe(
    filter: (event: PhantomEvent) => boolean,
    lastEventId: number | null,
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let listener: Listener | undefined;

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const write = (chunk: string) => {
          controller.enqueue(encoder.encode(chunk));
        };

        if (lastEventId !== null) {
          for (const event of this.events) {
            if (event.id > lastEventId && filter(event)) {
              write(encodeSseEvent(event));
            }
          }
        }

        listener = {
          filter,
          send: (event) => write(encodeSseEvent(event)),
        };
        this.listeners.add(listener);

        heartbeat = setInterval(() => {
          write(": heartbeat\n\n");
        }, HEARTBEAT_MS);
      },
      cancel: () => {
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        if (listener) {
          this.listeners.delete(listener);
        }
      },
    });
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

export function createSseResponse(
  stream: ReadableStream<Uint8Array>,
): Response {
  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  });
}

export function parseLastEventId(request: Request): number | null {
  const header = request.headers.get("Last-Event-ID");
  if (!header) {
    return null;
  }

  const value = Number.parseInt(header, 10);
  return Number.isFinite(value) ? value : null;
}
