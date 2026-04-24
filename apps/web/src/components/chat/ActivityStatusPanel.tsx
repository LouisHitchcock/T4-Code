import { memo } from "react";
import {
  BotIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  PauseCircleIcon,
  RefreshCwIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";

import { type ActiveThinkingContext, formatDuration } from "../../session-logic";
import { Badge } from "../ui/badge";
import { Spinner } from "../ui/spinner";
import { cn } from "~/lib/utils";

interface ActivityStatusPanelProps {
  context: ActiveThinkingContext;
  nowIso: string;
}

export const ActivityStatusPanel = memo(function ActivityStatusPanel({
  context,
  nowIso,
}: ActivityStatusPanelProps) {
  const elapsed = formatElapsedSince(context.startedAt, nowIso);
  const isIdle = context.kind === "idle";

  return (
    <section
      aria-live="polite"
      className={cn(
        "rounded-2xl border px-3 py-2.5 sm:px-4",
        isIdle ? "border-border/60 bg-card/65" : "border-primary/20 bg-card/85 shadow-sm",
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border",
            iconContainerClassName(context),
          )}
        >
          {renderContextIcon(context)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge size="sm" variant={badgeVariantForContext(context)}>
              {context.statusLabel}
            </Badge>
            <p className="min-w-0 flex-1 truncate font-medium text-sm leading-5">
              {context.headline}
            </p>
            {elapsed ? (
              <span className="shrink-0 text-muted-foreground text-xs">{elapsed}</span>
            ) : null}
          </div>
          {context.detail ? (
            <p className="mt-1 line-clamp-2 text-muted-foreground text-xs leading-5">
              {context.detail}
            </p>
          ) : null}
          {context.command || (context.changedFiles && context.changedFiles.length > 0) ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {context.command ? (
                <code className="max-w-full truncate rounded-md border border-border/70 bg-background/85 px-2 py-1 font-mono text-[11px]">
                  {context.command}
                </code>
              ) : null}
              {context.changedFiles?.slice(0, 2).map((filePath) => (
                <span
                  key={filePath}
                  className="max-w-full truncate rounded-md border border-border/70 bg-background/70 px-2 py-1 text-[11px]"
                  title={filePath}
                >
                  {filePath}
                </span>
              ))}
              {context.changedFiles && context.changedFiles.length > 2 ? (
                <span className="rounded-md border border-border/70 bg-background/70 px-2 py-1 text-[11px] text-muted-foreground">
                  +{context.changedFiles.length - 2} more files
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
});

function formatElapsedSince(startedAt: string | null, nowIso: string): string | null {
  if (!startedAt) {
    return null;
  }
  const startMs = Date.parse(startedAt);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs) || nowMs < startMs) {
    return null;
  }
  return formatDuration(nowMs - startMs);
}

function badgeVariantForContext(context: ActiveThinkingContext) {
  if (context.kind === "idle") {
    return "outline";
  }
  if (context.kind === "waiting-approval" || context.kind === "waiting-input") {
    return "warning";
  }
  if (context.tone === "error") {
    return "error";
  }
  if (context.kind === "thinking") {
    return "secondary";
  }
  return "info";
}

function iconContainerClassName(context: ActiveThinkingContext): string {
  if (context.kind === "idle") {
    return "border-border/70 bg-muted/40 text-muted-foreground";
  }
  if (context.kind === "waiting-approval" || context.kind === "waiting-input") {
    return "border-warning/30 bg-warning/10 text-warning-foreground";
  }
  if (context.tone === "error") {
    return "border-destructive/30 bg-destructive/10 text-destructive-foreground";
  }
  return "border-primary/20 bg-primary/10 text-primary";
}

function renderContextIcon(context: ActiveThinkingContext) {
  switch (context.kind) {
    case "idle":
      return <PauseCircleIcon className="size-4" />;
    case "connecting":
    case "preparing-worktree":
    case "sending-turn":
    case "reverting-checkpoint":
      return <Spinner className="size-4" />;
    case "waiting-approval":
    case "waiting-input":
      return <CircleAlertIcon className="size-4" />;
    case "tool":
      switch (context.itemType) {
        case "command_execution":
          return <TerminalIcon className="size-4" />;
        case "file_change":
          return <SquarePenIcon className="size-4" />;
        case "web_search":
          return <GlobeIcon className="size-4" />;
        case "image_view":
          return <EyeIcon className="size-4" />;
        default:
          return <WrenchIcon className="size-4" />;
      }
    case "thinking":
      return <BotIcon className="size-4" />;
    default:
      return <RefreshCwIcon className="size-4" />;
  }
}
