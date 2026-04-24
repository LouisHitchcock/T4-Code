import {
  ApprovalRequestId,
  PROVIDER_REASONING_LEVEL_OPTIONS,
  isToolLifecycleItemType,
  type ModelSlug,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  type ProviderKind,
  type ProviderReasoningLevel,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  type TurnId,
} from "@t3tools/contracts";
import { getModelDisplayName, isCodexOpenRouterModel } from "@t3tools/shared/model";

import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  ThreadSession,
  TurnDiffSummary,
} from "./types";

export type ProviderPickerKind = ProviderKind | "openrouter" | "claudeCode" | "cursor";
export type AvailableProviderPickerKind = Exclude<ProviderPickerKind, "claudeCode" | "cursor">;

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
}> = [
  { value: "codex", label: "Codex", available: true },
  { value: "openrouter", label: "OpenRouter", available: true },
  { value: "copilot", label: "GitHub Copilot", available: true },
  { value: "kimi", label: "Kimi Code", available: true },
  { value: "opencode", label: "OpenCode", available: true },
  { value: "pi", label: "Pi", available: true },
  { value: "claudeCode", label: "Claude Code", available: false },
  { value: "cursor", label: "Cursor", available: false },
];

export function getProviderPickerBackingProvider(
  providerPickerKind: ProviderPickerKind,
): ProviderKind | null {
  switch (providerPickerKind) {
    case "codex":
    case "openrouter":
      return "codex";
    case "copilot":
      return "copilot";
    case "kimi":
      return "kimi";
    case "opencode":
      return "opencode";
    case "pi":
      return "pi";
    case "claudeCode":
    case "cursor":
      return null;
    default:
      return null;
  }
}

export function getProviderPickerKindForSelection(
  provider: ProviderKind,
  model: ModelSlug,
): AvailableProviderPickerKind {
  if (provider === "codex" && isCodexOpenRouterModel(model)) {
    return "openrouter";
  }

  return provider;
}

export interface WorkLogEntry {
  id: string;
  turnId?: TurnId;
  createdAt: string;
  label: string;
  runId?: string;
  detail?: string;
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  alwaysVisible?: boolean;
  itemId?: string;
  activityKind?: string;
}

export type ActiveThinkingContextKind =
  | "idle"
  | "connecting"
  | "preparing-worktree"
  | "sending-turn"
  | "thinking"
  | "tool"
  | "waiting-approval"
  | "waiting-input"
  | "reverting-checkpoint";

export type SendPhaseContext = "idle" | "preparing-worktree" | "sending-turn";

export interface ActiveThinkingContext {
  kind: ActiveThinkingContextKind;
  live: boolean;
  statusLabel: string;
  headline: string;
  detail?: string;
  command?: string;
  changedFiles?: ReadonlyArray<string>;
  itemType?: ToolLifecycleItemType;
  tone: WorkLogEntry["tone"];
  startedAt: string | null;
}

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: "command" | "file-read" | "file-change" | "other";
  createdAt: string;
  requestType?: string;
  detail?: string;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface ConfiguredModelOption {
  slug: string;
  name: string;
  supportsReasoning?: boolean;
  supportsImageInput?: boolean;
  contextWindowTokens?: number;
}

export interface ConfiguredReasoningState {
  currentValue: ProviderReasoningLevel | null;
  options: ReadonlyArray<ProviderReasoningLevel>;
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
}

export interface LatestModelRerouteNotice {
  createdAt: string;
  turnId: TurnId | null;
  fromModel: string;
  toModel: string;
  reason: string;
}

export interface ThreadTaskProgressUpdate {
  id: string;
  createdAt: string;
  description: string;
  lastToolName?: string;
  usage?: unknown;
}

