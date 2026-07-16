"use client";

import { useState } from "react";
import { Sprout } from "lucide-react";
import { ConfirmDialog } from "@/components/ui";
import { useApiMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import type { CatalogCoverage } from "@/lib/secrets/lifecycle-types";

export interface CatalogCoverageTableProps {
  items: CatalogCoverage[];
  canRemediate: boolean;
  /** SECRET_REMEDIATION_WRITE_ENABLED — re-seed buttons only render when true. */
  writeEnabled: boolean;
}

interface ReseedTarget {
  app: string;
  path: string;
  key: string;
}

export function CatalogCoverageTable({ items, canRemediate, writeEnabled }: CatalogCoverageTableProps) {
  const [reseedTarget, setReseedTarget] = useState<ReseedTarget | null>(null);

  const reseed = useApiMutation<{ ok: boolean }, ReseedTarget>({
    path: "/api/secrets/lifecycle/reseed-key",
    request: (vars) => ({ json: vars }),
    successMessage: (_, vars) => `Reseeded ${vars.key}`,
    invalidateQueryKeys: [queryKeys.secrets.lifecycle()],
    onSuccess: () => setReseedTarget(null),
  });

  if (items.length === 0) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">No enabled catalog apps declare secrets, or coverage is unavailable.</p>;
  }

  const canReseed = canRemediate && writeEnabled;

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[840px] text-sm">
          <thead className="bg-slate-100 dark:bg-slate-950/80 text-left text-xs uppercase tracking-[0.18em] text-slate-500">
            <tr>
              <th className="px-4 py-3">App</th>
              <th className="px-4 py-3">Declared</th>
              <th className="px-4 py-3">Seeded</th>
              <th className="px-4 py-3">Referenced</th>
              <th className="px-4 py-3">Missing (declared − seeded)</th>
            </tr>
          </thead>
          <tbody>
            {items.map((app) => (
              <tr key={app.app} className="border-t border-gray-200 dark:border-white/5 align-top">
                <td className="px-4 py-4">
                  <p className="font-medium text-gray-900 dark:text-white">{app.app}</p>
                  <p className="mt-1 text-xs font-mono text-slate-500">{app.path}</p>
                  {app.undeclaredReferencedKeys.length > 0 ? (
                    <p className="mt-1.5 text-[11px] text-orange-300">
                      Referenced but undeclared: {app.undeclaredReferencedKeys.join(", ")}
                    </p>
                  ) : null}
                </td>
                <td className="px-4 py-4 text-slate-600 dark:text-slate-300">{app.declaredKeys.length}</td>
                <td className="px-4 py-4 text-slate-600 dark:text-slate-300">{app.seededKeys.length}</td>
                <td className="px-4 py-4 text-slate-600 dark:text-slate-300">{app.referencedKeys.length}</td>
                <td className="px-4 py-4">
                  {app.missingKeys.length === 0 ? (
                    <span className="rounded-full border border-green-500/20 bg-green-500/10 px-2 py-0.5 text-xs font-semibold text-green-400">Complete</span>
                  ) : (
                    <div className="flex max-w-md flex-wrap gap-1.5">
                      {app.missingKeys.map((key) => (
                        <span key={key} className="inline-flex items-center gap-1.5 rounded-full border border-orange-500/20 bg-orange-500/10 px-2 py-0.5 text-xs font-mono text-orange-300">
                          {key}
                          {canReseed ? (
                            <button
                              type="button"
                              onClick={() => setReseedTarget({ app: app.app, path: app.path, key })}
                              className="inline-flex items-center gap-0.5 text-cyan-300 hover:text-cyan-200"
                              title={`Re-seed ${key}`}
                            >
                              <Sprout className="h-3 w-3" aria-hidden="true" />
                              seed
                            </button>
                          ) : null}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={Boolean(reseedTarget)}
        onConfirm={() => reseedTarget ? reseed.mutate(reseedTarget) : undefined}
        onCancel={() => setReseedTarget(null)}
        title={reseedTarget ? `Re-seed ${reseedTarget.key}?` : "Re-seed key?"}
        description="Generates and writes this catalog-declared key into OpenBao (existing keys are preserved, never overwritten). The value is never shown."
        confirmText={reseed.isPending ? "Seeding…" : "Re-seed key"}
        danger
        requireTyping={reseedTarget?.key}
      />
    </div>
  );
}
