import { describe, expect, it, vi } from "vitest";

import { createSseResponse, EventHub, parseLastEventId } from "./event-hub";

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const result = await reader.read();
  if (result.done) {
    return "";
  }
  return new TextDecoder().decode(result.value);
}

describe("EventHub", () => {
  it("frames events as SSE and filters subscriptions", async () => {
    const hub = new EventHub();
    const stream = hub.subscribe((event) => event.chatId === "chat_1", null);
    const reader = stream.getReader();

    hub.emit("agent.item.delta", { text: "hello" }, { chatId: "chat_1" });
    hub.emit("agent.item.delta", { text: "ignored" }, { chatId: "chat_2" });

    const chunk = await readChunk(reader);
    expect(chunk).toContain("id: 1");
    expect(chunk).toContain("event: agent.item.delta");
    expect(chunk).toContain('"chatId":"chat_1"');
    expect(chunk).toContain('"text":"hello"');

    await reader.cancel();
    expect(hub.listenerCount()).toBe(0);
  });

  it("replays buffered events after Last-Event-ID", async () => {
    const hub = new EventHub(2);

    hub.emit("old", {}, { scope: "global" });
    hub.emit("kept.1", {}, { scope: "global" });
    hub.emit("kept.2", {}, { scope: "global" });

    const stream = hub.subscribe(() => true, 0);
    const reader = stream.getReader();

    const first = await readChunk(reader);
    const second = await readChunk(reader);

    expect(first).toContain("event: kept.1");
    expect(second).toContain("event: kept.2");
    expect(first).not.toContain("event: old");
    expect(second).not.toContain("event: old");

    await reader.cancel();
  });

  it("emits heartbeat comments and cleans the timer on cancel", async () => {
    vi.useFakeTimers();
    try {
      const hub = new EventHub();
      const stream = hub.subscribe(() => true, null);
      const reader = stream.getReader();

      await vi.advanceTimersByTimeAsync(15000);

      expect(await readChunk(reader)).toBe(": heartbeat\n\n");
      await reader.cancel();
      expect(hub.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sets standard SSE response headers and parses Last-Event-ID", () => {
    const response = createSseResponse(new ReadableStream());
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe(
      "no-cache, no-transform",
    );

    const request = new Request("http://localhost/api/events", {
      headers: { "Last-Event-ID": "42" },
    });
    expect(parseLastEventId(request)).toBe(42);
  });
});