export interface ThreadTask {
  taskId: string;
  turnId: TurnId | null;
  taskType?: string;
  title: string;
  status: "running" | "completed" | "failed" | "stopped";
  startedAt: string;
  completedAt?: string;
  summary?: string;
  usage?: unknown;
  progressUpdates: ThreadTaskProgressUpdate[];
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

type LatestTurnTiming = Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt">;
type SessionActivityState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;
type SessionInterruptState = SessionActivityState & Pick<ThreadSession, "createdAt">;

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  if (session.orchestrationStatus === "running") return false;
  return true;
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

export function deriveInterruptTurnId(
  latestTurn: LatestTurnTiming | null,
  session: SessionInterruptState | null,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): TurnId | null {
  const latestActivityTurnId = [...activities]
    .toSorted(compareActivitiesByOrder)
    .findLast((activity) => {
      if (!activity?.turnId) {
        return false;
      }
      if (session?.createdAt && activity.createdAt < session.createdAt) {
        return false;
      }
      return true;
    })?.turnId;

  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.turnId ?? session?.activeTurnId ?? latestActivityTurnId ?? null;
  }

  if (session?.activeTurnId) {
    return session.activeTurnId;
  }

  return latestActivityTurnId ?? null;
}

function requestKindFromRequestType(requestType: unknown): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return "other";
  }
}

