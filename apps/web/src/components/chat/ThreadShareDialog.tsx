import { memo } from "react";

import type { ThreadShareSummary } from "@t3tools/contracts";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { CircleAlertIcon } from "lucide-react";

export const ThreadShareDialog = memo(function ThreadShareDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threadTitle: string;
  share: ThreadShareSummary | null;
  shareUrl: string | null;
  isCreatingShare: boolean;
  isRevokingShare: boolean;
  onCreateShare: () => void;
  onCopyLink: () => void;
  onOpenSharedView: () => void;
  onRevokeShare: () => void;
}) {
  const hasShare = props.share !== null && props.share.revokedAt === null;
  const activeShare = hasShare ? props.share : null;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Share thread</DialogTitle>
          <DialogDescription>
            Create a read-only shared snapshot for{" "}
            <span className="font-medium text-foreground">{props.threadTitle}</span>.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <Alert variant="info">
            <CircleAlertIcon />
            <div>
              <AlertTitle>Read-only shared view</AlertTitle>
              <AlertDescription>
                Shared links expose a versioned thread snapshot that can be opened read-only and
                imported into another local thread.
              </AlertDescription>
            </div>
          </Alert>

          {activeShare && props.shareUrl ? (
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Share link</span>
              <Input value={props.shareUrl} readOnly spellCheck={false} />
              <span className="text-xs text-muted-foreground/75">
                Created {new Date(activeShare.createdAt).toLocaleString()}.
              </span>
            </label>
          ) : (
            <div className="rounded-lg border border-dashed border-border/70 bg-muted/15 px-3 py-3 text-sm text-muted-foreground">
              No active share link exists for this thread.
            </div>
          )}
        </DialogPanel>
        <DialogFooter className="gap-2 sm:justify-between">
          {hasShare ? (
            <Button
              variant="destructive-outline"
              size="sm"
              onClick={props.onRevokeShare}
              disabled={props.isRevokingShare}
            >
              {props.isRevokingShare ? "Revoking..." : "Revoke share"}
            </Button>
          ) : (
            <Button size="sm" onClick={props.onCreateShare} disabled={props.isCreatingShare}>
              {props.isCreatingShare ? "Creating..." : "Create share link"}
            </Button>
          )}

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => props.onOpenChange(false)}>
              Close
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={props.onOpenSharedView}
              disabled={!hasShare || !props.shareUrl}
            >
              Open shared view
            </Button>
            <Button size="sm" onClick={props.onCopyLink} disabled={!hasShare || !props.shareUrl}>
              Copy link
            </Button>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});
