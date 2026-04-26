import { Schema } from "effect";
import { NonNegativeInt, ThreadId, TrimmedNonEmptyString, TurnId } from "./baseSchemas";

export const ToolName = Schema.Literals([
  "terminal.exec",
  "cli.capabilities",
  "cli.rg",
  "cli.fd",
  "cli.jq",
  "cli.yq",
  "cli.git",
  "cli.gh",
  "grep",
  "file_glob",
  "semantic_search",
  "read_files",
  "apply_patch",
  "read_skill",
  "search_warp_documentation",
  "web_search",
  "fetch_web_pages",
  "create_plan",
  "read_plans",
  "edit_plans",
  "create_todo_list",
  "add_todos",
  "read_todos",
  "mark_todo_as_done",
  "remove_todos",
  "insert_code_review_comments",
  "address_review_comments",
  "report_pr",
]);
export type ToolName = typeof ToolName.Type;

export const ToolExecutionMode = Schema.Literals(["auto", "sequential", "parallel"]).pipe(
  Schema.withDecodingDefault(() => "auto"),
);
export type ToolExecutionMode = typeof ToolExecutionMode.Type;

export const ToolInvocationId = TrimmedNonEmptyString;
export type ToolInvocationId = typeof ToolInvocationId.Type;

export const ToolInvocation = Schema.Struct({
  toolCallId: ToolInvocationId,
  toolName: ToolName,
  input: Schema.Unknown,
  dependsOn: Schema.optional(Schema.Array(ToolInvocationId).check(Schema.isMaxLength(32))),
});
export type ToolInvocation = typeof ToolInvocation.Type;

export const ToolsExecuteInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  executionMode: ToolExecutionMode,
  invocations: Schema.Array(ToolInvocation).check(Schema.isMinLength(1)).check(Schema.isMaxLength(64)),
});
export type ToolsExecuteInput = typeof ToolsExecuteInput.Type;

export const ToolResultStatus = Schema.Literals(["succeeded", "failed", "blocked"]);
export type ToolResultStatus = typeof ToolResultStatus.Type;

export const ToolPolicyAction = Schema.Literals(["allow", "ask", "deny"]);
export type ToolPolicyAction = typeof ToolPolicyAction.Type;

export const ToolPolicyDecision = Schema.Struct({
  action: ToolPolicyAction,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ToolPolicyDecision = typeof ToolPolicyDecision.Type;

export const ToolResult = Schema.Struct({
  toolCallId: ToolInvocationId,
  toolName: ToolName,
  status: ToolResultStatus,
  startedAt: Schema.String,
  completedAt: Schema.String,
  durationMs: NonNegativeInt,
  policy: ToolPolicyDecision,
  output: Schema.optional(Schema.Unknown),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type ToolResult = typeof ToolResult.Type;

export const ToolRunStatus = Schema.Literals(["succeeded", "failed", "partial"]);
export type ToolRunStatus = typeof ToolRunStatus.Type;

export const ToolRunId = TrimmedNonEmptyString;
export type ToolRunId = typeof ToolRunId.Type;

export const ToolsExecuteResult = Schema.Struct({
  runId: ToolRunId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  status: ToolRunStatus,
  startedAt: Schema.String,
  completedAt: Schema.String,
  results: Schema.Array(ToolResult),
});
export type ToolsExecuteResult = typeof ToolsExecuteResult.Type;

export const ToolsGetResultInput = Schema.Struct({
  runId: ToolRunId,
});
export type ToolsGetResultInput = typeof ToolsGetResultInput.Type;

const ToolEventBase = Schema.Struct({
  runId: ToolRunId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  toolCallId: ToolInvocationId,
  toolName: ToolName,
  createdAt: Schema.String,
});

export const ToolEvent = Schema.Union([
  Schema.Struct({
    ...ToolEventBase.fields,
    type: Schema.Literal("tool.started"),
  }),
  Schema.Struct({
    ...ToolEventBase.fields,
    type: Schema.Literal("tool.output"),
    data: Schema.Unknown,
  }),
  Schema.Struct({
    ...ToolEventBase.fields,
    type: Schema.Literal("tool.completed"),
    result: ToolResult,
  }),
  Schema.Struct({
    ...ToolEventBase.fields,
    type: Schema.Literal("tool.error"),
    message: TrimmedNonEmptyString,
  }),
]);
export type ToolEvent = typeof ToolEvent.Type;
