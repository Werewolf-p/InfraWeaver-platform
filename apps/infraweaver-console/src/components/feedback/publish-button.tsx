"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Rocket } from "lucide-react";
import { apiClient, toApiErrorMessage } from "@/lib/api-client";
import { toast } from "@/lib/notify";
import { ConfirmDialog } from "@/components/ui";

interface PublishButtonProps {
  /** Number of accepted entries waiting on the staging branch. */
  acceptedCount: number;
  /** Short labels of the accepted entries that will go live, for the dialog. */
  acceptedTitles: string[];
  /** True while any pipeline op (approve / retry / publish) is already in flight. */
  pipelineBusy: boolean;
  /** Notifies the parent so a publish-in-flight also blocks other pipeline ops. */
  onBusyChange: (busy: boolean) => void;
}

/** Spell out exactly which accepted entries Publish will promote to live. */
function buildDescription(acceptedCount: number, titles: string[]): string {
  if (acceptedCount === 0) return "Nothing is staged yet.";
  const noun = acceptedCount === 1 ? "change" : `${acceptedCount} changes`;
  const list = titles.length > 0 ? `\n\n• ${titles.join("\n• ")}` : "";
  return `This updates the LIVE console for everyone and cannot be undone. The following ${noun} will go live:${list}`;
}

/**
 * "Publish N changes to live" — merges feedback/staging → main and releases prod
 * via the dispatch /publish run. Always rendered (disabled at 0) so the control
 * is discoverable; the publish is long-running and streamed under the synthetic
 * "publish" run id. Requires typing PUBLISH to confirm the irreversible action.
 */
export function PublishButton({ acceptedCount, acceptedTitles, pipelineBusy, onBusyChange }: PublishButtonProps) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const nothingStaged = acceptedCount === 0;
  // Disabled while its own request runs, while another pipeline op is in flight,
  // or when there is nothing staged to publish.
  const disabled = busy || pipelineBusy || nothingStaged;
  const countLabel = `${acceptedCount} ${acceptedCount === 1 ? "change" : "changes"}`;

  async function publish() {
    setConfirmOpen(false);
    setBusy(true);
    onBusyChange(true);
    try {
      const result = await apiClient.post<{ ok: boolean; skipped?: boolean; started?: boolean }>(
        "/api/feedback/publish",
        { json: {} },
      );
      if (result.skipped) {
        toast.success("Publish requested (dispatch not configured — skipped)");
      } else if (result.started) {
        toast.success("Publishing — merging staging → main and releasing prod…");
      } else {
        toast.success("Publish triggered");
      }
      await queryClient.invalidateQueries({ queryKey: ["feedback", "list"] });
    } catch (err) {
      toast.error(toApiErrorMessage(err, "Failed to publish"));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={disabled}
        title={nothingStaged ? "Nothing staged yet" : pipelineBusy ? "A pipeline action is already running" : undefined}
        onClick={() => setConfirmOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
        {nothingStaged ? "Publish to live" : `Publish ${countLabel} to live`}
      </button>
      {nothingStaged && <span className="text-[10px] text-gray-400 dark:text-[#666]">Nothing staged yet</span>}

      <ConfirmDialog
        open={confirmOpen}
        onConfirm={publish}
        onCancel={() => setConfirmOpen(false)}
        title={`Publish ${countLabel} to the live console?`}
        description={buildDescription(acceptedCount, acceptedTitles)}
        confirmText={`Publish ${countLabel} to live`}
        danger
        requireTyping="PUBLISH"
      />
    </div>
  );
}

export default PublishButton;
