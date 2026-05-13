"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { fetchJson } from "./utils";

interface NotesTagsEditorProps {
  serverName: string;
  notes: string;
  tags: string[];
  onSaved: () => void;
}

export function NotesTagsEditor({
  serverName,
  notes,
  tags,
  onSaved,
}: NotesTagsEditorProps) {
  const [notesValue, setNotesValue] = useState(notes);
  const [tagsValue, setTagsValue] = useState(tags);
  const [tagInput, setTagInput] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [savingTags, setSavingTags] = useState(false);

  useEffect(() => {
    setNotesValue(notes);
  }, [notes]);

  useEffect(() => {
    setTagsValue(tags);
  }, [tags]);

  async function saveNotes(nextNotes: string) {
    setSavingNotes(true);
    try {
      await fetchJson(`/api/game-hub/servers/${serverName}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update-notes", notes: nextNotes }),
      });
      toast.success("Notes saved");
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingNotes(false);
    }
  }

  async function saveTags(nextTags: string[]) {
    setSavingTags(true);
    try {
      await fetchJson(`/api/game-hub/servers/${serverName}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update-tags", tags: nextTags }),
      });
      setTagsValue(nextTags);
      toast.success(nextTags.length > 0 ? "Tags saved" : "Tags cleared");
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingTags(false);
    }
  }

  function addTag() {
    const nextTag = tagInput.trim();
    if (!nextTag) return;
    const nextTags = [...new Set([...tagsValue, nextTag])];
    if (nextTags.length === tagsValue.length) {
      toast.error("That tag already exists");
      return;
    }
    setTagInput("");
    void saveTags(nextTags);
  }

  function removeTag(tag: string) {
    void saveTags(tagsValue.filter((entry) => entry !== tag));
  }

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-4">
      <div>
        <h3 className="text-sm font-medium text-[#f2f2f2]">Notes & Tags</h3>
        <p className="text-xs text-[#888]">Quick metadata for admins and operators.</p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <label className="text-xs font-medium uppercase tracking-wide text-[#888]">
            Notes
          </label>
          {savingNotes ? (
            <span className="inline-flex items-center gap-1 text-xs text-[#888]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
            </span>
          ) : null}
        </div>
        <textarea
          value={notesValue}
          onChange={(event) => setNotesValue(event.target.value)}
          onBlur={() => {
            if (notesValue !== notes) void saveNotes(notesValue);
          }}
          rows={5}
          placeholder="Add notes about this server, connection info, or admin context…"
          className="w-full rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] p-3 text-sm text-[#f2f2f2] focus:border-[#0078D4] focus:outline-none"
        />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <label className="text-xs font-medium uppercase tracking-wide text-[#888]">
            Tags
          </label>
          {savingTags ? (
            <span className="inline-flex items-center gap-1 text-xs text-[#888]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
            </span>
          ) : null}
        </div>
        <div className="rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] p-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            {tagsValue.length === 0 ? (
              <span className="text-sm text-[#555]">No tags yet.</span>
            ) : (
              tagsValue.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full border border-[#0078D4]/30 bg-[#0078D4]/10 px-2.5 py-1 text-xs text-[#7cc2ff]"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    disabled={savingTags}
                    className="text-[#9dd4ff] transition hover:text-white disabled:opacity-50"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))
            )}
          </div>
          <div className="flex gap-2">
            <input
              value={tagInput}
              onChange={(event) => setTagInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addTag();
                }
              }}
              placeholder="Add a tag"
              className="flex-1 rounded-lg border border-[#2a2a2a] bg-[#111] px-3 py-2 text-sm text-[#f2f2f2] focus:border-[#0078D4] focus:outline-none"
            />
            <button
              type="button"
              onClick={addTag}
              disabled={!tagInput.trim() || savingTags}
              className="inline-flex items-center gap-2 rounded-lg border border-[#2a2a2a] px-3 py-2 text-sm text-[#f2f2f2] disabled:opacity-50"
            >
              <Plus className="h-4 w-4" /> Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
