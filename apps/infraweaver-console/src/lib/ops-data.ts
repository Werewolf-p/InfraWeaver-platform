import { X509Certificate } from "crypto";
import { makeBatchApi, makeCoreApi, makeCustomApi } from "@/lib/kube-client";
import { nextCronRun } from "@/lib/cron-utils";

export interface ClusterEventItem {
  id: string;
  name: string;
  namespace: string;
  reason: string;
  message: string;
  type: string;
  level: "info" | "warning" | "error";
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  involvedObject: {
    kind: string;
    name: string;
  };
  sourceComponent: string | null;
}

export interface ClusterEventPayload {
  events: ClusterEventItem[];
  live: boolean;
  summary: {
    total: number;
    warnings: number;
    errors: number;
    namespaces: number;
  };
}

export interface CertificateItem {
  id: string;
  name: string;
  namespace: string;
  secretName: string | null;
  commonName: string | null;
  dnsNames: string[];
  issuerRef: string | null;
  ready: boolean;
  valid: boolean;
  status: string;
  reason: string | null;
  notAfter: string | null;
  renewalTime: string | null;
  daysLeft: number | null;
  revision: number | null;
  source: "cert-manager" | "tls-secret";
}

export interface CertificatePayload {
  certs: CertificateItem[];
  live: boolean;
  summary: {
    total: number;
    ready: number;
    expiringSoon: number;
    renewalDue: number;
  };
}

export interface CronJobRunItem {
  name: string;
  status: "running" | "succeeded" | "failed" | "unknown";
  startedAt: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
}

export interface CronJobItem {
  id: string;
  namespace: string;
  name: string;
  schedule: string;
  suspended: boolean;
  active: number;
  image: string;
  concurrencyPolicy: string | null;
  lastSchedule: string | null;
  nextRun: string | null;
  lastSuccess: string | null;
  lastFailure: string | null;
  failing: boolean;
  recentJobs: CronJobRunItem[];
}

export interface CronJobPayload {
  cronjobs: CronJobItem[];
  live: boolean;
  summary: {
    total: number;
    active: number;
    suspended: number;
    failing: number;
  };
}

export interface IngressRouteItem {
  id: string;
  namespace: string;
  name: string;
  entryPoints: string[];
  hosts: string[];
  services: string[];
  middlewares: string[];
  authMiddlewares: string[];
  tlsSecretName: string | null;
  certResolver: string | null;
  hasTls: boolean;
}

export interface IngressRoutePayload {
  ingressRoutes: IngressRouteItem[];
  live: boolean;
  summary: {
    total: number;
    authProtected: number;
    tlsEnabled: number;
    hosts: number;
  };
}

const EVENT_ERROR_RE = /backoff|crash|error|evict|fail|imagepull|mount|oom|schedule|unhealthy/i;
const AUTH_MIDDLEWARE_RE = /auth|forward|oauth|oidc|sso|login/i;

function toIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "object" && value && "toISOString" in value && typeof (value as { toISOString?: unknown }).toISOString === "function") {
    return ((value as { toISOString: () => string }).toISOString());
  }
  return null;
}

function pickTimestamp(...values: unknown[]) {
  for (const value of values) {
    const iso = toIso(value);
    if (iso) return iso;
  }
  return null;
}

function compareTimestampDesc(left: string | null, right: string | null) {
  return new Date(right ?? 0).getTime() - new Date(left ?? 0).getTime();
}

function daysUntil(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor((date.getTime() - Date.now()) / 86_400_000);
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)).map((value) => value.trim()).filter(Boolean)));
}

function hostnamesFromMatch(match: string | undefined) {
  if (!match) return [] as string[];
  const values = new Set<string>();
  const patterns = [/Host\(`([^`]+)`\)/g, /HostSNI\(`([^`]+)`\)/g];
  for (const pattern of patterns) {
    for (const entry of match.matchAll(pattern)) {
      if (entry[1]) values.add(entry[1]);
    }
  }
  return Array.from(values);
}

function levelForEvent(type: string | undefined, reason: string | undefined, message: string | undefined) {
  if ((type ?? "Normal") !== "Warning") return "info" as const;
  return EVENT_ERROR_RE.test(`${reason ?? ""} ${message ?? ""}`) ? "error" as const : "warning" as const;
}

function extractSubjectValue(subject: string | undefined, key: string) {
  if (!subject) return null;
  const match = subject.match(new RegExp(`${key}=([^,]+)`));
  return match?.[1] ?? null;
}

