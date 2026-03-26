import type { Project, Thread } from "../types";
import { cn } from "../lib/utils";
import { findLatestProposedPlan, isLatestTurnSettled } from "../session-logic";
import {
  buildProjectRecencyById,
  compareProjectsForSidebar,
  compareThreadsByRecency,
  isArchivedVisible,
  matchesSidebarSearch,
  type SidebarArchiveFilterMode,
  type SidebarProjectSortMode,
} from "../lib/threadOrdering";
import type { ProjectId, ThreadId } from "@t3tools/contracts";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export type SidebarNewThreadEnvMode = "local" | "worktree";

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

type ThreadStatusInput = Pick<
  Thread,
  "interactionMode" | "latestTurn" | "lastVisitedAt" | "proposedPlans" | "session"
>;

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

export function resolveSidebarNewThreadEnvMode(input: {
  requestedEnvMode?: SidebarNewThreadEnvMode;
  defaultEnvMode: SidebarNewThreadEnvMode;
}): SidebarNewThreadEnvMode {
  return input.requestedEnvMode ?? input.defaultEnvMode;
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const baseClassName =
    "h-7 w-full translate-x-0 cursor-default justify-start px-2 text-left select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-primary/22 text-foreground font-medium hover:bg-primary/26 hover:text-foreground dark:bg-primary/30 dark:hover:bg-primary/36",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-primary/15 text-foreground hover:bg-primary/19 hover:text-foreground dark:bg-primary/22 dark:hover:bg-primary/28",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-accent/85 text-foreground font-medium hover:bg-accent hover:text-foreground dark:bg-accent/55 dark:hover:bg-accent/70",
    );
  }

  return cn(baseClassName, "text-muted-foreground hover:bg-accent hover:text-foreground");
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
}): ThreadStatusPill | null {
  const { hasPendingApprovals, hasPendingUserInput, thread } = input;

  if (hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (thread.session?.status === "running") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (thread.session?.status === "connecting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  const hasPlanReadyPrompt =
    !hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null) !== null;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

export interface SidebarThreadEntry {
  thread: Thread;
  isPinned: boolean;
  isArchived: boolean;
}

export interface SidebarProjectEntry {
  project: Project;
  isPinned: boolean;
  isArchived: boolean;
  matchedProject: boolean;
  threads: SidebarThreadEntry[];
  orderedThreadIds: ThreadId[];
}

export function buildSidebarProjectEntries(input: {
  projects: readonly Project[];
  threads: readonly Thread[];
  query: string;
  filterMode: SidebarArchiveFilterMode;
  projectSortMode: SidebarProjectSortMode;
  pinnedProjectIds?: ReadonlySet<ProjectId>;
  archivedProjectIds?: ReadonlySet<ProjectId>;
  pinnedThreadIds?: ReadonlySet<ThreadId>;
  archivedThreadIds?: ReadonlySet<ThreadId>;
}): SidebarProjectEntry[] {
  const pinnedProjectIds = input.pinnedProjectIds ?? new Set<ProjectId>();
  const archivedProjectIds = input.archivedProjectIds ?? new Set<ProjectId>();
  const pinnedThreadIds = input.pinnedThreadIds ?? new Set<ThreadId>();
  const archivedThreadIds = input.archivedThreadIds ?? new Set<ThreadId>();
  const manualOrderByProjectId = new Map(
    input.projects.map((project, index) => [project.id, index] as const),
  );
  const projectRecencyById = buildProjectRecencyById({
    projects: input.projects,
    threads: input.threads,
  });

  return input.projects
    .toSorted((left, right) =>
      compareProjectsForSidebar({
        left,
        right,
        pinnedProjectIds,
        projectRecencyById,
        manualOrderByProjectId,
        sortMode: input.projectSortMode,
      }),
    )
    .flatMap((project) => {
      const isProjectArchived = archivedProjectIds.has(project.id);
      const visibleProjectThreads = input.threads
        .filter((thread) => thread.projectId === project.id)
        .toSorted((left, right) => {
          const leftPinned = pinnedThreadIds.has(left.id);
          const rightPinned = pinnedThreadIds.has(right.id);
          if (leftPinned !== rightPinned) {
            return leftPinned ? -1 : 1;
          }
          return compareThreadsByRecency(left, right);
        })
        .filter((thread) =>
          isArchivedVisible({
            archived: archivedThreadIds.has(thread.id),
            filterMode: input.filterMode,
          }),
        );
      const projectVisibleByArchive = isArchivedVisible({
        archived: isProjectArchived,
        filterMode: input.filterMode,
      });

      if (!projectVisibleByArchive && visibleProjectThreads.length === 0) {
        return [];
      }

      const matchedProject = matchesSidebarSearch({
        query: input.query,
        project,
      });
      const matchingThreads = visibleProjectThreads.filter((thread) =>
        matchesSidebarSearch({
          query: input.query,
          project,
          thread,
        }),
      );

      if (input.query.trim().length > 0 && !matchedProject && matchingThreads.length === 0) {
        return [];
      }

      const threads = (matchedProject ? visibleProjectThreads : matchingThreads).map((thread) => ({
        thread,
        isPinned: pinnedThreadIds.has(thread.id),
        isArchived: archivedThreadIds.has(thread.id),
      }));

      return [
        {
          project,
          isPinned: pinnedProjectIds.has(project.id),
          isArchived: isProjectArchived,
          matchedProject,
          threads,
          orderedThreadIds: threads.map((entry) => entry.thread.id),
        },
      ];
    });
}
