"use client";

import { GitBranch, GitCompare } from "lucide-react";
import { TabHub } from "@/components/layout/tab-hub";
import { GitopsDiffView } from "./view";
import { DeploymentCompareView } from "../deployment-compare/view";

// Consolidated Compare hub — GitOps Diff (live-vs-git) is the bare first tab so
// /gitops-diff stays the canonical Compare home. Deploy Compare (A-vs-B) is a
// drill-down tab; /deployment-compare redirects to ?tab=deploy. Each tab renders
// the original page's extracted view (./view + ../deployment-compare/view).
export default function ComparePage() {
  return (
    <TabHub
      basePath="/gitops-diff"
      tabs={[
        { value: "gitops", label: "GitOps Diff", icon: GitBranch, Component: GitopsDiffView },
        { value: "deploy", label: "Deploy Compare", icon: GitCompare, Component: DeploymentCompareView },
      ]}
    />
  );
}
