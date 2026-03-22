import { describe, expect, it } from "vitest";

import type { ThreadId } from "@t3tools/contracts";

import {
  canCreateThreadShareLink,
  canOpenThreadShareDialog,
  shouldAutoCreateThreadShare,
} from "./threadShareMode";

const THREAD_ID = "thread-1" as unknown as ThreadId;

describe("threadShareMode helpers", () => {
  it("blocks new share links when sharing is disabled", () => {
    expect(
      canCreateThreadShareLink({
        shareMode: "disabled",
        baseShareAvailable: true,
        hasActiveShare: false,
      }),
    ).toBe(false);
  });

  it("still allows opening share controls when a thread already has an active share", () => {
    expect(
      canOpenThreadShareDialog({
        shareMode: "disabled",
        baseShareAvailable: false,
        hasActiveShare: true,
      }),
    ).toBe(true);
  });

  it("auto-shares only once per eligible thread", () => {
    expect(
      shouldAutoCreateThreadShare({
        shareMode: "auto",
        threadId: THREAD_ID,
        baseShareAvailable: true,
        hasActiveShare: false,
        attemptedThreadIds: new Set(),
      }),
    ).toBe(true);

    expect(
      shouldAutoCreateThreadShare({
        shareMode: "auto",
        threadId: THREAD_ID,
        baseShareAvailable: true,
        hasActiveShare: false,
        attemptedThreadIds: new Set([THREAD_ID]),
      }),
    ).toBe(false);
  });

  it("does not auto-share while the thread is unavailable or already shared", () => {
    expect(
      shouldAutoCreateThreadShare({
        shareMode: "auto",
        threadId: THREAD_ID,
        baseShareAvailable: false,
        hasActiveShare: false,
        attemptedThreadIds: new Set(),
      }),
    ).toBe(false);

    expect(
      shouldAutoCreateThreadShare({
        shareMode: "auto",
        threadId: THREAD_ID,
        baseShareAvailable: true,
        hasActiveShare: true,
        attemptedThreadIds: new Set(),
      }),
    ).toBe(false);
  });
});