function isUnknownPendingApprovalRequestDetail(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  return normalized !== undefined
    ? normalized.includes("unknown pending approval request") ||
        normalized.includes("unknown pending permission request")
    : false;
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  sessionStartedAt?: string,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    if (sessionStartedAt && activity.createdAt < sessionStartedAt) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    const requestKind =
      payload &&
      (payload.requestKind === "command" ||
        payload.requestKind === "file-read" ||
        payload.requestKind === "file-change" ||
        payload.requestKind === "other")
        ? payload.requestKind
        : payload
          ? requestKindFromRequestType(payload.requestType)
          : null;
    const requestType =
      payload && typeof payload.requestType === "string" ? payload.requestType : undefined;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(requestType ? { requestType } : {}),
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      isUnknownPendingApprovalRequestDetail(detail)
    ) {
      openByRequestId.delete(requestId);
      continue;
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  sessionStartedAt?: string,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    if (sessionStartedAt && activity.createdAt < sessionStartedAt) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;

    if (activity.kind === "user-input.requested" && requestId) {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

const KNOWN_PROVIDER_REASONING_LEVELS = new Set<ProviderReasoningLevel>(
  PROVIDER_REASONING_LEVEL_OPTIONS,
);

function normalizeProviderReasoningLevel(value: unknown): ProviderReasoningLevel | null {
  return typeof value === "string" &&
    KNOWN_PROVIDER_REASONING_LEVELS.has(value as ProviderReasoningLevel)
    ? (value as ProviderReasoningLevel)
    : null;
}

function parseConfiguredModelOption(
  candidate: Record<string, unknown>,
  provider: ProviderKind,
): ConfiguredModelOption | null {
  if (typeof candidate.modelId !== "string" || candidate.modelId.trim().length === 0) {
    return null;
  }

  const slug = candidate.modelId.trim();
  const input = Array.isArray(candidate.input)
    ? candidate.input.filter((entry): entry is string => typeof entry === "string")
    : [];

  return {
    slug,
    name:
      typeof candidate.name === "string" && candidate.name.trim().length > 0
        ? candidate.name.trim()
        : getModelDisplayName(slug, provider),
    ...(typeof candidate.reasoning === "boolean" ? { supportsReasoning: candidate.reasoning } : {}),
    ...(input.includes("image") ? { supportsImageInput: true } : {}),
    ...(typeof candidate.contextWindow === "number"
      ? { contextWindowTokens: candidate.contextWindow }
      : {}),
  };
}

export function deriveConfiguredModelOptions(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  provider: ProviderKind,
): ConfiguredModelOption[] {
  return deriveConfiguredModelOptionsFromActivityGroups([activities], provider);
}

export function deriveConfiguredModelOptionsFromActivityGroups(
  activityGroups: ReadonlyArray<ReadonlyArray<OrchestrationThreadActivity>>,
  provider: ProviderKind,
): ConfiguredModelOption[] {
  const ordered = activityGroups
    .flatMap((activities) => activities)
    .toSorted(compareActivitiesByOrder)
    .toReversed();

  for (const activity of ordered) {
    if (activity.kind !== "session.configured") {
      continue;
    }

    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const payloadProvider = typeof payload?.provider === "string" ? payload.provider : null;
    if (payloadProvider !== null && payloadProvider !== provider) {
      continue;
    }

    const config =
      payload?.config && typeof payload.config === "object"
        ? (payload.config as Record<string, unknown>)
        : null;
    if (!config) {
      continue;
    }

    const options: ConfiguredModelOption[] = [];
    const seen = new Set<string>();
    const availableModels = Array.isArray(config.availableModels) ? config.availableModels : [];

    for (const entry of availableModels) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const parsed = parseConfiguredModelOption(entry as Record<string, unknown>, provider);
      if (!parsed || seen.has(parsed.slug)) {
        continue;
      }
      seen.add(parsed.slug);
      options.push(parsed);
    }

    const currentModelId =
      typeof config.currentModelId === "string" && config.currentModelId.trim().length > 0
        ? config.currentModelId.trim()
        : null;
    if (currentModelId && !seen.has(currentModelId)) {
      options.unshift({
        slug: currentModelId,
        name: getModelDisplayName(currentModelId, provider),
      });
    }

    return options;
  }

  return [];
}

export function deriveConfiguredReasoningState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  provider: ProviderKind,
  model: string | null | undefined,
): ConfiguredReasoningState | null {
  const normalizedModel =
    typeof model === "string" && model.trim().length > 0 ? model.trim() : null;
  if (!normalizedModel) {
    return null;
  }

  const ordered = [...activities].toSorted(compareActivitiesByOrder).toReversed();
  for (const activity of ordered) {
    if (activity.kind !== "session.configured") {
      continue;
    }

    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const payloadProvider = typeof payload?.provider === "string" ? payload.provider : null;
    if (payloadProvider !== null && payloadProvider !== provider) {
      continue;
    }

    const config =
      payload?.config && typeof payload.config === "object"
        ? (payload.config as Record<string, unknown>)
        : null;
    if (!config) {
      continue;
    }

    const currentModelId =
      typeof config.currentModelId === "string" && config.currentModelId.trim().length > 0
        ? config.currentModelId.trim()
        : null;
    if (currentModelId !== null && currentModelId !== normalizedModel) {
      continue;
    }

    const options = Array.isArray(config.availableThinkingLevels)
      ? config.availableThinkingLevels
          .map(normalizeProviderReasoningLevel)
          .filter((value): value is ProviderReasoningLevel => value !== null)
      : [];
    const currentValue = normalizeProviderReasoningLevel(config.currentThinkingLevel);

    if (options.length === 0 && currentValue === null) {
      continue;
    }

    return {
      currentValue,
      options,
    };
  }

  return null;
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActivePlanState | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const candidates = ordered.filter((activity) => {
    if (activity.kind !== "turn.plan.updated") {
      return false;
    }
    if (!latestTurnId) {
      return true;
    }
    return activity.turnId === latestTurnId;
  });
  const latest = candidates.at(-1);
  if (!latest) {
    return null;
  }
  const payload =
    latest.payload && typeof latest.payload === "object"
      ? (latest.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps = rawPlan
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.step !== "string") {
        return null;
      }
      const status =
        record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
      return {
        step: record.step,
        status,
      };
    })
    .filter(
      (
        step,
      ): step is {
        step: string;
        status: "pending" | "inProgress" | "completed";
      } => step !== null,
    );
  if (steps.length === 0) {
    return null;
  }
  return {
    createdAt: latest.createdAt,
    turnId: latest.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps,
  };
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return {
        id: matchingTurnPlan.id,
        createdAt: matchingTurnPlan.createdAt,
        updatedAt: matchingTurnPlan.updatedAt,
        turnId: matchingTurnPlan.turnId,
        planMarkdown: matchingTurnPlan.planMarkdown,
      };
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return {
    id: latestPlan.id,
    createdAt: latestPlan.createdAt,
    updatedAt: latestPlan.updatedAt,
    turnId: latestPlan.turnId,
    planMarkdown: latestPlan.planMarkdown,
  };
}

