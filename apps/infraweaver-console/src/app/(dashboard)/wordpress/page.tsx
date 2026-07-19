import { WordpressView } from "./view";

// Match the sibling detail routes (`[site]`, `[site]/connector`): opt out of
// static prerendering. The shared dashboard layout mounts `useSearchParams()`
// chrome (GlobalSearch, FloatingActionButton) with no Suspense boundary, so a
// prerendered `/wordpress` hits Next's CSR-bailout and soft-navigating here from
// a detail page renders blank. Every dashboard route is auth-gated and per-user
// anyway, so there is nothing to gain from prerendering this one.
export const dynamic = "force-dynamic";

// The WordPress addon nav entry lands here directly. Rendering the dashboard in
// place (instead of redirecting to /workloads?tab=wordpress) avoids the visible
// flash where the Workloads hub painted its default "Apps" tab for a beat before
// the ?tab=wordpress query resolved. The Workloads hub still hosts a WordPress
// tab; detail routes (/wordpress/[site]) are unchanged.
export default function WordpressPage() {
  return <WordpressView />;
}
