import {
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type ContextMenuItem,
  DispatchResult,
  GitCreateWorktreeResult,
  GitListBranchesResult,
  GitPreparePullRequestThreadResult,
  GitPullResult,
  GitResolvePullRequestResult,
  GitRunStackedActionResult,
  GitStatusResult,
  type NativeApi,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetSnapshotResult,
  OrchestrationGetTurnDiffResult,
  OrchestrationReplayEventsResult,
  ProjectAgentsFileResult,
  ProjectDraftAgentsFileResult,
  ProjectListCommandTemplatesResult,
  ProjectListSkillsResult,
  ProjectSearchEntriesResult,
  ProjectWriteFileResult,
  ServerConfigUpdatedPayload,
  ServerConfig,
  ServerCopilotReasoningProbe,
  ServerCopilotUsage,
  ServerOpenCodeCredentialResult,
  ServerOpenCodeState,
  ServerUpsertKeybindingResult,
  TerminalExecResult,
  TerminalSessionSnapshot,
  ToolsExecuteResult,
  ThreadCompactResult,
  ThreadCreateShareResult,
  ThreadGetShareResult,
  ThreadRedoResult,
  ThreadRedoStatusResult,
  ThreadRevokeShareResult,
  ThreadShareStatusResult,
  ThreadUndoResult,
  ThreadImportShareResult,
  WS_CHANNELS,
  WS_METHODS,
  type WsWelcomePayload,
} from "@draft/contracts";
import { Schema } from "effect";

import { showContextMenuFallback } from "./contextMenuFallback";
import { type TransportState, WsTransport } from "./wsTransport";

let instance: { api: NativeApi; transport: WsTransport } | null = null;
const welcomeListeners = new Set<(payload: WsWelcomePayload) => void>();
const serverConfigUpdatedListeners = new Set<(payload: ServerConfigUpdatedPayload) => void>();
const serverConnectionStateListeners = new Set<() => void>();

function emitServerConnectionStateChange(): void {
  for (const listener of serverConnectionStateListeners) {
    try {
      listener();
    } catch {
      // Swallow listener errors
    }
  }
}

/**
 * Subscribe to the server welcome message. If a welcome was already received
 * before this call, the listener fires synchronously with the cached payload.
 * This avoids the race between WebSocket connect and React effect registration.
 */
export function onServerWelcome(listener: (payload: WsWelcomePayload) => void): () => void {
  welcomeListeners.add(listener);

  const latestWelcome = instance?.transport.getLatestPush(WS_CHANNELS.serverWelcome)?.data ?? null;
  if (latestWelcome) {
    try {
      listener(latestWelcome);
    } catch {
      // Swallow listener errors
    }
  }

  return () => {
    welcomeListeners.delete(listener);
  };
}

export function getLatestServerWelcome(): WsWelcomePayload | null {
  return instance?.transport.getLatestPush(WS_CHANNELS.serverWelcome)?.data ?? null;
}

/**
 * Subscribe to server config update events. Replays the latest update for
 * late subscribers to avoid missing config validation feedback.
 */
export function onServerConfigUpdated(
  listener: (payload: ServerConfigUpdatedPayload) => void,
): () => void {
  serverConfigUpdatedListeners.add(listener);

  const latestConfig =
    instance?.transport.getLatestPush(WS_CHANNELS.serverConfigUpdated)?.data ?? null;
  if (latestConfig) {
    try {
      listener(latestConfig);
    } catch {
      // Swallow listener errors
    }
  }

  return () => {
    serverConfigUpdatedListeners.delete(listener);
  };
}

export function subscribeServerConnectionState(listener: () => void): () => void {
  serverConnectionStateListeners.add(listener);

  return () => {
    serverConnectionStateListeners.delete(listener);
  };
}

export function getServerConnectionState(): TransportState {
  return instance?.transport.getState() ?? "connecting";
}