export function deriveLatestModelRerouteNotice(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): LatestModelRerouteNotice | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder).toReversed();
  for (const activity of ordered) {
    if (activity.kind !== "model.rerouted") {
      continue;
    }
    if (latestTurnId && activity.turnId !== latestTurnId) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const fromModel = asTrimmedString(payload?.fromModel);
    const toModel = asTrimmedString(payload?.toModel);
    const reason = asTrimmedString(payload?.reason) ?? asTrimmedString(payload?.detail);
    if (!fromModel || !toModel || !reason) {
      continue;
    }
    return {
      createdAt: activity.createdAt,
      turnId: activity.turnId,
      fromModel,
      toModel,
      reason,
    };
  }
  return null;
}

function deriveTaskTitle(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
): string {
  const taskType = asTrimmedString(payload?.taskType);
  if (taskType === "plan") {
    return "Plan task";
  }
  if (taskType) {
    return `${taskType} task`;
  }

  const normalizedSummary = activity.summary.replace(/\s+started$/i, "").trim();
  return normalizedSummary.length > 0 ? normalizedSummary : "Task";
}

function compareThreadTasks(left: ThreadTask, right: ThreadTask): number {
  const leftIsRunning = left.status === "running";
  const rightIsRunning = right.status === "running";
  if (leftIsRunning !== rightIsRunning) {
    return leftIsRunning ? -1 : 1;
  }

  const leftUpdatedAt =
    left.completedAt ?? left.progressUpdates.at(-1)?.createdAt ?? left.startedAt;
  const rightUpdatedAt =
    right.completedAt ?? right.progressUpdates.at(-1)?.createdAt ?? right.startedAt;
  return rightUpdatedAt.localeCompare(leftUpdatedAt) || left.taskId.localeCompare(right.taskId);
}

export function deriveThreadTasks(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ThreadTask[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const tasksById = new Map<string, ThreadTask>();

  for (const activity of ordered) {
    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.completed"
    ) {
      continue;
    }

    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const taskId = asTrimmedString(payload?.taskId);
    if (!taskId) {
      continue;
    }

    const existing = tasksById.get(taskId);
    const baseTask: ThreadTask = existing ?? {
      taskId,
      turnId: activity.turnId,
      title: deriveTaskTitle(activity, payload),
      status: "running",
      startedAt: activity.createdAt,
      progressUpdates: [],
    };

    if (activity.kind === "task.started") {
      const nextTaskType = asTrimmedString(payload?.taskType) ?? baseTask.taskType;
      tasksById.set(taskId, {
        ...baseTask,
        turnId: baseTask.turnId ?? activity.turnId,
        title: deriveTaskTitle(activity, payload),
        startedAt: activity.createdAt,
        ...(nextTaskType ? { taskType: nextTaskType } : {}),
      });
      continue;
    }

    if (activity.kind === "task.progress") {
      const description = asTrimmedString(payload?.detail) ?? activity.summary;
      const lastToolName = asTrimmedString(payload?.lastToolName);
      tasksById.set(taskId, {
        ...baseTask,
        turnId: baseTask.turnId ?? activity.turnId,
        progressUpdates: [
          ...baseTask.progressUpdates,
          {
            id: activity.id,
            createdAt: activity.createdAt,
            description,
            ...(lastToolName ? { lastToolName } : {}),
            ...(payload?.usage !== undefined ? { usage: payload.usage } : {}),
          },
        ],
      });
      continue;
    }

    const status =
      payload?.status === "completed" ||
      payload?.status === "failed" ||
      payload?.status === "stopped"
        ? payload.status
        : "completed";
    const summary = asTrimmedString(payload?.detail) ?? asTrimmedString(payload?.summary);
    tasksById.set(taskId, {
      ...baseTask,
      turnId: baseTask.turnId ?? activity.turnId,
      status,
      completedAt: activity.createdAt,
      ...(summary ? { summary } : {}),
      ...(payload?.usage !== undefined ? { usage: payload.usage } : {}),
    });
  }

  return [...tasksById.values()].toSorted(compareThreadTasks);
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
  options: {
    includeStreamingCommandOutput?: boolean;
  } = {},
): WorkLogEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  return ordered
    .filter((activity) => {
      if (!latestTurnId) {
        return true;
      }
      const payload =
        activity.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : null;
      return activity.turnId === latestTurnId || isAlwaysVisibleWorkLogActivity(activity, payload);
    })
    .filter(
      (activity) => options.includeStreamingCommandOutput || activity.kind !== "command.output.streaming",
    )
    .filter((activity) => activity.kind !== "tool.started")
    .filter((activity) => activity.kind !== "task.started" && activity.kind !== "task.completed")
    .filter((activity) => activity.summary !== "Checkpoint captured")
    .map((activity) => {
      const payload =
        activity.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : null;
      const alwaysVisible = isAlwaysVisibleWorkLogActivity(activity, payload);
      const command = extractToolCommand(payload);
      const changedFiles = extractChangedFiles(payload);
      const title = extractToolTitle(payload);
      const itemType = extractWorkLogItemType(payload);
      const requestKind = extractWorkLogRequestKind(payload);
      const itemId = extractWorkLogItemId(payload);
      const runId = extractWorkLogRunId(payload);
      const entry: WorkLogEntry = {
        id: activity.id,
        ...(activity.turnId ? { turnId: activity.turnId } : {}),
        createdAt: activity.createdAt,
        label: activity.summary,
        tone: activity.tone === "approval" ? "info" : activity.tone,
        activityKind: activity.kind,
      };
      if (runId) {
        entry.runId = runId;
      }
      if (alwaysVisible) {
        entry.alwaysVisible = true;
      }
      const detail = extractWorkLogDetail({
        payload,
        itemType,
        command,
      });
      if (detail) {
        entry.detail = detail;
      }
      if (command) {
        entry.command = command;
      }
      const cwd = extractWorkLogCwd(payload);
      if (cwd) {
        entry.cwd = cwd;
      }
      const exitCode = extractCommandExitCode(payload);
      if (exitCode !== undefined) {
        entry.exitCode = exitCode;
      }
      if (changedFiles.length > 0) {
        entry.changedFiles = changedFiles;
      }
      if (title) {
        entry.toolTitle = title;
      }
      if (itemType) {
        entry.itemType = itemType;
      }
      if (requestKind) {
        entry.requestKind = requestKind;
      }
      if (itemId) {
        entry.itemId = itemId;
      }
      return entry;
    });
}

