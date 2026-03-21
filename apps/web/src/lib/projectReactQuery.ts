import type {
  ProjectAgentsFileResult,
  ProjectListCommandTemplatesResult,
  ProjectListSkillsResult,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const projectQueryKeys = {
  all: ["projects"] as const,
  agentsFile: (cwd: string | null) => ["projects", "agents-file", cwd] as const,
  commandTemplates: (cwd: string | null) => ["projects", "command-templates", cwd] as const,
  skills: (cwd: string | null) => ["projects", "skills", cwd] as const,
  searchEntries: (cwd: string | null, query: string, limit: number) =>
    ["projects", "search-entries", cwd, query, limit] as const,
};

const DEFAULT_SEARCH_ENTRIES_LIMIT = 80;
const DEFAULT_SEARCH_ENTRIES_STALE_TIME = 15_000;
const EMPTY_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = {
  entries: [],
  truncated: false,
};
const EMPTY_COMMAND_TEMPLATES_RESULT: ProjectListCommandTemplatesResult = {
  commands: [],
  issues: [],
};
const EMPTY_SKILLS_RESULT: ProjectListSkillsResult = {
  skills: [],
  issues: [],
};

function buildMissingAgentsFileResult(cwd: string): ProjectAgentsFileResult {
  return {
    status: "missing",
    cwd,
    relativePath: "AGENTS.md",
    absolutePath: `${cwd.replace(/\/$/, "")}/AGENTS.md`,
  };
}

export function projectSearchEntriesQueryOptions(input: {
  cwd: string | null;
  query: string;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_ENTRIES_LIMIT;
  return queryOptions({
    queryKey: projectQueryKeys.searchEntries(input.cwd, input.query, limit),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Workspace entry search is unavailable.");
      }
      return api.projects.searchEntries({
        cwd: input.cwd,
        query: input.query,
        limit,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null && input.query.length > 0,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SEARCH_ENTRIES_RESULT,
  });
}

export function projectAgentsFileQueryOptions(input: {
  cwd: string | null;
  enabled?: boolean;
  includeContents?: boolean;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.agentsFile(input.cwd),
    queryFn: async () => {
      if (!input.cwd) {
        throw new Error("Workspace AGENTS.md lookup is unavailable.");
      }
      const api = ensureNativeApi();
      return api.projects.readAgentsFile({
        cwd: input.cwd,
        ...(input.includeContents !== undefined ? { includeContents: input.includeContents } : {}),
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: 30_000,
    placeholderData: (previous) =>
      previous ?? (input.cwd ? buildMissingAgentsFileResult(input.cwd) : undefined),
  });
}

export function projectCommandTemplatesQueryOptions(input: {
  cwd: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.commandTemplates(input.cwd),
    queryFn: async () => {
      if (!input.cwd) {
        throw new Error("Workspace command template lookup is unavailable.");
      }
      const api = ensureNativeApi();
      return api.projects.listCommandTemplates({ cwd: input.cwd });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: 30_000,
    placeholderData: (previous) => previous ?? EMPTY_COMMAND_TEMPLATES_RESULT,
  });
}

export function projectSkillsQueryOptions(input: { cwd: string | null; enabled?: boolean }) {
  return queryOptions({
    queryKey: projectQueryKeys.skills(input.cwd),
    queryFn: async () => {
      if (!input.cwd) {
        throw new Error("Workspace skill lookup is unavailable.");
      }
      const api = ensureNativeApi();
      return api.projects.listSkills({ cwd: input.cwd });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: 30_000,
    placeholderData: (previous) => previous ?? EMPTY_SKILLS_RESULT,
  });
}