export function createWsNativeApi(): NativeApi {
  if (instance) return instance.api;

  const transport = new WsTransport();
  const requestWithSchema = <T>(method: string, schema: Schema.Schema<T>, params?: unknown) =>
    transport.request(method, params, { resultSchema: schema });

  transport.subscribeState(() => {
    emitServerConnectionStateChange();
  });

  transport.subscribe(WS_CHANNELS.serverWelcome, (message) => {
    const payload = message.data;
    for (const listener of welcomeListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(WS_CHANNELS.serverConfigUpdated, (message) => {
    const payload = message.data;
    for (const listener of serverConfigUpdatedListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });

  const api: NativeApi = {
    dialogs: {
      pickFolder: async () => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder();
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    terminal: {
      open: (input) => requestWithSchema(WS_METHODS.terminalOpen, TerminalSessionSnapshot, input),
      write: (input) => requestWithSchema(WS_METHODS.terminalWrite, Schema.Void, input),
      resize: (input) => requestWithSchema(WS_METHODS.terminalResize, Schema.Void, input),
      clear: (input) => requestWithSchema(WS_METHODS.terminalClear, Schema.Void, input),
      restart: (input) =>
        requestWithSchema(WS_METHODS.terminalRestart, TerminalSessionSnapshot, input),
      close: (input) => requestWithSchema(WS_METHODS.terminalClose, Schema.Void, input),
      exec: (input) => requestWithSchema(WS_METHODS.terminalExec, TerminalExecResult, input),
      onEvent: (callback) =>
        transport.subscribe(WS_CHANNELS.terminalEvent, (message) => callback(message.data)),
      onExecEvent: (callback) =>
        transport.subscribe(WS_CHANNELS.terminalExecEvent, (message) => callback(message.data)),
    },
    tools: {
      execute: (input) => requestWithSchema(WS_METHODS.toolsExecute, ToolsExecuteResult, input),
      getResult: (input) =>
        requestWithSchema(WS_METHODS.toolsGetResult, ToolsExecuteResult, input),
      onEvent: (callback) =>
        transport.subscribe(WS_CHANNELS.toolsEvent, (message) => callback(message.data)),
    },
    projects: {
      searchEntries: (input) =>
        requestWithSchema(WS_METHODS.projectsSearchEntries, ProjectSearchEntriesResult, input),
      readAgentsFile: (input) =>
        requestWithSchema(WS_METHODS.projectsReadAgentsFile, ProjectAgentsFileResult, input),
      draftAgentsFile: (input) =>
        requestWithSchema(WS_METHODS.projectsDraftAgentsFile, ProjectDraftAgentsFileResult, input),
      listCommandTemplates: (input) =>
        requestWithSchema(
          WS_METHODS.projectsListCommandTemplates,
          ProjectListCommandTemplatesResult,
          input,
        ),
      listSkills: (input) =>
        requestWithSchema(WS_METHODS.projectsListSkills, ProjectListSkillsResult, input),
      writeFile: (input) =>
        requestWithSchema(WS_METHODS.projectsWriteFile, ProjectWriteFileResult, input),
    },
    threads: {
      getShareStatus: (input) =>
        requestWithSchema(WS_METHODS.threadsGetShareStatus, ThreadShareStatusResult, input),
      createShare: (input) =>
        requestWithSchema(WS_METHODS.threadsCreateShare, ThreadCreateShareResult, input),
      getShare: (input) =>
        requestWithSchema(WS_METHODS.threadsGetShare, ThreadGetShareResult, input),
      revokeShare: (input) =>
        requestWithSchema(WS_METHODS.threadsRevokeShare, ThreadRevokeShareResult, input),
      importShare: (input) =>
        requestWithSchema(WS_METHODS.threadsImportShare, ThreadImportShareResult, input),
      compact: (input) => requestWithSchema(WS_METHODS.threadsCompact, ThreadCompactResult, input),
      undo: (input) => requestWithSchema(WS_METHODS.threadsUndo, ThreadUndoResult, input),
      redo: (input) => requestWithSchema(WS_METHODS.threadsRedo, ThreadRedoResult, input),
      getRedoStatus: (input) =>
        requestWithSchema(WS_METHODS.threadsGetRedoStatus, ThreadRedoStatusResult, input),
    },
    shell: {
      openInEditor: (cwd, editor) =>
        requestWithSchema(WS_METHODS.shellOpenInEditor, Schema.Void, { cwd, editor }),
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        // Some mobile browsers can return null here even when the tab opens.
        // Avoid false negatives and let the browser handle popup policy.
        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    git: {
      pull: (input) => requestWithSchema(WS_METHODS.gitPull, GitPullResult, input),
      status: (input) => requestWithSchema(WS_METHODS.gitStatus, GitStatusResult, input),
      runStackedAction: (input) =>
        requestWithSchema(WS_METHODS.gitRunStackedAction, GitRunStackedActionResult, input),
      listBranches: (input) =>
        requestWithSchema(WS_METHODS.gitListBranches, GitListBranchesResult, input),
      createWorktree: (input) =>
        requestWithSchema(WS_METHODS.gitCreateWorktree, GitCreateWorktreeResult, input),
      removeWorktree: (input) =>
        requestWithSchema(WS_METHODS.gitRemoveWorktree, Schema.Void, input),
      createBranch: (input) => requestWithSchema(WS_METHODS.gitCreateBranch, Schema.Void, input),
      checkout: (input) => requestWithSchema(WS_METHODS.gitCheckout, Schema.Void, input),
      init: (input) => requestWithSchema(WS_METHODS.gitInit, Schema.Void, input),
      resolvePullRequest: (input) =>
        requestWithSchema(WS_METHODS.gitResolvePullRequest, GitResolvePullRequestResult, input),
      preparePullRequestThread: (input) =>
        requestWithSchema(
          WS_METHODS.gitPreparePullRequestThread,
          GitPreparePullRequestThreadResult,
          input,
        ),
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      getConfig: () => requestWithSchema(WS_METHODS.serverGetConfig, ServerConfig),
      getCopilotUsage: () =>
        requestWithSchema(WS_METHODS.serverGetCopilotUsage, ServerCopilotUsage),
      probeCopilotReasoning: (input) =>
        requestWithSchema(
          WS_METHODS.serverProbeCopilotReasoning,
          ServerCopilotReasoningProbe,
          input,
        ),
      getOpenCodeState: (input) =>
        requestWithSchema(WS_METHODS.serverGetOpenCodeState, ServerOpenCodeState, input ?? {}),
      upsertKeybinding: (input) =>
        requestWithSchema(WS_METHODS.serverUpsertKeybinding, ServerUpsertKeybindingResult, input),
      addOpenCodeCredential: (input) =>
        requestWithSchema(
          WS_METHODS.serverAddOpenCodeCredential,
          ServerOpenCodeCredentialResult,
          input,
        ),
      removeOpenCodeCredential: (input) =>
        requestWithSchema(
          WS_METHODS.serverRemoveOpenCodeCredential,
          ServerOpenCodeCredentialResult,
          input,
        ),
    },
    orchestration: {
      getSnapshot: () =>
        requestWithSchema(ORCHESTRATION_WS_METHODS.getSnapshot, OrchestrationGetSnapshotResult),
      dispatchCommand: (command) =>
        requestWithSchema(ORCHESTRATION_WS_METHODS.dispatchCommand, DispatchResult, { command }),
      getTurnDiff: (input) =>
        requestWithSchema(
          ORCHESTRATION_WS_METHODS.getTurnDiff,
          OrchestrationGetTurnDiffResult,
          input,
        ),
      getFullThreadDiff: (input) =>
        requestWithSchema(
          ORCHESTRATION_WS_METHODS.getFullThreadDiff,
          OrchestrationGetFullThreadDiffResult,
          input,
        ),
      replayEvents: (fromSequenceExclusive) =>
        requestWithSchema(ORCHESTRATION_WS_METHODS.replayEvents, OrchestrationReplayEventsResult, {
          fromSequenceExclusive,
        }).then((events) => Array.from(events)),
      onDomainEvent: (callback) =>
        transport.subscribe(ORCHESTRATION_WS_CHANNELS.domainEvent, (message) =>
          callback(message.data),
        ),
    },
  };

  instance = { api, transport };
  return api;
}