function extractDnsNames(subjectAltName: string | undefined) {
  if (!subjectAltName) return [] as string[];
  return Array.from(subjectAltName.matchAll(/DNS:([^,]+)/g)).map((match) => match[1]?.trim()).filter((value): value is string => Boolean(value));
}

function buildEventSummary(events: ClusterEventItem[]) {
  return {
    total: events.length,
    warnings: events.filter((event) => event.type === "Warning").length,
    errors: events.filter((event) => event.level === "error").length,
    namespaces: new Set(events.map((event) => event.namespace)).size,
  };
}

function buildCertificateSummary(certs: CertificateItem[]) {
  return {
    total: certs.length,
    ready: certs.filter((cert) => cert.ready).length,
    expiringSoon: certs.filter((cert) => cert.daysLeft !== null && cert.daysLeft <= 30).length,
    renewalDue: certs.filter((cert) => cert.renewalTime && new Date(cert.renewalTime).getTime() <= Date.now() + 7 * 86_400_000).length,
  };
}

function buildCronSummary(cronjobs: CronJobItem[]) {
  return {
    total: cronjobs.length,
    active: cronjobs.filter((cronjob) => !cronjob.suspended).length,
    suspended: cronjobs.filter((cronjob) => cronjob.suspended).length,
    failing: cronjobs.filter((cronjob) => cronjob.failing).length,
  };
}

function buildIngressSummary(routes: IngressRouteItem[]) {
  return {
    total: routes.length,
    authProtected: routes.filter((route) => route.authMiddlewares.length > 0).length,
    tlsEnabled: routes.filter((route) => route.hasTls).length,
    hosts: new Set(routes.flatMap((route) => route.hosts)).size,
  };
}





export async function loadClusterEvents(limit = 250): Promise<ClusterEventPayload> {
  try {
    const coreApi = makeCoreApi();
    const response = await coreApi.listEventForAllNamespaces();
    const items = ((response as { items?: unknown[] }).items ?? [])
      .map((item) => {
        const event = item as {
          metadata?: { uid?: string; name?: string; namespace?: string; creationTimestamp?: string | Date };
          reason?: string;
          message?: string;
          type?: string;
          count?: number;
          firstTimestamp?: string | Date;
          lastTimestamp?: string | Date;
          eventTime?: string | Date;
          source?: { component?: string };
          involvedObject?: { kind?: string; name?: string };
          reportingController?: string;
        };
        const lastSeen = pickTimestamp(event.lastTimestamp, event.eventTime, event.metadata?.creationTimestamp);
        return {
          id: event.metadata?.uid ?? `${event.metadata?.namespace ?? "default"}/${event.metadata?.name ?? event.reason ?? "event"}/${lastSeen ?? "now"}`,
          name: event.metadata?.name ?? event.reason ?? "event",
          namespace: event.metadata?.namespace ?? "default",
          reason: event.reason ?? "Unknown",
          message: event.message ?? "",
          type: event.type ?? "Normal",
          level: levelForEvent(event.type, event.reason, event.message),
          count: event.count ?? 1,
          firstSeen: pickTimestamp(event.firstTimestamp, event.metadata?.creationTimestamp),
          lastSeen,
          involvedObject: {
            kind: event.involvedObject?.kind ?? "Object",
            name: event.involvedObject?.name ?? "unknown",
          },
          sourceComponent: event.source?.component ?? event.reportingController ?? null,
        } satisfies ClusterEventItem;
      })
      .sort((left, right) => compareTimestampDesc(left.lastSeen, right.lastSeen))
      .slice(0, limit);

    return { events: items, live: true, summary: buildEventSummary(items) };
  } catch {
    return { events: [], live: false, summary: buildEventSummary([]) };
  }
}

