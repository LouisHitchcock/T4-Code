import type { ProviderKind } from "@t3tools/contracts";

import { summarizeTurnDiffStats } from "./lib/turnDiffTree";
import type { ThreadTask, WorkLogEntry } from "./session-logic";
import type { ChatAttachment, Project, Thread, TurnDiffSummary } from "./types";
import {
  parseLatestResumeContextActivity,
  parseLatestThreadImportActivity,
  parseLatestThreadSkillsActivity,
} from "./threadActivityMetadata";

export type ThreadExportFormat = "markdown" | "json";

interface BuildThreadExportInput {
  thread: Thread;
  project: Project | null;
  provider: ProviderKind | null;
  workLogEntries: ReadonlyArray<WorkLogEntry>;
  tasks: ReadonlyArray<ThreadTask>;
  exportedAt: string;
}

function sanitizeThreadFileSegment(input: string): string {
  const sanitized = input
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "thread";
}

function formatBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 1024) {
    return `${Math.max(0, Math.round(sizeBytes))} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function collectAttachmentMetadata(thread: Thread) {
  return thread.messages.flatMap((message) =>
    (message.attachments ?? []).map((attachment) => ({
      messageId: message.id,
      createdAt: message.createdAt,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      id: attachment.id,
    })),
  );
}

function checkpointExportSummary(summary: TurnDiffSummary) {
  const stats = summarizeTurnDiffStats(summary.files);
  return {
    turnId: summary.turnId,
    checkpointTurnCount: summary.checkpointTurnCount ?? null,
    completedAt: summary.completedAt,
    status: summary.status ?? null,
    checkpointRef: summary.checkpointRef ?? null,
    assistantMessageId: summary.assistantMessageId ?? null,
    additions: stats.additions,
    deletions: stats.deletions,
    files: summary.files,
  };
}

function serializeThreadExport(input: BuildThreadExportInput) {
  const latestResumeContext = parseLatestResumeContextActivity(input.thread.activities);
  const latestImportActivity = parseLatestThreadImportActivity(input.thread.activities);
  const latestSkillsActivity = parseLatestThreadSkillsActivity(input.thread.activities);

  return {
    version: 1,
    exportedAt: input.exportedAt,
    thread: {
      id: input.thread.id,
      title: input.thread.title,
      projectId: input.thread.projectId,
      projectName: input.project?.name ?? null,
      provider: input.provider,
      model: input.thread.model,
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      branch: input.thread.branch,
      worktreePath: input.thread.worktreePath,
      createdAt: input.thread.createdAt,
      latestTurn: input.thread.latestTurn,
    },
    threadFeatures: {
      continuationSummary: latestResumeContext,
      importedFromShare: latestImportActivity,
      latestAppliedSkills: latestSkillsActivity,
    },
    messages: input.thread.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      completedAt: message.completedAt ?? null,
      streaming: message.streaming,
      attachments: (message.attachments ?? []).map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      })),
    })),
    proposedPlans: input.thread.proposedPlans.map((plan) => ({ ...plan })),
    tasks: input.tasks.map((task) => ({
      taskId: task.taskId,
      turnId: task.turnId,
      taskType: task.taskType ?? null,
      title: task.title,
      status: task.status,
      startedAt: task.startedAt,
      completedAt: task.completedAt ?? null,
      summary: task.summary ?? null,
      usage: task.usage,
      progressUpdates: task.progressUpdates.map((update) => ({ ...update })),
    })),
    workLogEntries: input.workLogEntries.map((entry) => ({ ...entry })),
    diffSummaries: input.thread.turnDiffSummaries.map(checkpointExportSummary),
    attachments: collectAttachmentMetadata(input.thread),
  };
}

function buildThreadFeatureMarkdown(thread: Thread): string {
  const latestResumeContext = parseLatestResumeContextActivity(thread.activities);
  const latestImportActivity = parseLatestThreadImportActivity(thread.activities);
  const latestSkillsActivity = parseLatestThreadSkillsActivity(thread.activities);
  const lines: string[] = [];

  if (latestResumeContext) {
    lines.push("### Continuation Summary");
    lines.push(`Updated: ${latestResumeContext.compactedAt}`);
    if (latestResumeContext.source) {
      lines.push(`Source: ${latestResumeContext.source}`);
    }
    lines.push("");
    lines.push(latestResumeContext.summary);
    lines.push("");
  }

  if (latestImportActivity) {
    lines.push("### Shared Import");
    lines.push(`Imported at: ${latestImportActivity.importedAt}`);
    if (latestImportActivity.shareId) {
      lines.push(`Share ID: ${latestImportActivity.shareId}`);
    }
    if (latestImportActivity.sourceThreadId) {
      lines.push(`Source thread: ${latestImportActivity.sourceThreadId}`);
    }
    lines.push("");
  }

  if (latestSkillsActivity && latestSkillsActivity.skills.length > 0) {
    lines.push("### Latest Applied Skills");
    lines.push(`Applied at: ${latestSkillsActivity.createdAt}`);
    for (const skillName of latestSkillsActivity.skills) {
      lines.push(`- ${skillName}`);
    }
    lines.push("");
  }

  return lines.length > 0
    ? lines.join("\n").trimEnd()
    : "No continuation, import, or skill metadata.";
}

function buildMessageMarkdown(message: Thread["messages"][number]): string {
  const lines = [
    `### ${message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : "System"}`,
  ];
  lines.push(`Created: ${message.createdAt}`);
  if (message.completedAt) {
    lines.push(`Completed: ${message.completedAt}`);
  }
  if (message.attachments && message.attachments.length > 0) {
    lines.push("Attachments:");
    for (const attachment of message.attachments) {
      lines.push(
        `- ${attachment.name} (${attachment.mimeType}, ${formatBytes(attachment.sizeBytes)})`,
      );
    }
  }
  lines.push("");
  lines.push(message.text.length > 0 ? message.text : "(empty)");
  return lines.join("\n");
}

