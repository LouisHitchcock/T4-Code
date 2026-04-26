import { ToolInvocation, type ToolPolicyDecision } from "@draft/contracts";
import { Effect, Layer, Schema } from "effect";

import { ToolHarnessValidationError } from "../Errors.ts";
import { ToolPolicyEngine, type ToolPolicyContext, type ToolPolicyEngineShape } from "../Services/ToolPolicyEngine.ts";

const decodeToolInvocation = Schema.decodeUnknownSync(ToolInvocation);

function normalizePolicyDefaultAction(raw: string | undefined): ToolPolicyDecision["action"] {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "ask" || normalized === "deny") {
    return normalized;
  }
  return "allow";
}
function readInvocationInput(
  invocation: ReturnType<typeof decodeToolInvocation>,
): Record<string, unknown> | null {
  if (!invocation.input || typeof invocation.input !== "object" || Array.isArray(invocation.input)) {
    return null;
  }
  return invocation.input as Record<string, unknown>;
}

function readCliArgs(invocation: ReturnType<typeof decodeToolInvocation>): string[] {
  const input = readInvocationInput(invocation);
  if (!input) return [];
  const rawArgs = input.args;
  if (!Array.isArray(rawArgs)) return [];
  return rawArgs.filter((value): value is string => typeof value === "string");
}

function hasReadOnlyOverride(invocation: ReturnType<typeof decodeToolInvocation>): boolean {
  const input = readInvocationInput(invocation);
  return input?.readOnly === true;
}

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "show",
  "diff",
  "rev-parse",
  "remote",
  "config",
  "ls-files",
  "grep",
  "describe",
  "blame",
  "cat-file",
  "shortlog",
  "help",
  "version",
]);

function isRiskyTool(invocation: ReturnType<typeof decodeToolInvocation>): boolean {
  if (invocation.toolName === "apply_patch") {
    return true;
  }
  if (invocation.toolName === "terminal.exec") {
    if (!invocation.input || typeof invocation.input !== "object" || Array.isArray(invocation.input)) {
      return true;
    }
    const value = invocation.input as { isRisky?: unknown };
    return value.isRisky === true;
  }
  if (invocation.toolName === "cli.gh") {
    return !hasReadOnlyOverride(invocation);
  }
  if (invocation.toolName === "cli.git") {
    if (hasReadOnlyOverride(invocation)) {
      return false;
    }
    const args = readCliArgs(invocation);
    const subcommand = args[0]?.trim().toLowerCase();
    if (!subcommand) {
      return true;
    }
    return !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
  }
  return false;
}

const decidePolicy = (
  _context: ToolPolicyContext,
  rawInvocation: unknown,
): Effect.Effect<ToolPolicyDecision, ToolHarnessValidationError> =>
  Effect.try({
    try: () => decodeToolInvocation(rawInvocation),
    catch: (cause) =>
      new ToolHarnessValidationError({
        operation: "ToolPolicyEngine.decide",
        issue: "Invalid tool invocation payload",
        cause,
      }),
  }).pipe(
    Effect.map((invocation) => {
      const defaultAction = normalizePolicyDefaultAction(process.env.DRAFT_TOOL_POLICY_DEFAULT_ACTION);
      if (isRiskyTool(invocation)) {
        return {
          action: "ask",
          reason: "Risky tool invocation requires approval.",
        } satisfies ToolPolicyDecision;
      }
      return {
        action: defaultAction,
        ...(defaultAction === "allow" ? {} : { reason: "Policy requires explicit approval." }),
      } satisfies ToolPolicyDecision;
    }),
  );

export const ToolPolicyEngineLive = Layer.succeed(
  ToolPolicyEngine,
  {
    decide: decidePolicy,
  } satisfies ToolPolicyEngineShape,
);
