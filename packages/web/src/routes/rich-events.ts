import type { ChatMessageRecord } from "@phantompane/server";

export type RichEventKind =
  | "command"
  | "diff"
  | "file"
  | "plan"
  | "reasoning"
  | "warning";

export interface RichPlanStep {
  status: "completed" | "inProgress" | "pending";
  step: string;
}

export interface RichFileChange {
  diff: string;
  kind: string;
  path: string;
}

export function getRichEventKind(
  message: Pick<ChatMessageRecord, "eventType" | "role">,
): RichEventKind | null {
  if (message.role !== "event") {
    return null;
  }
  if (
    message.eventType === "turn/plan/updated" ||
    message.eventType === "item/plan/delta"
  ) {
    return "plan";
  }
  if (message.eventType === "turn/diff/updated") {
    return "diff";
  }
  if (
    message.eventType === "item/commandExecution/outputDelta" ||
    message.eventType === "command/exec/outputDelta"
  ) {
    return "command";
  }
  if (
    message.eventType === "item/fileChange/patchUpdated" ||
    message.eventType === "item/fileChange/outputDelta"
  ) {
    return "file";
  }
  if (
    message.eventType?.startsWith("item/reasoning/") &&
    message.eventType !== "item/reasoning/summaryPartAdded"
  ) {
    return "reasoning";
  }
  if (
    message.eventType === "warning" ||
    message.eventType === "guardianWarning" ||
    message.eventType === "configWarning"
  ) {
    return "warning";
  }
  return null;
}

export function isRichEventMessage(
  message: Pick<ChatMessageRecord, "eventType" | "role">,
): boolean {
  return getRichEventKind(message) !== null;
}

export function getPlanEventData(message: ChatMessageRecord): {
  explanation: string | null;
  plan: RichPlanStep[];
} {
  const eventData = getEventDataObject(message);
  const explanation = getString(eventData, "explanation") ?? null;
  const plan = getObjectArray(eventData, "plan")
    .map((step) => {
      const text = getString(step, "step");
      const status = getString(step, "status");
      if (
        !text ||
        (status !== "completed" &&
          status !== "inProgress" &&
          status !== "pending")
      ) {
        return null;
      }
      return { step: text, status };
    })
    .filter((step): step is RichPlanStep => Boolean(step));
  return { explanation, plan };
}

export function getDiffEventData(message: ChatMessageRecord): {
  diff: string;
  files: string[];
} {
  const eventData = getEventDataObject(message);
  const diff = getString(eventData, "diff") ?? message.text;
  return {
    diff,
    files: getStringArray(eventData, "files").filter(Boolean),
  };
}

export function getFilePatchEventData(
  message: ChatMessageRecord,
): RichFileChange[] {
  const eventData = getEventDataObject(message);
  return getObjectArray(eventData, "changes")
    .map((change) => {
      const path = getString(change, "path");
      if (!path) {
        return null;
      }
      return {
        path,
        kind: getString(change, "kind") ?? "update",
        diff: getString(change, "diff") ?? "",
      };
    })
    .filter((change): change is RichFileChange => Boolean(change));
}

export function getRichEventText(message: ChatMessageRecord): string {
  return getString(getEventDataObject(message), "text") ?? message.text;
}

export function getWarningEventText(message: ChatMessageRecord): {
  details: string | null;
  summary: string;
} {
  const eventData = getEventDataObject(message);
  const summary =
    getString(eventData, "message") ??
    getString(eventData, "summary") ??
    message.text;
  return {
    summary,
    details: getString(eventData, "details") ?? null,
  };
}

export function getCommandEventMeta(message: ChatMessageRecord): {
  capReached: boolean;
  command: string | null;
  cwd: string | null;
  durationMs: number | null;
  exitCode: number | null;
  stream: string | null;
  status: string | null;
} {
  const eventData = getEventDataObject(message);
  return {
    capReached: eventData?.capReached === true,
    command: getString(eventData, "command") ?? null,
    cwd: getString(eventData, "cwd") ?? null,
    durationMs: getNumber(eventData, "durationMs") ?? null,
    exitCode: getNumber(eventData, "exitCode") ?? null,
    stream: getString(eventData, "stream") ?? null,
    status: getString(eventData, "status") ?? null,
  };
}

export function getFileEventMeta(message: ChatMessageRecord): {
  status: string | null;
} {
  const eventData = getEventDataObject(message);
  return {
    status: getString(eventData, "status") ?? null,
  };
}

export function getTextLineCount(value: string): number {
  const trimmedValue = value.trimEnd();
  return trimmedValue ? trimmedValue.split(/\r?\n/).length : 0;
}

export function getDiffLineDelta(diff: string): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk && (line.startsWith("+++") || line.startsWith("---"))) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
      continue;
    }
    if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}

export function getFileChangesLineDelta(changes: RichFileChange[]): {
  added: number;
  removed: number;
} {
  return changes.reduce(
    (total, change) => {
      const changeDelta = getDiffLineDelta(change.diff);
      return {
        added: total.added + changeDelta.added,
        removed: total.removed + changeDelta.removed,
      };
    },
    { added: 0, removed: 0 },
  );
}

function getEventDataObject(
  message: ChatMessageRecord,
): Record<string, unknown> | null {
  return isRecord(message.eventData) ? message.eventData : null;
}

function getObjectArray(
  value: Record<string, unknown> | null,
  key: string,
): Array<Record<string, unknown>> {
  const candidate = value?.[key];
  return Array.isArray(candidate) ? candidate.filter(isRecord) : [];
}

function getString(
  value: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function getNumber(
  value: Record<string, unknown> | null,
  key: string,
): number | undefined {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

function getStringArray(
  value: Record<string, unknown> | null,
  key: string,
): string[] {
  const candidate = value?.[key];
  return Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