function buildTaskMarkdown(task: ThreadTask): string {
  const lines = [`### ${task.title}`];
  lines.push(`Status: ${task.status}`);
  lines.push(`Started: ${task.startedAt}`);
  if (task.completedAt) {
    lines.push(`Completed: ${task.completedAt}`);
  }
  if (task.turnId) {
    lines.push(`Turn ID: ${task.turnId}`);
  }
  if (task.summary) {
    lines.push(`Summary: ${task.summary}`);
  }
  if (task.progressUpdates.length > 0) {
    lines.push("Progress:");
    for (const update of task.progressUpdates) {
      lines.push(
        `- ${update.createdAt}: ${update.description}${update.lastToolName ? ` (${update.lastToolName})` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

function buildWorkLogMarkdown(entry: WorkLogEntry): string {
  const lines = [`- ${entry.createdAt} · ${entry.label}`];
  if (entry.detail) {
    lines.push(`  ${entry.detail}`);
  }
  if (entry.command) {
    lines.push(`  Command: ${entry.command}`);
  }
  if (entry.changedFiles && entry.changedFiles.length > 0) {
    lines.push(`  Files: ${entry.changedFiles.join(", ")}`);
  }
  return lines.join("\n");
}

function buildCheckpointMarkdown(summary: TurnDiffSummary): string {
  const stats = summarizeTurnDiffStats(summary.files);
  const title = `### Turn ${summary.checkpointTurnCount ?? "?"}`;
  const lines = [title, `Completed: ${summary.completedAt}`];
  if (summary.status) {
    lines.push(`Status: ${summary.status}`);
  }
  if (summary.checkpointRef) {
    lines.push(`Checkpoint: ${summary.checkpointRef}`);
  }
  lines.push(`Net diff: +${stats.additions} / -${stats.deletions}`);
  if (summary.files.length > 0) {
    lines.push("Files:");
    for (const file of summary.files) {
      lines.push(
        `- ${file.path}${file.kind ? ` (${file.kind})` : ""} · +${file.additions ?? 0} / -${file.deletions ?? 0}`,
      );
    }
  }
  return lines.join("\n");
}

function buildAttachmentMarkdown(
  attachment: ChatAttachment,
  createdAt: string,
  messageId: string,
): string {
  return `- ${attachment.name} (${attachment.mimeType}, ${formatBytes(attachment.sizeBytes)}) · message ${messageId} · ${createdAt}`;
}

function buildThreadExportMarkdown(input: BuildThreadExportInput): string {
  const sections: string[] = [];
  sections.push(`# ${input.thread.title}`);
  sections.push("");
  sections.push("## Metadata");
  sections.push(`- Exported at: ${input.exportedAt}`);
  sections.push(`- Project: ${input.project?.name ?? "Unknown project"}`);
  sections.push(`- Provider: ${input.provider ?? "unknown"}`);
  sections.push(`- Model: ${input.thread.model}`);
  sections.push(`- Runtime mode: ${input.thread.runtimeMode}`);
  sections.push(`- Interaction mode: ${input.thread.interactionMode}`);
  if (input.thread.branch) {
    sections.push(`- Branch: ${input.thread.branch}`);
  }
  if (input.thread.worktreePath) {
    sections.push(`- Worktree: ${input.thread.worktreePath}`);
  }
  sections.push("");
  sections.push("## Thread Features");
  sections.push("");
  sections.push(buildThreadFeatureMarkdown(input.thread));
  sections.push("");
  sections.push("## Conversation");
  sections.push("");
  sections.push(
    input.thread.messages.length > 0
      ? input.thread.messages.map(buildMessageMarkdown).join("\n\n")
      : "No messages.",
  );

  sections.push("");
  sections.push("## Proposed Plans");
  sections.push("");
  sections.push(
    input.thread.proposedPlans.length > 0
      ? input.thread.proposedPlans
          .map(
            (plan, index) =>
              `### Plan ${index + 1}\nCreated: ${plan.createdAt}\nUpdated: ${plan.updatedAt}\n\n${plan.planMarkdown}`,
          )
          .join("\n\n")
      : "No proposed plans.",
  );

  sections.push("");
  sections.push("## Tasks");
  sections.push("");
  sections.push(
    input.tasks.length > 0 ? input.tasks.map(buildTaskMarkdown).join("\n\n") : "No tasks.",
  );

  sections.push("");
  sections.push("## Work Log");
  sections.push("");
  sections.push(
    input.workLogEntries.length > 0
      ? input.workLogEntries.map(buildWorkLogMarkdown).join("\n")
      : "No work-log entries.",
  );

  sections.push("");
  sections.push("## Diff Summaries");
  sections.push("");
  sections.push(
    input.thread.turnDiffSummaries.length > 0
      ? input.thread.turnDiffSummaries.map(buildCheckpointMarkdown).join("\n\n")
      : "No checkpoint diffs.",
  );

  sections.push("");
  sections.push("## Attachments");
  sections.push("");
  const attachmentLines = input.thread.messages.flatMap((message) =>
    (message.attachments ?? []).map((attachment) =>
      buildAttachmentMarkdown(attachment, message.createdAt, message.id),
    ),
  );
  sections.push(attachmentLines.length > 0 ? attachmentLines.join("\n") : "No attachments.");

  return `${sections.join("\n").trimEnd()}\n`;
}

export function buildThreadExportFilename(thread: Thread, format: ThreadExportFormat): string {
  const extension = format === "json" ? "json" : "md";
  return `${sanitizeThreadFileSegment(thread.title)}.${extension}`;
}

export function buildThreadExportContents(
  format: ThreadExportFormat,
  input: BuildThreadExportInput,
): string {
  if (format === "json") {
    return `${JSON.stringify(serializeThreadExport(input), null, 2)}\n`;
  }
  return buildThreadExportMarkdown(input);
}

export function downloadThreadExportFile(
  filename: string,
  contents: string,
  format: ThreadExportFormat,
): void {
  const blob = new Blob([contents], {
    type: format === "json" ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
