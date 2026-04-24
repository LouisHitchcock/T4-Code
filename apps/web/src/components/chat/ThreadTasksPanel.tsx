import type { TurnId } from "@t3tools/contracts";
import { CheckCircle2Icon, CircleAlertIcon, ListTodoIcon, PauseCircleIcon } from "lucide-react";
import { memo } from "react";

import type { TimestampFormat } from "../../appSettings";
import { formatElapsed, type ThreadTask } from "../../session-logic";
import { formatTimestamp } from "../../timestampFormat";
import { formatTaskActivitySummary } from "./ThreadTasksPanel.logic";
import { cn } from "~/lib/utils";

function statusLabel(task: ThreadTask): string {
  switch (task.status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    default:
      return "Running";
  }
}

function statusClassName(task: ThreadTask): string {
  switch (task.status) {
    case "completed":
      return "border-emerald-500/30 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300";
    case "failed":
      return "border-destructive/30 bg-destructive/8 text-destructive";
    case "stopped":
      return "border-amber-500/30 bg-amber-500/8 text-amber-700 dark:text-amber-300";
    default:
      return "border-sky-500/30 bg-sky-500/8 text-sky-700 dark:text-sky-300";
  }
}

function StatusIcon(props: { task: ThreadTask }) {
  switch (props.task.status) {
    case "completed":
      return <CheckCircle2Icon className="size-3.5" />;
    case "failed":
      return <CircleAlertIcon className="size-3.5" />;
    case "stopped":
      return <PauseCircleIcon className="size-3.5" />;
    default:
      return <ListTodoIcon className="size-3.5" />;
  }
}

export const ThreadTasksPanel = memo(function ThreadTasksPanel(props: {
  tasks: ReadonlyArray<ThreadTask>;
  timestampFormat: TimestampFormat;
  checkpointTurnCountByTurnId: Partial<Record<TurnId, number>>;
}) {
  if (props.tasks.length === 0) {
    return null;
  }
  return (
    <div className="shrink-0 px-3 pt-3 sm:px-5">
      <div className="mx-auto w-full max-w-5xl rounded-[24px] border border-border/70 bg-card/55 p-3 shadow-[0_18px_50px_-36px_--alpha(var(--color-black)/24%)] backdrop-blur-xs sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground/90">
            <ListTodoIcon className="size-4 text-muted-foreground/80" />
            <span>Task activity</span>
          </div>
          <div className="text-xs text-muted-foreground/70">
            {formatTaskActivitySummary(props.tasks)}
          </div>
        </div>
        <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
          {props.tasks.map((task) => {
            const checkpointTurnCount =
              task.turnId !== null ? props.checkpointTurnCountByTurnId[task.turnId] : undefined;
            const duration = formatElapsed(task.startedAt, task.completedAt);
            const latestProgress = task.progressUpdates.at(-1);
            return (
              <section
                key={task.taskId}
                className="rounded-2xl border border-border/60 bg-background/70 px-3 py-2.5"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium text-foreground/90">
                        {task.title}
                      </p>
                      {task.taskType ? (
                        <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/75">
                          {task.taskType}
                        </span>
                      ) : null}
                      {checkpointTurnCount ? (
                        <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/75">
                          Turn {checkpointTurnCount}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground/70">
                      {formatTimestamp(task.startedAt, props.timestampFormat)}
                      {duration ? ` · ${duration}` : ""}
                    </p>
                  </div>
                  <div
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium",
                      statusClassName(task),
                    )}
                  >
                    <StatusIcon task={task} />
                    <span>{statusLabel(task)}</span>
                  </div>
                </div>
                {task.summary ? (
                  <p className="mt-2 text-sm leading-relaxed text-foreground/85">{task.summary}</p>
                ) : latestProgress ? (
                  <p className="mt-2 text-sm leading-relaxed text-foreground/85">
                    {latestProgress.description}
                  </p>
                ) : null}
                {task.progressUpdates.length > 0 ? (
                  <div className="mt-2 space-y-1.5">
                    {task.progressUpdates.slice(-3).map((update) => (
                      <div
                        key={update.id}
                        className="rounded-xl border border-border/50 bg-card/40 px-2.5 py-2"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs text-foreground/85">{update.description}</p>
                          <p className="text-[10px] text-muted-foreground/65">
                            {formatTimestamp(update.createdAt, props.timestampFormat)}
                          </p>
                        </div>
                        {update.lastToolName ? (
                          <p className="mt-1 text-[11px] text-muted-foreground/70">
                            Last tool: {update.lastToolName}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
});