async function loadSecretBackedCertificates(): Promise<CertificateItem[]> {
  const coreApi = makeCoreApi();
  const response = await coreApi.listSecretForAllNamespaces();
  const items = ((response as { items?: unknown[] }).items ?? [])
    .filter((item) => (item as { type?: string }).type === "kubernetes.io/tls")
    .map((item) => {
      const secret = item as {
        metadata?: { name?: string; namespace?: string; annotations?: Record<string, string> };
        data?: Record<string, string>;
      };
      const crt = secret.data?.["tls.crt"];
      if (!crt) {
        return {
          id: `${secret.metadata?.namespace ?? "default"}/${secret.metadata?.name ?? "unknown"}`,
          name: secret.metadata?.name ?? "unknown",
          namespace: secret.metadata?.namespace ?? "default",
          secretName: secret.metadata?.name ?? null,
          commonName: null,
          dnsNames: [],
          issuerRef: secret.metadata?.annotations?.["cert-manager.io/issuer"] ?? secret.metadata?.annotations?.["cert-manager.io/cluster-issuer"] ?? null,
          ready: false,
          valid: false,
          status: "Missing certificate data",
          reason: "tls.crt missing",
          notAfter: null,
          renewalTime: null,
          daysLeft: null,
          revision: null,
          source: "tls-secret",
        } satisfies CertificateItem;
      }

      try {
        const cert = new X509Certificate(Buffer.from(crt, "base64"));
        const notAfter = toIso(cert.validTo);
        const dnsNames = extractDnsNames(cert.subjectAltName);
        const commonName = extractSubjectValue(cert.subject, "CN") ?? dnsNames[0] ?? null;
        return {
          id: `${secret.metadata?.namespace ?? "default"}/${secret.metadata?.name ?? "unknown"}`,
          name: secret.metadata?.annotations?.["cert-manager.io/certificate-name"] ?? secret.metadata?.name ?? "unknown",
          namespace: secret.metadata?.namespace ?? "default",
          secretName: secret.metadata?.name ?? null,
          commonName,
          dnsNames,
          issuerRef: secret.metadata?.annotations?.["cert-manager.io/issuer-kind"] && secret.metadata?.annotations?.["cert-manager.io/issuer-name"]
            ? `${secret.metadata.annotations["cert-manager.io/issuer-kind"]}/${secret.metadata.annotations["cert-manager.io/issuer-name"]}`
            : secret.metadata?.annotations?.["cert-manager.io/cluster-issuer"]
              ? `ClusterIssuer/${secret.metadata.annotations["cert-manager.io/cluster-issuer"]}`
              : secret.metadata?.annotations?.["cert-manager.io/issuer"]
                ? `Issuer/${secret.metadata.annotations["cert-manager.io/issuer"]}`
                : null,
          ready: true,
          valid: true,
          status: daysUntil(notAfter) !== null && (daysUntil(notAfter) ?? 999) <= 14 ? "Expiring Soon" : "Ready",
          reason: null,
          notAfter,
          renewalTime: null,
          daysLeft: daysUntil(notAfter),
          revision: null,
          source: "tls-secret",
        } satisfies CertificateItem;
      } catch {
        return {
          id: `${secret.metadata?.namespace ?? "default"}/${secret.metadata?.name ?? "unknown"}`,
          name: secret.metadata?.name ?? "unknown",
          namespace: secret.metadata?.namespace ?? "default",
          secretName: secret.metadata?.name ?? null,
          commonName: null,
          dnsNames: [],
          issuerRef: null,
          ready: false,
          valid: false,
          status: "Unreadable certificate",
          reason: "Unable to parse tls.crt",
          notAfter: null,
          renewalTime: null,
          daysLeft: null,
          revision: null,
          source: "tls-secret",
        } satisfies CertificateItem;
      }
    });

  return items.sort((left, right) => (left.daysLeft ?? 9_999) - (right.daysLeft ?? 9_999));
}

export async function loadCertificates(): Promise<CertificatePayload> {
  try {
    const customApi = makeCustomApi();
    const response = await customApi.listClusterCustomObject({
      group: "cert-manager.io",
      version: "v1",
      plural: "certificates",
    });
    const items = ((response as { items?: unknown[] }).items ?? []).map((item) => {
      const cert = item as {
        metadata?: { name?: string; namespace?: string; uid?: string };
        spec?: {
          secretName?: string;
          dnsNames?: string[];
          commonName?: string;
          issuerRef?: { name?: string; kind?: string };
        };
        status?: {
          notAfter?: string | Date;
          renewalTime?: string | Date;
          revision?: number;
          conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
        };
      };
      const readyCondition = cert.status?.conditions?.find((condition) => condition.type === "Ready");
      const ready = readyCondition?.status === "True";
      const notAfter = toIso(cert.status?.notAfter);
      const daysLeft = daysUntil(notAfter);
      return {
        id: cert.metadata?.uid ?? `${cert.metadata?.namespace ?? "default"}/${cert.metadata?.name ?? "unknown"}`,
        name: cert.metadata?.name ?? "unknown",
        namespace: cert.metadata?.namespace ?? "default",
        secretName: cert.spec?.secretName ?? null,
        commonName: cert.spec?.commonName ?? cert.spec?.dnsNames?.[0] ?? null,
        dnsNames: cert.spec?.dnsNames ?? (cert.spec?.commonName ? [cert.spec.commonName] : []),
        issuerRef: cert.spec?.issuerRef?.name ? `${cert.spec?.issuerRef?.kind ?? "Issuer"}/${cert.spec.issuerRef.name}` : null,
        ready,
        valid: ready,
        status: ready ? (daysLeft !== null && daysLeft <= 14 ? "Expiring Soon" : "Ready") : (readyCondition?.reason ?? "Pending"),
        reason: readyCondition?.message ?? readyCondition?.reason ?? null,
        notAfter,
        renewalTime: toIso(cert.status?.renewalTime),
        daysLeft,
        revision: cert.status?.revision ?? null,
        source: "cert-manager",
      } satisfies CertificateItem;
    });

    if (items.length > 0) {
      const certs = items.sort((left, right) => (left.daysLeft ?? 9_999) - (right.daysLeft ?? 9_999));
      return { certs, live: true, summary: buildCertificateSummary(certs) };
    }

    const certs = await loadSecretBackedCertificates();
    return { certs, live: true, summary: buildCertificateSummary(certs) };
  } catch {
    try {
      const certs = await loadSecretBackedCertificates();
      return { certs, live: true, summary: buildCertificateSummary(certs) };
    } catch {
      return { certs: [], live: false, summary: buildCertificateSummary([]) };
    }
  }
}

