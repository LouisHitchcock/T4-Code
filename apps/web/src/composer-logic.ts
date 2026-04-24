import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";

export type ComposerTriggerKind = "path" | "slash-command" | "slash-model" | "slash-mcp";
export type ComposerSlashCommand =
  | "model"
  | "mcp"
  | "plan"
  | "default"
  | "init"
  | "new"
  | "compact"
  | "share"
  | "unshare"
  | "undo"
  | "redo"
  | "export"
  | "details";

export interface ComposerSlashInvocation {
  command: string;
  argumentsText: string;
}

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

const COMPOSER_SLASH_COMMAND_ALIASES: Record<ComposerSlashCommand, ReadonlyArray<string>> = {
  model: [],
  mcp: [],
  plan: [],
  default: [],
  init: [],
  new: ["clear"],
  compact: ["summarize"],
  share: [],
  unshare: [],
  undo: [],
  redo: [],
  export: [],
  details: [],
};

export function getComposerSlashCommandAliases(
  command: ComposerSlashCommand,
): ReadonlyArray<string> {
  return COMPOSER_SLASH_COMMAND_ALIASES[command];
}

export function normalizeBuiltInComposerSlashCommand(value: string): ComposerSlashCommand | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  for (const command of Object.keys(COMPOSER_SLASH_COMMAND_ALIASES) as ComposerSlashCommand[]) {
    if (command === normalized || COMPOSER_SLASH_COMMAND_ALIASES[command].includes(normalized)) {
      return command;
    }
  }

  return null;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) {
    index -= 1;
  }
  return index + 1;
}

export function expandCollapsedComposerCursor(text: string, cursorInput: number): number {
  const collapsedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return collapsedCursor;
  }

  let remaining = collapsedCursor;
  let expandedCursor = 0;

  for (const segment of segments) {
    if (segment.type === "mention") {
      const expandedLength = segment.path.length + 1;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return expandedCursor + remaining;
    }
    remaining -= segmentLength;
    expandedCursor += segmentLength;
  }

  return expandedCursor;
}

function collapsedSegmentLength(
  segment: { type: "text"; text: string } | { type: "mention" },
): number {
  return segment.type === "mention" ? 1 : segment.text.length;
}

function clampCollapsedComposerCursorForSegments(
  segments: ReadonlyArray<{ type: "text"; text: string } | { type: "mention" }>,
  cursorInput: number,
): number {
  const collapsedLength = segments.reduce(
    (total, segment) => total + collapsedSegmentLength(segment),
    0,
  );
  if (!Number.isFinite(cursorInput)) {
    return collapsedLength;
  }
  return Math.max(0, Math.min(collapsedLength, Math.floor(cursorInput)));
}

export function clampCollapsedComposerCursor(text: string, cursorInput: number): number {
  return clampCollapsedComposerCursorForSegments(
    splitPromptIntoComposerSegments(text),
    cursorInput,
  );
}

export function collapseExpandedComposerCursor(text: string, cursorInput: number): number {
  const expandedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return expandedCursor;
  }

  let remaining = expandedCursor;
  let collapsedCursor = 0;

  for (const segment of segments) {
    if (segment.type === "mention") {
      const expandedLength = segment.path.length + 1;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return collapsedCursor + remaining;
    }
    remaining -= segmentLength;
    collapsedCursor += segmentLength;
  }

  return collapsedCursor;
}

export function isCollapsedCursorAdjacentToMention(
  text: string,
  cursorInput: number,
  direction: "left" | "right",
): boolean {
  const segments = splitPromptIntoComposerSegments(text);
  if (!segments.some((segment) => segment.type === "mention")) {
    return false;
  }

  const cursor = clampCollapsedComposerCursorForSegments(segments, cursorInput);
  let collapsedOffset = 0;

  for (const segment of segments) {
    if (segment.type === "mention") {
      if (direction === "left" && cursor === collapsedOffset + 1) {
        return true;
      }
      if (direction === "right" && cursor === collapsedOffset) {
        return true;
      }
    }
    collapsedOffset += collapsedSegmentLength(segment);
  }

  return false;
}

export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      if (commandQuery.toLowerCase() === "model") {
        return {
          kind: "slash-model",
          query: "",
          rangeStart: lineStart,
          rangeEnd: cursor,
        };
      }
      if (commandQuery.toLowerCase() === "mcp") {
        return {
          kind: "slash-mcp",
          query: "",
          rangeStart: lineStart,
          rangeEnd: cursor,
        };
      }
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }

    const modelMatch = /^\/model(?:\s+(.*))?$/.exec(linePrefix);
    if (modelMatch) {
      return {
        kind: "slash-model",
        query: (modelMatch[1] ?? "").trim(),
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }

    const mcpMatch = /^\/mcp(?:\s+(.*))?$/.exec(linePrefix);
    if (mcpMatch) {
      return {
        kind: "slash-mcp",
        query: (mcpMatch[1] ?? "").trim(),
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

export function parseStandaloneComposerSlashCommand(
  text: string,
): Exclude<ComposerSlashCommand, "model" | "mcp"> | null {
  const match = /^\/([a-z0-9][a-z0-9_-]*)\s*$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const normalized = normalizeBuiltInComposerSlashCommand(match[1] ?? "");
  if (normalized === null || normalized === "model" || normalized === "mcp") {
    return null;
  }
  return normalized;
}

export function parseStandaloneComposerSlashInvocation(
  text: string,
): ComposerSlashInvocation | null {
  const match = /^\/([a-z0-9][a-z0-9_-]*)(?:\s+(.*))?$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const command = match[1]?.trim().toLowerCase();
  if (!command || normalizeBuiltInComposerSlashCommand(command) !== null) {
    return null;
  }
  return {
    command,
    argumentsText: (match[2] ?? "").trim(),
  };
}

export function parseStandaloneComposerBangCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("!")) {
    return null;
  }
  const command = trimmed.slice(1);
  if (command.trim().length === 0) {
    return null;
  }
  return command;
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}
