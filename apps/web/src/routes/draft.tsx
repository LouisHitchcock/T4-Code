import {
  ApprovalRequestId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ProviderApprovalDecision,
  type ProviderKind,
  type ServerProviderStatus,
  type EditorId,
  type ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";
import { resolveModelSlugForProvider } from "@t3tools/shared/model";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  EllipsisIcon,
  GlobeIcon,
  HammerIcon,
  PlusIcon,
  RefreshCwIcon,
  SendHorizonal,
  SquarePenIcon,
  TerminalIcon,
  TerminalSquareIcon,
  TriangleAlertIcon,
  UserIcon,
  WrenchIcon,
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
import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX, isScrollContainerNearBottom } from "../chat-scroll";
import ChatMarkdown from "../components/ChatMarkdown";
import GitActionsControl from "../components/GitActionsControl";
import ThreadNewButton from "../components/ThreadNewButton";
import ThreadSidebar from "../components/Sidebar";
import ThreadSidebarToggle from "../components/ThreadSidebarToggle";
import { OpenInPicker } from "../components/chat/OpenInPicker";
import { ComposerPendingApprovalActions } from "../components/chat/ComposerPendingApprovalActions";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import { Sidebar, SidebarInset, SidebarProvider } from "../components/ui/sidebar";
import {
  describeContextWindowState,
  getDocumentedContextWindowOverride,
} from "../lib/contextWindow";
import { gitStatusQueryOptions } from "../lib/gitReactQuery";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { newCommandId, newMessageId, newThreadId, randomUUID } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  type PendingApproval,
  type PendingUserInput,
  type WorkLogEntry,
} from "../session-logic";
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

