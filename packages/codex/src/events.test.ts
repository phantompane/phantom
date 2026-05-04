import { strictEqual } from "node:assert";
import { describe, it } from "vitest";
import { mapCodexMethodToEvent, summarizeCodexEvent } from "./events.ts";

describe("Codex event mapping", () => {
  it("maps rich app-server notifications to dedicated Phantom events", () => {
    strictEqual(
      mapCodexMethodToEvent("turn/plan/updated"),
      "agent.plan.updated",
    );
    strictEqual(
      mapCodexMethodToEvent("item/commandExecution/outputDelta"),
      "agent.command.output",
    );
    strictEqual(
      mapCodexMethodToEvent("item/reasoning/summaryTextDelta"),
      "agent.reasoning.updated",
    );
    strictEqual(mapCodexMethodToEvent("guardianWarning"), "agent.warning");
  });

  it("summarizes rich notifications for compatibility messages", () => {
    strictEqual(
      summarizeCodexEvent("turn/plan/updated", {
        plan: [{ step: "Inspect", status: "completed" }],
      }),
      "plan updated: 1 step",
    );
    strictEqual(
      summarizeCodexEvent("item/fileChange/patchUpdated", {
        changes: [{ path: "a.ts", kind: "modify", diff: "" }],
      }),
      "file patch updated: 1 file",
    );
  });
});
