"use client";

import { useState } from "react";
import { HandHelping, HardDrive, KeyRound, UserCircle } from "lucide-react";
import { PageScaffold, SectionTabs } from "@/components/ui";
import { AppAccessForm, StorageQuotaForm } from "./request-forms";
import { ProfileSection } from "./profile-section";
import { MyRequests } from "./my-requests";

type SelfServiceTab = "access" | "storage" | "profile";

const TABS = [
  { value: "access", label: "Request access", icon: KeyRound },
  { value: "storage", label: "Storage quota", icon: HardDrive },
  { value: "profile", label: "Profile & security", icon: UserCircle },
] as const;

/**
 * Self-service front door — visible to every authenticated user (no
 * NAV_REQUIREMENTS entry). Each request is applied instantly when within the
 * user's own access, or routed to the admin approval queue. The RBAC ceiling is
 * enforced server-side (see lib/self-service/evaluate.ts), never here.
 */
export default function SelfServicePage() {
  const [tab, setTab] = useState<SelfServiceTab>("access");

  return (
    <PageScaffold
      icon={HandHelping}
      title="Self-Service"
      description="Request app access or storage quota, reset your password, and update your profile — with RBAC guardrails."
      className="max-w-3xl"
    >
      <div className="space-y-5">
        <SectionTabs tabs={TABS.map(({ value, label, icon }) => ({ value, label, icon }))} activeTab={tab} onTabChange={(value) => setTab(value as SelfServiceTab)} />

        {tab === "access" ? <AppAccessForm /> : null}
        {tab === "storage" ? <StorageQuotaForm /> : null}
        {tab === "profile" ? <ProfileSection /> : null}

        <MyRequests />
      </div>
    </PageScaffold>
  );
}
