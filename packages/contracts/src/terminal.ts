import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const DEFAULT_TERMINAL_ID = "default";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const TerminalColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(20)).check(
  Schema.isLessThanOrEqualTo(400),
);
const TerminalRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(5)).check(
  Schema.isLessThanOrEqualTo(200),
);
const TerminalIdSchema = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(128));
const TerminalEnvKeySchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
).check(Schema.isMaxLength(128));
const TerminalEnvValueSchema = Schema.String.check(Schema.isMaxLength(8_192));
const TerminalCommandSchema = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4_096));
const TerminalCommandArgSchema = Schema.String.check(Schema.isMaxLength(4_096));
const TerminalCommandArgsSchema = Schema.Array(TerminalCommandArgSchema).check(
  Schema.isMaxLength(64),
);
const TerminalEnvSchema = Schema.Record(TerminalEnvKeySchema, TerminalEnvValueSchema).check(
  Schema.isMaxProperties(128),
);

const TerminalIdWithDefaultSchema = TerminalIdSchema.pipe(
  Schema.withDecodingDefault(() => DEFAULT_TERMINAL_ID),
);

export const TerminalThreadInput = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
});
export type TerminalThreadInput = Schema.Codec.Encoded<typeof TerminalThreadInput>;

const TerminalSessionInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: TerminalIdWithDefaultSchema,
});
export type TerminalSessionInput = Schema.Codec.Encoded<typeof TerminalSessionInput>;

export const TerminalOpenInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  command: Schema.optional(TerminalCommandSchema),
  args: Schema.optional(TerminalCommandArgsSchema),
  env: Schema.optional(TerminalEnvSchema),
});
export type TerminalOpenInput = Schema.Codec.Encoded<typeof TerminalOpenInput>;

export const TerminalWriteInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
});
export type TerminalWriteInput = Schema.Codec.Encoded<typeof TerminalWriteInput>;

export const TerminalResizeInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
});
export type TerminalResizeInput = Schema.Codec.Encoded<typeof TerminalResizeInput>;

export const TerminalClearInput = TerminalSessionInput;
export type TerminalClearInput = Schema.Codec.Encoded<typeof TerminalClearInput>;

export const TerminalRestartInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
  command: Schema.optional(TerminalCommandSchema),
  args: Schema.optional(TerminalCommandArgsSchema),
  env: Schema.optional(TerminalEnvSchema),
});
export type TerminalRestartInput = Schema.Codec.Encoded<typeof TerminalRestartInput>;

export const TerminalCloseInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: Schema.optional(TerminalIdSchema),
  deleteHistory: Schema.optional(Schema.Boolean),
});
export type TerminalCloseInput = Schema.Codec.Encoded<typeof TerminalCloseInput>;
export const TerminalExecMode = Schema.Literals(["wait", "interact"]);
export type TerminalExecMode = typeof TerminalExecMode.Type;

export const TerminalExecInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  mode: TerminalExecMode.pipe(Schema.withDecodingDefault(() => "wait")),
  command: TerminalCommandSchema,
  args: Schema.optional(TerminalCommandArgsSchema),
  env: Schema.optional(TerminalEnvSchema),
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  isReadOnly: Schema.optional(Schema.Boolean.pipe(Schema.withDecodingDefault(() => false))),
  isRisky: Schema.optional(Schema.Boolean.pipe(Schema.withDecodingDefault(() => false))),
  usesPager: Schema.optional(Schema.Boolean.pipe(Schema.withDecodingDefault(() => false))),
  approveRiskyExecution: Schema.optional(
    Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  ),
  reason: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(1_024))),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(900_000)),
  ),
});
export type TerminalExecInput = Schema.Codec.Encoded<typeof TerminalExecInput>;

const TerminalExecMetadata = Schema.Struct({
  isReadOnly: Schema.Boolean,
  isRisky: Schema.Boolean,
  usesPager: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
});

const TerminalExecResultBase = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  commandId: Schema.String.check(Schema.isNonEmpty()),
  mode: TerminalExecMode,
  command: Schema.String.check(Schema.isNonEmpty()),
  args: Schema.Array(Schema.String),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  startedAt: Schema.String,
  metadata: TerminalExecMetadata,
});

const TerminalWaitExecStatus = Schema.Literals(["succeeded", "failed", "timed_out"]);
export type TerminalWaitExecStatus = typeof TerminalWaitExecStatus.Type;

export const TerminalWaitExecResult = Schema.Struct({
  ...TerminalExecResultBase.fields,
  mode: Schema.Literal("wait"),
  status: TerminalWaitExecStatus,
  completedAt: Schema.String,
  durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
});
export type TerminalWaitExecResult = typeof TerminalWaitExecResult.Type;

export const TerminalInteractExecResult = Schema.Struct({
  ...TerminalExecResultBase.fields,
  mode: Schema.Literal("interact"),
  status: Schema.Literal("running"),
  snapshot: Schema.suspend(() => TerminalSessionSnapshot),
});
export type TerminalInteractExecResult = typeof TerminalInteractExecResult.Type;

export const TerminalExecResult = Schema.Union([
  TerminalWaitExecResult,
  TerminalInteractExecResult,
]);
export type TerminalExecResult = typeof TerminalExecResult.Type;

const TerminalExecEventBase = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  commandId: Schema.String.check(Schema.isNonEmpty()),
  createdAt: Schema.String,
  mode: TerminalExecMode,
});

const TerminalExecStartedEvent = Schema.Struct({
  ...TerminalExecEventBase.fields,
  type: Schema.Literal("exec.started"),
  command: Schema.String.check(Schema.isNonEmpty()),
  args: Schema.Array(Schema.String),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  metadata: TerminalExecMetadata,
});

const TerminalExecOutputEvent = Schema.Struct({
  ...TerminalExecEventBase.fields,
  type: Schema.Literal("exec.output"),
  stream: Schema.Literals(["stdout", "stderr"]),
  data: Schema.String.check(Schema.isNonEmpty()),
});

const TerminalExecCompletedEvent = Schema.Struct({
  ...TerminalExecEventBase.fields,
  type: Schema.Literal("exec.completed"),
  result: TerminalExecResult,
});

const TerminalExecErrorEvent = Schema.Struct({
  ...TerminalExecEventBase.fields,
  type: Schema.Literal("exec.error"),
  message: Schema.String.check(Schema.isNonEmpty()),
});

export const TerminalExecEvent = Schema.Union([
  TerminalExecStartedEvent,
  TerminalExecOutputEvent,
  TerminalExecCompletedEvent,
  TerminalExecErrorEvent,
]);
export type TerminalExecEvent = typeof TerminalExecEvent.Type;

export const TerminalSessionStatus = Schema.Literals(["starting", "running", "exited", "error"]);
export type TerminalSessionStatus = typeof TerminalSessionStatus.Type;

export const TerminalSessionSnapshot = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  history: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  updatedAt: Schema.String,
});
export type TerminalSessionSnapshot = typeof TerminalSessionSnapshot.Type;

const TerminalEventBaseSchema = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  createdAt: Schema.String,
});

const TerminalStartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("started"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalOutputEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
});

const TerminalExitedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});

const TerminalErrorEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("error"),
  message: Schema.String.check(Schema.isNonEmpty()),
});

const TerminalClearedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("cleared"),
});

const TerminalRestartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("restarted"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalActivityEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("activity"),
  hasRunningSubprocess: Schema.Boolean,
});

export const TerminalEvent = Schema.Union([
  TerminalStartedEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalEvent = typeof TerminalEvent.Type;
