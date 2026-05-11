import { Sparkles, FileText} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";

interface Release {
  version: string;
  date: string;
  highlights?: string;
  changes: { type: "feature" | "fix" | "improvement" | "breaking"; text: string }[];
}

const RELEASES: Release[] = [
  {
    version: "0.4.0",
    date: "2025-07-01",
    highlights: "UX overhaul + 20 new automation API routes",
    changes: [
      { type: "feature", text: "Notification center with badge and dismiss" },
      { type: "feature", text: "Theme toggle: Light / Dark / System with no FOUC" },
      { type: "feature", text: "Density controls: Compact / Comfortable / Spacious" },
      { type: "feature", text: "Keyboard shortcuts modal (press ? anywhere)" },
      { type: "feature", text: "Auto-refresh control bar on every data page" },
      { type: "feature", text: "Breadcrumb navigation in dashboard layout" },
      { type: "feature", text: "Export button (CSV / JSON) on tables" },
      { type: "feature", text: "Bookmark pages for quick access" },
      { type: "feature", text: "Onboarding wizard for new users" },
      { type: "feature", text: "Namespace CPU / Memory usage widget on dashboard" },
      { type: "feature", text: "Log level filter (ALL / ERROR / WARN / INFO) + copy per line" },
      { type: "feature", text: "Restart app button on AppCard" },
      { type: "feature", text: "SSE log streaming via /api/logs/stream" },
      { type: "feature", text: "Pod delete API (admin)" },
      { type: "feature", text: "Deployment scale API (GET + PATCH)" },
      { type: "feature", text: "Node cordon / uncordon API" },
      { type: "feature", text: "Node drain with pod eviction" },
      { type: "feature", text: "Namespace rolling restart" },
      { type: "feature", text: "Namespace cleanup (evicted pods + completed jobs)" },
      { type: "feature", text: "CronJob manual trigger" },
      { type: "feature", text: "ArgoCD hard refresh, diff, rollback" },
      { type: "feature", text: "ExternalSecret force sync" },
      { type: "feature", text: "Velero backup trigger" },
      { type: "feature", text: "OpenBao/Vault unseal via API" },
      { type: "feature", text: "cert-manager certificate renewal" },
      { type: "feature", text: "Longhorn PVC snapshot creation" },
      { type: "feature", text: "Discord test alert webhook" },
      { type: "feature", text: "ArgoCD hot-reload (config/reload)" },
      { type: "improvement", text: "Enhanced error boundary with stack trace, copy, and Go Home" },
      { type: "improvement", text: "Settings page now has ThemeToggle and DensityToggle cards" },
      { type: "improvement", text: "Sidebar Changelog entry added" },
    ],
  },
  {
    version: "0.3.0",
    date: "2025-06-01",
    changes: [
      { type: "feature", text: "ArgoCD sync-all and per-app delete" },
      { type: "feature", text: "Cluster nodes page with health status" },
      { type: "feature", text: "Cluster health API endpoint" },
      { type: "improvement", text: "Command palette with fuzzy search" },
      { type: "fix", text: "Session expiry no longer silently fails — redirects to sign in" },
    ],
  },
  {
    version: "0.2.0",
    date: "2025-05-01",
    changes: [
      { type: "feature", text: "Pod logs viewer with namespace / pod / container selectors" },
      { type: "feature", text: "Apps page with health dots and hover previews" },
      { type: "feature", text: "Settings with refresh interval and compact mode" },
      { type: "improvement", text: "Role-based access: admin / operator / viewer" },
    ],
  },
];

const typeStyles: Record<string, string> = {
  feature: "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30",
  fix: "bg-red-500/20 text-red-300 border border-red-500/30",
  improvement: "bg-blue-500/20 text-blue-300 border border-blue-500/30",
  breaking: "bg-orange-500/20 text-orange-300 border border-orange-500/30",
};

const typeLabel: Record<string, string> = {
  feature: "Feature",
  fix: "Fix",
  improvement: "Improvement",
  breaking: "Breaking",
};

export default function ChangelogPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <PageHeader icon={FileText} title="Changelog" />
      <div className="flex items-center gap-3 mb-10">
        <Sparkles className="w-6 h-6 text-indigo-400" />
        <h1 className="text-2xl font-bold text-white">What&apos;s New</h1>
      </div>

      <div className="space-y-12">
        {RELEASES.map((release) => (
          <div key={release.version} className="relative pl-6 border-l border-white/10">
            <div className="absolute -left-1.5 top-0 w-3 h-3 rounded-full bg-indigo-500 ring-2 ring-neutral-950" />
            <div className="mb-4">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-lg font-semibold text-white">v{release.version}</span>
                <span className="text-xs text-white/30">{release.date}</span>
                {release.highlights && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                    {release.highlights}
                  </span>
                )}
              </div>
            </div>
            <ul className="space-y-2">
              {release.changes.map((change, i) => (
                <li key={i} className="flex items-start gap-2.5">
                  <span className={`shrink-0 text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded mt-0.5 ${typeStyles[change.type]}`}>
                    {typeLabel[change.type]}
                  </span>
                  <span className="text-sm text-white/70 leading-relaxed">{change.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
