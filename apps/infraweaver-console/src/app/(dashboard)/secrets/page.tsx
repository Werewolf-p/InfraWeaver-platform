"use client";

import { KeyRound, Clock, ShieldCheck } from "lucide-react";
import { TabHub } from "@/components/layout/tab-hub";
import { SecretsView } from "./view";
import { SecretExpiryView } from "../secret-expiry/view";
import { CertificatesView } from "../certificates/view";

export default function SecretsPage() {
  return (
    <TabHub
      basePath="/secrets"
      tabs={[
        { value: "secrets", label: "Secrets", icon: KeyRound, Component: SecretsView },
        { value: "expiry", label: "Expiry", icon: Clock, Component: SecretExpiryView },
        { value: "certificates", label: "Certificates", icon: ShieldCheck, Component: CertificatesView },
      ]}
    />
  );
}
