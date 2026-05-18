"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, Plus, Save, Trash2, Upload } from "lucide-react";
import { toast } from "@/lib/notify";
import { fetchJson } from "./utils";
import { useRBAC } from "@/hooks/use-rbac";

interface EnvEntry {
  name: string;
  value?: string;
}

interface EnvRow {
  id: string;
  name: string;
  value: string;
}

interface EnvTableEditorProps {
  serverName: string;
  env: EnvEntry[];
  onSave: () => void;
}

function createRow(name = "", value = ""): EnvRow {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return { id: crypto.randomUUID(), name, value };
  }
  return { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, name, value };
}

function parseEnvText(content: string) {
  return content
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .flatMap((line) => {
      const index = line.indexOf("=");
      if (index < 0) return [] as EnvRow[];
      return [createRow(line.slice(0, index).trim(), line.slice(index + 1))];
    });
}

export function EnvTableEditor({ serverName, env, onSave }: EnvTableEditorProps) {
  const { can } = useRBAC();
  const canWrite = can("game-hub:write", `/game-hub/servers/${serverName}`) || can("game-hub:admin", `/game-hub/servers/${serverName}`);
  const [rows, setRows] = useState<EnvRow[]>(() => env.map((entry) => createRow(entry.name, entry.value ?? "")));
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  useEffect(() => {
    setRows(env.map((entry) => createRow(entry.name, entry.value ?? "")));
  }, [env]);

  const envObject = useMemo(() => {
    const next: Record<string, string> = {};
    for (const row of rows) {
      const key = row.name.trim();
      if (!key) continue;
      next[key] = row.value;
    }
    return next;
  }, [rows]);

  function updateRow(id: string, field: "name" | "value", value: string) {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, [field]: value } : row)),
    );
  }

  function addRow() {
    setRows((current) => [...current, createRow()]);
  }

  function deleteRow(id: string) {
    setRows((current) => current.filter((row) => row.id !== id));
  }

  function exportEnv() {
    const content = Object.entries(envObject)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${serverName}.env`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function applyImport() {
    const importedRows = parseEnvText(importText);
    if (importedRows.length === 0) {
      toast.error("Paste at least one KEY=VALUE pair");
      return;
    }
    setRows(importedRows);
    setImportText("");
    setImportOpen(false);
    toast.success("Imported .env content");
  }

  async function saveAll() {
    if (!canWrite) {
      toast.error("You do not have permission to update environment variables");
      return;
    }
    setSaving(true);
    try {
      await fetchJson(`/api/game-hub/servers/${serverName}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update-env",
          env: envObject,
          replaceEnv: true,
        }),
      });
      toast.success("Environment variables saved");
      onSave();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4 space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h3 className="text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">Environment Variables</h3>
          <p className="text-xs text-gray-500 dark:text-[#888]">Edit env values in a spreadsheet-style table.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setImportOpen((current) => !current)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0a0a0a] px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2]"
          >
            <Upload className="h-4 w-4" /> Paste .env
          </button>
          <button
            type="button"
            onClick={exportEnv}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0a0a0a] px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2]"
          >
            <Download className="h-4 w-4" /> Export
          </button>
          <button
            type="button"
            onClick={() => void saveAll()}
            disabled={saving || !canWrite}
            className="inline-flex items-center gap-2 rounded-lg bg-[#0078D4] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save All
          </button>
        </div>
      </div>

      {importOpen ? (
        <div className="rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0a0a0a] p-3 space-y-3">
          <textarea
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            rows={8}
            placeholder="KEY=VALUE"
            className="w-full rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-3 font-mono text-sm text-gray-900 dark:text-[#f2f2f2] focus:border-[#0078D4] focus:outline-none"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={applyImport}
              className="rounded-lg bg-[#0078D4] px-3 py-2 text-sm font-medium text-white"
            >
              Apply import
            </button>
            <button
              type="button"
              onClick={() => setImportOpen(false)}
              className="rounded-lg border border-gray-200 dark:border-[#2a2a2a] px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0a0a0a]">
        <table className="min-w-full divide-y divide-[#2a2a2a] text-sm">
          <thead className="bg-white dark:bg-[#111] text-left text-xs uppercase tracking-wide text-gray-500 dark:text-[#888]">
            <tr>
              <th className="px-3 py-2">Key</th>
              <th className="px-3 py-2">Value</th>
              <th className="px-3 py-2 w-20">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#1f1f1f]">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-gray-500 dark:text-[#888]">
                  No environment variables. Add a row to begin.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-3 py-2 align-top">
                    <input
                      value={row.name}
                      onChange={(event) => updateRow(row.id, "name", event.target.value)}
                      disabled={!canWrite}
                      placeholder="KEY"
                      className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-gray-900 dark:text-[#f2f2f2] focus:border-[#2a2a2a] focus:bg-[#111] focus:outline-none"
                    />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <input
                      value={row.value}
                      onChange={(event) => updateRow(row.id, "value", event.target.value)}
                      disabled={!canWrite}
                      placeholder="VALUE"
                      className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-gray-900 dark:text-[#f2f2f2] focus:border-[#2a2a2a] focus:bg-[#111] focus:outline-none"
                    />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <button
                      type="button"
                      onClick={() => deleteRow(row.id)}
                      disabled={!canWrite}
                      className="rounded-lg p-2 text-gray-500 dark:text-[#888] transition hover:bg-red-500/10 hover:text-red-300"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <button
        type="button"
        onClick={addRow}
        disabled={!canWrite}
        className="inline-flex items-center gap-2 rounded-lg border border-dashed border-gray-200 dark:border-[#2a2a2a] px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2]"
      >
        <Plus className="h-4 w-4" /> Add row
      </button>
    </div>
  );
}