function isAlwaysVisibleWorkLogActivity(
  activity: OrchestrationThreadActivity,
  _payload: Record<string, unknown> | null,
): boolean {
  return activity.kind.startsWith("terminal.command.");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

function extractToolCommand(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
  ];
  return candidates.find((candidate) => candidate !== null) ?? null;
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function extractWorkLogRunId(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.runId);
}

function extractWorkLogCwd(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const input = asRecord(item?.input);
  return (
    asTrimmedString(data?.cwd) ??
    asTrimmedString(item?.cwd) ??
    asTrimmedString(input?.cwd) ??
    null
  );
}

function flattenTextValue(value: unknown, depth = 0): string | null {
  if (depth > 4) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => flattenTextValue(entry, depth + 1))
      .filter((entry): entry is string => entry !== null);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const candidates = [
    flattenTextValue(record.text, depth + 1),
    flattenTextValue(record.output, depth + 1),
    flattenTextValue(record.stdout, depth + 1),
    flattenTextValue(record.stderr, depth + 1),
    flattenTextValue(record.content, depth + 1),
    flattenTextValue(record.message, depth + 1),
  ];
  return candidates.find((candidate) => candidate !== null) ?? null;
}

function normalizeWorkLogDetail(value: string | null): string | null {
  if (!value) return null;
  return stripTrailingExitCode(value).output;
}

