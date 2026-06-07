"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Rocket } from "lucide-react";
import { apiClient, toApiErrorMessage } from "@/lib/api-client";
import { toast } from "@/lib/notify";

interface PublishButtonProps {
  /** Number of accepted entries waiting on the staging branch. */
  acceptedCount: number;
}

/**
 * "Publish all to main" — merges feedback/staging → main and releases prod via
 * the dispatch /publish run. Only rendered when there are accepted changes. The
 * publish is long-running and streamed under the synthetic "publish" run id.
 */
export function PublishButton({ acceptedCount }: PublishButtonProps) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  if (acceptedCount === 0) return null;

  async function publish() {
    if (!window.confirm(`Publish ${acceptedCount} accepted change(s) to main and release prod?`)) return;
    setBusy(true);
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
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={publish}
      className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-60"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
      Publish all to main
      <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[10px]">{acceptedCount}</span>
    </button>
  );
}

export default PublishButton;
