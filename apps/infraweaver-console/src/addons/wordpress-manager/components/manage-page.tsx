"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SiteTabs } from "./site-tabs";
import { ManageView } from "./demo/manage/manage-view";

/**
 * Per-site "Manage" page shell. Mirrors the Overview / Connector page chrome
 * (back-link → title → SiteTabs) and hosts the ManageView console. Every panel
 * inside ManageView reads the site's live state over the secure in-pod wp-cli path
 * and every write control dispatches a real allow-listed Manage action — there is
 * no dummy data or no-op control on this surface.
 */
export function ManagePage({ site }: { site: string }) {
  return (
    <div className="w-full px-4 py-8 sm:px-6 lg:px-8">
      <Link href="/wordpress" className="inline-flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200">
        <ArrowLeft className="h-4 w-4" aria-hidden /> All sites
      </Link>

      <header className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">{site}</h1>
      </header>

      <SiteTabs site={site} active="manage" />

      <ManageView site={site} />
    </div>
  );
}
