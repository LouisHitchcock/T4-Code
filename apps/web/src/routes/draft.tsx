import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EditorId,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
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
} from "react";
import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX, isScrollContainerNearBottom } from "../chat-scroll";
import ChatMarkdown from "../components/ChatMarkdown";
import GitActionsControl from "../components/GitActionsControl";
import ThreadNewButton from "../components/ThreadNewButton";
import ThreadSidebar from "../components/Sidebar";
import ThreadSidebarToggle from "../components/ThreadSidebarToggle";
import { OpenInPicker } from "../components/chat/OpenInPicker";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import { Sidebar, SidebarInset, SidebarProvider } from "../components/ui/sidebar";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { newCommandId, newMessageId, newThreadId, randomUUID } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { deriveTimelineEntries, deriveWorkLogEntries, type WorkLogEntry } from "../session-logic";
import { useStore } from "../store";
import type { Thread } from "../types";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_EDITORS: EditorId[] = [];

interface RuntimeNotice {
  id: string;
  tone: "success" | "error" | "info";
  text: string;
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
  if (entry.tone === "error" || entry.label.trim().toLowerCase() === "command failed") {
    return "Failed";
  }
  return isRunningCommandEntry(entry) ? "Running" : "Done";
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
}
function DraftCommandEntryRow({
  workEntry,
  commandLabel,
  status,
  isOutputExpanded,
  onOutputExpandedChange,
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
        <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition hover:border-[#2b3148] hover:bg-[#11162a]">
          <TerminalSquareIcon className="size-3.5 shrink-0 text-cyan-300" />
          <code className="min-w-0 flex-1 truncate font-mono text-sm text-zinc-100">
            {commandLabel}
          </code>
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
              status === "Failed"
                ? "border-red-700/60 bg-red-950/40 text-red-200"
                : status === "Running"
                  ? "border-cyan-700/60 bg-cyan-950/40 text-cyan-200"
                  : "border-emerald-700/60 bg-emerald-950/40 text-emerald-200"
            }`}
          >
            {status}
          </span>
          <ChevronDownIcon
            className={`size-3.5 shrink-0 text-zinc-400 transition-transform ${
              isOutputExpanded ? "rotate-180" : ""
            }`}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="pl-2">
          <div className="mt-2 overflow-hidden rounded-2xl border border-[#2b3148] bg-[#0a0f1b] shadow-[0_24px_56px_-36px_rgba(0,0,0,0.9)]">
            <div className="flex items-center justify-between gap-2 border-b border-[#2b3148] bg-[#11162a]/70 px-3 py-2">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-zinc-400">
                <TerminalIcon className="size-3.5" />
                <span>Viewing command detail</span>
              </div>
              <span className="text-[11px] text-zinc-500">{workEntry.label}</span>
            </div>
            <div className="border-b border-[#2b3148] bg-[#0d1221]/75 px-3 py-2">
              <code className="block break-words font-mono text-[11px] text-zinc-200">
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
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs text-zinc-200">
                    {output}
                  </pre>
                ) : (
                  <p className="font-mono text-xs text-zinc-500">
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
                    className="pointer-events-auto border-[#2b3148] bg-[#11162a]/95 text-zinc-200 hover:bg-[#1a2136]"
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

function DraftRouteView() {
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const { data: serverConfig } = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfig?.keybindings ?? EMPTY_KEYBINDINGS;
  const availableEditors = serverConfig?.availableEditors ?? EMPTY_EDITORS;

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [preferredThreadId, setPreferredThreadId] = useState<ThreadId | null>(null);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
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
  const activeProject = useMemo(() => {
    if (activeThread) {
      return projects.find((project) => project.id === activeThread.projectId) ?? null;
    }
    return projects[0] ?? null;
  }, [activeThread, projects]);
  const openInCwd = activeThread
    ? activeThread.worktreePath ?? activeProject?.cwd ?? null
    : activeProject?.cwd ?? null;
  const gitCwd = openInCwd;
  const projectLabel = activeProject?.name ?? "No project";
  const branchLabel = activeThread?.branch ?? "main";
  const title = activeThread?.title ?? "Warp-style Live Draft";
  const isThreadBusy =
    activeThread?.session?.orchestrationStatus === "starting" ||
    activeThread?.session?.orchestrationStatus === "running";
  const canSend = prompt.trim().length > 0 && !sending;
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
  }, [timelineEntries, scrollTimelineToBottom]);

  const addNotice = (tone: RuntimeNotice["tone"], text: string) => {
    setNotices((existing) => {
      const next = [...existing, { id: randomUUID(), tone, text }];
      return next.slice(-6);
    });
  };

  const createLiveThread = async (seedText: string): Promise<{
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
    if (!activeProject) {
      addNotice("error", "No project available. Add a project first.");
      return null;
    }

    const model = activeProject.model?.trim() || DEFAULT_MODEL_BY_PROVIDER.codex;
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();

    await api.orchestration.dispatchCommand({
      type: "thread.create",
      commandId: newCommandId(),
      threadId,
      projectId: activeProject.id,
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
      provider: undefined,
    };
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || sending) return;

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
              model: activeThread.model,
              runtimeMode: activeThread.runtimeMode,
              interactionMode: activeThread.interactionMode,
              provider: activeThread.provider,
            }
          : await createLiveThread(text);

      if (!target) {
        return;
      }

      const createdAt = new Date().toISOString();
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: target.threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text,
          attachments: [],
        },
        ...(target.provider ? { provider: target.provider } : {}),
        model: target.model?.trim() || DEFAULT_MODEL_BY_PROVIDER.codex,
        runtimeMode: target.runtimeMode,
        interactionMode: target.interactionMode,
        createdAt,
      });
      setPreferredThreadId(target.threadId);
      setPrompt("");
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
      className="h-dvh w-full bg-[#090b14] text-zinc-100"
      style={{ "--sidebar-width": "272px" } as CSSProperties}
      dir="ltr"
    >
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-[#1e2232] bg-[#0b0e1a] text-zinc-100"
      >
        <ThreadSidebar />
      </Sidebar>

      <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-[#090b14] text-zinc-100">
        <div className="flex h-full min-h-0 flex-col">
          <header className="drag-region border-b border-[#1e2232] bg-[#0b0e1a]/95 px-3 py-1.5">
            <div className="flex h-9 min-w-0 items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-1.5">
                <ThreadSidebarToggle className="border-[#242a3d] bg-[#11162a] text-zinc-300 hover:bg-[#1a2136]" />
                <ThreadNewButton className="border-[#242a3d] bg-[#11162a] text-zinc-300 hover:bg-[#1a2136]" />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-zinc-500 hover:bg-[#1a2136] hover:text-zinc-300"
                >
                  <ArrowLeftIcon className="size-3.5" />
                </Button>
                <span className="rounded border border-[#2a2f45] bg-[#0f1322] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                  ESC
                </span>
                <span className="truncate text-xs text-zinc-400">for terminal</span>
              </div>

              <div className="flex min-w-0 items-center gap-2">
                <CheckIcon className="size-3.5 text-emerald-400" />
                <span className="truncate text-sm text-zinc-200">{title}</span>
              </div>

              <div className="flex items-center gap-1.5">
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="xs"
                        variant="outline"
                        className="border-[#2b3148] bg-[#12172b] text-zinc-200 hover:bg-[#1a2136]"
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
                    className="border-[#2b3148] bg-[#12172b] text-zinc-300"
                  >
                    Commit & push
                  </Button>
                )}

                <Button
                  size="icon-xs"
                  variant="outline"
                  className="border-[#2b3148] bg-[#12172b] text-zinc-300 hover:bg-[#1a2136]"
                  onClick={() => addNotice("info", "Timeline refreshed from live store state.")}
                >
                  <RefreshCwIcon className="size-3.5" />
                </Button>
                <Button
                  size="icon-xs"
                  variant="outline"
                  className="border-[#2b3148] bg-[#12172b] text-zinc-300 hover:bg-[#1a2136]"
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
              <div className="mb-4 flex items-center gap-2 text-xs text-zinc-500">
                <TerminalSquareIcon className="size-3.5" />
                <span>{projectLabel}</span>
                <span>•</span>
                <span>{branchLabel}</span>
                <span>•</span>
                <span>{activeThread?.messages.length ?? 0} messages</span>
                {isThreadBusy ? (
                  <>
                    <span>•</span>
                    <span className="text-cyan-300">running</span>
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
                          ? "border-red-800/60 bg-red-950/25 text-red-200"
                          : notice.tone === "success"
                            ? "border-emerald-800/60 bg-emerald-950/25 text-emerald-200"
                            : "border-[#303852] bg-[#151a2a] text-zinc-300"
                      }`}
                    >
                      {notice.text}
                    </div>
                  ))}
                </div>
              ) : null}

              {!threadsHydrated ? (
                <div className="rounded-md border border-[#262c42] bg-[#151a2a] px-4 py-4 text-sm text-zinc-300">
                  Connecting to orchestration snapshot...
                </div>
              ) : null}


              <div className="space-y-4">
                {!activeThread ? (
                  <div className="rounded-md border border-[#262c42] bg-[#151a2a] px-4 py-4 text-sm text-zinc-300">
                    No thread yet. Send a prompt below and this draft view will create a real thread and
                    dispatch a live turn.
                  </div>
                ) : activeThread.messages.length === 0 ? (
                  <div className="rounded-md border border-[#262c42] bg-[#151a2a] px-4 py-4 text-sm text-zinc-300">
                    Thread is ready. Send a prompt to start a live run.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {timelineEntries.map((entry) => {
                      if (entry.kind === "message") {
                        if (entry.message.role === "user") {
                          return (
                            <div key={entry.id} className="space-y-2">
                              <div className="flex items-start gap-2">
                                <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-[#2b3148] bg-[#11162a] text-zinc-200">
                                  <UserIcon className="size-3" />
                                </span>
                                <p className="max-w-4xl whitespace-pre-wrap break-words font-medium text-zinc-100">
                                  {entry.message.text}
                                </p>
                              </div>
                              {entry.message.attachments && entry.message.attachments.length > 0 ? (
                                <div className="ml-7 flex flex-wrap gap-2">
                                  {entry.message.attachments.map((attachment) => (
                                    <span
                                      key={attachment.id}
                                      className="rounded-md border border-[#2b3148] bg-[#11162a] px-2 py-1 font-mono text-xs text-zinc-300"
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
                              <div className="max-w-4xl text-[15px] leading-6 text-zinc-200">
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
                            className="ml-7 rounded-md border border-[#2b3148] bg-[#11162a] px-3 py-2 text-xs text-zinc-300"
                          >
                            {entry.message.text}
                          </div>
                        );
                      }

                      if (entry.kind === "proposed-plan") {
                        return (
                          <div
                            key={entry.id}
                            className="ml-7 rounded-xl border border-[#2b3148] bg-[#11162a] px-3 py-3"
                          >
                            <p className="mb-2 text-xs uppercase tracking-wide text-zinc-400">
                              Proposed plan
                            </p>
                            <div className="text-sm text-zinc-200">
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
                          />
                        );
                      }

                      const WorkIcon = resolveWorkIcon(workEntry);
                      const heading = resolveWorkHeading(workEntry);
                      return (
                        <div
                          key={entry.id}
                          className={`ml-7 rounded-xl border px-3 py-2 ${
                            workEntry.tone === "error"
                              ? "border-red-800/60 bg-red-950/20"
                              : "border-[#2b3148] bg-[#11162a]"
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            <WorkIcon
                              className={`mt-0.5 size-3.5 shrink-0 ${
                                workEntry.tone === "error" ? "text-red-300" : "text-zinc-300"
                              }`}
                            />
                            <div className="min-w-0 flex-1 space-y-1">
                              <p className="text-sm text-zinc-100">{heading}</p>
                              {workEntry.detail ? (
                                <p className="whitespace-pre-wrap break-words text-xs text-zinc-300">
                                  {workEntry.detail}
                                </p>
                              ) : null}
                              {workEntry.command ? (
                                <code className="block break-words font-mono text-xs text-zinc-300">
                                  {workEntry.command}
                                </code>
                              ) : null}
                              {workEntry.changedFiles && workEntry.changedFiles.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {workEntry.changedFiles.slice(0, 4).map((filePath) => (
                                    <span
                                      key={`${entry.id}:${filePath}`}
                                      className="rounded border border-[#333a55] bg-[#0d1120] px-1.5 py-0.5 font-mono text-[10px] text-zinc-300"
                                    >
                                      {filePath}
                                    </span>
                                  ))}
                                  {workEntry.changedFiles.length > 4 ? (
                                    <span className="self-center text-[10px] text-zinc-500">
                                      +{workEntry.changedFiles.length - 4} more
                                    </span>
                                  ) : null}
                                </div>
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
                <div className="mt-4 flex items-start gap-2 rounded border border-red-800/60 bg-red-950/30 px-3 py-2 text-sm text-red-200">
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
                  className="pointer-events-auto border-[#2b3148] bg-[#12172b] text-zinc-200 shadow-lg hover:bg-[#1a2136]"
                  onClick={() => scrollTimelineToBottom("smooth")}
                >
                  <ChevronDownIcon className="size-3.5" />
                  Scroll to latest
                </Button>
              </div>
            ) : null}
          </main>

          <footer className="border-t border-[#1e2232] bg-[#0b0e1a] px-4 py-3">
            <form onSubmit={onSubmit} className="mx-auto flex w-full max-w-5xl items-center gap-2">
              <Button
                size="icon-xs"
                variant="outline"
                className="border-[#2a3048] bg-[#12172b] text-zinc-300 hover:bg-[#1a2136]"
              >
                <PlusIcon className="size-3.5" />
              </Button>
              <label className="flex h-11 flex-1 items-center rounded-lg border border-[#2a3048] bg-[#12172b] px-3">
                <input
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  className="w-full border-0 bg-transparent text-sm text-zinc-100 outline-none"
                  placeholder="Warp anything e.g. Set up Redis caching for my web application"
                />
              </label>
              <Button
                type="submit"
                size="sm"
                disabled={!canSend}
                className="h-11 border-cyan-500/30 bg-cyan-500/15 text-cyan-100 hover:bg-cyan-500/25"
              >
                <SendHorizonal className="size-4" />
                {sending ? "Sending..." : "Send"}
              </Button>
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