interface RuntimeNotice {
  id: string;
  tone: "success" | "error" | "info";
  text: string;
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

function resolveDraftModelOptions(input: {
  providerStatuses: ReadonlyArray<ServerProviderStatus>;
  provider: ProviderKind;
  currentModel: string;
}): string[] {
  const status = input.providerStatuses.find((entry) => entry.provider === input.provider);
  const fromStatus = (status?.availableModels ?? [])
    .map((entry) => entry.slug.trim())
    .filter((slug) => slug.length > 0);
  const options = new Set<string>(fromStatus);
  if (input.currentModel.trim().length > 0) {
    options.add(input.currentModel.trim());
  }
  if (options.size === 0) {
    options.add(DEFAULT_MODEL_BY_PROVIDER[input.provider]);
  }
  return [...options];
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
  if (entry.tone === "error") {
    return true;
  }
  const activityKind = entry.activityKind?.trim().toLowerCase();
  const label = entry.label.trim().toLowerCase();
  if (
    activityKind === "terminal.command.completed" ||
    activityKind === "tool.completed" ||
    label === "command completed" ||
    label === "command failed"
  ) {
    return true;
  }
  return !isRunningCommandEntry(entry) && Boolean(entry.itemId);
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
function mergeCommandProgressEntries(entries: ReadonlyArray<WorkLogEntry>): WorkLogEntry[] {
  const merged: WorkLogEntry[] = [];
  const activeCommandIndexByKey = new Map<string, number>();
  for (const entry of entries) {
    if (!isCommandWorkEntry(entry)) {
      merged.push(entry);
      continue;
    }
    const key = commandMergeKey(entry);
    if (!key) {
      merged.push(entry);
      continue;
    }
    const existingIndex = activeCommandIndexByKey.get(key);
    if (existingIndex === undefined) {
      merged.push(entry);
      if (isRunningCommandEntry(entry)) {
        activeCommandIndexByKey.set(key, merged.length - 1);
      }
      continue;
    }
    const existing = merged[existingIndex];
    if (!existing) {
      activeCommandIndexByKey.delete(key);
      merged.push(entry);
      if (isRunningCommandEntry(entry)) {
        activeCommandIndexByKey.set(key, merged.length - 1);
      }
      continue;
    }
    const mergedCommand = entry.command ?? existing.command;
    const mergedDetail = mergeCommandOutputDetail(existing.detail, entry.detail);
    const mergedChangedFiles = entry.changedFiles ?? existing.changedFiles;
    const mergedItemType = entry.itemType ?? existing.itemType;
    const mergedRequestKind = entry.requestKind ?? existing.requestKind;
    const mergedToolTitle = entry.toolTitle ?? existing.toolTitle;
    const mergedItemId = entry.itemId ?? existing.itemId;
    const mergedActivityKind = entry.activityKind ?? existing.activityKind;
    merged[existingIndex] = {
      ...existing,
      ...entry,
      createdAt: existing.createdAt,
      tone: entry.tone,
      label: entry.label,
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
                className="h-[58vh] max-h-[72vh] overflow-y-auto px-3 py-3"
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

function buildFileChangeTabs(entry: WorkLogEntry): DraftFileChangeTab[] {
  const changedFiles = [...new Set((entry.changedFiles ?? []).map((path) => path.trim()))].filter(
    (path) => path.length > 0,
  );
  const detail = entry.detail?.trim();
  const diffBlocks = detail ? splitUnifiedDiffByFile(detail) : [];
  const tabByPath = new Map<string, DraftFileChangeTab>();

  for (const filePath of changedFiles) {
    tabByPath.set(filePath, { path: filePath, content: null });
  }
  for (const diffBlock of diffBlocks) {
    tabByPath.set(diffBlock.path, { path: diffBlock.path, content: diffBlock.content });
  }

  if (tabByPath.size === 0) {
    if (!detail) {
      return [];
    }
    return [{ path: "details", content: detail }];
  }

  if (detail && diffBlocks.length === 0 && changedFiles.length === 1) {
    const onlyPath = changedFiles[0]!;
    tabByPath.set(onlyPath, { path: onlyPath, content: detail });
  }

  const orderedPaths = [
    ...changedFiles,
    ...[...tabByPath.keys()].filter((path) => !changedFiles.includes(path)),
  ];
  return orderedPaths
    .map((path) => tabByPath.get(path))
    .filter((tab): tab is DraftFileChangeTab => Boolean(tab));
}

function DraftFileChangesPanel({ workEntry }: { workEntry: WorkLogEntry }) {
  const tabs = useMemo(() => buildFileChangeTabs(workEntry), [workEntry]);
  const [isOpen, setIsOpen] = useState(false);
  const [activePath, setActivePath] = useState<string>(tabs[0]?.path ?? "");
  const activeTab = tabs.find((tab) => tab.path === activePath) ?? tabs[0] ?? null;

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
      <CollapsibleContent className="pt-2">
        <div className="overflow-hidden rounded-xl border border-border bg-card/70">
          <div className="border-b border-border bg-muted/40 px-2 py-2">
            <div className="flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {tabs.map((tab) => (
                <button
                  key={`${workEntry.id}:${tab.path}`}
                  type="button"
                  className={`shrink-0 rounded-md border px-2 py-1 font-mono text-[10px] transition ${
                    activeTab.path === tab.path
                      ? "border-border bg-background text-foreground"
                      : "border-border/70 bg-muted/30 text-muted-foreground hover:bg-muted/50"
                  }`}
                  title={tab.path}
                  onClick={() => setActivePath(tab.path)}
                >
                  {tab.path}
                </button>
              ))}
            </div>
          </div>
          <div className="max-h-[34vh] overflow-auto px-3 py-2">
            {activeTab.content ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                {activeTab.content}
              </pre>
            ) : (
              <p className="font-mono text-xs text-muted-foreground">
                Diff content is unavailable for this file in the current tool payload.
              </p>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function resolveActionStepTarget(workEntry: WorkLogEntry): string {
  const command = workEntry.command?.trim();
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
    const preferred = threads.find((thread) => thread.id === preferredThreadId);
    if (preferred) {
      return preferred;
    }
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
  const { data: serverConfig } = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfig?.keybindings ?? EMPTY_KEYBINDINGS;
  const availableEditors = serverConfig?.availableEditors ?? EMPTY_EDITORS;
  const preferredProvider = useMemo(
    () => resolvePreferredDraftProvider(serverConfig?.providers ?? []),
    [serverConfig?.providers],
  );

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
  const [expandedCommandOutputByKey, setExpandedCommandOutputByKey] = useState<
    Record<string, boolean>
  >({});
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const timelineScrollRef = useRef<HTMLElement | null>(null);
  const shouldAutoScrollRef = useRef(true);

  const activeThread = useMemo(
    () => resolveLatestThread(threads, preferredThreadId),
    [threads, preferredThreadId],
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
    return projects[0] ?? null;
  }, [activeThread, projects]);
  const openInCwd = activeThread
    ? activeThread.worktreePath ?? activeProject?.cwd ?? null
    : activeProject?.cwd ?? null;
  const activeShellCwd = activeThread
    ? (terminalCwdByThreadId[activeThread.id] ?? openInCwd)
    : openInCwd;
  const gitCwd = activeShellCwd ?? openInCwd;
  const { data: gitStatus } = useQuery(gitStatusQueryOptions(gitCwd));
  const projectLabel = activeProject?.name ?? "No project";
  const branchLabel = gitStatus?.branch ?? activeThread?.branch ?? "main";
  const title = activeThread?.title ?? "Warp-style Live Draft";
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
  const providerForFooter = activeThread?.provider ?? preferredProvider;
  const modelForFooter = activeThread?.model
    ? resolveModelSlugForProvider(providerForFooter, activeThread.model)
    : resolveModelSlugForProvider(
        providerForFooter,
        activeProject?.model ?? DEFAULT_MODEL_BY_PROVIDER[providerForFooter],
      );
  const contextState = describeContextWindowState({
    provider: providerForFooter,
    model: modelForFooter,
    tokenUsage: activeThread?.session?.tokenUsage,
    ...getDocumentedContextWindowOverride({ provider: providerForFooter, model: modelForFooter }),
  });
  const contextUsageLabel = formatDraftContextUsage({
    usedTokens: contextState.usedTokens,
    totalTokens: contextState.totalTokens,
  });
  const unifiedInteractionBundleEnabled =
    import.meta.env.VITE_DRAFT_UNIFIED_INTERACTIONS !== "0";
  const draftModelOptions = useMemo(
    () =>
      resolveDraftModelOptions({
        providerStatuses: serverConfig?.providers ?? [],
        provider: providerForFooter,
        currentModel: modelForFooter,
      }),
    [modelForFooter, providerForFooter, serverConfig?.providers],
  );
  const [selectedDraftModel, setSelectedDraftModel] = useState(modelForFooter);
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
      unifiedInteractionBundleEnabled
        ? timelineRenderables
        : timelineEntries.map((entry) => ({
            id: `entry:${entry.id}`,
            createdAt: entry.createdAt,
            kind: "entry" as const,
            entry,
          })),
    [timelineEntries, timelineRenderables, unifiedInteractionBundleEnabled],
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
  const qualityMetrics = useMemo(() => {
    if (!activeThread) return null;
    const firstUserMessage = activeThread.messages.find((message) => message.role === "user");
    const firstCommandEntry = timelineEntries.find(
      (entry) => entry.kind === "work" && isCommandWorkEntry(entry.entry),
    );
    const commandCompletionEntries = timelineEntries
      .flatMap((entry) => (entry.kind === "work" && isCommandWorkEntry(entry.entry) ? [entry.entry] : []))
      .filter((entry) => entry.exitCode !== undefined || entry.tone === "error");
    const startupToReadyMs =
      activeThread.session?.createdAt && activeThread.latestTurn?.startedAt
        ? Math.max(
            0,
            Date.parse(activeThread.latestTurn.startedAt) - Date.parse(activeThread.session.createdAt),
          )
        : null;
    const firstCommandLatencyMs =
      firstUserMessage && firstCommandEntry
        ? Math.max(0, Date.parse(firstCommandEntry.createdAt) - Date.parse(firstUserMessage.createdAt))
        : null;
    return {
      startupToReadyMs,
      firstCommandLatencyMs,
      commandCompletions: commandCompletionEntries.length,
      pendingApprovals: pendingApprovals.length,
    };
  }, [activeThread, pendingApprovals.length, timelineEntries]);
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
    setSuggestionActive(false);
    setHistoryIndexByThreadId((existing) => ({ ...existing, [activeThreadKey]: -1 }));
  }, [activeThreadKey]);
  useEffect(() => {
    setSelectedDraftModel(modelForFooter);
  }, [modelForFooter, activeThread?.id, providerForFooter]);
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

  const addNotice = useCallback((tone: RuntimeNotice["tone"], text: string) => {
    setNotices((existing) => {
      const next = [...existing, { id: randomUUID(), tone, text }];
      return next.slice(-6);
    });
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
    const provider = preferredProvider;
    const model = resolveModelSlugForProvider(
      provider,
      selectedDraftModel || targetProject.model?.trim(),
    );
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();

    await api.orchestration.dispatchCommand({
      type: "thread.create",
      commandId: newCommandId(),
      threadId,
      projectId: targetProject.id,
      title: truncateTitle(seedText || "Live draft thread"),
      model,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt,
    });

    setPreferredThreadId(threadId);
    addNotice("success", "Created live thread in orchestration runtime.");
    return {
      threadId,
      model,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      provider,
    };
  };
  const onSelectThreadFromSidebar = useCallback((threadId: ThreadId) => {
    setPreferredThreadId(threadId);
  }, []);
  const onCreateThreadInProjectFromSidebar = useCallback(
    async (projectId: Thread["projectId"]) => {
      await createLiveThread("Live draft thread", projectId);
    },
    [createLiveThread],
  );
  const onSelectDraftModel = useCallback(
    async (model: string) => {
      setSelectedDraftModel(model);
      if (!activeThread) return;
      const api = readNativeApi();
      if (!api) {
        addNotice("error", "Native API unavailable. Could not update thread model.");
        return;
      }
      const normalizedModel = resolveModelSlugForProvider(providerForFooter, model);
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
    [activeThread, addNotice, providerForFooter],
  );
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
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Tab" && suggestionActive && applySuggestionFromMode()) {
        event.preventDefault();
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
      setHistoryIndexByThreadId((existing) => ({ ...existing, [activeThreadKey]: -1 }));
      const hasTypedText = value.trim().length > 0;
      setSuggestionActive(hasTypedText);
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
              provider: activeThread.provider ?? preferredProvider,
              model: resolveModelSlugForProvider(
                activeThread.provider ?? preferredProvider,
                activeThread.model,
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

        setPreferredThreadId(target.threadId);
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
        ...(target.provider ? { provider: target.provider } : {}),
        model:
          resolveModelSlugForProvider(
            target.provider ?? providerForFooter,
            selectedDraftModel || target.model?.trim(),
          ) || DEFAULT_MODEL_BY_PROVIDER.codex,
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
      setPreferredThreadId(target.threadId);
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
        <div className="flex h-full min-h-0 flex-col">
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
                        setPreferredThreadId(null);
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
                <span
                  className={`rounded border px-2 py-1 ${
                    unifiedInteractionBundleEnabled
                      ? "border-success/40 bg-success/10 text-success"
                      : "border-warning/40 bg-warning/10 text-warning"
                  }`}
                >
                  interactions {unifiedInteractionBundleEnabled ? "on" : "off"}
                </span>

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
                  {notices.map((notice) => (
                    <div
                      key={notice.id}
                      className={`rounded border px-3 py-2 text-xs ${
                        notice.tone === "error"
                          ? "border-destructive/40 bg-destructive/10 text-destructive"
                          : notice.tone === "success"
                            ? "border-success/40 bg-success/10 text-success"
                            : "border-border bg-muted/40 text-foreground"
                      }`}
                    >
                      {notice.text}
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
                            isResponding={respondingApprovalRequestIds.includes(
                              renderable.approval.requestId,
                            )}
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
                          const messageText =
                            entry.message.text || (entry.message.streaming ? "" : "(empty response)");
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
                          <div
                            key={entry.id}
                            className="ml-7 rounded-xl border border-border bg-card/60 px-3 py-3"
                          >
                            <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                              Proposed plan
                            </p>
                            <div className="text-sm text-foreground">
                              <ChatMarkdown
                                text={entry.proposedPlan.planMarkdown}
                                cwd={openInCwd ?? undefined}
                              />
                            </div>
                          </div>
                        );
                      }

                      const workEntry = entry.entry;
                      if (isCommandWorkEntry(workEntry)) {
                        const status = commandStatusLabel(workEntry);
                        const commandText = workEntry.command?.trim() || workEntry.label;
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
                              {workEntry.detail ? (
                                <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                                  {workEntry.detail}
                                </p>
                              ) : null}
                              {workEntry.command ? (
                                <code className="block break-words font-mono text-xs text-muted-foreground">
                                  {workEntry.command}
                                </code>
                              ) : null}
                              {workEntry.changedFiles && workEntry.changedFiles.length > 0 ? (
                                <DraftFileChangesPanel workEntry={workEntry} />
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
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
                  className={`flex h-11 flex-1 items-center rounded-lg border px-3 ${
                    resolvedIntentMode === "command"
                      ? "border-primary/45 bg-primary/5"
                      : "border-border bg-background"
                  }`}
                >
                  <input
                    list={visibleSuggestions.length > 0 ? "draft-composer-suggestions" : undefined}
                    value={prompt}
                    onChange={(event) => onPromptChange(event.target.value)}
                    onKeyDown={onPromptKeyDown}
                    className="w-full border-0 bg-transparent text-sm text-foreground outline-none"
                    placeholder={
                      resolvedIntentMode === "command"
                        ? "! npm run test (Tab to accept suggestion)"
                        : "Warp anything e.g. Set up Redis caching for my web application"
                    }
                  />
                </label>
                {visibleSuggestions.length > 0 ? (
                  <datalist id="draft-composer-suggestions">
                    {visibleSuggestions.map((suggestion) => (
                      <option key={`suggestion:${suggestion}`} value={suggestion} />
                    ))}
                  </datalist>
                ) : null}
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
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="xs"
                        variant="outline"
                        className="h-auto border-border bg-muted/40 px-2 py-1 text-[11px] text-foreground hover:bg-muted/60"
                      >
                        <span className="truncate">{selectedDraftModel}</span>
                        <ChevronDownIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <MenuPopup align="end">
                    {draftModelOptions.map((model) => (
                      <MenuItem key={model} onClick={() => void onSelectDraftModel(model)}>
                        {model}
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              </div>
              {import.meta.env.DEV && qualityMetrics ? (
                <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
                  <p className="mb-1 uppercase tracking-wide text-foreground">Draft quality metrics</p>
                  <div className="flex flex-wrap gap-3">
                    <span>
                      startup→ready{" "}
                      {qualityMetrics.startupToReadyMs === null
                        ? "n/a"
                        : `${Math.round(qualityMetrics.startupToReadyMs)}ms`}
                    </span>
                    <span>
                      first-command{" "}
                      {qualityMetrics.firstCommandLatencyMs === null
                        ? "n/a"
                        : `${Math.round(qualityMetrics.firstCommandLatencyMs)}ms`}
                    </span>
                    <span>completed commands {qualityMetrics.commandCompletions}</span>
                    <span>pending approvals {qualityMetrics.pendingApprovals}</span>
                  </div>
                </div>
              ) : null}
            </form>
          </footer>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export const Route = createFileRoute("/draft")({
  component: DraftRouteView,
});
