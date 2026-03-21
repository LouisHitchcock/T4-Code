import type {
  OrchestrationThreadActivity,
  ProjectSkillName,
  ThreadShareId,
  ThreadId,
} from "@t3tools/contracts";

export const THREAD_RESUME_CONTEXT_ACTIVITY_KIND = "thread.resume-context.updated";
export const THREAD_IMPORT_ACTIVITY_KIND = "thread.imported";
export const THREAD_SKILLS_ACTIVITY_KIND = "thread.skills.applied";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface ResumeContextActivity {
  readonly summary: string;
  readonly compactedAt: string;
  readonly source: string | null;
}

export interface ThreadImportActivity {
  readonly shareId: ThreadShareId | null;
  readonly sourceThreadId: ThreadId | null;
  readonly importedAt: string;
}

export interface ThreadSkillsActivity {
  readonly skills: ReadonlyArray<ProjectSkillName>;
  readonly createdAt: string;
}

export function parseLatestResumeContextActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ResumeContextActivity | null {
  const ordered = [...activities].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  for (const activity of ordered.toReversed()) {
    if (activity.kind !== THREAD_RESUME_CONTEXT_ACTIVITY_KIND) {
      continue;
    }
    const payload = asRecord(activity.payload);
    const summary = asTrimmedString(payload?.summary);
    if (!summary) {
      continue;
    }
    return {
      summary,
      compactedAt: asTrimmedString(payload?.compactedAt) ?? activity.createdAt,
      source: asTrimmedString(payload?.source),
    };
  }
  return null;
}

export function parseLatestThreadImportActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ThreadImportActivity | null {
  const ordered = [...activities].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  for (const activity of ordered.toReversed()) {
    if (activity.kind !== THREAD_IMPORT_ACTIVITY_KIND) {
      continue;
    }
    const payload = asRecord(activity.payload);
    return {
      shareId: (asTrimmedString(payload?.shareId) as ThreadShareId | null) ?? null,
      sourceThreadId: (asTrimmedString(payload?.sourceThreadId) as ThreadId | null) ?? null,
      importedAt: asTrimmedString(payload?.importedAt) ?? activity.createdAt,
    };
  }
  return null;
}

export function parseLatestThreadSkillsActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ThreadSkillsActivity | null {
  const ordered = [...activities].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  for (const activity of ordered.toReversed()) {
    if (activity.kind !== THREAD_SKILLS_ACTIVITY_KIND) {
      continue;
    }
    const payload = asRecord(activity.payload);
    const skills = Array.isArray(payload?.skills)
      ? payload.skills.flatMap((entry) => {
          const value = asTrimmedString(entry);
          return value ? [value as ProjectSkillName] : [];
        })
      : [];
    if (skills.length === 0) {
      continue;
    }
    return {
      skills,
      createdAt: activity.createdAt,
    };
  }
  return null;
}
