import {
  ApprovalRequestId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ModelSlug,
  type ProviderApprovalDecision,
  type ProviderKind,
  type ServerProviderStatus,
  type EditorId,
  type ResolvedKeybindingsConfig,
  ThreadId,
} from "@draft/contracts";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import { isCodexOpenRouterModel, resolveModelSlugForProvider } from "@draft/shared/model";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  EllipsisIcon,
  GlobeIcon,
  HammerIcon,
  ListTodoIcon,
  PlusIcon,
  RefreshCwIcon,
  SendHorizonal,
  SquarePenIcon,
  TerminalIcon,
  TerminalSquareIcon,
  TriangleAlertIcon,
  UserIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useAppSettings } from "../appSettings";
import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX, isScrollContainerNearBottom } from "../chat-scroll";
import ChatMarkdown from "../components/ChatMarkdown";
import GitActionsControl from "../components/GitActionsControl";
import ThreadNewButton from "../components/ThreadNewButton";
import ThreadSidebar from "../components/Sidebar";
import ThreadSidebarToggle from "../components/ThreadSidebarToggle";
import { useComposerDraftStore } from "../composerDraftStore";
import { OpenInPicker } from "../components/chat/OpenInPicker";
import { ComposerPendingApprovalActions } from "../components/chat/ComposerPendingApprovalActions";
import { ProviderModelPicker, type PickerModelOption } from "../components/chat/ProviderModelPicker";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import { Sidebar, SidebarInset, SidebarProvider } from "../components/ui/sidebar";
import { useTheme } from "../hooks/useTheme";
import {
  describeContextWindowState,
  getDocumentedContextWindowOverride,
} from "../lib/contextWindow";
import { buildPatchCacheKey, resolveDiffThemeName } from "../lib/diffRendering";
import { gitStatusQueryOptions } from "../lib/gitReactQuery";
import { isTerminalFocused } from "../lib/terminalFocus";
import { serverConfigQueryOptions, serverOpenCodeStateQueryOptions } from "../lib/serverReactQuery";
import { newCommandId, newMessageId, newThreadId, randomUUID } from "../lib/utils";
import { resolveShortcutCommand } from "../keybindings";
import { readNativeApi } from "../nativeApi";
import {
  deriveActivePlanState,
  findLatestProposedPlan,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  getProviderPickerBackingProvider,
  getProviderPickerKindForSelection,
  type AvailableProviderPickerKind,
  type PendingApproval,
  type PendingUserInput,
  type WorkLogEntry,
} from "../session-logic";
import PlanSidebar from "../components/PlanSidebar";
import {
  commandLifecycleDisplayLabel,
  deriveActionStepStatus,
  deriveActionStepType,
  deriveCommandLifecycleState,
} from "../components/chat/MessagesTimeline.logic";
import { useStore } from "../store";
import {
  selectThreadTerminalControlState,
  selectThreadTerminalState,
  useTerminalStateStore,
  type ThreadTerminalControlState,
} from "../terminalStateStore";
import type { Thread } from "../types";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_EDITORS: EditorId[] = [];
const DRAFT_TERMINAL_COLS = 120;
const DRAFT_TERMINAL_ROWS = 36;
const DRAFT_PROVIDER_PRIORITY: readonly ProviderKind[] = [
  "codex",
  "copilot",
  "opencode",
  "kimi",
  "pi",
];
function resolveTemporaryForcedProvider(): ProviderKind | null {
  return null;
}

interface RuntimeNotice {
  id: string;
  tone: "success" | "error" | "info";
  text: string;
  kind: "general" | "status-continuity";
}
interface DraftTerminalRunEntry {
  id: string;
  threadId: ThreadId;
  terminalId: string;
  command: string;
  output: string;
  status: "running" | "done" | "failed";
  surfacedToAgentAt?: string;
  createdAt: string;
  updatedAt: string;
}

type DraftComposerMode = "auto" | "task" | "command";
const DRAFT_TERMINAL_CONTEXT_START = "[[draft_terminal_context_start]]";
const DRAFT_TERMINAL_CONTEXT_END = "[[draft_terminal_context_end]]";
const WINDOWS_PROMPT_CWD_PATTERN = /(?:PS\s+)?([A-Za-z]:\\[^>\r\n]*)>/g;

function formatDraftContextUsage(input: { usedTokens: number | null; totalTokens: number | null }): string {
  if (
    input.usedTokens !== null &&
    input.totalTokens !== null &&
    input.totalTokens > 0 &&
    Number.isFinite(input.usedTokens) &&
    Number.isFinite(input.totalTokens)
  ) {
    const percent = Math.max(0, Math.min(100, Math.round((input.usedTokens / input.totalTokens) * 100)));
    return `${percent}% context`;
  }
  return "context n/a";
}

