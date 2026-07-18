import { WordpressView } from "./view";

// The WordPress addon nav entry lands here directly. Rendering the dashboard in
// place (instead of redirecting to /workloads?tab=wordpress) avoids the visible
// flash where the Workloads hub painted its default "Apps" tab for a beat before
// the ?tab=wordpress query resolved. The Workloads hub still hosts a WordPress
// tab; detail routes (/wordpress/[site]) are unchanged.
export default function WordpressPage() {
  return <WordpressView />;
}
