import { WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { useEffect, useMemo, type ReactNode } from "react";
import { useTheme } from "../hooks/useTheme";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";

/**
 * Catch the fire-and-forget `initialize()` promise on the worker pool singleton.
 *
 * `@pierre/diffs` calls `workerPoolManager.initialize()` inside
 * `getOrCreateWorkerPoolSingleton` without attaching a `.catch()`. When the
 * React tree unmounts quickly (e.g. browser-test teardown), the pool is
 * terminated while init is still in flight, which causes an unhandled
 * rejection ("WorkerPoolManager: workers failed to initialize"). Attaching a
 * no-op catch here prevents that from surfacing as a test/runtime error.
 */
function DiffWorkerPoolInitGuard() {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool) return;
    // `initialized` is `false | Promise<void> | true` on WorkerPoolManager.
    const pending = (workerPool as unknown as Record<string, unknown>).initialized;
    if (pending && typeof (pending as Promise<void>).catch === "function") {
      (pending as Promise<void>).catch(() => undefined);
    }
  }, [workerPool]);

  return null;
}

function DiffWorkerThemeSync({ themeName }: { themeName: DiffThemeName }) {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool) {
      return;
    }

    const current = workerPool.getDiffRenderOptions();
    if (current.theme === themeName) {
      return;
    }

    void workerPool
      .setRenderOptions({
        ...current,
        theme: themeName,
      })
      .catch(() => undefined);
  }, [themeName, workerPool]);

  return null;
}

export function DiffWorkerPoolProvider({ children }: { children?: ReactNode }) {
  const { resolvedTheme, activeCustomThemeId } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme, activeCustomThemeId);
  const workerPoolSize = useMemo(() => {
    const cores =
      typeof navigator === "undefined" ? 4 : Math.max(1, navigator.hardwareConcurrency || 4);
    return Math.max(2, Math.min(6, Math.floor(cores / 2)));
  }, []);

  return (
    <WorkerPoolContextProvider
      poolOptions={{
        workerFactory: () => new DiffsWorker(),
        poolSize: workerPoolSize,
        totalASTLRUCacheSize: 240,
      }}
      highlighterOptions={{
        theme: diffThemeName,
        tokenizeMaxLineLength: 1_000,
      }}
    >
      <DiffWorkerPoolInitGuard />
      <DiffWorkerThemeSync themeName={diffThemeName} />
      {children}
    </WorkerPoolContextProvider>
  );
}
