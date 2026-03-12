import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isWithinAllowedRoot, resolvePathForContainmentCheck } from "./pathAuthorization";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createDirectorySymlink(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolvePathForContainmentCheck", () => {
  it("resolves existing symlinked paths to their real target", () => {
    const root = makeTempDir("t3-path-auth-root-");
    const outside = makeTempDir("t3-path-auth-outside-");
    const linkPath = path.join(root, "link");
    const targetPath = path.join(outside, "secret.txt");
    fs.writeFileSync(targetPath, "secret\n", "utf8");
    createDirectorySymlink(outside, linkPath);

    expect(
      resolvePathForContainmentCheck({
        requestedPath: path.join(linkPath, "secret.txt"),
        pathExists: fs.existsSync,
        realpath: fs.realpathSync.native,
      }),
    ).toBe(targetPath);
  });

  it("resolves non-existent children through the nearest existing symlinked ancestor", () => {
    const root = makeTempDir("t3-path-auth-root-");
    const outside = makeTempDir("t3-path-auth-outside-");
    const linkPath = path.join(root, "link");
    createDirectorySymlink(outside, linkPath);

    expect(
      resolvePathForContainmentCheck({
        requestedPath: path.join(linkPath, "nested", "new.txt"),
        pathExists: fs.existsSync,
        realpath: fs.realpathSync.native,
      }),
    ).toBe(path.join(outside, "nested", "new.txt"));
  });
});

describe("isWithinAllowedRoot", () => {
  it("allows paths that stay inside the root", () => {
    expect(isWithinAllowedRoot("/repo/src/file.ts", "/repo")).toBe(true);
  });

  it("rejects paths that escape the root", () => {
    expect(isWithinAllowedRoot("/etc/passwd", "/repo")).toBe(false);
  });
});
