import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { useThreadSendQueueStore, type QueuedThreadTurn } from "./threadSendQueue";

const threadId = ThreadId.makeUnsafe("thread-queue-test");

function queuedTurn(overrides: Partial<QueuedThreadTurn> = {}): QueuedThreadTurn {
  return {
    id: overrides.id ?? "queued-turn-1",
    threadId,
    text: "queued follow-up",
    attachments: [],
    provider: "codex",
    model: "gpt-5.4",
    serviceTier: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    skillNames: [],
    createdAt: "2026-03-26T10:00:00.000Z",
    mode: "queue",
    status: "pending",
    error: null,
    ...overrides,
  };
}

describe("threadSendQueue", () => {
  beforeEach(() => {
    useThreadSendQueueStore.setState({ queueByThreadId: {} });
  });

  it("adds items to the end of a thread queue by default", () => {
    const store = useThreadSendQueueStore.getState();
    store.enqueue(queuedTurn({ id: "first" }));
    store.enqueue(queuedTurn({ id: "second" }));

    expect(
      useThreadSendQueueStore.getState().queueByThreadId[threadId]?.map((item) => item.id),
    ).toEqual(["first", "second"]);
  });

  it("can insert steering items at the front of the queue", () => {
    const store = useThreadSendQueueStore.getState();
    store.enqueue(queuedTurn({ id: "first" }));
    store.enqueue(queuedTurn({ id: "steer", mode: "steer" }), { front: true });

    expect(
      useThreadSendQueueStore.getState().queueByThreadId[threadId]?.map((item) => item.id),
    ).toEqual(["steer", "first"]);
  });

  it("reorders and updates queue item status safely", () => {
    const store = useThreadSendQueueStore.getState();
    store.enqueue(queuedTurn({ id: "first" }));
    store.enqueue(queuedTurn({ id: "second" }));
    store.move(threadId, "second", -1);
    store.markSending(threadId, "second");
    store.markFailed(threadId, "second", "boom");
    store.markPending(threadId, "second");

    const queue = useThreadSendQueueStore.getState().queueByThreadId[threadId] ?? [];
    expect(queue.map((item) => item.id)).toEqual(["second", "first"]);
    expect(queue[0]).toMatchObject({ status: "pending", error: null });
  });

  it("removes queue items and clears empty thread entries", () => {
    const store = useThreadSendQueueStore.getState();
    store.enqueue(queuedTurn({ id: "first" }));
    store.remove(threadId, "first");

    expect(useThreadSendQueueStore.getState().queueByThreadId[threadId]).toBeUndefined();
  });
});
