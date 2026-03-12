import { WS_CHANNELS } from "@t3tools/contracts";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WsTransport } from "./wsTransport";

type WsEventType = "open" | "message" | "close" | "error";
type WsListener = (event?: { data?: unknown }) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly url: string;
  readonly sent: string[] = [];
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
  }

  serverMessage(data: unknown) {
    this.emit("message", { data });
  }

  private emit(type: WsEventType, event?: { data?: unknown }) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;

function getSocket(): MockWebSocket {
  const socket = sockets.at(-1);
  if (!socket) {
    throw new Error("Expected a websocket instance");
  }
  return socket;
}

beforeEach(() => {
  sockets.length = 0;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        href: "http://localhost:3020/",
        protocol: "http:",
        hostname: "localhost",
        port: "3020",
        pathname: "/",
        search: "",
        hash: "",
      },
      history: {
        state: null,
        replaceState: vi.fn(),
      },
      desktopBridge: undefined,
    },
  });

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("WsTransport", () => {
  it("notifies state listeners when the websocket state changes", () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();

    const listener = vi.fn();
    const unsubscribe = transport.subscribeState(listener);

    socket.open();
    socket.close();

    expect(listener).toHaveBeenNthCalledWith(1, "open");
    expect(listener).toHaveBeenNthCalledWith(2, "closed");

    unsubscribe();
    transport.dispose();
  });

  it("routes valid push envelopes to channel listeners", () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const listener = vi.fn();
    transport.subscribe(WS_CHANNELS.serverConfigUpdated, listener);

    socket.serverMessage(
      JSON.stringify({
        type: "push",
        sequence: 1,
        channel: WS_CHANNELS.serverConfigUpdated,
        data: { issues: [], providers: [] },
      }),
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      type: "push",
      sequence: 1,
      channel: WS_CHANNELS.serverConfigUpdated,
      data: { issues: [], providers: [] },
    });

    transport.dispose();
  });

  it("resolves pending requests for valid response envelopes", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const requestPromise = transport.request("projects.list");
    const sent = socket.sent.at(-1);
    if (!sent) {
      throw new Error("Expected request envelope to be sent");
    }

    const requestEnvelope = JSON.parse(sent) as { id: string };
    socket.serverMessage(
      JSON.stringify({
        id: requestEnvelope.id,
        result: { projects: [] },
      }),
    );

    await expect(requestPromise).resolves.toEqual({ projects: [] });

    transport.dispose();
  });

  it("rejects responses that do not match the expected result schema", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const requestPromise = transport.request("server.getConfig", undefined, {
      resultSchema: Schema.Struct({ cwd: Schema.String }),
    });
    const sent = socket.sent.at(-1);
    if (!sent) {
      throw new Error("Expected request envelope to be sent");
    }

    const requestEnvelope = JSON.parse(sent) as { id: string };
    socket.serverMessage(
      JSON.stringify({
        id: requestEnvelope.id,
        result: { cwd: 123 },
      }),
    );

    await expect(requestPromise).rejects.toThrow(
      "Invalid response payload for server.getConfig: Expected string, got 123",
    );

    transport.dispose();
  });

  it("flushes requests queued before the socket opens", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();

    const requestPromise = transport.request("projects.list");
    expect(socket.sent).toHaveLength(0);

    socket.open();
    const sent = socket.sent.at(-1);
    if (!sent) {
      throw new Error("Expected queued request envelope to be sent after open");
    }

    const requestEnvelope = JSON.parse(sent) as { id: string };
    socket.serverMessage(
      JSON.stringify({
        id: requestEnvelope.id,
        result: { projects: ["queued"] },
      }),
    );

    await expect(requestPromise).resolves.toEqual({ projects: ["queued"] });

    transport.dispose();
  });

  it("rejects in-flight requests immediately when the socket closes", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const requestPromise = transport.request("projects.list");
    expect(socket.sent).toHaveLength(1);

    socket.close();

    await expect(requestPromise).rejects.toThrow(
      "WebSocket disconnected before a response was received",
    );

    transport.dispose();
  });

  it("drops malformed envelopes without crashing transport", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const listener = vi.fn();
    transport.subscribe(WS_CHANNELS.serverConfigUpdated, listener);

    socket.serverMessage("{ invalid-json");
    socket.serverMessage(
      JSON.stringify({
        type: "push",
        sequence: 2,
        channel: 42,
        data: { bad: true },
      }),
    );
    socket.serverMessage(
      JSON.stringify({
        type: "push",
        sequence: 3,
        channel: WS_CHANNELS.serverConfigUpdated,
        data: { issues: [], providers: [] },
      }),
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      type: "push",
      sequence: 3,
      channel: WS_CHANNELS.serverConfigUpdated,
      data: { issues: [], providers: [] },
    });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(
      1,
      "Dropped inbound WebSocket envelope",
      "SyntaxError: Expected property name or '}' in JSON at position 2 (line 1 column 3)",
    );
    expect(warnSpy).toHaveBeenNthCalledWith(
      2,
      "Dropped inbound WebSocket envelope",
      expect.stringContaining('Expected "server.configUpdated"'),
    );

    transport.dispose();
  });

  it("clears cached push payloads after the socket closes", () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    socket.serverMessage(
      JSON.stringify({
        type: "push",
        sequence: 1,
        channel: WS_CHANNELS.serverConfigUpdated,
        data: { issues: [], providers: [] },
      }),
    );

    expect(transport.getLatestPush(WS_CHANNELS.serverConfigUpdated)?.data).toEqual({
      issues: [],
      providers: [],
    });

    socket.close();

    expect(transport.getLatestPush(WS_CHANNELS.serverConfigUpdated)).toBeNull();

    transport.dispose();
  });

  it("queues requests until the websocket opens", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();

    const requestPromise = transport.request("projects.list");
    expect(socket.sent).toHaveLength(0);

    socket.open();
    expect(socket.sent).toHaveLength(1);
    const requestEnvelope = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        id: requestEnvelope.id,
        result: { projects: [] },
      }),
    );

    await expect(requestPromise).resolves.toEqual({ projects: [] });
    transport.dispose();
  });

  it("re-resolves the desktop bridge websocket url on reconnect", async () => {
    vi.useFakeTimers();

    const desktopBridge = {
      getWsUrl: vi
        .fn<() => string | null>()
        .mockReturnValueOnce("ws://127.0.0.1:4001")
        .mockReturnValueOnce("ws://127.0.0.1:4002"),
    };
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: desktopBridge,
    });

    const transport = new WsTransport();
    const firstSocket = getSocket();
    expect(firstSocket.url).toBe("ws://127.0.0.1:4001");
    firstSocket.open();
    firstSocket.close();

    await vi.advanceTimersByTimeAsync(500);

    const secondSocket = getSocket();
    expect(secondSocket).not.toBe(firstSocket);
    expect(secondSocket.url).toBe("ws://127.0.0.1:4002");

    transport.dispose();
    vi.useRealTimers();
  });

  it("omits the port delimiter when the page uses a default port", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: "https://example.com/",
        protocol: "https:",
        hostname: "example.com",
        port: "",
        pathname: "/",
        search: "",
        hash: "",
      },
    });

    const transport = new WsTransport();
    const socket = getSocket();

    expect(socket.url).toBe("wss://example.com");

    transport.dispose();
  });

  it("applies the page auth token to the websocket url and removes it from the visible location", () => {
    const replaceState = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: "http://localhost:3020/?token=secret-token&view=settings#plans",
        protocol: "http:",
        hostname: "localhost",
        port: "3020",
        pathname: "/",
        search: "?token=secret-token&view=settings",
        hash: "#plans",
      },
    });
    Object.defineProperty(window, "history", {
      configurable: true,
      value: {
        state: null,
        replaceState,
      },
    });

    const transport = new WsTransport();
    const socket = getSocket();

    expect(socket.url).toBe("ws://localhost:3020/?token=secret-token");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?view=settings#plans");

    transport.dispose();
  });
});
