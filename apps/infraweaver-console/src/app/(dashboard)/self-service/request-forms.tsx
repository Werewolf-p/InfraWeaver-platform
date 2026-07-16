"use client";

import { useMemo, useState } from "react";
import { HardDrive, KeyRound, Send } from "lucide-react";
import { SettingsCard, Select } from "@/components/ui";
import { useApiMutation, useApiQuery } from "@/hooks";
import { queryKeys } from "@/lib/query-keys";
import { queryStaleTimes } from "@/lib/query-defaults";
import {
  RESOURCE_TYPES,
  resourceTypeById,
  rolesForResource,
  gameServerInstanceScope,
  wordpressSiteScope,
  type ResourceType,
  type ResourceTypeId,
} from "../rbac/resources";
import type { OwnedPvcOption } from "@/lib/self-service/owned-pvcs";
import type { SelfServiceRequest } from "@/lib/self-service/types";

interface SubmitResponse {
  request: SelfServiceRequest;
  recoveryLink?: string;
  error?: string;
}

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 dark:border-white/10 bg-white dark:bg-white/5 px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/40";

const REASON_CLASS = `${INPUT_CLASS} min-h-[64px] resize-y`;

/** Compose the concrete scope for an instance-based resource type. */
function composeScope(resource: ResourceType, instanceName: string): string {
  const name = instanceName.trim();
  if (resource.instance === "game-server" && name) return gameServerInstanceScope(name);
  if (resource.instance === "wordpress" && name) return wordpressSiteScope(name);
  return resource.allScope;
}

function useSubmitRequest(onDone: (data: SubmitResponse) => void) {
  return useApiMutation<SubmitResponse, Record<string, unknown>>({
    path: "/api/self-service/requests",
    method: "POST",
    invalidateQueryKeys: [queryKeys.selfService.mine()],
    successMessage: (data) =>
      data.request.status === "auto-applied" ? "Applied immediately — within your access" : "Request submitted for approval",
    errorMessage: (error) => error.message || "Failed to submit request",
    onSuccess: async (data) => onDone(data),
  });
}

export function AppAccessForm() {
  const [resourceId, setResourceId] = useState<ResourceTypeId>("cluster");
  const [roleId, setRoleId] = useState("");
  const [instanceName, setInstanceName] = useState("");
  const [reason, setReason] = useState("");

  const resource = resourceTypeById(resourceId);
  const roles = useMemo(() => rolesForResource(resource), [resource]);
  const effectiveRoleId = roleId || roles[0]?.id || "";
  const needsInstance = resource.instance === "game-server" || resource.instance === "wordpress";
  const scope = composeScope(resource, instanceName);

  const submit = useSubmitRequest(() => {
    setReason("");
    setInstanceName("");
  });

  const disabled = !effectiveRoleId || submit.isPending || (needsInstance && !instanceName.trim());

  return (
    <SettingsCard title="Request app access" description="Ask for a role at a scope. Granted instantly if it is within your own access, otherwise routed to an admin." icon={KeyRound}>
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs text-slate-500">Resource</span>
          <Select value={resourceId} onChange={(event) => { setResourceId(event.target.value as ResourceTypeId); setRoleId(""); }}>
            {RESOURCE_TYPES.map((type) => (
              <option key={type.id} value={type.id}>{type.label}</option>
            ))}
          </Select>
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-slate-500">Role</span>
          <Select value={effectiveRoleId} onChange={(event) => setRoleId(event.target.value)}>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>{role.name}</option>
            ))}
          </Select>
        </label>

        {needsInstance ? (
          <label className="block space-y-1">
            <span className="text-xs text-slate-500">{resource.instance === "game-server" ? "Server name" : "Site name"}</span>
            <input className={INPUT_CLASS} value={instanceName} onChange={(event) => setInstanceName(event.target.value)} placeholder={resource.instance === "game-server" ? "valheim" : "blog"} />
          </label>
        ) : null}

        <p className="text-xs text-slate-500">Scope: <code className="text-slate-700 dark:text-slate-300">{scope}</code></p>

        <label className="block space-y-1">
          <span className="text-xs text-slate-500">Reason (optional)</span>
          <textarea className={REASON_CLASS} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why do you need this access?" maxLength={500} />
        </label>

        <button
          type="button"
          disabled={disabled}
          onClick={() => submit.mutate({ type: "app-access", reason: reason.trim() || undefined, payload: { roleId: effectiveRoleId, scope } })}
          className="touch-target inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
        >
          <Send className="h-4 w-4" /> Submit request
        </button>
      </div>
    </SettingsCard>
  );
}

export function StorageQuotaForm() {
  const [pvcKey, setPvcKey] = useState("");
  const [requestedSize, setRequestedSize] = useState("");
  const [reason, setReason] = useState("");

  const pvcsQuery = useApiQuery<{ pvcs: OwnedPvcOption[] }>({
    queryKey: queryKeys.selfService.ownedPvcs(),
    path: "/api/self-service/owned-pvcs",
    staleTime: queryStaleTimes.minute,
  });
  const pvcs = pvcsQuery.data?.pvcs ?? [];
  const selected = pvcs.find((pvc) => `${pvc.namespace}/${pvc.name}` === pvcKey) ?? pvcs[0];

  const submit = useSubmitRequest(() => {
    setRequestedSize("");
    setReason("");
  });

  const sizeValid = /^\d+(?:\.\d+)?(?:Ki|Mi|Gi|Ti|Pi)$/.test(requestedSize.trim());
  const disabled = !selected || !sizeValid || submit.isPending;

  if (!pvcsQuery.isLoading && pvcs.length === 0) {
    return (
      <SettingsCard title="Request storage quota" description="Ask an admin to expand a volume assigned to you." icon={HardDrive}>
        <p className="text-sm text-slate-500">You have no volumes assigned. Storage quota requests apply to your own PVCs only.</p>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard title="Request storage quota" description="Expanding a PVC needs cluster-admin, so this always routes to an admin — bounded to your own volumes." icon={HardDrive}>
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs text-slate-500">Volume</span>
          <Select value={selected ? `${selected.namespace}/${selected.name}` : ""} onChange={(event) => setPvcKey(event.target.value)}>
            {pvcs.map((pvc) => (
              <option key={`${pvc.namespace}/${pvc.name}`} value={`${pvc.namespace}/${pvc.name}`}>
                {pvc.provider}:{pvc.share}{pvc.subfolder ? `/${pvc.subfolder}` : ""} ({pvc.namespace}/{pvc.name})
              </option>
            ))}
          </Select>
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-slate-500">Requested size (e.g. 20Gi)</span>
          <input className={INPUT_CLASS} value={requestedSize} onChange={(event) => setRequestedSize(event.target.value)} placeholder="20Gi" />
          {requestedSize && !sizeValid ? <span className="text-xs text-red-500">Use a Kubernetes size like 20Gi or 500Mi</span> : null}
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-slate-500">Reason (optional)</span>
          <textarea className={REASON_CLASS} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why do you need more space?" maxLength={500} />
        </label>

        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            selected &&
            submit.mutate({
              type: "storage-quota",
              reason: reason.trim() || undefined,
              payload: { namespace: selected.namespace, pvcName: selected.name, scope: selected.scope, requestedSize: requestedSize.trim() },
            })
          }
          className="touch-target inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
        >
          <Send className="h-4 w-4" /> Submit request
        </button>
      </div>
    </SettingsCard>
  );
}
