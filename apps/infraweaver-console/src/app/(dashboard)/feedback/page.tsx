import { headers } from "next/headers";
import { ShieldAlert } from "lucide-react";
import { PageScaffold } from "@/components/ui/page-scaffold";
import { FeedbackReview } from "@/components/feedback/feedback-review";
import { feedbackDashboardHost, isFeedbackHost } from "@/lib/feedback-host";

/**
 * Server entry for the feedback review dashboard. The console image is reused
 * for ephemeral preview deployments, so this surface is host-gated: the review
 * UI (and its mutating APIs) are only available on the canonical console host
 * (FEEDBACK_DASHBOARD_HOST). On a preview host we render a notice instead, so an
 * approval/publish can never be triggered from inside a preview.
 */
export default async function FeedbackPage() {
  const headerList = await headers();

  if (!isFeedbackHost(headerList)) {
    return (
      <PageScaffold title="Developer Feedback" subtitle="Review">
        <div className="flex flex-col items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-8 text-center dark:border-amber-500/30 dark:bg-amber-500/10">
          <ShieldAlert className="h-8 w-8 text-amber-500" />
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
            The feedback review dashboard is only available on the canonical console host.
          </p>
          <p className="max-w-md text-xs text-amber-600/80 dark:text-amber-300/70">
            Open <span className="font-mono">{feedbackDashboardHost()}</span> to approve, accept, or publish changes.
            The report button stays available everywhere.
          </p>
        </div>
      </PageScaffold>
    );
  }

  return <FeedbackReview />;
}
