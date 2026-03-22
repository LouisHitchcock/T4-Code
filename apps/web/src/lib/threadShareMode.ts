import type { ThreadId } from "@t3tools/contracts";

import type { ThreadShareMode } from "../appSettings";

export interface ThreadShareAvailabilityInput {
  readonly shareMode: ThreadShareMode;
  readonly baseShareAvailable: boolean;
  readonly hasActiveShare: boolean;
}

export function canCreateThreadShareLink(input: ThreadShareAvailabilityInput): boolean {
  return input.baseShareAvailable && input.shareMode !== "disabled";
}

export function canOpenThreadShareDialog(input: ThreadShareAvailabilityInput): boolean {
  return input.hasActiveShare || canCreateThreadShareLink(input);
}

export interface AutoThreadShareInput extends ThreadShareAvailabilityInput {
  readonly threadId: ThreadId | null;
  readonly attemptedThreadIds: ReadonlySet<ThreadId>;
}

export function shouldAutoCreateThreadShare(input: AutoThreadShareInput): boolean {
  return (
    input.shareMode === "auto" &&
    input.threadId !== null &&
    !input.hasActiveShare &&
    input.baseShareAvailable &&
    !input.attemptedThreadIds.has(input.threadId)
  );
}
