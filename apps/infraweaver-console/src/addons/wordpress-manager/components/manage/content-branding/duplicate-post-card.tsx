"use client";

/**
 * Duplicate-from-console (Epic C2) — clone any post the operator names into a DRAFT
 * over the signed `content.duplicate` command, before ever opening wp-admin. Behind
 * the `duplicate_post` (Pro) TierGate — a non-Pro site shows the upsell, and even a
 * signed request is refused by the plugin's statement-1 gate, whose reason renders
 * verbatim (`entitlement-locked`, `unknown-post`).
 */

import { useState } from "react";
import { Copy, FileCheck2, Hash } from "lucide-react";
import { toast } from "@/lib/notify";
import { SectionCard } from "../../demo/widgets";
import { Spinner } from "../../demo/manage/panel-shell";
import { ActionError, BTN_PRIMARY, Field, INPUT } from "../../demo/manage/manage-ui";
import { Pill } from "../../demo/manage/kit";
import { TierGate } from "../kit/tier-gate";
import { parseId } from "../../demo/manage/form-validation";
import { useDuplicateWriter } from "./use-content-branding";

/** Turn a plugin refusal reason into a plain-English line. */
function reasonText(reason: string): string {
  switch (reason) {
    case "entitlement-locked":
      return "Duplicate isn't active on this site's plan.";
    case "unknown-post":
      return "No post exists with that ID.";
    case "no-wp-context":
      return "The site's WordPress isn't reachable right now — try again shortly.";
    case "insert-failed":
      return "WordPress couldn't create the draft — check the server logs.";
    default:
      return `Duplicate refused: ${reason}`;
  }
}

function DuplicateForm({ site, onChanged }: { site: string; onChanged?: () => void }) {
  const writer = useDuplicateWriter(site);
  const [idText, setIdText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [newId, setNewId] = useState<number | null>(null);
  const postId = parseId(idText);
  const ready = postId !== null && !writer.pending;

  async function duplicate() {
    if (postId === null) return;
    setError(null);
    setNewId(null);
    try {
      const result = await writer.duplicate(postId);
      if (result.ok) {
        setNewId(result.new_id);
        setIdText("");
        toast.success(`Created draft #${result.new_id}`);
        onChanged?.();
      } else {
        setError(reasonText(result.reason));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Duplicate failed");
    }
  }

  return (
    <div className="space-y-3">
      <Field
        label="Post ID to duplicate"
        htmlFor="dup-post-id"
        hint="Any post, page, or custom post — you'll see its number in the web address while editing it."
      >
        <input
          id="dup-post-id"
          inputMode="numeric"
          value={idText}
          onChange={(e) => {
            setIdText(e.target.value);
            setError(null);
          }}
          className={INPUT}
          placeholder="e.g. 42"
        />
      </Field>
      <button type="button" className={BTN_PRIMARY} disabled={!ready} onClick={duplicate}>
        {writer.pending ? <Spinner /> : <Copy className="h-4 w-4" aria-hidden />} Duplicate as draft
      </button>
      {newId !== null ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
          <Pill tone="good" icon={FileCheck2}>
            Draft #{newId}
          </Pill>
          <span className="text-zinc-600 dark:text-zinc-400">
            Created as a draft. Open it in this site&apos;s wp-admin under Posts → Drafts to publish.
          </span>
        </div>
      ) : null}
      {error ? <ActionError message={error} onDismiss={() => setError(null)} /> : null}
    </div>
  );
}

/** Duplicate card, gated behind `duplicate_post` (Pro). */
export function DuplicatePostCard({ site, onChanged }: { site: string; onChanged?: () => void }) {
  return (
    <SectionCard title="Duplicate a post" description="Clone any post or page into a fresh draft — without opening wp-admin." icon={Hash}>
      <TierGate site={site} flag="duplicate_post">
        <DuplicateForm site={site} onChanged={onChanged} />
      </TierGate>
    </SectionCard>
  );
}
