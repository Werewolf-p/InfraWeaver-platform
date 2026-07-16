"use client";
import { motion } from "framer-motion";
import { useState } from "react";
import { toast } from "@/lib/notify";
import { Send, Zap } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge, type StatusType } from "@/components/ui/status-badge";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

interface TestResult {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  latencyMs?: number;
  error?: string;
}

function httpBadge(status?: number, error?: string): { status: StatusType; label: string } {
  if (error || status === undefined) return { status: "failed", label: "Error" };
  if (status < 300) return { status: "healthy", label: String(status) };
  if (status < 400) return { status: "warning", label: String(status) };
  if (status < 500) return { status: "warning", label: String(status) };
  return { status: "failed", label: String(status) };
}

function buildCurl(method: string, url: string, headersRaw: string, body: string): string {
  const parts = [`curl -X ${method}`];
  try {
    const headers = JSON.parse(headersRaw) as Record<string, string>;
    for (const [key, value] of Object.entries(headers)) {
      parts.push(`-H '${key}: ${value}'`);
    }
  } catch {
    // Invalid header JSON — emit the request line without headers rather than fail.
  }
  if (body && method !== "GET") parts.push(`--data '${body.replace(/'/g, "'\\''")}'`);
  parts.push(`'${url}'`);
  return parts.join(" ");
}

export function WebhookTesterView() {
  const [url, setUrl] = useState("https://");
  const [method, setMethod] = useState("GET");
  const [headersRaw, setHeadersRaw] = useState('{"Content-Type": "application/json"}');
  const [body, setBody] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);
  const [loading, setLoading] = useState(false);

  const handleTest = async () => {
    setLoading(true);
    try {
      let headers: Record<string, string> = {};
      try { headers = JSON.parse(headersRaw) as Record<string, string>; } catch { toast.error("Invalid headers JSON"); setLoading(false); return; }
      const res = await fetch("/api/webhooks/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, method, headers, body }),
      });
      const data = await res.json() as TestResult;
      setResult(data);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  };

  const headersText = result?.headers
    ? Object.entries(result.headers).map(([k, v]) => `${k}: ${v}`).join("\n")
    : "";
  const curlCommand = buildCurl(method, url, headersRaw, body);

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={Zap} title="Webhook Tester" subtitle="Send HTTP requests and inspect responses" />
      <div className="bg-slate-100 dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 rounded-xl backdrop-blur-sm p-4 space-y-4">
        <div className="flex gap-2">
          <select value={method} onChange={e => setMethod(e.target.value)} className="px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white outline-none focus:border-indigo-500/50">
            {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/webhook" className="flex-1 px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50" />
          <button onClick={handleTest} disabled={loading} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-700 dark:text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50">
            <Send className="w-4 h-4" />{loading ? "Sending..." : "Send"}
          </button>
        </div>
        <div>
          <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">Headers (JSON)</label>
          <textarea value={headersRaw} onChange={e => setHeadersRaw(e.target.value)} rows={3} className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white font-mono placeholder:text-slate-500 outline-none focus:border-indigo-500/50 resize-none" />
        </div>
        {method !== "GET" && (
          <div>
            <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">Body</label>
            <textarea value={body} onChange={e => setBody(e.target.value)} rows={4} className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white font-mono placeholder:text-slate-500 outline-none focus:border-indigo-500/50 resize-none" />
          </div>
        )}
        <div className="flex justify-end">
          <CopyButton text={curlCommand} label="Copy as cURL" />
        </div>
      </div>
      {result && (
        <div className="bg-slate-100 dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 rounded-xl backdrop-blur-sm p-4 space-y-4">
          <div className="flex items-center gap-3">
            {(() => {
              const badge = httpBadge(result.status, result.error);
              return <StatusBadge status={badge.status} label={badge.label} />;
            })()}
            <span className="text-sm text-slate-500 dark:text-slate-400">{result.statusText}</span>
            <span className="ml-auto text-xs text-slate-500">{result.latencyMs}ms</span>
          </div>
          {result.error && <p className="text-sm text-red-500 dark:text-red-400">{result.error}</p>}
          {result.body && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-slate-500 dark:text-slate-400">Response Body</p>
                <CopyButton text={result.body} label="Copy" />
              </div>
              <pre className="bg-black/5 dark:bg-black/30 rounded-lg p-3 text-xs text-emerald-700 dark:text-green-300 overflow-auto max-h-64">{result.body}</pre>
            </div>
          )}
          {result.headers && Object.keys(result.headers).length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-slate-500 dark:text-slate-400">Response Headers</p>
                <CopyButton text={headersText} label="Copy" />
              </div>
              <div className="space-y-1">
                {Object.entries(result.headers).map(([k, v]) => (
                  <div key={k} className="flex gap-2 text-xs">
                    <span className="text-slate-500 dark:text-slate-400 font-mono">{k}:</span>
                    <span className="text-slate-700 dark:text-slate-300 font-mono truncate">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}
