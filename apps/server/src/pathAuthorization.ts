import Path from "node:path";

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

export function isWithinAllowedRoot(requestedPath: string, rootPath: string): boolean {
  const relativeToRoot = toPosixRelativePath(Path.relative(rootPath, requestedPath));
  return (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    (!relativeToRoot.startsWith("../") &&
      relativeToRoot !== ".." &&
      !Path.isAbsolute(relativeToRoot))
  );
}

export function resolvePathForContainmentCheck(args: {
  requestedPath: string;
  pathExists: (path: string) => boolean;
  realpath: (path: string) => string;
}): string {
  let currentPath = Path.resolve(args.requestedPath);
  const missingSegments: string[] = [];

  while (!args.pathExists(currentPath)) {
    const parentPath = Path.dirname(currentPath);
    if (parentPath === currentPath) {
      return currentPath;
    }

    missingSegments.unshift(Path.basename(currentPath));
    currentPath = parentPath;
  }

  let resolvedPath = args.realpath(currentPath);
  for (const segment of missingSegments) {
    resolvedPath = Path.join(resolvedPath, segment);
  }

  return resolvedPath;
}
