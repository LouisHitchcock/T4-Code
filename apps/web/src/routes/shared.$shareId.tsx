import { type ProjectId, ThreadShareId } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { useAppSettings } from "../appSettings";
import ChatMarkdown from "../components/ChatMarkdown";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { toastManager } from "../components/ui/toast";
import { threadImportShareMutationOptions, threadShareQueryOptions } from "../lib/threadReactQuery";
import { useStore } from "../store";
import { parseLatestResumeContextActivity } from "../threadActivityMetadata";
import { formatTimestamp } from "../timestampFormat";
import { ArrowLeftIcon, CircleAlertIcon, DownloadIcon, LinkIcon } from "lucide-react";

export const Route = createFileRoute("/shared/$shareId")({
  component: SharedThreadRouteView,
});

function SharedThreadRouteView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    settings: { timestampFormat },
  } = useAppSettings();
  const shareId = Route.useParams({
    select: (params) => ThreadShareId.makeUnsafe(params.shareId),
  });
  const projects = useStore((store) => store.projects);
  const shareQuery = useQuery(threadShareQueryOptions(shareId));
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const [importTitle, setImportTitle] = useState("");

  useEffect(() => {
    if (selectedProjectId || projects.length === 0) {
      return;
    }
    const firstProject = projects[0];
    if (firstProject) {
      setSelectedProjectId(firstProject.id);
    }
  }, [projects, selectedProjectId]);

  useEffect(() => {
    if (importTitle.length > 0) {
      return;
    }
    const title = shareQuery.data?.share.title;
    if (title) {
      setImportTitle(title);
    }
  }, [importTitle.length, shareQuery.data?.share.title]);

  const importMutation = useMutation(
    threadImportShareMutationOptions({
      shareId,
      projectId: selectedProjectId,
      queryClient,
    }),
  );

  const sourceProjectItems = useMemo(
    () =>
      projects.map((project) => ({
        value: project.id,
        label: project.name,
      })),
    [projects],
  );

  const onImport = async () => {
    if (!selectedProjectId) {
      return;
    }
    try {
      const result = await importMutation.mutateAsync({ title: importTitle });
      toastManager.add({
        type: "success",
        title: "Shared thread imported",
      });
      void navigate({
        to: "/$threadId",
        params: { threadId: result.threadId },
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not import shared thread",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    }
  };

  if (shareQuery.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="text-sm text-muted-foreground">Loading shared thread…</div>
      </div>
    );
  }

  if (shareQuery.isError || !shareQuery.data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
        <div className="w-full max-w-xl">
          <Alert variant="error">
            <CircleAlertIcon />
            <AlertTitle>Shared thread unavailable</AlertTitle>
            <AlertDescription>
              {shareQuery.error instanceof Error
                ? shareQuery.error.message
                : "This shared thread could not be loaded."}
            </AlertDescription>
          </Alert>
          <div className="mt-4 flex justify-start">
            <Button variant="outline" onClick={() => void navigate({ to: "/" })}>
              <ArrowLeftIcon className="size-4" />
              Back to chat
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const { share, snapshot } = shareQuery.data;
  const restoreState = snapshot.state;
  const latestResumeContext = parseLatestResumeContextActivity(restoreState.activities);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/80 bg-card/75 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Shared thread</Badge>
              {snapshot.sourceProjectName ? (
                <Badge variant="secondary">{snapshot.sourceProjectName}</Badge>
              ) : null}
            </div>
            <h1 className="mt-2 truncate text-xl font-semibold">{share.title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Exported {formatTimestamp(snapshot.exportedAt, timestampFormat)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => void navigate({ to: "/" })}>
              <ArrowLeftIcon className="size-4" />
              Back to chat
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 lg:flex-row lg:items-start">
        <section className="min-w-0 flex-1 space-y-4">
          {latestResumeContext ? (
            <Alert variant="info">
              <LinkIcon />
              <AlertTitle>Continuation summary</AlertTitle>
              <AlertDescription>
                <div className="line-clamp-5" title={latestResumeContext.summary}>
                  {latestResumeContext.summary}
                </div>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-3">
            <SharedThreadStatCard label="Messages" value={String(restoreState.messages.length)} />
            <SharedThreadStatCard
              label="Activities"
              value={String(restoreState.activities.length)}
            />
            <SharedThreadStatCard
              label="Checkpoints"
              value={String(restoreState.checkpoints.length)}
            />
          </div>

          <div className="space-y-3">
            {restoreState.messages.map((message) => (
              <article
                key={message.id}
                className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3 shadow-xs/5"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant={message.role === "assistant" ? "default" : "outline"}>
                    {message.role}
                  </Badge>
                  <span>{formatTimestamp(message.createdAt, timestampFormat)}</span>
                  {message.attachments && message.attachments.length > 0 ? (
                    <span>
                      {message.attachments.length} attachment
                      {message.attachments.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </div>
                <div className="mt-3 min-w-0">
                  {message.role === "assistant" ? (
                    <ChatMarkdown text={message.text} cwd={undefined} />
                  ) : (
                    <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                      {message.text}
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>

        <aside className="w-full shrink-0 rounded-2xl border border-border/70 bg-card/60 p-4 shadow-xs/5 lg:sticky lg:top-6 lg:w-[22rem]">
          <div className="flex items-center gap-2">
            <DownloadIcon className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Import into a project</h2>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Create a local thread from this shared snapshot so you can continue working from its
            current state.
          </p>

          <div className="mt-4 space-y-3">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Destination project</span>
              <Select
                value={selectedProjectId ?? undefined}
                onValueChange={(value) => setSelectedProjectId(value as ProjectId)}
                items={sourceProjectItems}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose a project" />
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>

            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Imported thread title</span>
              <Input
                value={importTitle}
                onChange={(event) => setImportTitle(event.target.value)}
                placeholder="Imported thread title"
              />
            </label>
          </div>

          <Button
            className="mt-4 w-full"
            onClick={() => {
              void onImport();
            }}
            disabled={!selectedProjectId || importMutation.isPending}
          >
            {importMutation.isPending ? "Importing..." : "Import shared thread"}
          </Button>

          {projects.length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Add a local project first to import this shared thread.
            </p>
          ) : null}
        </aside>
      </main>
    </div>
  );
}

function SharedThreadStatCard(props: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3 shadow-xs/5">
      <div className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">
        {props.label}
      </div>
      <div className="mt-1 text-2xl font-semibold">{props.value}</div>
    </div>
  );
}
