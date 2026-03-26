import type { Project, Thread } from "../types";

export type SidebarProjectSortMode = "manual" | "recent";
export type SidebarArchiveFilterMode = "active" | "all" | "archived";

function parseIsoTime(value: string | null | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export function getThreadRecencyTime(thread: Pick<Thread, "createdAt" | "updatedAt">): number {
  return Math.max(parseIsoTime(thread.updatedAt), parseIsoTime(thread.createdAt));
}

export function compareThreadsByRecency(
  left: Pick<Thread, "id" | "createdAt" | "updatedAt">,
  right: Pick<Thread, "id" | "createdAt" | "updatedAt">,
): number {
  const byRecency = getThreadRecencyTime(right) - getThreadRecencyTime(left);
  if (byRecency !== 0) {
    return byRecency;
  }
  return right.id.localeCompare(left.id);
}

export function buildProjectRecencyById(input: {
  projects: readonly Pick<Project, "id" | "updatedAt">[];
  threads: readonly Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt">[];
}): Map<Project["id"], number> {
  const recencyByProjectId = new Map<Project["id"], number>();

  for (const project of input.projects) {
    recencyByProjectId.set(project.id, parseIsoTime(project.updatedAt));
  }

  for (const thread of input.threads) {
    const nextRecency = getThreadRecencyTime(thread);
    const previousRecency = recencyByProjectId.get(thread.projectId) ?? Number.NEGATIVE_INFINITY;
    if (nextRecency > previousRecency) {
      recencyByProjectId.set(thread.projectId, nextRecency);
    }
  }

  return recencyByProjectId;
}

export function compareProjectsForSidebar(input: {
  left: Pick<Project, "id" | "cwd" | "updatedAt">;
  right: Pick<Project, "id" | "cwd" | "updatedAt">;
  pinnedProjectIds?: ReadonlySet<Project["id"]>;
  projectRecencyById?: ReadonlyMap<Project["id"], number>;
  manualOrderByProjectId?: ReadonlyMap<Project["id"], number>;
  sortMode?: SidebarProjectSortMode;
}): number {
  const pinnedProjectIds = input.pinnedProjectIds ?? new Set<Project["id"]>();
  const leftPinned = pinnedProjectIds.has(input.left.id);
  const rightPinned = pinnedProjectIds.has(input.right.id);
  if (leftPinned !== rightPinned) {
    return leftPinned ? -1 : 1;
  }

  if (input.sortMode === "manual") {
    const leftOrder = input.manualOrderByProjectId?.get(input.left.id) ?? Number.POSITIVE_INFINITY;
    const rightOrder =
      input.manualOrderByProjectId?.get(input.right.id) ?? Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
  }

  const leftRecency =
    input.projectRecencyById?.get(input.left.id) ?? parseIsoTime(input.left.updatedAt);
  const rightRecency =
    input.projectRecencyById?.get(input.right.id) ?? parseIsoTime(input.right.updatedAt);
  const byRecency = rightRecency - leftRecency;
  if (byRecency !== 0) {
    return byRecency;
  }

  return (
    input.left.cwd.localeCompare(input.right.cwd) || input.left.id.localeCompare(input.right.id)
  );
}

export function matchesSidebarSearch(input: {
  query: string;
  project: Pick<Project, "name" | "cwd">;
  thread?: Pick<Thread, "title" | "model"> | null;
}): boolean {
  const normalizedQuery = input.query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const projectHaystack = `${input.project.name}\n${input.project.cwd}`.toLocaleLowerCase();
  if (projectHaystack.includes(normalizedQuery)) {
    return true;
  }

  if (!input.thread) {
    return false;
  }

  const threadHaystack = `${input.thread.title}\n${input.thread.model}`.toLocaleLowerCase();
  return threadHaystack.includes(normalizedQuery);
}

export function filterArchivedIds<TId extends string>(input: {
  ids: ReadonlySet<TId>;
  knownIds: readonly TId[];
}): Set<TId> {
  const knownIds = new Set(input.knownIds);
  const next = new Set<TId>();
  for (const id of input.ids) {
    if (knownIds.has(id)) {
      next.add(id);
    }
  }
  return next;
}

export function isArchivedVisible(input: {
  archived: boolean;
  filterMode: SidebarArchiveFilterMode;
}): boolean {
  switch (input.filterMode) {
    case "all":
      return true;
    case "archived":
      return input.archived;
    case "active":
      return !input.archived;
  }
}

export function selectLatestThreadForNavigation(input: {
  threads: readonly Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt">[];
  activeProjectId?: Thread["projectId"] | null;
  archivedThreadIds?: ReadonlySet<Thread["id"]>;
  archivedProjectIds?: ReadonlySet<Project["id"]>;
  pinnedThreadIds?: ReadonlySet<Thread["id"]>;
}): Thread["id"] | null {
  const archivedThreadIds = input.archivedThreadIds ?? new Set<Thread["id"]>();
  const archivedProjectIds = input.archivedProjectIds ?? new Set<Project["id"]>();
  const pinnedThreadIds = input.pinnedThreadIds ?? new Set<Thread["id"]>();

  const candidates = input.threads.filter((thread) => {
    if (input.activeProjectId && thread.projectId !== input.activeProjectId) {
      return false;
    }
    if (archivedThreadIds.has(thread.id)) {
      return false;
    }
    if (archivedProjectIds.has(thread.projectId)) {
      return false;
    }
    return true;
  });

  const latestThread = candidates.toSorted((left, right) => {
    const leftPinned = pinnedThreadIds.has(left.id);
    const rightPinned = pinnedThreadIds.has(right.id);
    if (leftPinned !== rightPinned) {
      return leftPinned ? -1 : 1;
    }
    return compareThreadsByRecency(left, right);
  })[0];

  return latestThread?.id ?? null;
}