function extractCommandOutputDetail(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const result = asRecord(item?.result);
  const combinedStdStreams = [flattenTextValue(result?.stdout), flattenTextValue(result?.stderr)]
    .filter((entry): entry is string => entry !== null)
    .join("\n");
  const candidates = [
    flattenTextValue(result?.output),
    flattenTextValue(result?.content),
    flattenTextValue(result?.text),
    combinedStdStreams.length > 0 ? combinedStdStreams : null,
    flattenTextValue(data?.output),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeWorkLogDetail(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function extractWorkLogDetail(input: {
  payload: Record<string, unknown> | null;
  itemType: WorkLogEntry["itemType"] | undefined;
  command: string | null;
}): string | null {
  const commandOutput =
    input.itemType === "command_execution" ? extractCommandOutputDetail(input.payload) : null;
  const payloadDetail =
    input.payload && typeof input.payload.detail === "string" && input.payload.detail.length > 0
      ? normalizeWorkLogDetail(input.payload.detail)
      : null;
  const detail = commandOutput ?? payloadDetail;
  if (!detail) {
    return null;
  }
  if (input.command && detail.trim() === input.command.trim()) {
    return null;
  }
  return detail;
}

function extractCommandExitCode(
  payload: Record<string, unknown> | null,
): number | null | undefined {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const result = asRecord(item?.result);
  if (typeof result?.exitCode === "number" && Number.isFinite(result.exitCode)) {
    return result.exitCode;
  }

  const parsedFromDetail =
    typeof payload?.detail === "string" ? stripTrailingExitCode(payload.detail).exitCode : undefined;
  if (parsedFromDetail !== undefined) {
    return parsedFromDetail;
  }

  return undefined;
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry["itemType"] | undefined {
  if (typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)) {
    return payload.itemType;
  }
  return undefined;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}
function extractWorkLogItemId(payload: Record<string, unknown> | null): string | null {
  const directItemId = asTrimmedString(payload?.itemId);
  if (directItemId) {
    return directItemId;
  }
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  return asTrimmedString(item?.id);
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(asRecord(payload?.data), changedFiles, seen, 0);
  return changedFiles;
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function hasToolActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return activities.some((activity) => activity.turnId === turnId && activity.tone === "tool");
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  proposedPlans: ProposedPlan[],
  workEntries: WorkLogEntry[],
): TimelineEntry[] {
  const messageRows: TimelineEntry[] = messages.map((message) => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  }));
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const workRows: TimelineEntry[] = workEntries.map((entry) => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
  return [...messageRows, ...proposedPlanRows, ...workRows].toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export function deriveActiveThinkingContext(input: {
  phase: SessionPhase;
  sendPhase: SendPhaseContext;
  isRevertingCheckpoint: boolean;
  activeWorkStartedAt: string | null;
  workEntries: ReadonlyArray<WorkLogEntry>;
  pendingApproval: PendingApproval | null;
  pendingUserInput: PendingUserInput | null;
}): ActiveThinkingContext {
  if (input.isRevertingCheckpoint) {
    return {
      kind: "reverting-checkpoint",
      live: true,
      statusLabel: "Working",
      headline: "Reverting to checkpoint",
      tone: "info",
      startedAt: input.activeWorkStartedAt,
    };
  }

  if (input.pendingApproval) {
    return {
      kind: "waiting-approval",
      live: true,
      statusLabel: "Waiting",
      headline: approvalHeadline(input.pendingApproval),
      ...(input.pendingApproval.detail ? { detail: input.pendingApproval.detail } : {}),
      tone: "info",
      startedAt: input.pendingApproval.createdAt,
    };
  }

  if (input.pendingUserInput) {
    const question = input.pendingUserInput.questions[0];
    return {
      kind: "waiting-input",
      live: true,
      statusLabel: "Waiting",
      headline: "Waiting for input",
      ...(question?.question ? { detail: question.question } : {}),
      tone: "info",
      startedAt: input.pendingUserInput.createdAt,
    };
  }

  if (input.phase === "connecting") {
    return {
      kind: "connecting",
      live: true,
      statusLabel: "Connecting",
      headline: "Connecting to provider",
      tone: "info",
      startedAt: input.activeWorkStartedAt,
    };
  }

  if (input.sendPhase === "preparing-worktree") {
    return {
      kind: "preparing-worktree",
      live: true,
      statusLabel: "Working",
      headline: "Preparing worktree",
      tone: "info",
      startedAt: input.activeWorkStartedAt,
    };
  }

  if (input.sendPhase === "sending-turn") {
    return {
      kind: "sending-turn",
      live: true,
      statusLabel: "Working",
      headline: "Sending your turn",
      tone: "info",
      startedAt: input.activeWorkStartedAt,
    };
  }

  const latestEntry = input.workEntries.at(-1);
  if (input.phase === "running" || latestEntry) {
    if (latestEntry) {
      const derived = deriveActiveThinkingContextFromEntry(latestEntry);
      return {
        ...derived,
        live: input.phase === "running",
        startedAt: input.activeWorkStartedAt ?? latestEntry.createdAt,
      };
    }
    return {
      kind: "thinking",
      live: true,
      statusLabel: "Thinking",
      headline: "Working on your request",
      tone: "thinking",
      startedAt: input.activeWorkStartedAt,
    };
  }

  return {
    kind: "idle",
    live: false,
    statusLabel: "Idle",
    headline: "No active work",
    tone: "info",
    startedAt: null,
  };
}

function deriveActiveThinkingContextFromEntry(
  entry: WorkLogEntry,
): Omit<ActiveThinkingContext, "live" | "startedAt"> {
  if (entry.itemType) {
    return {
      kind: "tool",
      statusLabel: "Working",
      headline: toolHeadline(entry),
      ...(entry.detail ? { detail: entry.detail } : {}),
      ...(entry.command ? { command: entry.command } : {}),
      ...(entry.changedFiles && entry.changedFiles.length > 0
        ? { changedFiles: entry.changedFiles }
        : {}),
      itemType: entry.itemType,
      tone: entry.tone,
    };
  }

  const detailLine = firstLine(entry.detail);
  const preferredHeadline =
    entry.tone === "thinking" && detailLine
      ? detailLine
      : (normalizeEntryHeadline(entry.label) ?? detailLine ?? defaultHeadlineForTone(entry.tone));

  return {
    kind: entry.tone === "tool" ? "tool" : "thinking",
    statusLabel: entry.tone === "tool" ? "Working" : "Thinking",
    headline: preferredHeadline,
    ...(detailLine && detailLine !== preferredHeadline ? { detail: detailLine } : {}),
    ...(entry.command ? { command: entry.command } : {}),
    ...(entry.changedFiles && entry.changedFiles.length > 0
      ? { changedFiles: entry.changedFiles }
      : {}),
    tone: entry.tone,
  };
}

function approvalHeadline(approval: PendingApproval): string {
  switch (approval.requestKind) {
    case "command":
      return "Waiting for command approval";
    case "file-read":
      return "Waiting for file read approval";
    case "file-change":
      return "Waiting for file change approval";
    default:
      return "Waiting for approval";
  }
}

function toolHeadline(entry: WorkLogEntry): string {
  switch (entry.itemType) {
    case "command_execution":
      return "Running command";
    case "file_change":
      return entry.changedFiles && entry.changedFiles.length > 0
        ? `Editing ${entry.changedFiles.length} ${entry.changedFiles.length === 1 ? "file" : "files"}`
        : "Editing files";
    case "web_search":
      return "Searching the web";
    case "image_view":
      return "Inspecting image";
    case "mcp_tool_call":
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return entry.toolTitle ? `Calling ${entry.toolTitle}` : "Calling tool";
    default:
      return normalizeEntryHeadline(entry.label) ?? "Working";
  }
}

function defaultHeadlineForTone(tone: WorkLogEntry["tone"]): string {
  switch (tone) {
    case "error":
      return "Hit an error";
    case "tool":
      return "Running tool";
    case "thinking":
      return "Thinking";
    default:
      return "Working";
  }
}

function normalizeEntryHeadline(value: string | undefined): string | null {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/\s+/g, " ");
  if (/^(reasoning update|thinking|working)$/i.test(normalized)) {
    return null;
  }
  return normalized;
}

function firstLine(value: string | undefined): string | null {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return null;
  }
  const [line] = trimmed.split(/\r?\n/, 1);
  return line ? line.trim() : null;
}

export function inferCheckpointTurnCountByTurnId(
  summaries: TurnDiffSummary[],
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