function resolveDraftPickerModelOptionsByProvider(input: {
  providerStatuses: ReadonlyArray<ServerProviderStatus>;
  selectedProvider: ProviderKind;
  selectedModel: string;
  projectDefaultProvider: ProviderKind | null;
  projectDefaultModel: string | null;
}): Record<ProviderKind, ReadonlyArray<PickerModelOption>> {
  const byProvider: Record<ProviderKind, PickerModelOption[]> = {
    codex: [],
    copilot: [],
    opencode: [],
    kimi: [],
    pi: [],
  };
  const seenByProvider = new Map<ProviderKind, Set<string>>();
  const appendOption = (provider: ProviderKind, option: PickerModelOption) => {
    const normalizedSlug = option.slug.trim();
    if (!normalizedSlug) {
      return;
    }
    const seen = seenByProvider.get(provider) ?? new Set<string>();
    if (seen.has(normalizedSlug)) {
      return;
    }
    seen.add(normalizedSlug);
    seenByProvider.set(provider, seen);
    byProvider[provider].push({ ...option, slug: normalizedSlug });
  };

  for (const status of input.providerStatuses) {
    for (const model of status.availableModels ?? []) {
      appendOption(status.provider, {
        slug: model.slug,
        name: model.name,
        ...(typeof model.supportsReasoning === "boolean"
          ? { supportsReasoning: model.supportsReasoning }
          : {}),
        ...(typeof model.supportsImageInput === "boolean"
          ? { supportsImageInput: model.supportsImageInput }
          : {}),
        ...(typeof model.contextWindowTokens === "number"
          ? { contextWindowTokens: model.contextWindowTokens }
          : {}),
      });
    }
  }

  appendOption(input.selectedProvider, {
    slug: input.selectedModel,
    name: input.selectedModel,
  });

  if (input.projectDefaultProvider && input.projectDefaultModel) {
    appendOption(input.projectDefaultProvider, {
      slug: input.projectDefaultModel,
      name: input.projectDefaultModel,
    });
  }

  return byProvider;
}
function buildProviderOptionsForDispatch(input: {
  readonly provider: ProviderKind;
  readonly settings: {
    readonly codexBinaryPath: string;
    readonly codexHomePath: string;
    readonly openAiApiKey: string;
    readonly openRouterApiKey: string;
    readonly copilotBinaryPath: string;
    readonly opencodeBinaryPath: string;
    readonly opencodePromptTimeoutMs: number;
    readonly kimiBinaryPath: string;
    readonly kimiApiKey: string;
  };
}) {
  const codexBinaryPath = input.settings.codexBinaryPath.trim();
  const codexHomePath = input.settings.codexHomePath.trim();
  const openAiApiKey = input.settings.openAiApiKey.trim();
  const openRouterApiKey = input.settings.openRouterApiKey.trim();
  const copilotBinaryPath = input.settings.copilotBinaryPath.trim();
  const opencodeBinaryPath = input.settings.opencodeBinaryPath.trim();
  const opencodePromptTimeoutMs = Math.round(input.settings.opencodePromptTimeoutMs);
  const kimiBinaryPath = input.settings.kimiBinaryPath.trim();
  const kimiApiKey = input.settings.kimiApiKey.trim();

  switch (input.provider) {
    case "codex":
      return codexBinaryPath || codexHomePath || openAiApiKey || openRouterApiKey
        ? {
            codex: {
              ...(codexBinaryPath ? { binaryPath: codexBinaryPath } : {}),
              ...(codexHomePath ? { homePath: codexHomePath } : {}),
              ...(openAiApiKey ? { openAiApiKey } : {}),
              ...(openRouterApiKey ? { openRouterApiKey } : {}),
            },
          }
        : undefined;
    case "copilot":
      return copilotBinaryPath
        ? {
            copilot: {
              binaryPath: copilotBinaryPath,
            },
          }
        : undefined;
    case "opencode":
      return (
        opencodeBinaryPath ||
        openRouterApiKey ||
        (Number.isInteger(opencodePromptTimeoutMs) && opencodePromptTimeoutMs > 0)
      )
        ? {
            opencode: {
              ...(opencodeBinaryPath ? { binaryPath: opencodeBinaryPath } : {}),
              ...(openRouterApiKey ? { openRouterApiKey } : {}),
              ...(Number.isInteger(opencodePromptTimeoutMs) && opencodePromptTimeoutMs > 0
                ? { promptTimeoutMs: opencodePromptTimeoutMs }
                : {}),
              useClientToolBridge: true,
            },
          }
        : undefined;
    case "kimi":
      return kimiBinaryPath || kimiApiKey
        ? {
            kimi: {
              ...(kimiBinaryPath ? { binaryPath: kimiBinaryPath } : {}),
              ...(kimiApiKey ? { apiKey: kimiApiKey } : {}),
            },
          }
        : undefined;
    case "pi":
      return undefined;
    default:
      return undefined;
  }
}

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function truncateTitle(title: string): string {
  const compact = title.trim().replace(/\s+/g, " ");
  if (compact.length <= 72) return compact;
  return `${compact.slice(0, 69)}...`;
}
function stripDraftTerminalContextEnvelope(text: string): string {
  const start = text.indexOf(DRAFT_TERMINAL_CONTEXT_START);
  if (start < 0) return text;
  return text.slice(0, start).trimEnd();
}
function normalizeWindowsPathSegments(input: string): string {
  const normalizedSlashes = input.replace(/\//g, "\\").trim();
  const driveMatch = /^([A-Za-z]:)(\\.*)?$/.exec(normalizedSlashes);
  if (!driveMatch) {
    return normalizedSlashes;
  }
  const drive = driveMatch[1]!;
  const rest = driveMatch[2] ?? "\\";
  const rawSegments = rest.split("\\").filter((segment) => segment.length > 0);
  const resolved: string[] = [];
  for (const segment of rawSegments) {
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return `${drive}\\${resolved.join("\\")}`.replace(/\\$/, resolved.length === 0 ? "\\" : "");
}
function normalizeWindowsCwdCandidate(rawCwd: string): string | null {
  const cleaned = stripAnsiAndOscSequences(rawCwd)
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .replace(/\//g, "\\");
  if (cleaned.length === 0) {
    return null;
  }
  const driveMatches = [...cleaned.matchAll(/[A-Za-z]:\\/g)];
  const collapsed =
    driveMatches.length > 1
      ? cleaned.slice(driveMatches[0]!.index!, driveMatches[1]!.index)
      : cleaned;
  const normalized = normalizeWindowsPathSegments(collapsed);
  return /^[A-Za-z]:\\/.test(normalized) ? normalized : null;
}
function resolveCdTargetCwd(command: string, currentCwd: string | null): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const cdMatch = /^(?:cd|set-location)\s+(.+)$/i.exec(trimmed);
  if (!cdMatch?.[1]) {
    return null;
  }
  const rawArg = cdMatch[1].trim().replace(/^['"]|['"]$/g, "");
  if (!rawArg || rawArg.startsWith("-")) {
    return null;
  }
  if (/^[A-Za-z]:\\/.test(rawArg) || /^[A-Za-z]:$/.test(rawArg)) {
    return normalizeWindowsCwdCandidate(rawArg.length === 2 ? `${rawArg}\\` : rawArg);
  }
  const base = normalizeWindowsCwdCandidate(currentCwd ?? "");
  if (!base) {
    return null;
  }
  const baseDrive = /^([A-Za-z]:)\\/.exec(base)?.[1] ?? null;
  if (!baseDrive) {
    return null;
  }
  if (rawArg.startsWith("\\")) {
    return normalizeWindowsCwdCandidate(`${baseDrive}${rawArg}`);
  }
  return normalizeWindowsCwdCandidate(`${base}\\${rawArg}`);
}
function resolveCwdContextLabel(input: {
  cwd: string;
  projects: ReadonlyArray<{ name: string; cwd: string }>;
}): string {
  const projectMatch = input.projects.find(
    (project) => normalizeWindowsCwdCandidate(project.cwd) === input.cwd,
  );
  if (projectMatch) {
    return projectMatch.name;
  }
  const normalized = input.cwd.replace(/\\+$/, "");
  const segments = normalized.split("\\").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? input.cwd;
}
function extractLatestPromptCwdFromTerminalOutput(outputChunk: string): string | null {
  const sanitizedChunk = stripAnsiAndOscSequences(outputChunk).replace(/[\u0000-\u001F\u007F]/g, "");
  let match: RegExpExecArray | null = null;
  let latestCwd: string | null = null;
  WINDOWS_PROMPT_CWD_PATTERN.lastIndex = 0;
  while ((match = WINDOWS_PROMPT_CWD_PATTERN.exec(sanitizedChunk)) !== null) {
    latestCwd = normalizeWindowsCwdCandidate(match[1] ?? "") ?? latestCwd;
  }
  return latestCwd;
}
function isCommandWorkEntry(entry: WorkLogEntry): boolean {
  return (
    entry.itemType === "command_execution" || entry.requestKind === "command" || Boolean(entry.command)
  );
}
function commandMergeKey(entry: WorkLogEntry): string | null {
  const runId = entry.runId?.trim();
  if (runId && runId.length > 0) {
    return `run:${runId}`;
  }
  const itemId = entry.itemId?.trim();
  if (itemId && itemId.length > 0) {
    return `item:${itemId}`;
  }
  const command = entry.command?.trim();
  if (command && command.length > 0) {
    return `command:${command.toLowerCase()}`;
  }
  return null;
}
function isRunningCommandEntry(entry: WorkLogEntry): boolean {
  const activityKind = entry.activityKind?.trim().toLowerCase();
  const label = entry.label.trim().toLowerCase();
  return (
    label === "running command" ||
    activityKind === "terminal.command.started" ||
    activityKind === "command.output.streaming"
  );
}
function isSettledCommandEntry(entry: WorkLogEntry): boolean {
  const activityKind = entry.activityKind?.trim().toLowerCase();
  const label = entry.label.trim().toLowerCase();
  if (
    activityKind === "terminal.command.completed" ||
    activityKind === "terminal.command.exited" ||
    activityKind === "terminal.command.failed" ||
    activityKind === "tool.completed" ||
    label === "command completed" ||
    label === "command failed"
  ) {
    return true;
  }
  if (entry.exitCode !== undefined) {
    return true;
  }
  return false;
}
function mergeCommandOutputDetail(
  currentDetail: string | undefined,
  incomingDetail: string | undefined,
): string | undefined {
  if (!currentDetail) {
    return incomingDetail;
  }
  if (!incomingDetail) {
    return currentDetail;
  }
  if (incomingDetail.includes(currentDetail)) {
    return incomingDetail;
  }
  if (currentDetail.includes(incomingDetail)) {
    return currentDetail;
  }
  const separator =
    currentDetail.endsWith("\n") || incomingDetail.startsWith("\n") ? "" : "\n";
  return `${currentDetail}${separator}${incomingDetail}`;
}
function isRuntimeErrorLikeEntry(entry: WorkLogEntry): boolean {
  const activityKind = entry.activityKind?.trim().toLowerCase();
  const label = entry.label.trim().toLowerCase();
  return activityKind === "runtime.error" || label === "runtime error";
}
function mergeIntoCommandEntry(existing: WorkLogEntry, entry: WorkLogEntry): WorkLogEntry {
  const mergedCommand = entry.command ?? existing.command;
  const mergedDetail = mergeCommandOutputDetail(existing.detail, entry.detail);
  const mergedChangedFiles = entry.changedFiles ?? existing.changedFiles;
  const mergedItemType = entry.itemType ?? existing.itemType;
  const mergedRequestKind = entry.requestKind ?? existing.requestKind;
  const mergedToolTitle = entry.toolTitle ?? existing.toolTitle;
  const mergedItemId = entry.itemId ?? existing.itemId;
  const mergedActivityKind = entry.activityKind ?? existing.activityKind;
  const runtimeErrorLike = isRuntimeErrorLikeEntry(entry);
  const hasErrorTone = existing.tone === "error" || entry.tone === "error" || runtimeErrorLike;
  const normalizedEntryLabel = entry.label.trim().toLowerCase();
  const mergedLabel =
    runtimeErrorLike
      ? existing.label
      : hasErrorTone && normalizedEntryLabel === "command completed"
        ? existing.label
        : entry.label;
  const mergedTone = hasErrorTone ? "error" : entry.tone;
  const mergedExitCode = entry.exitCode !== undefined ? entry.exitCode : existing.exitCode;
  return {
    ...existing,
    ...entry,
    createdAt: existing.createdAt,
    tone: mergedTone,
    label: mergedLabel,
    ...(mergedExitCode !== undefined ? { exitCode: mergedExitCode } : {}),
    ...(mergedCommand !== undefined ? { command: mergedCommand } : {}),
    ...(mergedDetail !== undefined ? { detail: mergedDetail } : {}),
    ...(mergedChangedFiles !== undefined ? { changedFiles: mergedChangedFiles } : {}),
    ...(mergedItemType !== undefined ? { itemType: mergedItemType } : {}),
    ...(mergedRequestKind !== undefined ? { requestKind: mergedRequestKind } : {}),
    ...(mergedToolTitle !== undefined ? { toolTitle: mergedToolTitle } : {}),
    ...(existing.alwaysVisible || entry.alwaysVisible ? { alwaysVisible: true } : {}),
    ...(mergedItemId !== undefined ? { itemId: mergedItemId } : {}),
    ...(mergedActivityKind !== undefined ? { activityKind: mergedActivityKind } : {}),
  };
}
function mergeCommandProgressEntries(entries: ReadonlyArray<WorkLogEntry>): WorkLogEntry[] {
  const merged: WorkLogEntry[] = [];
  const activeCommandIndexByKey = new Map<string, number>();
  const latestCommandIndexByKey = new Map<string, number>();
  const latestCommandIndexByTurnId = new Map<string, number>();
  let latestCommandIndex: number | undefined;
  const rememberLatestCommandIndex = (entry: WorkLogEntry, index: number) => {
    latestCommandIndex = index;
    if (entry.turnId) {
      latestCommandIndexByTurnId.set(entry.turnId, index);
    }
  };
  const resolveFallbackCommandIndex = (entry: WorkLogEntry): number | undefined => {
    if (entry.turnId) {
      const latestTurnCommandIndex = latestCommandIndexByTurnId.get(entry.turnId);
      if (latestTurnCommandIndex !== undefined) {
        return latestTurnCommandIndex;
      }
    }
    let latestActiveCommandIndex: number | undefined;
    for (const candidateIndex of activeCommandIndexByKey.values()) {
      if (latestActiveCommandIndex === undefined || candidateIndex > latestActiveCommandIndex) {
        latestActiveCommandIndex = candidateIndex;
      }
    }
    return latestActiveCommandIndex ?? latestCommandIndex;
  };
  for (const entry of entries) {
    const key = commandMergeKey(entry);
    if (!isCommandWorkEntry(entry)) {
      if (key) {
        const latestIndex = latestCommandIndexByKey.get(key);
        const existing = latestIndex !== undefined ? merged[latestIndex] : undefined;
        if (latestIndex !== undefined && existing && isCommandWorkEntry(existing)) {
          merged[latestIndex] = mergeIntoCommandEntry(existing, entry);
          rememberLatestCommandIndex(merged[latestIndex] ?? existing, latestIndex);
          continue;
        }
      }
      if (isRuntimeErrorLikeEntry(entry)) {
        const fallbackIndex = resolveFallbackCommandIndex(entry);
        const fallbackCommand = fallbackIndex !== undefined ? merged[fallbackIndex] : undefined;
        if (fallbackIndex !== undefined && fallbackCommand && isCommandWorkEntry(fallbackCommand)) {
          merged[fallbackIndex] = mergeIntoCommandEntry(fallbackCommand, entry);
          rememberLatestCommandIndex(merged[fallbackIndex] ?? fallbackCommand, fallbackIndex);
          continue;
        }
      }
      merged.push(entry);
      continue;
    }
    if (!key) {
      merged.push(entry);
      rememberLatestCommandIndex(entry, merged.length - 1);
      continue;
    }
    const existingIndex = activeCommandIndexByKey.get(key);
    if (existingIndex === undefined) {
      merged.push(entry);
      latestCommandIndexByKey.set(key, merged.length - 1);
      rememberLatestCommandIndex(entry, merged.length - 1);
      if (!isSettledCommandEntry(entry)) {
        activeCommandIndexByKey.set(key, merged.length - 1);
      } else {
        activeCommandIndexByKey.delete(key);
      }
      continue;
    }
    const existing = merged[existingIndex];
    if (!existing || !isCommandWorkEntry(existing)) {
      activeCommandIndexByKey.delete(key);
      merged.push(entry);
      latestCommandIndexByKey.set(key, merged.length - 1);
      rememberLatestCommandIndex(entry, merged.length - 1);
      if (!isSettledCommandEntry(entry)) {
        activeCommandIndexByKey.set(key, merged.length - 1);
      }
      continue;
    }
    merged[existingIndex] = mergeIntoCommandEntry(existing, entry);
    latestCommandIndexByKey.set(key, existingIndex);
    rememberLatestCommandIndex(merged[existingIndex] ?? existing, existingIndex);
    if (isSettledCommandEntry(entry)) {
      activeCommandIndexByKey.delete(key);
    } else {
      activeCommandIndexByKey.set(key, existingIndex);
    }
  }
  return merged;
}

function commandStatusLabel(entry: WorkLogEntry): "Running" | "Done" | "Failed" {
  const lifecycleState = deriveCommandLifecycleState({
    tone: entry.tone,
    label: entry.label,
    activityKind: entry.activityKind,
    exitCode: entry.exitCode,
  });
  const label = commandLifecycleDisplayLabel(lifecycleState);
  if (label === "Running") {
    return "Running";
  }
  return label === "Failed" ? "Failed" : "Done";
}
function commandDropdownStateKey(entry: WorkLogEntry): string {
  return commandMergeKey(entry) ?? `entry:${entry.id}`;
}
const DRAFT_PROGRESS_QUERY_PATTERNS: ReadonlyArray<RegExp> = [
  /\bhow(?:\s+is|'s)\s+it\s+going\b/i,
  /\bstatus(?:\s+update)?\b/i,
  /\bprogress\b/i,
  /\bwhat(?:'s|\s+is)\s+happening\b/i,
  /\bwhat(?:'s|\s+is)\s+the\s+update\b/i,
  /\bwhat\s+are\s+you\s+working\s+on\b/i,
];
function isDraftProgressStatusQuery(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return DRAFT_PROGRESS_QUERY_PATTERNS.some((pattern) => pattern.test(normalized));
}
function buildDraftProgressStatusNotice(input: {
  activeThread: Thread | null;
  isThreadBusy: boolean;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  activeTerminalRuns: ReadonlyArray<DraftTerminalRunEntry>;
  pendingApprovals: ReadonlyArray<PendingApproval>;
  pendingUserInputs: ReadonlyArray<PendingUserInput>;
}): string {
  if (!input.activeThread) {
    return "No active thread is selected right now.";
  }
  type DraftTimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
  const latestWorkEntry = [...input.timelineEntries]
    .reverse()
    .find(
      (entry): entry is Extract<DraftTimelineEntry, { kind: "work" }> => entry.kind === "work",
    )?.entry;
  const latestAssistantMessage = [...input.timelineEntries]
    .reverse()
    .find(
      (
        entry,
      ): entry is Extract<DraftTimelineEntry, { kind: "message" }> =>
        entry.kind === "message" && entry.message.role === "assistant",
    )?.message;
  const runningTerminalRuns = input.activeTerminalRuns.filter((run) => run.status === "running");
  const parts: string[] = [];
  parts.push(
    input.isThreadBusy
      ? "Run is still in progress."
      : "No provider turn is running right now.",
  );
  if (latestWorkEntry) {
    const commandOrLabel = latestWorkEntry.command?.trim() || latestWorkEntry.label.trim();
    if (commandOrLabel.length > 0) {
      parts.push(`Latest action: ${commandOrLabel}.`);
    }
  }
  if (runningTerminalRuns.length > 0) {
    const latestRun = runningTerminalRuns[runningTerminalRuns.length - 1];
    if (latestRun) {
      const latestCommand = latestRun.command.trim();
      parts.push(
        latestCommand.length > 0
          ? `Running shell command: ${latestCommand}.`
          : "A shell command is currently running.",
      );
    }
  }
  if (latestAssistantMessage?.streaming) {
    parts.push("Assistant output is still streaming.");
  }
  if (input.pendingApprovals.length > 0) {
    parts.push(
      `${input.pendingApprovals.length} approval request${input.pendingApprovals.length === 1 ? "" : "s"} waiting.`,
    );
  }
  if (input.pendingUserInputs.length > 0) {
    parts.push(
      `${input.pendingUserInputs.length} input request${input.pendingUserInputs.length === 1 ? "" : "s"} waiting.`,
    );
  }
  return parts.join(" ");
}
interface DraftCommandEntryRowProps {
  workEntry: WorkLogEntry;
  commandLabel: string;
  status: "Running" | "Done" | "Failed";
  isOutputExpanded: boolean;
  onOutputExpandedChange: (expanded: boolean) => void;
  showTerminalActions: boolean;
  terminalControlState: ThreadTerminalControlState;
  onOpenTerminal: () => void;
  onTakeOver: () => void;
  onHandBack: () => void;
}
function DraftCommandEntryRow({
  workEntry,
  commandLabel,
  status,
  isOutputExpanded,
  onOutputExpandedChange,
  showTerminalActions,
  terminalControlState,
  onOpenTerminal,
  onTakeOver,
  onHandBack,
}: DraftCommandEntryRowProps) {
  const output = workEntry.detail?.trimEnd() ?? "";
  const hasOutput = output.length > 0;
  const outputScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollOutputRef = useRef(true);
  const [showOutputScrollToBottom, setShowOutputScrollToBottom] = useState(false);

  const scrollOutputToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const outputScroll = outputScrollRef.current;
    if (!outputScroll) return;
    outputScroll.scrollTo({ top: outputScroll.scrollHeight, behavior });
    shouldAutoScrollOutputRef.current = true;
    setShowOutputScrollToBottom(false);
  }, []);

  const onOutputScroll = useCallback(() => {
    const outputScroll = outputScrollRef.current;
    if (!outputScroll) return;
    const nearBottom = isScrollContainerNearBottom(
      outputScroll,
      AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
    );
    shouldAutoScrollOutputRef.current = nearBottom;
    setShowOutputScrollToBottom(!nearBottom);
  }, []);

  useEffect(() => {
    if (!isOutputExpanded) return;
    shouldAutoScrollOutputRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      scrollOutputToBottom();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [isOutputExpanded, scrollOutputToBottom]);

  useLayoutEffect(() => {
    if (!isOutputExpanded || !shouldAutoScrollOutputRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      scrollOutputToBottom();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [hasOutput, isOutputExpanded, output, scrollOutputToBottom]);

  return (
    <div className="ml-7">
      <Collapsible open={isOutputExpanded} onOpenChange={onOutputExpandedChange}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition hover:border-border hover:bg-muted/40">
          <TerminalSquareIcon className="size-3.5 shrink-0 text-primary" />
          <code className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
            {commandLabel}
          </code>
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
              status === "Failed"
                ? "border-destructive/50 bg-destructive/15 text-destructive"
                : status === "Running"
                  ? "border-primary/50 bg-primary/15 text-primary"
                  : "border-success/50 bg-success/15 text-success"
            }`}
          >
            {status}
          </span>
          <ChevronDownIcon
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
              isOutputExpanded ? "rotate-180" : ""
            }`}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="pl-2">
          {showTerminalActions ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 px-1 pb-2">
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="border-border bg-background/90 text-foreground hover:bg-muted/50"
                onClick={onOpenTerminal}
              >
                Open terminal
              </Button>
              {terminalControlState === "agent-attached" ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="border-border bg-background/90 text-foreground hover:bg-muted/50"
                  onClick={onTakeOver}
                >
                  Take over
                </Button>
              ) : (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="border-border bg-background/90 text-foreground hover:bg-muted/50"
                  onClick={onHandBack}
                >
                  Hand back
                </Button>
              )}
            </div>
          ) : null}
          <div className="mt-2 overflow-hidden rounded-2xl border border-border bg-card shadow-lg">
            <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                <TerminalIcon className="size-3.5" />
                <span>Viewing command detail</span>
              </div>
              <span className="text-[11px] text-muted-foreground">{workEntry.label}</span>
            </div>
            <div className="border-b border-border bg-muted/25 px-3 py-2">
              <code className="block break-words font-mono text-[11px] text-foreground">
                {commandLabel}
              </code>
            </div>
            <div className="relative">
              <div
                ref={outputScrollRef}
                onScroll={onOutputScroll}
                className="max-h-[72vh] overflow-y-auto px-3 py-3"
              >
                {hasOutput ? (
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                    {output}
                  </pre>
                ) : (
                  <p className="font-mono text-xs text-muted-foreground">
                    {status === "Running" ? "Waiting for output..." : workEntry.label}
                  </p>
                )}
              </div>
              {showOutputScrollToBottom ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 flex justify-center px-2">
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    className="pointer-events-auto border-border bg-background/95 text-foreground hover:bg-muted/50"
                    onClick={() => scrollOutputToBottom("smooth")}
                  >
                    <ChevronDownIcon className="size-3.5" />
                    Follow output
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

interface DraftFileChangeTab {
  path: string;
  content: string | null;
}

function normalizeDiffPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) {
    return trimmed.slice(2);
  }
  return trimmed;
}
function normalizeDiffPathForComparison(path: string): string {
  return normalizeDiffPath(path)
    .replace(/\\/g, "/")
    .replace(/^[a-z]:\//i, "")
    .replace(/^\/+/, "")
    .replace(/^\.\/+/, "")
    .toLowerCase();
}
function diffPathMatchScore(leftPath: string, rightPath: string): number {
  if (leftPath.length === 0 || rightPath.length === 0) {
    return -1;
  }
  if (leftPath === rightPath) {
    return Math.max(leftPath.length, rightPath.length) + 1000;
  }
  if (leftPath.endsWith(`/${rightPath}`)) {
    return rightPath.length;
  }
  if (rightPath.endsWith(`/${leftPath}`)) {
    return leftPath.length;
  }
  return -1;
}
function findBestMatchingDiffTab(input: {
  changedFilePath: string;
  diffTabsByPath: ReadonlyMap<string, DraftFileChangeTab>;
  consumedNormalizedPaths: ReadonlySet<string>;
}): { normalizedPath: string; tab: DraftFileChangeTab } | null {
  const normalizedChangedPath = normalizeDiffPathForComparison(input.changedFilePath);
  let bestMatch: { normalizedPath: string; tab: DraftFileChangeTab } | null = null;
  let bestScore = -1;
  for (const [normalizedPath, tab] of input.diffTabsByPath.entries()) {
    if (input.consumedNormalizedPaths.has(normalizedPath)) {
      continue;
    }
    const score = diffPathMatchScore(normalizedChangedPath, normalizedPath);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = { normalizedPath, tab };
    }
  }
  return bestScore >= 0 ? bestMatch : null;
}

function extractDiffPath(diffBlock: string): string | null {
  const diffHeaderMatch = /^diff --git a\/(.+?) b\/(.+)$/m.exec(diffBlock);
  if (diffHeaderMatch?.[2]) {
    return normalizeDiffPath(diffHeaderMatch[2]);
  }
  const nextFileMatch = /^\+\+\+ b\/(.+)$/m.exec(diffBlock);
  if (nextFileMatch?.[1]) {
    return normalizeDiffPath(nextFileMatch[1]);
  }
  const oldFileMatch = /^--- a\/(.+)$/m.exec(diffBlock);
  if (oldFileMatch?.[1]) {
    return normalizeDiffPath(oldFileMatch[1]);
  }
  return null;
}

function splitUnifiedDiffByFile(text: string): Array<{ path: string; content: string }> {
  const blocks = text
    .split(/^diff --git /m)
    .map((block, index) => (index === 0 ? block : `diff --git ${block}`))
    .filter((block) => block.trim().length > 0 && block.trimStart().startsWith("diff --git "));
  return blocks
    .map((block) => {
      const path = extractDiffPath(block);
      if (!path) {
        return null;
      }
      return {
        path,
        content: block.trimEnd(),
      };
    })
    .filter((entry): entry is { path: string; content: string } => entry !== null);
}
function isLikelyUnifiedHunkOnlyText(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^@@ /m.test(trimmed) &&
    !/^diff --git /m.test(trimmed) &&
    !/^--- a\//m.test(trimmed) &&
    !/^\+\+\+ b\//m.test(trimmed)
  );
}
function toSyntheticDiffPath(path: string): string {
  const normalized = normalizeDiffPath(path)
    .replace(/\\/g, "/")
    .replace(/^[a-z]:\//i, "")
    .replace(/^\/+/, "")
    .replace(/^\.\/+/, "")
    .trim();
  return normalized.length > 0 ? normalized : "file";
}
function buildSyntheticUnifiedDiff(content: string, filePath: string): string {
  const normalizedPath = toSyntheticDiffPath(filePath);
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    `--- a/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    content.trim(),
  ].join("\n");
}
const DRAFT_FILE_DIFF_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-font-family: var(--font-code-snippet) !important;
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;
  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));
  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));
  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(
    in srgb,
    var(--background) 88%,
    var(--destructive)
  );
  --diffs-bg-deletion-hover-override: color-mix(
    in srgb,
    var(--background) 85%,
    var(--destructive)
  );
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );
  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
}
`;
function formatDraftFileChangeTabLabel(path: string): string {
  const normalizedPath = normalizeDiffPath(path).replace(/\\/g, "/").trim();
  if (normalizedPath.length === 0) {
    return "file";
  }
  const pathSegments = normalizedPath.split("/").filter((segment) => segment.length > 0);
  if (pathSegments.length <= 3) {
    return normalizedPath;
  }
  return `…/${pathSegments.slice(-3).join("/")}`;
}
type DraftFileChangeRenderableContent =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };
function parseDraftFileChangeContent(input: {
  content: string;
  cacheScope: string;
  fallbackFilePath: string;
}): DraftFileChangeRenderableContent {
  const normalizedContent = input.content.trim();
  if (normalizedContent.length === 0) {
    return {
      kind: "raw",
      text: normalizedContent,
      reason: "Diff content is empty for the selected file.",
    };
  }
  const parseFileDiffs = (patchText: string, cacheScope: string): FileDiffMetadata[] | null => {
    try {
      const files = parsePatchFiles(patchText, buildPatchCacheKey(patchText, cacheScope)).flatMap(
        (parsedPatch) => parsedPatch.files,
      );
      return files.length > 0 ? files : null;
    } catch {
      return null;
    }
  };
  const parsedFiles = parseFileDiffs(normalizedContent, input.cacheScope);
  if (parsedFiles) {
    return { kind: "files", files: parsedFiles };
  }
  if (isLikelyUnifiedHunkOnlyText(normalizedContent)) {
    const syntheticDiff = buildSyntheticUnifiedDiff(normalizedContent, input.fallbackFilePath);
    const parsedSyntheticFiles = parseFileDiffs(syntheticDiff, `${input.cacheScope}:synthetic`);
    if (parsedSyntheticFiles) {
      return { kind: "files", files: parsedSyntheticFiles };
    }
  }
  try {
    return {
      kind: "raw",
      text: normalizedContent,
      reason: "Unsupported diff format. Showing raw diff text.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedContent,
      reason: "Failed to parse diff content. Showing raw diff text.",
    };
  }
}
function resolveDraftFileDiffPath(fileDiff: FileDiffMetadata): string {
  const rawPath = fileDiff.name ?? fileDiff.prevName ?? "";
  return normalizeDiffPath(rawPath);
}
function buildDraftFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

function buildFileChangeTabs(entry: WorkLogEntry): DraftFileChangeTab[] {
  const changedFiles = [...new Set((entry.changedFiles ?? []).map((path) => path.trim()))].filter(
    (path) => path.length > 0,
  );
  const structuredFileDiffs = (entry.fileDiffs ?? [])
    .map((fileDiff) => ({
      path: fileDiff.path.trim(),
      content: fileDiff.diff.trim(),
    }))
    .filter((fileDiff) => fileDiff.path.length > 0 && fileDiff.content.length > 0);
  const detail = entry.detail?.trim();
  const diffBlocks = detail ? splitUnifiedDiffByFile(detail) : [];
  const tabByNormalizedPath = new Map<string, DraftFileChangeTab>();
  const diffTabCandidates =
    structuredFileDiffs.length > 0
      ? structuredFileDiffs
      : diffBlocks.map((diffBlock) => ({ path: diffBlock.path, content: diffBlock.content }));

  for (const diffTab of diffTabCandidates) {
    const normalizedPath = normalizeDiffPathForComparison(diffTab.path);
    if (!tabByNormalizedPath.has(normalizedPath)) {
      tabByNormalizedPath.set(normalizedPath, { path: diffTab.path, content: diffTab.content });
    }
  }

  if (tabByNormalizedPath.size === 0 && changedFiles.length === 0) {
    if (!detail) {
      return [];
    }
    return [{ path: "details", content: detail }];
  }

  if (detail && tabByNormalizedPath.size === 0 && changedFiles.length > 0) {
    return changedFiles.map((path) => ({
      path,
      content: detail,
    }));
  }

  const tabs: DraftFileChangeTab[] = [];
  const consumedNormalizedPaths = new Set<string>();
  for (const changedFilePath of changedFiles) {
    const matchedDiffTab = findBestMatchingDiffTab({
      changedFilePath,
      diffTabsByPath: tabByNormalizedPath,
      consumedNormalizedPaths,
    });
    if (matchedDiffTab) {
      consumedNormalizedPaths.add(matchedDiffTab.normalizedPath);
    }
    tabs.push({
      path: changedFilePath,
      content: matchedDiffTab?.tab.content ?? null,
    });
  }
  for (const [normalizedPath, tab] of tabByNormalizedPath.entries()) {
    if (consumedNormalizedPaths.has(normalizedPath)) {
      continue;
    }
    tabs.push(tab);
  }
  return tabs;
}

function DraftFileChangesPanel({ workEntry }: { workEntry: WorkLogEntry }) {
  const { resolvedTheme, activeCustomThemeId } = useTheme();
  const tabs = useMemo(() => buildFileChangeTabs(workEntry), [workEntry]);
  const [isOpen, setIsOpen] = useState(false);
  const [activePath, setActivePath] = useState<string>(tabs[0]?.path ?? "");
  const activeTab = tabs.find((tab) => tab.path === activePath) ?? tabs[0] ?? null;
  const parsedActiveTabContent = useMemo(() => {
    if (!activeTab?.content) {
      return null;
    }
    return parseDraftFileChangeContent({
      content: activeTab.content,
      cacheScope: `draft-file-change:${workEntry.id}:${activeTab.path}`,
      fallbackFilePath: activeTab.path,
    });
  }, [activeTab?.content, activeTab?.path, workEntry.id]);
  const activeTabDiffFiles = useMemo(() => {
    if (!activeTab || !parsedActiveTabContent || parsedActiveTabContent.kind !== "files") {
      return [] as FileDiffMetadata[];
    }
    const normalizedActivePath = normalizeDiffPathForComparison(activeTab.path);
    return [...parsedActiveTabContent.files].toSorted((left, right) => {
      const leftPath = normalizeDiffPathForComparison(resolveDraftFileDiffPath(left));
      const rightPath = normalizeDiffPathForComparison(resolveDraftFileDiffPath(right));
      const leftScore = diffPathMatchScore(normalizedActivePath, leftPath);
      const rightScore = diffPathMatchScore(normalizedActivePath, rightPath);
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }
      return resolveDraftFileDiffPath(left).localeCompare(resolveDraftFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });
  }, [activeTab, parsedActiveTabContent]);
  const activeDiffThemeName = useMemo(
    () => resolveDiffThemeName(resolvedTheme, activeCustomThemeId),
    [activeCustomThemeId, resolvedTheme],
  );

  useEffect(() => {
    if (tabs.length === 0) {
      setActivePath("");
      return;
    }
    if (tabs.some((tab) => tab.path === activePath)) {
      return;
    }
    setActivePath(tabs[0]!.path);
  }, [activePath, tabs]);

  if (tabs.length === 0 || !activeTab) {
    return null;
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="mt-2">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition hover:border-border hover:bg-muted/40">
        <SquarePenIcon className="size-3.5 shrink-0 text-primary" />
        <span className="flex-1 text-xs text-foreground">
          {tabs.length} file{tabs.length === 1 ? "" : "s"} changed
        </span>
        <ChevronDownIcon
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1.5">
        <div className="overflow-hidden rounded-xl border border-border/80 bg-card/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
          <div className="border-b border-border/80 bg-background/30 px-2 py-1.5">
            <div className="flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {tabs.map((tab) => (
                <button
                  key={`${workEntry.id}:${tab.path}`}
                  type="button"
                  className={`app-interactive-motion shrink-0 rounded-md border px-2 py-1 font-mono text-[10px] ${
                    activeTab.path === tab.path
                      ? "border-border bg-card text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                      : "border-border/70 bg-background/40 text-muted-foreground hover:bg-muted/45 hover:text-foreground"
                  }`}
                  title={tab.path}
                  onClick={() => setActivePath(tab.path)}
                >
                  <span className="block max-w-[240px] truncate">
                    {formatDraftFileChangeTabLabel(tab.path)}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="border-b border-border/70 bg-background/20 px-3 py-1.5">
            <p className="truncate font-mono text-[11px] text-muted-foreground" title={activeTab.path}>
              {activeTab.path}
            </p>
          </div>
          <div className="max-h-[50vh] overflow-auto bg-background/25 px-2 py-2">
            {activeTab.content ? (
              parsedActiveTabContent?.kind === "files" && activeTabDiffFiles.length > 0 ? (
                <div className="space-y-2">
                  {activeTabDiffFiles.map((fileDiff) => (
                    <div
                      key={`${workEntry.id}:${activeTab.path}:${buildDraftFileDiffRenderKey(fileDiff)}`}
                      className="diff-render-file"
                    >
                      <FileDiff
                        fileDiff={fileDiff}
                        options={{
                          diffStyle: "unified",
                          lineDiffType: "none",
                          theme: activeDiffThemeName,
                          themeType: resolvedTheme,
                          unsafeCSS: DRAFT_FILE_DIFF_UNSAFE_CSS,
                        }}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-2 px-1 py-1">
                  {parsedActiveTabContent?.kind === "raw" ? (
                    <p className="text-[11px] text-muted-foreground">
                      {parsedActiveTabContent.reason}
                    </p>
                  ) : null}
                  <pre className="max-h-[72vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-background/50 p-2 font-mono text-xs text-foreground">
                    {activeTab.content}
                  </pre>
                </div>
              )
            ) : (
              <p className="px-1 py-1 font-mono text-xs text-muted-foreground">
                Diff content for this file was not included in the tool payload (only summary-level
                diff text was provided).
              </p>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function resolveActionStepTarget(workEntry: WorkLogEntry): string {
  const command = workEntry.command
    ? sanitizeCommandLabelForDisplay(workEntry.command).trim()
    : "";
  if (command && command.length > 0) {
    return command;
  }
  const firstChangedFile = workEntry.changedFiles?.[0]?.trim();
  if (firstChangedFile && firstChangedFile.length > 0) {
    if ((workEntry.changedFiles?.length ?? 0) > 1) {
      return `${firstChangedFile} +${(workEntry.changedFiles?.length ?? 1) - 1}`;
    }
    return firstChangedFile;
  }
  const detail = workEntry.detail?.trim();
  if (detail && detail.length > 0) {
    return detail.split(/\r?\n/, 1)[0] ?? detail;
  }
  const label = workEntry.label.trim();
  return label.length > 0 ? label : "Tool activity";
}

function actionStepTypeLabel(type: ReturnType<typeof deriveActionStepType>): string {
  switch (type) {
    case "read":
      return "Read";
    case "search":
      return "Search";
    case "edit":
      return "Edit";
    case "command":
      return "Command";
    default:
      return "Tool";
  }
}

function DraftActionStepRow({ workEntry }: { workEntry: WorkLogEntry }) {
  const actionType = deriveActionStepType({
    itemType: workEntry.itemType,
    requestKind: workEntry.requestKind,
  });
  const status = deriveActionStepStatus({
    tone: workEntry.tone,
    label: workEntry.label,
    activityKind: workEntry.activityKind,
    exitCode: workEntry.exitCode,
  });
  const target = resolveActionStepTarget(workEntry);
  const statusClassName =
    status === "failed"
      ? "border-destructive/45 bg-destructive/15 text-destructive"
      : status === "running"
        ? "border-primary/45 bg-primary/15 text-primary"
        : "border-success/45 bg-success/15 text-success";
  return (
    <div className="ml-7 flex items-center gap-2 rounded-lg border border-border/70 bg-card/55 px-2.5 py-1.5 text-xs">
      <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {actionStepTypeLabel(actionType)}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground" title={target}>
        {target}
      </span>
      <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${statusClassName}`}>
        {status === "running" ? "Running" : status === "failed" ? "Failed" : "Done"}
      </span>
    </div>
  );
}


function approvalKindLabel(approval: PendingApproval): string {
  switch (approval.requestKind) {
    case "command":
      return "Command approval";
    case "file-read":
      return "File read approval";
    case "file-change":
      return "File change approval";
    default:
      return "Approval requested";
  }
}

function DraftApprovalBlock(props: {
  approval: PendingApproval;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}) {
  const { approval, isResponding, onRespondToApproval } = props;
  return (
    <div className="ml-7 rounded-xl border border-warning/50 bg-warning/10 px-3 py-2.5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-warning/50 bg-warning/20 px-2 py-0.5 text-[10px] uppercase tracking-wide text-warning">
          Pending approval
        </span>
        <span className="text-sm text-foreground">{approvalKindLabel(approval)}</span>
        <span className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          Scope: Once / Session
        </span>
      </div>
      {approval.detail ? (
        <p className="mb-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">{approval.detail}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <ComposerPendingApprovalActions
          requestId={approval.requestId}
          isResponding={isResponding}
          submittingLabel="Submitting..."
          onRespondToApproval={onRespondToApproval}
        />
      </div>
    </div>
  );
}

function DraftPendingInputBlock({ input }: { input: PendingUserInput }) {
  return (
    <div className="ml-7 rounded-xl border border-border bg-card/60 px-3 py-2.5">
      <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Input required</p>
      <div className="space-y-1">
        {input.questions.map((question) => (
          <p key={`${input.requestId}:${question.id}`} className="text-sm text-foreground">
            {question.question}
          </p>
        ))}
      </div>
    </div>
  );
}

function DraftInlineTerminalRunRow({ run }: { run: DraftTerminalRunEntry }) {
  const displayOutput = sanitizeTerminalTranscriptForDisplay(run.output, run.command);
  const hasOutput = displayOutput.length > 0;
  return (
    <div className="ml-7 rounded-xl border border-border bg-card/70">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/35 px-3 py-2">
        <span className="rounded-full border border-border bg-background/70 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          Shell
        </span>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
            run.status === "failed"
              ? "border-destructive/45 bg-destructive/15 text-destructive"
              : run.status === "running"
                ? "border-primary/45 bg-primary/15 text-primary"
                : "border-success/45 bg-success/15 text-success"
          }`}
        >
          {run.status === "running" ? "Running" : run.status === "failed" ? "Failed" : "Done"}
        </span>
      </div>
      <div className="border-b border-border bg-muted/20 px-3 py-2">
        <code className="block break-words font-mono text-xs text-foreground">{`! ${run.command}`}</code>
      </div>
      <div className="max-h-[36vh] overflow-auto px-3 py-2">
        {hasOutput ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
            {displayOutput}
          </pre>
        ) : (
          <p className="font-mono text-xs text-muted-foreground">Waiting for output...</p>
        )}
      </div>
    </div>
  );
}
function stripAnsiAndOscSequences(value: string): string {
  return value
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "");
}
function applyBackspaces(value: string): string {
  let output = "";
  for (const char of value) {
    if (char === "\b") {
      output = output.slice(0, -1);
      continue;
    }
    output += char;
  }
  return output;
}
function stripWindowsPromptFragments(value: string): string {
  return value
    .replace(/(?:PS\s+)?[A-Za-z]:\\[^>\r\n]*>\s*/g, "\n")
    .replace(/Microsoft Windows \[Version [^\]\r\n]+\]/gi, "")
    .replace(/\(c\) Microsoft Corporation\. All rights reserved\./gi, "")
    .trimEnd();
}
function unwrapPowerShellCommandWrapper(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  const wrapperMatch = /^"?[A-Za-z]:\\[^"\r\n]*powershell\.exe"?\s+-Command\s+([\s\S]+)$/i.exec(
    trimmed,
  );
  if (!wrapperMatch?.[1]) {
    return trimmed;
  }
  let payload = wrapperMatch[1].trim();
  if (
    (payload.startsWith("{") && payload.endsWith("}")) ||
    (payload.startsWith("\"") && payload.endsWith("\"")) ||
    (payload.startsWith("'") && payload.endsWith("'"))
  ) {
    payload = payload.slice(1, -1).trim();
  }
  return payload.length > 0 ? payload : trimmed;
}
function sanitizeCommandLabelForDisplay(command: string): string {
  const withoutWrapper = unwrapPowerShellCommandWrapper(command);
  return withoutWrapper.replace(/^&\s+/, "").trim();
}
function collapseDuplicatedConcatenatedLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length < 2) {
    return line;
  }
  let candidate = trimmed;
  while (candidate.length % 2 === 0) {
    const half = candidate.length / 2;
    if (candidate.slice(0, half) !== candidate.slice(half)) {
      break;
    }
    candidate = candidate.slice(0, half);
  }
  if (candidate === trimmed) {
    return line;
  }
  return candidate;
}
function sanitizeTerminalTranscriptForDisplay(rawOutput: string, command?: string): string {
  const withoutAnsi = stripAnsiAndOscSequences(rawOutput);
  const withBackspacesApplied = applyBackspaces(withoutAnsi);
  const normalized = withBackspacesApplied
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/\n{3,}/g, "\n\n");
  const commandText = command?.trim().toLowerCase() ?? "";
  const lines = normalized
    .split("\n")
    .flatMap((line) => stripWindowsPromptFragments(line).split("\n"))
    .map((line) => collapseDuplicatedConcatenatedLine(line))
    .map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0]!.trim().length === 0) {
    lines.shift();
  }
  while (
    commandText.length > 0 &&
    lines.length > 0 &&
    lines[0]!.trim().toLowerCase() === commandText
  ) {
    lines.shift();
  }
  if (commandText.length > 0) {
    const firstCommandEchoIndex = lines.findIndex(
      (line) => line.trim().toLowerCase() === commandText,
    );
    if (firstCommandEchoIndex >= 0) {
      lines.splice(0, firstCommandEchoIndex + 1);
    }
    while (
      lines.length > 0 &&
      lines[0]!.trim().toLowerCase() === commandText
    ) {
      lines.shift();
    }
  }
  for (let index = lines.length - 1; index > 0; index -= 1) {
    const current = lines[index]!.trim();
    const previous = lines[index - 1]!.trim();
    if (current.length > 0 && current === previous) {
      lines.splice(index, 1);
    }
  }
  while (lines.length > 0 && lines[lines.length - 1]!.trim().length === 0) {
    lines.pop();
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
function buildTerminalContextForAgent(input: {
  runs: DraftTerminalRunEntry[];
  shellCwd: string | null;
  projects: ReadonlyArray<{ name: string; cwd: string }>;
}): {
  context: string;
  runIds: string[];
} | null {
  const candidateRuns = input.runs
    .filter((run) => !run.surfacedToAgentAt)
    .slice(-3)
    .map((run) => ({
      run,
      sanitizedOutput: sanitizeTerminalTranscriptForDisplay(run.output, run.command).slice(-1200),
    }))
    .filter(({ run, sanitizedOutput }) => run.status !== "running" || sanitizedOutput.length > 0);
  const shellCwd = input.shellCwd ? normalizeWindowsCwdCandidate(input.shellCwd) : null;
  if (!shellCwd && candidateRuns.length === 0) {
    return null;
  }
  const shellContextLabel = shellCwd
    ? resolveCwdContextLabel({
        cwd: shellCwd,
        projects: input.projects,
      })
    : null;
  const transcriptSection =
    candidateRuns.length > 0
      ? [
          "Recent shell transcript from this thread:",
          ...candidateRuns.flatMap(({ run, sanitizedOutput }, index) => {
            const statusLabel =
              run.status === "running" ? "running" : run.status === "failed" ? "failed" : "done";
            return [
              index > 0 ? "---" : "",
              `Command: ${run.command}`,
              `Status: ${statusLabel}`,
              "Output:",
              sanitizedOutput.length > 0 ? sanitizedOutput : "(no output yet)",
            ].filter((line) => line.length > 0);
          }),
        ]
      : ["Recent shell transcript from this thread: (none)"];
  const context = [
    DRAFT_TERMINAL_CONTEXT_START,
    "For repo/location questions, authoritative shell cwd is source of truth over thread workspace defaults.",
    shellCwd
      ? `Authoritative shell cwd for this thread: ${shellCwd}${shellContextLabel ? ` (${shellContextLabel})` : ""}`
      : "Authoritative shell cwd for this thread: unknown",
    ...transcriptSection,
    DRAFT_TERMINAL_CONTEXT_END,
  ].join("\n");
  return {
    context,
    runIds: candidateRuns.map(({ run }) => run.id),
  };
}
function resolveWorkIcon(entry: WorkLogEntry) {
  switch (entry.itemType) {
    case "command_execution":
      return TerminalIcon;
    case "file_change":
      return SquarePenIcon;
    case "web_search":
      return GlobeIcon;
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return HammerIcon;
    default:
      return BotIcon;
  }
}

function resolveWorkHeading(entry: WorkLogEntry): string {
  const preferred = entry.toolTitle?.trim();
  if (preferred && preferred.length > 0) {
    return preferred;
  }
  const label = entry.label.trim();
  if (label.length > 0) {
    return label;
  }
  return "Tool activity";
}

function resolveLatestThread(threads: Thread[], preferredThreadId: ThreadId | null): Thread | null {
  if (preferredThreadId) {
    return threads.find((thread) => thread.id === preferredThreadId) ?? null;
  }
  if (threads.length === 0) return null;
  return [...threads].sort(
    (left, right) =>
      toEpoch(right.updatedAt ?? right.createdAt) - toEpoch(left.updatedAt ?? left.createdAt),
  )[0]!;
}

function resolvePreferredDraftProvider(statuses: ReadonlyArray<ServerProviderStatus>): ProviderKind {
  const availableStatuses = statuses.filter((status) => status.available);
  if (availableStatuses.length === 0) {
    return "codex";
  }

  const statusScore = (value: ServerProviderStatus["status"]): number => {
    if (value === "ready") return 2;
    if (value === "warning") return 1;
    return 0;
  };
  const authScore = (value: ServerProviderStatus["authStatus"]): number => {
    if (value === "authenticated") return 2;
    if (value === "unknown") return 1;
    return 0;
  };

  return (
    [...availableStatuses].sort((left, right) => {
      const byStatus = statusScore(right.status) - statusScore(left.status);
      if (byStatus !== 0) return byStatus;
      const byAuth = authScore(right.authStatus) - authScore(left.authStatus);
      if (byAuth !== 0) return byAuth;
      return (
        DRAFT_PROVIDER_PRIORITY.indexOf(left.provider) -
        DRAFT_PROVIDER_PRIORITY.indexOf(right.provider)
      );
    })[0]?.provider ?? "codex"
  );
}

function DraftRouteView() {
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const navigate = useNavigate();
  const routeSearch = Route.useSearch();
  const routeSearchThreadId =
    typeof routeSearch.threadId === "string" && routeSearch.threadId.trim().length > 0
      ? ThreadId.makeUnsafe(routeSearch.threadId.trim())
      : null;
  const { data: serverConfig } = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfig?.keybindings ?? EMPTY_KEYBINDINGS;
  const availableEditors = serverConfig?.availableEditors ?? EMPTY_EDITORS;
  const preferredProvider = useMemo(
    () => resolvePreferredDraftProvider(serverConfig?.providers ?? []),
    [serverConfig?.providers],
  );
  const forcedProvider = resolveTemporaryForcedProvider();
  const { settings } = useAppSettings();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [preferredThreadId, setPreferredThreadId] = useState<ThreadId | null>(null);
  const [prompt, setPrompt] = useState("");
  const [composerModeByThreadId, setComposerModeByThreadId] = useState<
    Record<string, DraftComposerMode>
  >({});
  const [suggestionActive, setSuggestionActive] = useState(false);
  const [historyByThreadId, setHistoryByThreadId] = useState<Record<string, string[]>>({});
  const [historyIndexByThreadId, setHistoryIndexByThreadId] = useState<Record<string, number>>({});
  const [sending, setSending] = useState(false);
  const [respondingApprovalRequestIds, setRespondingApprovalRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const [terminalRunsByThreadId, setTerminalRunsByThreadId] = useState<
    Record<string, DraftTerminalRunEntry[]>
  >({});
  const [terminalCwdByThreadId, setTerminalCwdByThreadId] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<RuntimeNotice[]>([]);
  const [planSidebarOpen, setPlanSidebarOpen] = useState(false);
  const [expandedCommandOutputByKey, setExpandedCommandOutputByKey] = useState<
    Record<string, boolean>
  >({});
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const timelineScrollRef = useRef<HTMLElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const planSidebarDismissedForTurnRef = useRef<string | null>(null);

  useEffect(() => {
    setPreferredThreadId(routeSearchThreadId);
  }, [routeSearchThreadId]);

  const activeThread = useMemo(
    () => resolveLatestThread(threads, preferredThreadId),
    [threads, preferredThreadId],
  );
  const selectedDraftThread = useComposerDraftStore((store) =>
    preferredThreadId ? (store.draftThreadsByThreadId[preferredThreadId] ?? null) : null,
  );
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const selectDraftThread = useCallback(
    (threadId: ThreadId | null) => {
      setPreferredThreadId(threadId);
      void navigate({
        to: "/draft",
        replace: true,
        search: threadId ? { threadId } : { threadId: undefined },
      });
    },
    [navigate],
  );
  const setTerminalOpen = useTerminalStateStore((state) => state.setTerminalOpen);
  const setTerminalControlState = useTerminalStateStore((state) => state.setTerminalControlState);
  const terminalState = useTerminalStateStore((state) =>
    activeThread
      ? selectThreadTerminalState(state.terminalStateByThreadId, activeThread.id)
      : selectThreadTerminalState(
          state.terminalStateByThreadId,
          ThreadId.makeUnsafe("__draft-fallback"),
        ),
  );
  const terminalControlState = useTerminalStateStore((state) =>
    activeThread
      ? selectThreadTerminalControlState(state.terminalControlStateByThreadId, activeThread.id)
      : "agent-attached",
  );
  const activeProject = useMemo(() => {
    if (activeThread) {
      return projects.find((project) => project.id === activeThread.projectId) ?? null;
    }
    if (selectedDraftThread) {
      return projects.find((project) => project.id === selectedDraftThread.projectId) ?? null;
    }
    return projects[0] ?? null;
  }, [activeThread, projects, selectedDraftThread]);
  const openCodeStateQuery = useQuery(
    serverOpenCodeStateQueryOptions({
      ...(activeProject?.cwd ? { cwd: activeProject.cwd } : {}),
      ...(settings.opencodeBinaryPath.trim().length > 0
        ? { binaryPath: settings.opencodeBinaryPath.trim() }
        : {}),
      refreshModels: false,
    }),
  );
  const openInCwd = activeThread
    ? activeThread.worktreePath ?? activeProject?.cwd ?? null
    : selectedDraftThread?.worktreePath ?? activeProject?.cwd ?? null;
  const activeShellCwd = activeThread
    ? (terminalCwdByThreadId[activeThread.id] ?? openInCwd)
    : openInCwd;
  const gitCwd = activeShellCwd ?? openInCwd;
  const { data: gitStatus } = useQuery(gitStatusQueryOptions(gitCwd));
  const projectLabel = activeProject?.name ?? "No project";
  const branchLabel = gitStatus?.branch ?? activeThread?.branch ?? selectedDraftThread?.branch ?? "main";
  const title = activeThread?.title ?? (selectedDraftThread ? "New draft thread" : "Warp-style Live Draft");
  const isThreadBusy =
    activeThread?.session?.orchestrationStatus === "starting" ||
    activeThread?.session?.orchestrationStatus === "running";
  const pendingApprovals = useMemo(
    () =>
      activeThread
        ? derivePendingApprovals(
            activeThread.activities,
            activeThread.session?.createdAt ?? activeThread.createdAt,
          )
        : [],
    [activeThread],
  );
  const pendingUserInputs = useMemo(
    () =>
      activeThread
        ? derivePendingUserInputs(
            activeThread.activities,
            activeThread.session?.createdAt ?? activeThread.createdAt,
          )
        : [],
    [activeThread],
  );
  const activeThreadKey = activeThread?.id ?? "__draft";
  const currentComposerMode = composerModeByThreadId[activeThreadKey] ?? "auto";
  const promptStartsWithBang = prompt.trimStart().startsWith("!");
  const resolvedIntentMode: DraftComposerMode =
    currentComposerMode === "auto"
      ? (promptStartsWithBang ? "command" : "task")
      : currentComposerMode;
  const canSend = prompt.trim().length > 0 && !sending;
  const defaultProviderForFooter = forcedProvider ?? preferredProvider;
  const defaultModelForFooter = activeThread?.model
    ? resolveModelSlugForProvider(defaultProviderForFooter, activeThread.model)
    : resolveModelSlugForProvider(
        defaultProviderForFooter,
        activeProject?.model ?? DEFAULT_MODEL_BY_PROVIDER[defaultProviderForFooter],
      );
  const [selectedDraftProvider, setSelectedDraftProvider] =
    useState<ProviderKind>(defaultProviderForFooter);
  const [selectedDraftModel, setSelectedDraftModel] = useState(defaultModelForFooter);
  useEffect(() => {
    setSelectedDraftProvider(defaultProviderForFooter);
    setSelectedDraftModel(defaultModelForFooter);
  }, [activeThread?.id, defaultModelForFooter, defaultProviderForFooter]);
  const providerForFooter = forcedProvider ?? selectedDraftProvider;
  const selectedModelForFooter = resolveModelSlugForProvider(
    providerForFooter,
    selectedDraftModel || defaultModelForFooter,
  );
  const projectDefaultProvider = activeProject?.provider ?? null;
  const projectDefaultModel = activeProject
    ? (resolveModelSlugForProvider(
        activeProject.provider,
        activeProject.model ?? DEFAULT_MODEL_BY_PROVIDER[activeProject.provider],
      ) as ModelSlug)
    : null;
  const selectedModelSelectionSource =
    projectDefaultProvider &&
    projectDefaultModel &&
    providerForFooter === projectDefaultProvider &&
    selectedModelForFooter === projectDefaultModel
      ? "project-default"
      : "manual";
  const allModelOptionsByProvider = useMemo(
    () =>
      resolveDraftPickerModelOptionsByProvider({
        providerStatuses: serverConfig?.providers ?? [],
        selectedProvider: providerForFooter,
        selectedModel: selectedModelForFooter,
        projectDefaultProvider,
        projectDefaultModel,
      }),
    [
      projectDefaultModel,
      projectDefaultProvider,
      providerForFooter,
      selectedModelForFooter,
      serverConfig?.providers,
    ],
  );
  const hiddenModelsByProvider = useMemo(
    () => ({
      codex: new Set(settings.hiddenCodexModels),
      copilot: new Set(settings.hiddenCopilotModels),
      opencode: new Set(settings.hiddenOpencodeModels),
      kimi: new Set(settings.hiddenKimiModels),
      pi: new Set(settings.hiddenPiModels),
    }),
    [
      settings.hiddenCodexModels,
      settings.hiddenCopilotModels,
      settings.hiddenKimiModels,
      settings.hiddenOpencodeModels,
      settings.hiddenPiModels,
    ],
  );
  const discoveredOpencodeModelOptions = useMemo(
    () =>
      openCodeStateQuery.data?.status === "available"
        ? openCodeStateQuery.data.models.map((model) => ({
            slug: model.slug,
            name: `${model.providerId}/${model.modelId}`,
            ...(typeof model.contextWindowTokens === "number"
              ? { contextWindowTokens: model.contextWindowTokens }
              : {}),
          }))
        : [],
    [openCodeStateQuery.data],
  );
  const visibleDiscoveredOpencodeModelOptions = useMemo(
    () =>
      discoveredOpencodeModelOptions.filter(
        (option) => !hiddenModelsByProvider.opencode.has(option.slug),
      ),
    [discoveredOpencodeModelOptions, hiddenModelsByProvider.opencode],
  );
  const visibleModelOptionsByProvider = useMemo(
    () => ({
      codex: allModelOptionsByProvider.codex.filter(
        (option) => !hiddenModelsByProvider.codex.has(option.slug),
      ),
      copilot: allModelOptionsByProvider.copilot.filter(
        (option) => !hiddenModelsByProvider.copilot.has(option.slug),
      ),
      opencode: allModelOptionsByProvider.opencode.filter(
        (option) => !hiddenModelsByProvider.opencode.has(option.slug),
      ),
      kimi: allModelOptionsByProvider.kimi.filter(
        (option) => !hiddenModelsByProvider.kimi.has(option.slug),
      ),
      pi: allModelOptionsByProvider.pi.filter((option) => !hiddenModelsByProvider.pi.has(option.slug)),
    }),
    [allModelOptionsByProvider, hiddenModelsByProvider],
  );
  const openRouterModelOptions = useMemo(
    () =>
      visibleModelOptionsByProvider.codex.filter((option) => isCodexOpenRouterModel(option.slug)),
    [visibleModelOptionsByProvider.codex],
  );
  const openRouterContextLengthsBySlug = useMemo(
    () =>
      new Map(
        openRouterModelOptions.map((option) => [option.slug, option.contextWindowTokens ?? null]),
      ),
    [openRouterModelOptions],
  );
  const opencodeContextLengthsBySlug = useMemo(
    () =>
      new Map(
        [...visibleModelOptionsByProvider.opencode, ...visibleDiscoveredOpencodeModelOptions].map(
          (option) => [option.slug, option.contextWindowTokens ?? null],
        ),
      ),
    [visibleDiscoveredOpencodeModelOptions, visibleModelOptionsByProvider.opencode],
  );
  const selectedProviderPickerKind = useMemo(
    () => getProviderPickerKindForSelection(providerForFooter, selectedModelForFooter),
    [providerForFooter, selectedModelForFooter],
  );
  const hasHiddenPickerModels =
    settings.hiddenCodexModels.length +
      settings.hiddenCopilotModels.length +
      settings.hiddenOpencodeModels.length +
      settings.hiddenKimiModels.length +
      settings.hiddenPiModels.length >
    0;
  const favoriteModelsByProvider = useMemo(
    () => ({
      codex: settings.favoriteCodexModels,
      copilot: settings.favoriteCopilotModels,
      opencode: settings.favoriteOpencodeModels,
      kimi: settings.favoriteKimiModels,
      pi: settings.favoritePiModels,
    }),
    [
      settings.favoriteCodexModels,
      settings.favoriteCopilotModels,
      settings.favoriteKimiModels,
      settings.favoriteOpencodeModels,
      settings.favoritePiModels,
    ],
  );
  const recentModelsByProvider = useMemo(
    () => ({
      codex: settings.recentCodexModels,
      copilot: settings.recentCopilotModels,
      opencode: settings.recentOpencodeModels,
      kimi: settings.recentKimiModels,
      pi: settings.recentPiModels,
    }),
    [
      settings.recentCodexModels,
      settings.recentCopilotModels,
      settings.recentKimiModels,
      settings.recentOpencodeModels,
      settings.recentPiModels,
    ],
  );
  const contextState = describeContextWindowState({
    provider: providerForFooter,
    model: selectedModelForFooter,
    tokenUsage: activeThread?.session?.tokenUsage,
    ...getDocumentedContextWindowOverride({
      provider: providerForFooter,
      model: selectedModelForFooter,
    }),
  });
  const contextUsageLabel = formatDraftContextUsage({
    usedTokens: contextState.usedTokens,
    totalTokens: contextState.totalTokens,
  });
  const latestPlanTurnId =
    activeThread?.latestTurn?.turnId ?? activeThread?.session?.activeTurnId ?? null;
  const activeProposedPlan = useMemo(
    () =>
      activeThread ? findLatestProposedPlan(activeThread.proposedPlans, latestPlanTurnId) : null,
    [activeThread, latestPlanTurnId],
  );
  const activePlan = useMemo(
    () =>
      activeThread
        ? deriveActivePlanState(activeThread.activities, latestPlanTurnId ?? undefined)
        : null,
    [activeThread, latestPlanTurnId],
  );
  const activePlanSidebarKey = useMemo(() => {
    if (activePlan?.turnId) {
      return activePlan.turnId;
    }
    if (activeProposedPlan?.turnId) {
      return activeProposedPlan.turnId;
    }
    return activeProposedPlan ? `proposed:${activeProposedPlan.id}` : null;
  }, [activePlan?.turnId, activeProposedPlan]);
  const hasPlanSidebarContent = activePlan !== null || activeProposedPlan !== null;
  const codexAuthSourceIndicator = useMemo<{
    label: string;
    description: string;
    tone: "success" | "warning" | "outline";
  } | null>(() => {
    if (providerForFooter !== "codex") {
      return null;
    }

    const hasOpenAiApiKey = settings.openAiApiKey.trim().length > 0;
    const hasOpenRouterApiKey = settings.openRouterApiKey.trim().length > 0;
    const modelUsesOpenRouter = isCodexOpenRouterModel(selectedModelForFooter);

    if (modelUsesOpenRouter) {
      if (hasOpenRouterApiKey) {
        return {
          label: "OpenRouter key",
          description: "Codex is using your configured OpenRouter API key.",
          tone: "success",
        };
      }
      return {
        label: "OpenRouter key missing",
        description:
          "This Codex model routes through OpenRouter. Add an OpenRouter API key in Settings.",
        tone: "warning",
      };
    }

    if (hasOpenAiApiKey) {
      return {
        label: "OpenAI key",
        description: "Codex is using your configured OpenAI API key.",
        tone: "success",
      };
    }

    return {
      label: "Codex login",
      description:
        "No OpenAI key is configured, so Draft falls back to your Codex CLI login session.",
      tone: "outline",
    };
  }, [
    providerForFooter,
    selectedModelForFooter,
    settings.openAiApiKey,
    settings.openRouterApiKey,
  ]);
  const gitInsertions = gitStatus?.workingTree.insertions ?? 0;
  const gitDeletions = gitStatus?.workingTree.deletions ?? 0;
  const cwdLabel = activeShellCwd ?? "No directory";
  const timelineEntries = useMemo(() => {
    if (!activeThread) {
      return [] as ReturnType<typeof deriveTimelineEntries>;
    }
    const workEntries = mergeCommandProgressEntries(
      deriveWorkLogEntries(activeThread.activities, undefined, {
        includeStreamingCommandOutput: true,
      }),
    );
    return deriveTimelineEntries(activeThread.messages, activeThread.proposedPlans, workEntries);
  }, [activeThread]);
  const timelineRenderables = useMemo(() => {
    const entryRows = timelineEntries.map((entry) => ({
      id: `entry:${entry.id}`,
      createdAt: entry.createdAt,
      kind: "entry" as const,
      entry,
    }));
    const approvalRows = pendingApprovals.map((approval) => ({
      id: `approval:${approval.requestId}`,
      createdAt: approval.createdAt,
      kind: "pending-approval" as const,
      approval,
    }));
    const inputRows = pendingUserInputs.map((input) => ({
      id: `input:${input.requestId}`,
      createdAt: input.createdAt,
      kind: "pending-input" as const,
      input,
    }));
    return [...entryRows, ...approvalRows, ...inputRows].toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }, [pendingApprovals, pendingUserInputs, timelineEntries]);
  const activeTimelineRenderables = useMemo(
    () =>
      import.meta.env.VITE_DRAFT_UNIFIED_INTERACTIONS !== "0"
        ? timelineRenderables
        : timelineEntries.map((entry) => ({
            id: `entry:${entry.id}`,
            createdAt: entry.createdAt,
            kind: "entry" as const,
            entry,
          })),
    [timelineEntries, timelineRenderables],
  );
  const activeTerminalRuns = useMemo(
    () => terminalRunsByThreadId[activeThread?.id ?? "__draft"] ?? [],
    [activeThread?.id, terminalRunsByThreadId],
  );
  const draftRenderables = useMemo(() => {
    const timelineRows = activeTimelineRenderables.map((row) => ({
      ...row,
      renderKind: "timeline" as const,
    }));
    const terminalRows = activeTerminalRuns.map((run) => ({
      id: `terminal-run:${run.id}`,
      createdAt: run.createdAt,
      renderKind: "terminal-run" as const,
      run,
    }));
    return [...timelineRows, ...terminalRows].toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }, [activeTerminalRuns, activeTimelineRenderables]);
  const commandSuggestions = useMemo(
    () =>
      [...new Set(timelineEntries.flatMap((entry) =>
        entry.kind === "work" && isCommandWorkEntry(entry.entry) && entry.entry.command
          ? [entry.entry.command]
          : [],
      ))].slice(-12),
    [timelineEntries],
  );
  const promptSuggestions = useMemo(
    () =>
      [...new Set(
        timelineEntries.flatMap((entry) =>
          entry.kind === "message" &&
          entry.message.role === "user" &&
          stripDraftTerminalContextEnvelope(entry.message.text).trim().length > 0
            ? [stripDraftTerminalContextEnvelope(entry.message.text).trim()]
            : [],
        ),
      )].slice(-12),
    [timelineEntries],
  );
  const activeSuggestionPool = resolvedIntentMode === "command" ? commandSuggestions : promptSuggestions;
  const visibleSuggestions = useMemo(() => {
    if (!suggestionActive) return [] as string[];
    const query = prompt.trim().toLowerCase();
    if (query.length === 0) return [] as string[];
    return activeSuggestionPool
      .filter((entry) => entry.trim().toLowerCase().startsWith(query))
      .filter((entry) => entry.trim().toLowerCase() !== query)
      .slice(0, 6);
  }, [activeSuggestionPool, prompt, suggestionActive]);
  const scrollTimelineToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const scrollContainer = timelineScrollRef.current;
    if (!scrollContainer) return;
    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior });
    shouldAutoScrollRef.current = true;
    setShowScrollToBottom(false);
  }, []);
  const onTimelineScroll = useCallback(() => {
    const scrollContainer = timelineScrollRef.current;
    if (!scrollContainer) return;
    const nearBottom = isScrollContainerNearBottom(
      scrollContainer,
      AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
    );
    shouldAutoScrollRef.current = nearBottom;
    setShowScrollToBottom(!nearBottom);
  }, []);
  const onCommandOutputExpandedChange = useCallback(
    (entry: WorkLogEntry, expanded: boolean) => {
      const stateKey = commandDropdownStateKey(entry);
      setExpandedCommandOutputByKey((existing) =>
        existing[stateKey] === expanded ? existing : { ...existing, [stateKey]: expanded },
      );
      if (!expanded) return;
      window.requestAnimationFrame(() => {
        const scrollContainer = timelineScrollRef.current;
        if (!scrollContainer || !isScrollContainerNearBottom(scrollContainer)) return;
        scrollTimelineToBottom();
      });
    },
    [scrollTimelineToBottom],
  );
  useEffect(() => {
    setExpandedCommandOutputByKey({});
  }, [activeThread?.id]);
  useEffect(() => {
    setPlanSidebarOpen(false);
    planSidebarDismissedForTurnRef.current = null;
  }, [activeThread?.id]);
  useEffect(() => {
    if (!hasPlanSidebarContent || !activePlanSidebarKey || planSidebarOpen) {
      return;
    }
    if (planSidebarDismissedForTurnRef.current === activePlanSidebarKey) {
      return;
    }
    setPlanSidebarOpen(true);
  }, [activePlanSidebarKey, hasPlanSidebarContent, planSidebarOpen]);
  useEffect(() => {
    setSuggestionActive(false);
    setHistoryIndexByThreadId((existing) => ({ ...existing, [activeThreadKey]: -1 }));
  }, [activeThreadKey]);
  useLayoutEffect(() => {
    shouldAutoScrollRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      scrollTimelineToBottom();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, scrollTimelineToBottom]);
  useLayoutEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      scrollTimelineToBottom();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [draftRenderables, scrollTimelineToBottom]);

  const addNotice = useCallback(
    (
      tone: RuntimeNotice["tone"],
      text: string,
      kind: RuntimeNotice["kind"] = "general",
    ) => {
      setNotices((existing) => {
        const next = [...existing, { id: randomUUID(), tone, text, kind }];
        return next.slice(-6);
      });
    },
    [],
  );
  const dismissNotice = useCallback((noticeId: string) => {
    setNotices((existing) => existing.filter((notice) => notice.id !== noticeId));
  }, []);
  const clearNotices = useCallback(() => {
    setNotices([]);
  }, []);
  const togglePlanSidebar = useCallback(() => {
    setPlanSidebarOpen((open) => {
      if (open) {
        if (activePlanSidebarKey) {
          planSidebarDismissedForTurnRef.current = activePlanSidebarKey;
        }
      } else {
        planSidebarDismissedForTurnRef.current = null;
      }
      return !open;
    });
  }, [activePlanSidebarKey]);
  const openPlanSidebar = useCallback(() => {
    planSidebarDismissedForTurnRef.current = null;
    setPlanSidebarOpen(true);
  }, []);
  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    const unsubscribe = api.terminal.onEvent((event) => {
      setTerminalRunsByThreadId((existing) => {
        const threadRuns = existing[event.threadId] ?? [];
        if (threadRuns.length === 0) {
          return existing;
        }
        const nextRuns = [...threadRuns];
        const targetRunIndex = [...nextRuns]
          .reverse()
          .findIndex((run) => run.terminalId === event.terminalId && run.status === "running");
        if (targetRunIndex < 0) {
          return existing;
        }
        const actualIndex = nextRuns.length - 1 - targetRunIndex;
        const run = nextRuns[actualIndex];
        if (!run) {
          return existing;
        }
        if (event.type === "output") {
          const outputCwd = extractLatestPromptCwdFromTerminalOutput(event.data);
          if (outputCwd) {
            setTerminalCwdByThreadId((current) =>
              current[event.threadId] === outputCwd
                ? current
                : { ...current, [event.threadId]: outputCwd },
            );
          }
          nextRuns[actualIndex] = {
            ...run,
            output: `${run.output}${event.data}`,
            updatedAt: event.createdAt,
          };
        } else if (event.type === "activity" && !event.hasRunningSubprocess) {
          nextRuns[actualIndex] = {
            ...run,
            status: "done",
            updatedAt: event.createdAt,
          };
        } else if (event.type === "error") {
          nextRuns[actualIndex] = {
            ...run,
            status: "failed",
            output: `${run.output}${run.output.endsWith("\n") ? "" : "\n"}${event.message}`,
            updatedAt: event.createdAt,
          };
        } else if (event.type === "exited") {
          nextRuns[actualIndex] = {
            ...run,
            status: event.exitCode === null || event.exitCode === 0 ? "done" : "failed",
            updatedAt: event.createdAt,
          };
        } else if (
          event.type === "started" ||
          event.type === "restarted"
        ) {
          const snapshotCwd = normalizeWindowsCwdCandidate(event.snapshot.cwd);
          if (snapshotCwd) {
            setTerminalCwdByThreadId((current) =>
              current[event.threadId] === snapshotCwd
                ? current
                : { ...current, [event.threadId]: snapshotCwd },
            );
          }
          return existing;
        } else {
          return existing;
        }
        return {
          ...existing,
          [event.threadId]: nextRuns.slice(-24),
        };
      });
    });
    return () => {
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || !activeThread) {
        return;
      }
      const terminalFocus = isTerminalFocused();
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus,
          terminalOpen: Boolean(terminalState.terminalOpen),
        },
      });
      if (command !== "chat.interrupt") {
        return;
      }

      const threadRuns = terminalRunsByThreadId[activeThread.id] ?? [];
      const hasRunningTerminalCommand = threadRuns.some((run) => run.status === "running");
      if (!isThreadBusy && !hasRunningTerminalCommand) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const api = readNativeApi();
      if (!api) {
        addNotice("error", "Native API unavailable. Could not interrupt active work.");
        return;
      }

      if (hasRunningTerminalCommand) {
        const targetTerminalId =
          terminalState.activeTerminalId || threadRuns[threadRuns.length - 1]?.terminalId || "default";
        void api.terminal
          .write({
            threadId: activeThread.id,
            terminalId: targetTerminalId,
            data: "\u0003",
          })
          .catch((error) => {
            addNotice(
              "error",
              error instanceof Error
                ? error.message
                : "Failed to interrupt the active shell command.",
            );
          });
      }

      if (isThreadBusy) {
        void api.orchestration
          .dispatchCommand({
            type: "thread.turn.interrupt",
            commandId: newCommandId(),
            threadId: activeThread.id,
            createdAt: new Date().toISOString(),
          })
          .catch((error) => {
            addNotice(
              "error",
              error instanceof Error ? error.message : "Failed to interrupt the active turn.",
            );
          });
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [
    activeThread,
    addNotice,
    isThreadBusy,
    keybindings,
    terminalRunsByThreadId,
    terminalState.activeTerminalId,
    terminalState.terminalOpen,
  ]);

  const createLiveThread = async (
    seedText: string,
    preferredProjectId?: Thread["projectId"],
  ): Promise<{
    threadId: ThreadId;
    model: string;
    runtimeMode: Thread["runtimeMode"];
    interactionMode: Thread["interactionMode"];
    provider: Thread["provider"];
  } | null> => {
    const api = readNativeApi();
    if (!api) {
      addNotice("error", "Native API unavailable. Could not connect to orchestration runtime.");
      return null;
    }
    const targetProject =
      (preferredProjectId
        ? (projects.find((project) => project.id === preferredProjectId) ?? null)
        : null) ?? activeProject;
    if (!targetProject) {
      addNotice("error", "No project available. Add a project first.");
      return null;
    }
    const provider = forcedProvider ?? selectedDraftProvider ?? preferredProvider;
    const model = resolveModelSlugForProvider(
      provider,
      selectedDraftModel || targetProject.model?.trim(),
    );
    const draftThreadContext =
      selectedDraftThread && selectedDraftThread.projectId === targetProject.id
        ? selectedDraftThread
        : null;
    const nextRuntimeMode = draftThreadContext?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
    const nextInteractionMode =
      draftThreadContext?.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();

    await api.orchestration.dispatchCommand({
      type: "thread.create",
      commandId: newCommandId(),
      threadId,
      projectId: targetProject.id,
      title: truncateTitle(seedText || "Live draft thread"),
      model,
      runtimeMode: nextRuntimeMode,
      interactionMode: nextInteractionMode,
      branch: draftThreadContext?.branch ?? null,
      worktreePath: draftThreadContext?.worktreePath ?? null,
      createdAt,
    });
    if (draftThreadContext && preferredThreadId) {
      clearProjectDraftThreadById(targetProject.id, preferredThreadId);
    }
    selectDraftThread(threadId);
    addNotice("success", "Created live thread in orchestration runtime.");
    return {
      threadId,
      model,
      runtimeMode: nextRuntimeMode,
      interactionMode: nextInteractionMode,
      provider,
    };
  };
  const onSelectThreadFromSidebar = useCallback((threadId: ThreadId) => {
    selectDraftThread(threadId);
  }, [selectDraftThread]);
  const onCreateThreadInProjectFromSidebar = useCallback(
    async (projectId: Thread["projectId"]) => {
      await createLiveThread("Live draft thread", projectId);
    },
    [createLiveThread],
  );
  const onSelectDraftProviderModel = useCallback(
    async (providerPickerKind: AvailableProviderPickerKind, model: ModelSlug) => {
      const backingProvider = getProviderPickerBackingProvider(providerPickerKind);
      if (!backingProvider) {
        return;
      }
      if (forcedProvider !== null && backingProvider !== forcedProvider) {
        return;
      }
      const normalizedModel = resolveModelSlugForProvider(backingProvider, model);
      setSelectedDraftProvider(backingProvider);
      setSelectedDraftModel(normalizedModel);
      if (!activeThread) return;
      const api = readNativeApi();
      if (!api) {
        addNotice("error", "Native API unavailable. Could not update thread model.");
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThread.id,
          model: normalizedModel,
        });
      } catch (error) {
        addNotice("error", error instanceof Error ? error.message : "Failed to update model.");
      }
    },
    [activeThread, addNotice, forcedProvider],
  );
  const onSetProjectDefaultFromPicker = useCallback(
    async (providerPickerKind: AvailableProviderPickerKind, model: ModelSlug) => {
      if (!activeProject) {
        return;
      }
      const backingProvider = getProviderPickerBackingProvider(providerPickerKind);
      if (!backingProvider) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        addNotice("error", "Native API unavailable. Could not update project defaults.");
        return;
      }
      const defaultModel = resolveModelSlugForProvider(backingProvider, model);
      try {
        await api.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId: activeProject.id,
          defaultProvider: backingProvider,
          defaultModel,
        });
        addNotice("success", "Updated project default model for new tabs.");
      } catch (error) {
        addNotice(
          "error",
          error instanceof Error ? error.message : "Failed to update project default model.",
        );
      }
    },
    [activeProject, addNotice],
  );
  const onOpenSettingsFromDraftPicker = useCallback(() => {
    void navigate({ to: "/settings" });
  }, [navigate]);
  const onOpenUsageFromDraftPicker = useCallback(() => {
    addNotice("info", "Usage dashboard is available in the main chat view.");
  }, [addNotice]);
  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!activeThread) return;
      const api = readNativeApi();
      if (!api) {
        addNotice("error", "Native API unavailable. Could not respond to approval.");
        return;
      }
      setRespondingApprovalRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId: activeThread.id,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        addNotice("error", error instanceof Error ? error.message : "Approval response failed.");
      } finally {
        setRespondingApprovalRequestIds((existing) => existing.filter((id) => id !== requestId));
      }
    },
    [activeThread],
  );
  const onOpenTerminal = useCallback(() => {
    if (!activeThread) return;
    setTerminalOpen(activeThread.id, true);
    addNotice("info", "Terminal opened for this thread.");
  }, [activeThread, addNotice, setTerminalOpen]);
  const onTakeOverTerminal = useCallback(() => {
    if (!activeThread) return;
    setTerminalOpen(activeThread.id, true);
    setTerminalControlState(activeThread.id, "user-takeover");
    addNotice("info", "Terminal control switched to user takeover.");
  }, [activeThread, addNotice, setTerminalControlState, setTerminalOpen]);
  const onHandBackTerminal = useCallback(() => {
    if (!activeThread) return;
    setTerminalControlState(activeThread.id, "handback-pending");
    window.setTimeout(() => {
      setTerminalControlState(activeThread.id, "agent-attached");
    }, 350);
    addNotice("info", "Handback to agent requested.");
  }, [activeThread, addNotice, setTerminalControlState]);
  const applySuggestionFromMode = useCallback(() => {
    if (prompt.trim().length === 0) {
      return false;
    }
    const source = resolvedIntentMode === "command" ? commandSuggestions : promptSuggestions;
    const normalizedPrompt = prompt.trim().toLowerCase();
    const match = source.find(
      (entry) =>
        entry.trim().toLowerCase().startsWith(normalizedPrompt) &&
        entry.trim().toLowerCase() !== normalizedPrompt,
    );
    if (!match) {
      return false;
    }
    setPrompt(match);
    setSuggestionActive(false);
    return true;
  }, [commandSuggestions, prompt, promptSuggestions, resolvedIntentMode]);
  const onPromptKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Tab" && suggestionActive && applySuggestionFromMode()) {
        event.preventDefault();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.getModifierState("Shift")) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
        return;
      }
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (prompt.trim().length > 0) return;
      const history = historyByThreadId[activeThreadKey] ?? [];
      if (history.length === 0) return;
      event.preventDefault();
      const currentIndex = historyIndexByThreadId[activeThreadKey] ?? -1;
      const direction = event.key === "ArrowUp" ? 1 : -1;
      const nextIndex = Math.min(history.length - 1, Math.max(-1, currentIndex + direction));
      setHistoryIndexByThreadId((existing) => ({ ...existing, [activeThreadKey]: nextIndex }));
      if (nextIndex === -1) {
        setPrompt("");
        return;
      }
      const nextValue = history[history.length - 1 - nextIndex] ?? "";
      setPrompt(nextValue);
    },
    [
      activeThreadKey,
      applySuggestionFromMode,
      historyByThreadId,
      historyIndexByThreadId,
      prompt,
      suggestionActive,
    ],
  );
  const onPromptChange = useCallback(
    (value: string) => {
      setPrompt(value);
      setHistoryIndexByThreadId((existing) =>
        existing[activeThreadKey] === -1 ? existing : { ...existing, [activeThreadKey]: -1 },
      );
      const hasTypedText = value.trim().length > 0;
      setSuggestionActive((current) => (current === hasTypedText ? current : hasTypedText));
    },
    [activeThreadKey],
  );

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || sending) return;
    const textForDispatch =
      resolvedIntentMode === "command" && !text.trimStart().startsWith("!") ? `! ${text}` : text;
    const nextModeForThread: DraftComposerMode =
      currentComposerMode === "auto" ? "auto" : currentComposerMode;
    if (isThreadBusy && activeThread && isDraftProgressStatusQuery(textForDispatch)) {
      const statusNotice = buildDraftProgressStatusNotice({
        activeThread,
        isThreadBusy,
        timelineEntries,
        activeTerminalRuns,
        pendingApprovals,
        pendingUserInputs,
      });
      setHistoryByThreadId((existing) => ({
        ...existing,
        [activeThread.id]: [...(existing[activeThread.id] ?? []), textForDispatch].slice(-30),
      }));
      setHistoryIndexByThreadId((existing) => ({ ...existing, [activeThread.id]: -1 }));
      setPrompt("");
      setSuggestionActive(false);
      addNotice("info", statusNotice, "status-continuity");
      shouldAutoScrollRef.current = true;
      setShowScrollToBottom(false);
      scrollTimelineToBottom("smooth");
      return;
    }

    const api = readNativeApi();
    if (!api) {
      addNotice("error", "Native API unavailable. Could not send turn.");
      return;
    }
    shouldAutoScrollRef.current = true;
    setShowScrollToBottom(false);
    scrollTimelineToBottom("smooth");

    setSending(true);
    try {
      const target =
        activeThread !== null
          ? {
              threadId: activeThread.id,
              provider: forcedProvider ?? selectedDraftProvider ?? preferredProvider,
              model: resolveModelSlugForProvider(
                forcedProvider ?? selectedDraftProvider ?? preferredProvider,
                selectedDraftModel || activeThread.model,
              ),
              runtimeMode: activeThread.runtimeMode,
              interactionMode: activeThread.interactionMode,
            }
          : await createLiveThread(text);

      if (!target) {
        return;
      }

      if (resolvedIntentMode === "command") {
        const shellCommand = textForDispatch.trimStart().startsWith("!")
          ? textForDispatch.trimStart().slice(1).trimStart()
          : textForDispatch;
        if (shellCommand.length === 0) {
          return;
        }
        const nextTerminalState = selectThreadTerminalState(
          useTerminalStateStore.getState().terminalStateByThreadId,
          target.threadId,
        );
        const targetTerminalId =
          nextTerminalState.activeTerminalId ||
          nextTerminalState.terminalIds[0] ||
          "default";
        const targetCwd = terminalCwdByThreadId[target.threadId] ?? openInCwd ?? activeProject?.cwd;
        if (!targetCwd) {
          addNotice("error", "No working directory available for shell command.");
          return;
        }

        setTerminalOpen(target.threadId, true);
        setTerminalControlState(target.threadId, "user-takeover");
        useTerminalStateStore.getState().setActiveTerminal(target.threadId, targetTerminalId);

        const terminalSnapshot = await api.terminal.open({
          threadId: target.threadId,
          terminalId: targetTerminalId,
          cwd: targetCwd,
          cols: DRAFT_TERMINAL_COLS,
          rows: DRAFT_TERMINAL_ROWS,
        });
        const openedCwd = normalizeWindowsCwdCandidate(terminalSnapshot.cwd) ?? terminalSnapshot.cwd;
        setTerminalCwdByThreadId((current) =>
          current[target.threadId] === openedCwd
            ? current
            : { ...current, [target.threadId]: openedCwd },
        );
        const startedAt = new Date().toISOString();
        setTerminalRunsByThreadId((existing) => {
          const threadRuns = existing[target.threadId] ?? [];
          const runEntry: DraftTerminalRunEntry = {
            id: randomUUID(),
            threadId: target.threadId,
            terminalId: targetTerminalId,
            command: shellCommand,
            output: "",
            status: "running",
            createdAt: startedAt,
            updatedAt: startedAt,
          };
          return {
            ...existing,
            [target.threadId]: [...threadRuns, runEntry].slice(-24),
          };
        });
        await api.terminal.write({
          threadId: target.threadId,
          terminalId: targetTerminalId,
          data: `${shellCommand}\r`,
        });
        const inferredCwd = resolveCdTargetCwd(
          shellCommand,
          terminalCwdByThreadId[target.threadId] ?? targetCwd,
        );
        if (inferredCwd) {
          const previousCwd = terminalCwdByThreadId[target.threadId] ?? openedCwd;
          setTerminalCwdByThreadId((current) => ({
            ...current,
            [target.threadId]: inferredCwd,
          }));
          if (previousCwd !== inferredCwd) {
            addNotice(
              "success",
              `Entered ${resolveCwdContextLabel({
                cwd: inferredCwd,
                projects,
              })}`,
            );
          }
        }

        selectDraftThread(target.threadId);
        setComposerModeByThreadId((existing) => ({
          ...existing,
          [target.threadId]: nextModeForThread,
        }));
        setHistoryByThreadId((existing) => ({
          ...existing,
          [target.threadId]: [...(existing[target.threadId] ?? []), `! ${shellCommand}`].slice(-30),
        }));
        setHistoryIndexByThreadId((existing) => ({ ...existing, [target.threadId]: -1 }));
        setPrompt("");
        setSuggestionActive(false);
        addNotice("info", "Command sent directly to the thread shell.");
        return;
      }
      const terminalContext = buildTerminalContextForAgent(
        {
          runs: terminalRunsByThreadId[target.threadId] ?? [],
          shellCwd: terminalCwdByThreadId[target.threadId] ?? null,
          projects,
        },
      );
      const outgoingText = terminalContext
        ? `${textForDispatch}\n\n${terminalContext.context}`
        : textForDispatch;
      const providerForDispatch = forcedProvider ?? target.provider ?? providerForFooter;
      const providerOptionsForDispatch = buildProviderOptionsForDispatch({
        provider: providerForDispatch,
        settings: {
          codexBinaryPath: settings.codexBinaryPath,
          codexHomePath: settings.codexHomePath,
          openAiApiKey: settings.openAiApiKey,
          openRouterApiKey: settings.openRouterApiKey,
          copilotBinaryPath: settings.copilotBinaryPath,
          opencodeBinaryPath: settings.opencodeBinaryPath,
          opencodePromptTimeoutMs: settings.opencodePromptTimeoutMs,
          kimiBinaryPath: settings.kimiBinaryPath,
          kimiApiKey: settings.kimiApiKey,
        },
      });

      const createdAt = new Date().toISOString();
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: target.threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: outgoingText,
          attachments: [],
        },
        ...(providerForDispatch ? { provider: providerForDispatch } : {}),
        model:
          resolveModelSlugForProvider(
            providerForDispatch,
            selectedDraftModel || target.model?.trim(),
          ) || DEFAULT_MODEL_BY_PROVIDER.codex,
        ...(providerOptionsForDispatch
          ? { providerOptions: providerOptionsForDispatch }
          : {}),
        assistantDeliveryMode: settings.enableAssistantStreaming ? "streaming" : "buffered",
        runtimeMode: target.runtimeMode,
        interactionMode: target.interactionMode,
        createdAt,
      });
      if (terminalContext && terminalContext.runIds.length > 0) {
        setTerminalRunsByThreadId((existing) => {
          const threadRuns = existing[target.threadId] ?? [];
          if (threadRuns.length === 0) {
            return existing;
          }
          return {
            ...existing,
            [target.threadId]: threadRuns.map((run) =>
              terminalContext.runIds.includes(run.id)
                ? { ...run, surfacedToAgentAt: createdAt }
                : run,
            ),
          };
        });
      }
      selectDraftThread(target.threadId);
      setComposerModeByThreadId((existing) => ({ ...existing, [target.threadId]: nextModeForThread }));
      setHistoryByThreadId((existing) => ({
        ...existing,
        [target.threadId]: [...(existing[target.threadId] ?? []), textForDispatch].slice(-30),
      }));
      setHistoryIndexByThreadId((existing) => ({ ...existing, [target.threadId]: -1 }));
      setPrompt("");
      setSuggestionActive(false);
      addNotice("info", "Dispatched turn to live orchestration runtime.");
    } catch (error) {
      addNotice("error", error instanceof Error ? error.message : "Failed to dispatch turn.");
    } finally {
      setSending(false);
    }
  };
  const draftTimelineContent = useMemo(
    () => (
      <div className="space-y-4">
        {draftRenderables.map((renderable) => {
          if (renderable.renderKind === "terminal-run") {
            return <DraftInlineTerminalRunRow key={renderable.id} run={renderable.run} />;
          }
          if (renderable.kind === "pending-approval") {
            return (
              <DraftApprovalBlock
                key={renderable.id}
                approval={renderable.approval}
                isResponding={respondingApprovalRequestIds.includes(renderable.approval.requestId)}
                onRespondToApproval={onRespondToApproval}
              />
            );
          }
          if (renderable.kind === "pending-input") {
            return <DraftPendingInputBlock key={renderable.id} input={renderable.input} />;
          }
          const entry = renderable.entry;
          if (entry.kind === "message") {
            if (entry.message.role === "user") {
              return (
                <div key={entry.id} className="space-y-2">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-muted/40 text-foreground">
                      <UserIcon className="size-3" />
                    </span>
                    <p className="max-w-4xl whitespace-pre-wrap break-words font-medium text-foreground">
                      {stripDraftTerminalContextEnvelope(entry.message.text)}
                    </p>
                  </div>
                  {entry.message.attachments && entry.message.attachments.length > 0 ? (
                    <div className="ml-7 flex flex-wrap gap-2">
                      {entry.message.attachments.map((attachment) => (
                        <span
                          key={attachment.id}
                          className="rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground"
                        >
                          {attachment.name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            }

            if (entry.message.role === "assistant") {
              const messageText = entry.message.text || (entry.message.streaming ? "" : "(empty response)");
              return (
                <div key={entry.id} className="ml-7 space-y-1">
                  <div className="max-w-4xl text-[15px] leading-6 text-foreground">
                    <ChatMarkdown
                      text={messageText}
                      cwd={openInCwd ?? undefined}
                      isStreaming={entry.message.streaming}
                    />
                  </div>
                </div>
              );
            }

            return (
              <div
                key={entry.id}
                className="ml-7 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
              >
                {entry.message.text}
              </div>
            );
          }

          if (entry.kind === "proposed-plan") {
            return (
              <div key={entry.id} className="ml-7 rounded-xl border border-border bg-card/60 px-3 py-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Proposed plan</p>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    className="h-6 border-border bg-background/80 px-2 text-[11px] text-foreground hover:bg-muted/50"
                    onClick={openPlanSidebar}
                  >
                    <ListTodoIcon className="size-3.5" />
                    Open plan
                  </Button>
                </div>
                <div className="text-sm text-foreground">
                  <ChatMarkdown text={entry.proposedPlan.planMarkdown} cwd={openInCwd ?? undefined} />
                </div>
              </div>
            );
          }

          const workEntry = entry.entry;
          if (isCommandWorkEntry(workEntry)) {
            const status = commandStatusLabel(workEntry);
            const commandTextSanitized = sanitizeCommandLabelForDisplay(
              workEntry.command?.trim() || workEntry.label,
            ).trim();
            const commandText = commandTextSanitized.length > 0 ? commandTextSanitized : workEntry.label;
            const commandLabel =
              workEntry.alwaysVisible && !commandText.startsWith("!")
                ? `! ${commandText}`
                : commandText;
            const stateKey = commandDropdownStateKey(workEntry);
            const isOutputExpanded = expandedCommandOutputByKey[stateKey] ?? false;
            return (
              <DraftCommandEntryRow
                key={entry.id}
                workEntry={workEntry}
                commandLabel={commandLabel}
                status={status}
                isOutputExpanded={isOutputExpanded}
                onOutputExpandedChange={(expanded) =>
                  onCommandOutputExpandedChange(workEntry, expanded)
                }
                showTerminalActions={status === "Running"}
                terminalControlState={terminalControlState}
                onOpenTerminal={onOpenTerminal}
                onTakeOver={onTakeOverTerminal}
                onHandBack={onHandBackTerminal}
              />
            );
          }

          if (
            workEntry.requestKind === "file-read" ||
            workEntry.itemType === "web_search" ||
            workEntry.itemType === "mcp_tool_call" ||
            workEntry.itemType === "dynamic_tool_call" ||
            workEntry.itemType === "collab_agent_tool_call"
          ) {
            return <DraftActionStepRow key={entry.id} workEntry={workEntry} />;
          }
          const WorkIcon = resolveWorkIcon(workEntry);
          const heading = resolveWorkHeading(workEntry);
          const hasFileChangePanel = Boolean(workEntry.changedFiles && workEntry.changedFiles.length > 0);
          const shouldShowInlineDetail =
            Boolean(workEntry.detail) &&
            !(workEntry.itemType === "file_change" && hasFileChangePanel);
          return (
            <div
              key={entry.id}
              className={`ml-7 rounded-xl border px-3 py-2 ${
                workEntry.tone === "error"
                  ? "border-destructive/40 bg-destructive/10"
                  : "border-border bg-card/60"
              }`}
            >
              <div className="flex items-start gap-2">
                <WorkIcon
                  className={`mt-0.5 size-3.5 shrink-0 ${
                    workEntry.tone === "error" ? "text-destructive" : "text-muted-foreground"
                  }`}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm text-foreground">{heading}</p>
                  {shouldShowInlineDetail ? (
                    <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                      {workEntry.detail}
                    </p>
                  ) : null}
                  {workEntry.command ? (
                    <code className="block break-words font-mono text-xs text-muted-foreground">
                      {sanitizeCommandLabelForDisplay(workEntry.command)}
                    </code>
                  ) : null}
                  {hasFileChangePanel ? (
                    <DraftFileChangesPanel workEntry={workEntry} />
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    ),
    [
      draftRenderables,
      expandedCommandOutputByKey,
      onCommandOutputExpandedChange,
      onHandBackTerminal,
      onOpenTerminal,
      onRespondToApproval,
      onTakeOverTerminal,
      openInCwd,
      openPlanSidebar,
      respondingApprovalRequestIds,
      terminalControlState,
    ],
  );

  return (
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={setSidebarOpen}
      className="h-dvh w-full bg-background text-foreground"
      style={{ "--sidebar-width": "272px" } as CSSProperties}
      dir="ltr"
    >
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
      >
        <ThreadSidebar
          onSelectThread={onSelectThreadFromSidebar}
          onCreateThreadInProject={onCreateThreadInProjectFromSidebar}
        />
      </Sidebar>

      <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
        <div className="flex h-full min-h-0">
          <div className="flex min-w-0 flex-1 flex-col">
          <header className="drag-region border-b border-border bg-card/95 px-3 py-1.5">
            <div className="flex h-9 min-w-0 items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-1.5">
                <ThreadSidebarToggle className="border-border bg-background text-foreground hover:bg-muted/60" />
                <ThreadNewButton className="border-border bg-background text-foreground hover:bg-muted/60" />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                >
                  <ArrowLeftIcon className="size-3.5" />
                </Button>
                <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  ESC
                </span>
                <span className="truncate text-xs text-muted-foreground">for terminal</span>
              </div>

              <div className="flex min-w-0 items-center gap-2">
                <CheckIcon className="size-3.5 text-success" />
                <span className="truncate text-sm text-foreground">{title}</span>
                <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {terminalControlState === "user-takeover"
                    ? "User takeover"
                    : terminalControlState === "handback-pending"
                      ? "Handback pending"
                      : "Agent attached"}
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="xs"
                        variant="outline"
                        className="border-border bg-background text-foreground hover:bg-muted/60"
                      >
                        <PlusIcon className="size-3.5" />
                        <span>Add action</span>
                        <ChevronDownIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <MenuPopup align="end">
                    <MenuItem onClick={() => void createLiveThread("New live draft thread")}>
                      Create live thread
                    </MenuItem>
                    <MenuItem
                      onClick={() => {
                        selectDraftThread(null);
                        addNotice("info", "Switched to latest active thread.");
                      }}
                    >
                      Follow latest thread
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      onClick={() => setPrompt("Summarize the latest thread activity and next steps.")}
                    >
                      Insert summary prompt
                    </MenuItem>
                  </MenuPopup>
                </Menu>

                <OpenInPicker
                  keybindings={keybindings}
                  availableEditors={availableEditors}
                  openInCwd={openInCwd}
                />

                {activeThread && gitCwd ? (
                  <GitActionsControl gitCwd={gitCwd} activeThreadId={activeThread.id} />
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled
                    className="border-border bg-background text-muted-foreground"
                  >
                    Commit & push
                  </Button>
                )}

                <Button
                  size="icon-xs"
                  variant="outline"
                  className="border-border bg-background text-muted-foreground hover:bg-muted/60"
                  onClick={() => addNotice("info", "Timeline refreshed from live store state.")}
                >
                  <RefreshCwIcon className="size-3.5" />
                </Button>
                {hasPlanSidebarContent || planSidebarOpen ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="outline"
                    className={`border-border bg-background hover:bg-muted/60 ${
                      planSidebarOpen ? "text-primary" : "text-muted-foreground"
                    }`}
                    title={planSidebarOpen ? "Hide plan sidebar" : "Show plan sidebar"}
                    onClick={togglePlanSidebar}
                  >
                    <ListTodoIcon className="size-3.5" />
                  </Button>
                ) : null}
                <Button
                  size="icon-xs"
                  variant="outline"
                  className="border-border bg-background text-muted-foreground hover:bg-muted/60"
                >
                  <EllipsisIcon className="size-3.5" />
                </Button>
              </div>
            </div>
          </header>

          <main
            ref={timelineScrollRef}
            onScroll={onTimelineScroll}
            className="relative flex min-h-0 flex-1 flex-col overflow-y-auto"
          >
            <div className="mx-auto w-full max-w-5xl px-5 py-5">
              <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
                <TerminalSquareIcon className="size-3.5" />
                <span>{projectLabel}</span>
                <span>•</span>
                <span>{branchLabel}</span>
                <span>•</span>
                <span>{activeThread?.messages.length ?? 0} messages</span>
                {isThreadBusy ? (
                  <>
                    <span>•</span>
                    <span className="text-primary">running</span>
                  </>
                ) : null}
              </div>

              {notices.length > 0 ? (
                <div className="mb-4 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Notices
                    </p>
                    {notices.length > 1 ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        className="h-6 px-2 text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                        onClick={clearNotices}
                      >
                        Clear all
                      </Button>
                    ) : null}
                  </div>
                  {notices.map((notice) => (
                    <div
                      key={notice.id}
                      className={`flex items-start gap-2 rounded border px-3 py-2 text-xs ${
                        notice.tone === "error"
                          ? "border-destructive/40 bg-destructive/10 text-destructive"
                          : notice.tone === "success"
                            ? "border-success/40 bg-success/10 text-success"
                            : "border-border bg-muted/40 text-foreground"
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        {notice.kind === "status-continuity" ? (
                          <span className="mr-1.5 inline-flex rounded-full border border-primary/35 bg-primary/12 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary">
                            Status
                          </span>
                        ) : null}
                        {notice.text}
                      </span>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        className="h-5 w-5 shrink-0 rounded-full p-0 text-current/70 hover:bg-muted/60 hover:text-current"
                        aria-label="Dismiss notice"
                        onClick={() => dismissNotice(notice.id)}
                      >
                        <XIcon className="size-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}

              {!threadsHydrated ? (
                <div className="rounded-md border border-border bg-card/60 px-4 py-4 text-sm text-muted-foreground">
                  Connecting to orchestration snapshot...
                </div>
              ) : null}


              <div className="space-y-4">
                {!activeThread ? (
                  <div className="rounded-md border border-border bg-card/60 px-4 py-4 text-sm text-muted-foreground">
                    No thread yet. Send a prompt below and this draft view will create a real thread and
                    dispatch a live turn.
                  </div>
                ) : activeThread.messages.length === 0 && draftRenderables.length === 0 ? (
                  <div className="rounded-md border border-border bg-card/60 px-4 py-4 text-sm text-muted-foreground">
                    Thread is ready. Send a prompt to start a live run.
                  </div>
                ) : (
                  draftTimelineContent
                )}
              </div>

              {activeThread?.error ? (
                <div className="mt-4 flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                  <span>{activeThread.error}</span>
                </div>
              ) : null}
            </div>
            {showScrollToBottom ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="pointer-events-auto border-border bg-background text-foreground shadow-lg hover:bg-muted/60"
                  onClick={() => scrollTimelineToBottom("smooth")}
                >
                  <ChevronDownIcon className="size-3.5" />
                  Scroll to latest
                </Button>
              </div>
            ) : null}
          </main>

          <footer className="border-t border-border bg-card px-4 py-3">
            <form onSubmit={onSubmit} className="mx-auto w-full max-w-5xl space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  {(["auto", "task", "command"] as const).map((mode) => (
                    <Button
                      key={`mode:${mode}`}
                      type="button"
                      size="xs"
                      variant={currentComposerMode === mode ? "default" : "outline"}
                      className="h-7 px-2.5"
                      onClick={() =>
                        setComposerModeByThreadId((existing) => ({
                          ...existing,
                          [activeThreadKey]: mode,
                        }))
                      }
                    >
                      {mode === "auto" ? "Auto" : mode === "task" ? "Agent" : "Command"}
                    </Button>
                  ))}
                </div>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                    resolvedIntentMode === "command"
                      ? "border-primary/50 bg-primary/15 text-primary"
                      : "border-border bg-muted/40 text-muted-foreground"
                  }`}
                >
                  {resolvedIntentMode === "command" ? "! shell mode" : "agent mode"}
                </span>
                {resolvedIntentMode === "command" ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="h-7 px-2 text-[11px] text-muted-foreground"
                    onClick={() =>
                      setComposerModeByThreadId((existing) => ({
                        ...existing,
                        [activeThreadKey]: "auto",
                      }))
                    }
                  >
                    Exit shell
                  </Button>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="icon-xs"
                  variant="outline"
                  className="border-border bg-background text-muted-foreground hover:bg-muted/60"
                >
                  <PlusIcon className="size-3.5" />
                </Button>
                <label
                  className={`flex min-h-11 flex-1 items-stretch rounded-lg border px-3 py-2 ${
                    resolvedIntentMode === "command"
                      ? "border-primary/45 bg-primary/5"
                      : "border-border bg-background"
                  }`}
                >
                  <textarea
                    value={prompt}
                    onChange={(event) => onPromptChange(event.target.value)}
                    onKeyDown={onPromptKeyDown}
                    rows={2}
                    className="max-h-[45vh] min-h-[3rem] w-full resize-y overflow-y-auto border-0 bg-transparent text-sm leading-5 text-foreground outline-none"
                    placeholder={
                      resolvedIntentMode === "command"
                        ? "! npm run test (Tab to accept suggestion)"
                        : "Ask anything, e.g. set up Redis caching for my web application"
                    }
                  />
                </label>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!canSend}
                  className={`h-11 border-primary/40 text-primary hover:bg-primary/25 ${
                    resolvedIntentMode === "command" ? "bg-primary/20" : "bg-primary/15"
                  }`}
                >
                  <SendHorizonal className="size-4" />
                  {sending ? "Sending..." : resolvedIntentMode === "command" ? "Run" : "Send"}
                </Button>
              </div>
              {visibleSuggestions.length > 0 ? (
                <p className="pl-9 text-[11px] text-muted-foreground">
                  Tab to autocomplete:{" "}
                  <span className="font-mono text-foreground">{visibleSuggestions[0]}</span>
                </p>
              ) : null}
              <div className="flex items-center gap-2 overflow-x-auto text-[11px] text-muted-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <span className="max-w-[40%] truncate rounded border border-border bg-muted/40 px-2 py-1 font-mono text-foreground" title={cwdLabel}>
                  {cwdLabel}
                </span>
                <span className="rounded border border-border bg-muted/40 px-2 py-1">{branchLabel}</span>
                <span className="rounded border border-border bg-muted/40 px-2 py-1">
                  <span className="text-success">+{gitInsertions}</span>
                  <span className="mx-1 text-muted-foreground">/</span>
                  <span className="text-destructive">-{gitDeletions}</span>
                </span>
                <span className="rounded border border-border bg-muted/40 px-2 py-1">{contextUsageLabel}</span>
                {codexAuthSourceIndicator ? (
                  <span
                    title={codexAuthSourceIndicator.description}
                    className={`rounded border px-2 py-1 ${
                      codexAuthSourceIndicator.tone === "success"
                        ? "border-success/45 bg-success/10 text-success"
                        : codexAuthSourceIndicator.tone === "warning"
                          ? "border-amber-500/45 bg-amber-500/12 text-amber-700 dark:text-amber-300"
                          : "border-border bg-muted/40 text-muted-foreground"
                    }`}
                  >
                    {codexAuthSourceIndicator.label}
                  </span>
                ) : null}
                <span className="rounded border border-border bg-muted/40 px-2 py-1">
                  {terminalControlState === "user-takeover"
                    ? "User takeover"
                    : terminalControlState === "handback-pending"
                      ? "Handback pending"
                      : "Agent attached"}
                </span>
                <span className="rounded border border-border bg-muted/40 px-2 py-1">
                  terminals {terminalState.runningTerminalIds.length > 0 ? "active" : "idle"}
                </span>
                <ProviderModelPicker
                  activeThread={activeThread ?? null}
                  compact
                  language={settings.language}
                  provider={providerForFooter}
                  providerPickerKind={selectedProviderPickerKind}
                  model={selectedModelForFooter as ModelSlug}
                  lockedProvider={forcedProvider}
                  allModelOptionsByProvider={allModelOptionsByProvider}
                  visibleModelOptionsByProvider={visibleModelOptionsByProvider}
                  openRouterModelOptions={openRouterModelOptions}
                  opencodeModelOptions={visibleDiscoveredOpencodeModelOptions}
                  openRouterContextLengthsBySlug={openRouterContextLengthsBySlug}
                  opencodeContextLengthsBySlug={opencodeContextLengthsBySlug}
                  serviceTierSetting={settings.codexServiceTier}
                  hasHiddenModels={hasHiddenPickerModels}
                  projectDefaultProvider={projectDefaultProvider}
                  projectDefaultModel={projectDefaultModel}
                  modelSelectionSource={selectedModelSelectionSource}
                  favoriteModelsByProvider={favoriteModelsByProvider}
                  recentModelsByProvider={recentModelsByProvider}
                  onOpenProviderSetup={onOpenSettingsFromDraftPicker}
                  onOpenManageModels={onOpenSettingsFromDraftPicker}
                  onOpenUsageDashboard={onOpenUsageFromDraftPicker}
                  onProviderModelChange={onSelectDraftProviderModel}
                  onSetProjectDefaultModel={onSetProjectDefaultFromPicker}
                />
              </div>
            </form>
          </footer>
          </div>
          {planSidebarOpen ? (
            <PlanSidebar
              activePlan={activePlan}
              activeProposedPlan={activeProposedPlan}
              markdownCwd={openInCwd ?? undefined}
              workspaceRoot={activeProject?.cwd ?? undefined}
              timestampFormat={settings.timestampFormat}
              onClose={() => {
                setPlanSidebarOpen(false);
                if (activePlanSidebarKey) {
                  planSidebarDismissedForTurnRef.current = activePlanSidebarKey;
                }
              }}
            />
          ) : null}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export const Route = createFileRoute("/draft")({
  validateSearch: (search: Record<string, unknown>) => ({
    threadId:
      typeof search.threadId === "string" && search.threadId.trim().length > 0
        ? search.threadId
        : undefined,
  }),
  component: DraftRouteView,
});
