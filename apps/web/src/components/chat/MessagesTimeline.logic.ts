export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export type CommandLifecycleState = "queued" | "running" | "completed" | "failed";

export interface TimelineCommandLifecycleInput {
  tone: TimelineWorkTone;
  label: string;
  activityKind?: string | undefined;
  exitCode?: number | null | undefined;
}

export function deriveCommandLifecycleState(
  input: TimelineCommandLifecycleInput,
): CommandLifecycleState {
  if (typeof input.exitCode === "number") {
    return input.exitCode === 0 ? "completed" : "failed";
  }
  if (input.tone === "error") {
    return "failed";
  }
  const normalizedLabel = input.label.trim().toLowerCase();
  const normalizedActivityKind = input.activityKind?.trim().toLowerCase();
  if (
    normalizedLabel === "running command" ||
    normalizedActivityKind === "terminal.command.started" ||
    normalizedActivityKind === "command.output.streaming"
  ) {
    return "running";
  }
  if (
    normalizedLabel === "command queued" ||
    normalizedActivityKind === "terminal.command.queued"
  ) {
    return "queued";
  }
  if (normalizedLabel === "command failed") {
    return "failed";
  }
  return "completed";
}

export function commandLifecycleDisplayLabel(state: CommandLifecycleState): string {
  switch (state) {
    case "running":
      return "Running";
    case "queued":
      return "Queued";
    case "failed":
      return "Failed";
    default:
      return "Done";
  }
}

export type TimelineActionStepStatus = "running" | "done" | "failed";
export type TimelineActionStepType = "read" | "search" | "edit" | "command" | "tool";

export function deriveActionStepStatus(
  input: Pick<TimelineCommandLifecycleInput, "activityKind" | "exitCode" | "label" | "tone">,
): TimelineActionStepStatus {
  const lifecycleState = deriveCommandLifecycleState(input);
  if (lifecycleState === "failed") {
    return "failed";
  }
  if (lifecycleState === "running" || lifecycleState === "queued") {
    return "running";
  }
  return "done";
}

export function deriveActionStepType(input: {
  itemType?: string | undefined;
  requestKind?: string | undefined;
}): TimelineActionStepType {
  if (input.requestKind === "file-read") {
    return "read";
  }
  if (input.itemType === "web_search") {
    return "search";
  }
  if (input.itemType === "file_change") {
    return "edit";
  }
  if (input.itemType === "command_execution" || input.requestKind === "command") {
    return "command";
  }
  return "tool";
}

export function isCommandWorkEntry(input: {
  itemType?: string | undefined;
  requestKind?: string | undefined;
  command?: string | undefined;
}): boolean {
  if (input.itemType === "command_execution") {
    return true;
  }
  return input.requestKind === "command" && typeof input.command === "string";
}

export type TimelineWorkTone = "thinking" | "tool" | "info" | "error";

export type TimelineWorkEntryVisualState = "active" | "recent" | "settled" | "error";
export type TimelineRowKindForAnimation =
  | "message"
  | "work"
  | "command-run"
  | "proposed-plan"
  | "working"
  | null;

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function deriveTimelineWorkEntryVisualState(input: {
  tone: TimelineWorkTone;
  isLiveGroup: boolean;
  isLatestVisibleEntry: boolean;
  entryIndex: number;
  visibleEntryCount: number;
}): TimelineWorkEntryVisualState {
  if (input.tone === "error") {
    return "error";
  }
  if (!input.isLiveGroup) {
    return "settled";
  }
  if (input.isLatestVisibleEntry) {
    return "active";
  }
  return input.entryIndex >= Math.max(input.visibleEntryCount - 3, 0) ? "recent" : "settled";
}

export function shouldAnimateAssistantResponseAfterTool(input: {
  messageRole: TimelineDurationMessage["role"];
  previousRowKind: TimelineRowKindForAnimation;
}): boolean {
  return (
    input.messageRole === "assistant" &&
    (input.previousRowKind === "work" || input.previousRowKind === "command-run")
  );
}
