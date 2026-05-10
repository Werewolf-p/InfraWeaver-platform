"use client";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Package, FileText, ChevronRight, ChevronLeft, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import dynamic from "next/dynamic";
import Link from "next/link";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

type AppType = "helm" | "raw" | null;

interface HelmFields {
  appName: string;
  namespace: string;
  helmRepoURL: string;
  chartName: string;
  chartVersion: string;
  targetRevision: string;
  valuesOverride: string;
}

interface RawFields {
  appName: string;
  namespace: string;
  gitRepoURL: string;
  gitPath: string;
  targetRevision: string;
}

function generateHelmYaml(f: HelmFields): string {
  const valuesBlock = f.valuesOverride.trim()
    ? `\n    helm:\n      releaseName: ${f.appName}\n      values: |\n${f.valuesOverride.split("\n").map(l => `        ${l}`).join("\n")}`
    : `\n    helm:\n      releaseName: ${f.appName}`;
  return `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: catalog-${f.appName}-manifests
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: infraweaver
spec:
  project: platform
  source:
    repoURL: ${f.helmRepoURL}
    chart: ${f.chartName}
    targetRevision: ${f.chartVersion}${valuesBlock}
  destination:
    server: https://kubernetes.default.svc
    namespace: ${f.namespace}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
`;
}

function generateRawYaml(f: RawFields): string {
  return `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: catalog-${f.appName}-manifests
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: infraweaver
spec:
  project: platform
  source:
    repoURL: ${f.gitRepoURL}
    path: ${f.gitPath}
    targetRevision: ${f.targetRevision}
  destination:
    server: https://kubernetes.default.svc
    namespace: ${f.namespace}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
`;
}

const DEFAULT_GIT_REPO = "https://github.com/Werewolf-p/InfraWeaver-platform";

const inputCls =
  "w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50 transition-colors";

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-1.5">
        {label}
        {required && <span className="text-red-400 ml-1">*</span>}
      </label>
      {children}
    </div>
  );
}

