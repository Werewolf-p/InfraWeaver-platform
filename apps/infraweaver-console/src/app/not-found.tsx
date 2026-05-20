import Link from "next/link";
import { Compass, Home, Search } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 dark:bg-slate-950 px-6 text-gray-900 dark:text-white">
      <div className="w-full max-w-xl rounded-3xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-8 text-center shadow-2xl backdrop-blur">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-500/20 bg-cyan-500/10 text-cyan-200">
          <Compass className="h-7 w-7" />
        </div>
        <p className="mt-6 text-xs font-semibold uppercase tracking-[0.35em] text-slate-500">404 · Page not found</p>
        <h1 className="mt-3 text-3xl font-semibold text-gray-900 dark:text-white">We couldn&apos;t find that page</h1>
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          Try going back home, open the DNS manager, or search from the dashboard command palette.
        </p>

        <div className="mt-6 grid gap-3 text-left sm:grid-cols-3">
          <Link href="/home" className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/70 p-4 transition hover:border-cyan-500/30 hover:bg-cyan-500/5">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-white">
              <Home className="h-4 w-4 text-cyan-200" />
              Go home
            </div>
            <p className="mt-2 text-xs text-slate-500">Jump back to the InfraWeaver home portal.</p>
          </Link>
          <Link href="/dns" className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/70 p-4 transition hover:border-emerald-500/30 hover:bg-emerald-500/5">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-white">
              <Search className="h-4 w-4 text-emerald-200" />
              Open DNS
            </div>
            <p className="mt-2 text-xs text-slate-500">Manage internal and public hostnames.</p>
          </Link>
          <Link href="/game-hub" className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/70 p-4 transition hover:border-violet-500/30 hover:bg-violet-500/5">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-white">
              <Compass className="h-4 w-4 text-violet-200" />
              Browse Game Hub
            </div>
            <p className="mt-2 text-xs text-slate-500">Open recent game servers and quick actions.</p>
          </Link>
        </div>
      </div>
    </div>
  );
}
