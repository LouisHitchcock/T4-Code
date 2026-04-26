import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolPolicyEngine } from "../Services/ToolPolicyEngine.ts";
import { ToolPolicyEngineLive } from "./ToolPolicyEngine.ts";

const makePolicyEngine = () =>
  Effect.gen(function* () {
    return yield* ToolPolicyEngine;
  }).pipe(Effect.provide(ToolPolicyEngineLive));

describe("ToolPolicyEngineLive", () => {
  const priorDefaultAction = process.env.DRAFT_TOOL_POLICY_DEFAULT_ACTION;

  beforeEach(() => {
    process.env.DRAFT_TOOL_POLICY_DEFAULT_ACTION = "allow";
  });

  afterEach(() => {
    if (priorDefaultAction === undefined) {
      delete process.env.DRAFT_TOOL_POLICY_DEFAULT_ACTION;
      return;
    }
    process.env.DRAFT_TOOL_POLICY_DEFAULT_ACTION = priorDefaultAction;
  });

  it("flags mutating git subcommands for approval", async () => {
    const policyEngine = await Effect.runPromise(makePolicyEngine());
    const decision = await Effect.runPromise(
      policyEngine.decide(
        { threadId: "thread-1" },
        {
          toolCallId: "call-1",
          toolName: "cli.git",
          input: {
            args: ["push", "origin", "main"],
          },
        },
      ),
    );

    expect(decision.action).toBe("ask");
  });

  it("allows read-only git subcommands", async () => {
    const policyEngine = await Effect.runPromise(makePolicyEngine());
    const decision = await Effect.runPromise(
      policyEngine.decide(
        { threadId: "thread-2" },
        {
          toolCallId: "call-1",
          toolName: "cli.git",
          input: {
            args: ["status"],
          },
        },
      ),
    );

    expect(decision.action).toBe("allow");
  });

  it("requires explicit readOnly override for gh commands", async () => {
    const policyEngine = await Effect.runPromise(makePolicyEngine());
    const blockedDecision = await Effect.runPromise(
      policyEngine.decide(
        { threadId: "thread-3" },
        {
          toolCallId: "call-1",
          toolName: "cli.gh",
          input: {
            args: ["pr", "list"],
          },
        },
      ),
    );
    const allowedDecision = await Effect.runPromise(
      policyEngine.decide(
        { threadId: "thread-3" },
        {
          toolCallId: "call-2",
          toolName: "cli.gh",
          input: {
            args: ["pr", "list"],
            readOnly: true,
          },
        },
      ),
    );

    expect(blockedDecision.action).toBe("ask");
    expect(allowedDecision.action).toBe("allow");
  });
});