export default function CatalogInstallPage() {
  const [step, setStep] = useState(1);
  const [appType, setAppType] = useState<AppType>(null);
  const [helmFields, setHelmFields] = useState<HelmFields>({
    appName: "",
    namespace: "",
    helmRepoURL: "",
    chartName: "",
    chartVersion: "",
    targetRevision: "HEAD",
    valuesOverride: "",
  });
  const [rawFields, setRawFields] = useState<RawFields>({
    appName: "",
    namespace: "",
    gitRepoURL: DEFAULT_GIT_REPO,
    gitPath: "",
    targetRevision: "HEAD",
  });
  const [commitMessage, setCommitMessage] = useState("");
  const [installing, setInstalling] = useState(false);
  const [success, setSuccess] = useState(false);

  const appName = appType === "helm" ? helmFields.appName : rawFields.appName;
  const generatedYaml =
    appType === "helm"
      ? generateHelmYaml(helmFields)
      : appType === "raw"
      ? generateRawYaml(rawFields)
      : "";

  const defaultCommitMessage = `feat: install catalog app ${appName} via InfraWeaver Console`;

  const canProceedStep1 = appType !== null;
  const canProceedStep2 =
    appType === "helm"
      ? !!(
          helmFields.appName &&
          helmFields.namespace &&
          helmFields.helmRepoURL &&
          helmFields.chartName &&
          helmFields.chartVersion
        )
      : !!(rawFields.appName && rawFields.namespace && rawFields.gitRepoURL && rawFields.gitPath);

  const handleInstall = async () => {
    setInstalling(true);
    try {
      const body =
        appType === "helm"
          ? {
              appName: helmFields.appName,
              namespace: helmFields.namespace,
              yaml: generatedYaml,
              appType,
              helmRepoURL: helmFields.helmRepoURL,
              chartName: helmFields.chartName,
              chartVersion: helmFields.chartVersion,
            }
          : {
              appName: rawFields.appName,
              namespace: rawFields.namespace,
              yaml: generatedYaml,
              appType,
              gitRepoURL: rawFields.gitRepoURL,
              gitPath: rawFields.gitPath,
            };
      const res = await fetch("/api/catalog-install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, commitMessage: commitMessage || defaultCommitMessage }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Install failed");
      }
      toast.success(`${appName} installed successfully! ArgoCD will sync shortly.`);
      setSuccess(true);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-8">
        <h2 className="text-xl font-bold text-white">App Installer</h2>
        <p className="text-sm text-slate-400 mt-1">
          Install a new application to the catalog via ArgoCD
        </p>
      </div>

      {/* Step Indicators */}
      <div className="flex items-center gap-2 mb-8">
        {["Choose Type", "Fill Details", "Preview YAML", "Commit"].map((label, i) => {
          const stepNum = i + 1;
          const isActive = step === stepNum;
          const isDone = step > stepNum;
          return (
            <div key={label} className="flex items-center gap-2">
              <div
                className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 transition-colors",
                  isDone
                    ? "bg-green-500 text-white"
                    : isActive
                    ? "bg-indigo-500 text-white"
                    : "bg-white/10 text-slate-400"
                )}
              >
                {isDone ? <Check className="w-3.5 h-3.5" /> : stepNum}
              </div>
              <span
                className={cn(
                  "text-xs font-medium hidden sm:block",
                  isActive ? "text-white" : "text-slate-500"
                )}
              >
                {label}
              </span>
              {i < 3 && (
                <ChevronRight className="w-3.5 h-3.5 text-slate-600 flex-shrink-0" />
              )}
            </div>
          );
        })}
      </div>

      <AnimatePresence mode="wait">
        {/* Step 1: Choose Type */}
        {step === 1 && (
          <motion.div
            key="step1"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
          >
            <h3 className="text-base font-semibold text-white mb-4">
              Choose Application Type
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
              {(
                [
                  {
                    type: "helm" as const,
                    icon: Package,
                    title: "Helm Chart",
                    desc: "Deploy from a Helm repository. Supports version pinning and values overrides.",
                  },
                  {
                    type: "raw" as const,
                    icon: FileText,
                    title: "Raw Manifests",
                    desc: "Deploy Kubernetes manifests from a Git directory path.",
                  },
                ] as const
              ).map(({ type, icon: Icon, title, desc }) => (
                <button
                  key={type}
                  onClick={() => setAppType(type)}
                  className={cn(
                    "flex flex-col items-center gap-4 p-6 rounded-xl border transition-all text-left",
                    appType === type
                      ? "border-indigo-500/50 bg-indigo-500/10"
                      : "border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/10"
                  )}
                >
                  <div
                    className={cn(
                      "w-12 h-12 rounded-xl flex items-center justify-center",
                      appType === type ? "bg-indigo-500/20" : "bg-white/10"
                    )}
                  >
                    <Icon
                      className={cn(
                        "w-6 h-6",
                        appType === type ? "text-indigo-400" : "text-slate-400"
                      )}
                    />
                  </div>
                  <div>
                    <h4 className="font-semibold text-white text-sm">{title}</h4>
                    <p className="text-xs text-slate-400 mt-1">{desc}</p>
                  </div>
                </button>
              ))}
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => setStep(2)}
                disabled={!canProceedStep1}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-600 transition-colors disabled:opacity-40"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}

        {/* Step 2: Fill Details */}
        {step === 2 && (
          <motion.div
            key="step2"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
          >
            <h3 className="text-base font-semibold text-white mb-4">
              {appType === "helm" ? "Helm Chart Details" : "Raw Manifests Details"}
            </h3>
            <div className="space-y-4 mb-6">
              {appType === "helm" ? (
                <>
                  <Field label="App Name" required>
                    <input
                      value={helmFields.appName}
                      onChange={e => {
                        const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
                        setHelmFields(p => ({
                          ...p,
                          appName: v,
                          namespace: p.namespace || v,
                        }));
                      }}
                      placeholder="my-app"
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Namespace" required>
                    <input
                      value={helmFields.namespace}
                      onChange={e => setHelmFields(p => ({ ...p, namespace: e.target.value }))}
                      placeholder={helmFields.appName || "my-app"}
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Helm Repo URL" required>
                    <input
                      value={helmFields.helmRepoURL}
                      onChange={e => setHelmFields(p => ({ ...p, helmRepoURL: e.target.value }))}
                      placeholder="https://charts.example.com"
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Chart Name" required>
                    <input
                      value={helmFields.chartName}
                      onChange={e => setHelmFields(p => ({ ...p, chartName: e.target.value }))}
                      placeholder="my-chart"
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Chart Version" required>
                    <input
                      value={helmFields.chartVersion}
                      onChange={e =>
                        setHelmFields(p => ({ ...p, chartVersion: e.target.value }))
                      }
                      placeholder="1.2.3"
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Target Revision">
                    <input
                      value={helmFields.targetRevision}
                      onChange={e =>
                        setHelmFields(p => ({ ...p, targetRevision: e.target.value }))
                      }
                      placeholder="HEAD"
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Values Override (YAML)">
                    <textarea
                      value={helmFields.valuesOverride}
                      onChange={e =>
                        setHelmFields(p => ({ ...p, valuesOverride: e.target.value }))
                      }
                      placeholder={`replicaCount: 1\nimage:\n  tag: latest`}
                      rows={5}
                      className={cn(inputCls, "resize-none font-mono text-xs")}
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="App Name" required>
                    <input
                      value={rawFields.appName}
                      onChange={e => {
                        const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
                        setRawFields(p => ({
                          ...p,
                          appName: v,
                          namespace: p.namespace || v,
                        }));
                      }}
                      placeholder="my-app"
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Namespace" required>
                    <input
                      value={rawFields.namespace}
                      onChange={e => setRawFields(p => ({ ...p, namespace: e.target.value }))}
                      placeholder={rawFields.appName || "my-app"}
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Git Repo URL" required>
                    <input
                      value={rawFields.gitRepoURL}
                      onChange={e => setRawFields(p => ({ ...p, gitRepoURL: e.target.value }))}
                      placeholder={DEFAULT_GIT_REPO}
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Git Path" required>
                    <input
                      value={rawFields.gitPath}
                      onChange={e => setRawFields(p => ({ ...p, gitPath: e.target.value }))}
                      placeholder="kubernetes/catalog/my-app"
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Target Revision">
                    <input
                      value={rawFields.targetRevision}
                      onChange={e =>
                        setRawFields(p => ({ ...p, targetRevision: e.target.value }))
                      }
                      placeholder="HEAD"
                      className={inputCls}
                    />
                  </Field>
                </>
              )}
            </div>
            <div className="flex justify-between">
              <button
                onClick={() => setStep(1)}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-slate-300 text-sm font-medium hover:bg-white/10 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
              <button
                onClick={() => setStep(3)}
                disabled={!canProceedStep2}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-600 transition-colors disabled:opacity-40"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}

        {/* Step 3: Preview YAML */}
        {step === 3 && (
          <motion.div
            key="step3"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
          >
            <h3 className="text-base font-semibold text-white mb-2">Preview Generated YAML</h3>
            <p className="text-xs text-slate-400 mb-4">
              This ArgoCD Application manifest will be committed to{" "}
              <code className="font-mono bg-white/10 px-1 rounded">
                kubernetes/catalog/{appName}/application.yaml
              </code>
            </p>
            <div className="rounded-xl overflow-hidden border border-white/10 mb-6">
              <MonacoEditor
                height="380px"
                language="yaml"
                theme="vs-dark"
                value={generatedYaml}
                options={{
                  readOnly: true,
                  fontSize: 12,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  lineNumbers: "on",
                }}
              />
            </div>
            <div className="flex justify-between">
              <button
                onClick={() => setStep(2)}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-slate-300 text-sm font-medium hover:bg-white/10 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
              <button
                onClick={() => {
                  setCommitMessage(defaultCommitMessage);
                  setStep(4);
                }}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-600 transition-colors"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}

        {/* Step 4: Commit */}
        {step === 4 && (
          <motion.div
            key="step4"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
          >
            {success ? (
              <div className="text-center py-12">
                <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-4">
                  <Check className="w-8 h-8 text-green-400" />
                </div>
                <h3 className="text-lg font-semibold text-white mb-2">{appName} installed!</h3>
                <p className="text-sm text-slate-400 mb-6">
                  ArgoCD will sync the application shortly. Check the Applications page for status.
                </p>
                <Link
                  href="/apps"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-600 transition-colors"
                >
                  Go to Apps
                </Link>
              </div>
            ) : (
              <>
                <h3 className="text-base font-semibold text-white mb-4">Review &amp; Commit</h3>
                <div className="bg-white/5 border border-white/10 rounded-xl p-4 mb-4 space-y-3">
                  <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                    Files to commit
                  </h4>
                  <div className="space-y-2">
                    <div className="flex items-start gap-2 text-sm text-slate-300">
                      <FileText className="w-4 h-4 text-indigo-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="font-mono text-xs">
                          kubernetes/catalog/{appName}/application.yaml
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          ArgoCD Application manifest
                        </p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2 text-sm text-slate-300">
                      <FileText className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="font-mono text-xs">platform.yaml</p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Adding{" "}
                          <code className="font-mono bg-white/10 px-1 rounded">{appName}</code> to
                          catalog.enabled
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
                <Field label="Commit Message">
                  <input
                    value={commitMessage || defaultCommitMessage}
                    onChange={e => setCommitMessage(e.target.value)}
                    className={inputCls}
                  />
                </Field>
                <div className="flex justify-between mt-6">
                  <button
                    onClick={() => setStep(3)}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-slate-300 text-sm font-medium hover:bg-white/10 transition-colors"
                  >
                    <ChevronLeft className="w-4 h-4" /> Back
                  </button>
                  <button
                    onClick={handleInstall}
                    disabled={installing}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50"
                  >
                    {installing ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Package className="w-4 h-4" />
                    )}
                    {installing ? "Installing..." : "Install Application"}
                  </button>
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
