import { describe, expect, it } from "vitest";

import { getWsAuthToken, withoutWsAuthToken, withWsAuthToken } from "./wsAuth";

describe("getWsAuthToken", () => {
  it("reads the token query param when present", () => {
    expect(getWsAuthToken("ws://127.0.0.1:3773/?token=secret-token")).toBe("secret-token");
  });

  it("returns null when the token param is absent", () => {
    expect(getWsAuthToken("ws://127.0.0.1:3773/")).toBeNull();
  });
});

describe("withWsAuthToken", () => {
  it("appends a token when one is not already present", () => {
    expect(withWsAuthToken("ws://127.0.0.1:3773/", "secret-token")).toBe(
      "ws://127.0.0.1:3773/?token=secret-token",
    );
  });

  it("preserves an existing tokenized url", () => {
    expect(withWsAuthToken("ws://127.0.0.1:3773/?token=already-set", "secret-token")).toBe(
      "ws://127.0.0.1:3773/?token=already-set",
    );
  });
});

describe("withoutWsAuthToken", () => {
  it("removes only the auth token query param", () => {
    expect(
      withoutWsAuthToken("http://127.0.0.1:3773/chat?token=secret-token&view=settings#plans"),
    ).toBe("http://127.0.0.1:3773/chat?view=settings#plans");
  });
});