function statusForJob(job: {
  status?: {
    active?: number;
    succeeded?: number;
    failed?: number;
    startTime?: string | Date;
    completionTime?: string | Date;
    conditions?: Array<{ type?: string; status?: string; lastTransitionTime?: string | Date }>;
  };
}) {
  if ((job.status?.active ?? 0) > 0) return "running" as const;
  if ((job.status?.succeeded ?? 0) > 0 || job.status?.conditions?.some((condition) => condition.type === "Complete" && condition.status === "True")) {
    return "succeeded" as const;
  }
  if ((job.status?.failed ?? 0) > 0 || job.status?.conditions?.some((condition) => condition.type === "Failed" && condition.status === "True")) {
    return "failed" as const;
  }
  return "unknown" as const;
}

export async function loadCronJobs(): Promise<CronJobPayload> {
  try {
    const batchApi = makeBatchApi();
    const [cronResponse, jobResponse] = await Promise.all([
      batchApi.listCronJobForAllNamespaces(),
      batchApi.listJobForAllNamespaces(),
    ]);

    const jobsByCron = new Map<string, CronJobRunItem[]>();
    for (const item of ((jobResponse as { items?: unknown[] }).items ?? [])) {
      const job = item as {
        metadata?: {
          name?: string;
          namespace?: string;
          annotations?: Record<string, string>;
          ownerReferences?: Array<{ kind?: string; name?: string }>;
          creationTimestamp?: string | Date;
        };
        status?: {
          active?: number;
          succeeded?: number;
          failed?: number;
          startTime?: string | Date;
          completionTime?: string | Date;
          conditions?: Array<{ type?: string; status?: string; lastTransitionTime?: string | Date }>;
        };
      };
      const ownerName = job.metadata?.ownerReferences?.find((reference) => reference.kind === "CronJob")?.name
        ?? job.metadata?.annotations?.["cronjob-name"];
      if (!ownerName || !job.metadata?.namespace) continue;
      const key = `${job.metadata.namespace}/${ownerName}`;
      const startedAt = pickTimestamp(job.status?.startTime, job.metadata?.creationTimestamp);
      const completedAt = pickTimestamp(
        job.status?.completionTime,
        job.status?.conditions?.find((condition) => ["Complete", "Failed"].includes(condition.type ?? ""))?.lastTransitionTime,
      );
      const durationSeconds = startedAt && completedAt
        ? Math.max(0, Math.round((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000))
        : null;
      const recentRun: CronJobRunItem = {
        name: job.metadata?.name ?? "job",
        status: statusForJob(job),
        startedAt,
        completedAt,
        durationSeconds,
      };
      const current = jobsByCron.get(key) ?? [];
      current.push(recentRun);
      jobsByCron.set(key, current);
    }

    const cronjobs = ((cronResponse as { items?: unknown[] }).items ?? []).map((item) => {
      const cronjob = item as {
        metadata?: { name?: string; namespace?: string; uid?: string };
        spec?: {
          schedule?: string;
          suspend?: boolean;
          concurrencyPolicy?: string;
          jobTemplate?: { spec?: { template?: { spec?: { containers?: Array<{ image?: string }> } } } };
        };
        status?: {
          lastScheduleTime?: string | Date;
          lastSuccessfulTime?: string | Date;
          active?: unknown[];
        };
      };
      const key = `${cronjob.metadata?.namespace ?? "default"}/${cronjob.metadata?.name ?? "unknown"}`;
      const recentJobs = [...(jobsByCron.get(key) ?? [])].sort((left, right) => compareTimestampDesc(left.completedAt ?? left.startedAt, right.completedAt ?? right.startedAt)).slice(0, 4);
      const lastSuccess = recentJobs.find((job) => job.status === "succeeded")?.completedAt
        ?? pickTimestamp(cronjob.status?.lastSuccessfulTime);
      const lastFailure = recentJobs.find((job) => job.status === "failed")?.completedAt
        ?? recentJobs.find((job) => job.status === "failed")?.startedAt
        ?? null;
      return {
        id: cronjob.metadata?.uid ?? key,
        namespace: cronjob.metadata?.namespace ?? "default",
        name: cronjob.metadata?.name ?? "unknown",
        schedule: cronjob.spec?.schedule ?? "",
        suspended: cronjob.spec?.suspend ?? false,
        active: (cronjob.status?.active ?? []).length,
        image: cronjob.spec?.jobTemplate?.spec?.template?.spec?.containers?.[0]?.image ?? "",
        concurrencyPolicy: cronjob.spec?.concurrencyPolicy ?? null,
        lastSchedule: pickTimestamp(cronjob.status?.lastScheduleTime),
        nextRun: nextCronRun(cronjob.spec?.schedule ?? "")?.toISOString() ?? null,
        lastSuccess,
        lastFailure,
        failing: Boolean(lastFailure && (!lastSuccess || new Date(lastFailure).getTime() > new Date(lastSuccess).getTime())),
        recentJobs,
      } satisfies CronJobItem;
    }).sort((left, right) => compareTimestampDesc(left.nextRun, right.nextRun));

    return { cronjobs, live: true, summary: buildCronSummary(cronjobs) };
  } catch {
    return { cronjobs: [], live: false, summary: buildCronSummary([]) };
  }
}

export async function loadIngressRoutes(): Promise<IngressRoutePayload> {
  try {
    const customApi = makeCustomApi();
    const response = await customApi.listClusterCustomObject({
      group: "traefik.io",
      version: "v1alpha1",
      plural: "ingressroutes",
    });
    const ingressRoutes = ((response as { items?: unknown[] }).items ?? []).map((item) => {
      const ingressRoute = item as {
        metadata?: { name?: string; namespace?: string; uid?: string };
        spec?: {
          entryPoints?: string[];
          routes?: Array<{
            match?: string;
            middlewares?: Array<{ name?: string; namespace?: string }>;
            services?: Array<{ name?: string; namespace?: string; port?: string | number }>;
          }>;
          tls?: { secretName?: string; certResolver?: string };
        };
      };
      const middlewares = uniqueStrings((ingressRoute.spec?.routes ?? []).flatMap((route) =>
        (route.middlewares ?? []).map((middleware) => `${middleware.namespace ?? ingressRoute.metadata?.namespace ?? "default"}/${middleware.name ?? "middleware"}`)
      ));
      const authMiddlewares = middlewares.filter((middleware) => AUTH_MIDDLEWARE_RE.test(middleware));
      const services = uniqueStrings((ingressRoute.spec?.routes ?? []).flatMap((route) =>
        (route.services ?? []).map((service) => `${service.namespace ?? ingressRoute.metadata?.namespace ?? "default"}/${service.name ?? "service"}${service.port ? `:${service.port}` : ""}`)
      ));
      const hosts = uniqueStrings((ingressRoute.spec?.routes ?? []).flatMap((route) => hostnamesFromMatch(route.match)));
      return {
        id: ingressRoute.metadata?.uid ?? `${ingressRoute.metadata?.namespace ?? "default"}/${ingressRoute.metadata?.name ?? "unknown"}`,
        namespace: ingressRoute.metadata?.namespace ?? "default",
        name: ingressRoute.metadata?.name ?? "unknown",
        entryPoints: ingressRoute.spec?.entryPoints ?? [],
        hosts,
        services,
        middlewares,
        authMiddlewares,
        tlsSecretName: ingressRoute.spec?.tls?.secretName ?? null,
        certResolver: ingressRoute.spec?.tls?.certResolver ?? null,
        hasTls: Boolean(ingressRoute.spec?.tls?.secretName || ingressRoute.spec?.tls?.certResolver),
      } satisfies IngressRouteItem;
    }).sort((left, right) => left.namespace.localeCompare(right.namespace) || left.name.localeCompare(right.name));

    return { ingressRoutes, live: true, summary: buildIngressSummary(ingressRoutes) };
  } catch {
    return { ingressRoutes: [], live: false, summary: buildIngressSummary([]) };
  }
}
