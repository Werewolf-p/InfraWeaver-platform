"use client";
import { motion } from "framer-motion";
import { useState } from "react";
import { toast } from "sonner";
import { Globe, Send } from "lucide-react";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

interface TestResult {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  latencyMs?: number;
  error?: string;
}

export default function WebhookTesterPage() {
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

  const statusColor = (s?: number) => !s ? "text-slate-400" : s < 300 ? "text-green-400" : s < 500 ? "text-yellow-400" : "text-red-400";

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2"><Globe className="w-5 h-5 text-slate-400" />Webhook Tester</h2>
        <p className="text-sm text-slate-400">Send HTTP requests and inspect responses</p>
      </div>
      <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4 space-y-4">
        <div className="flex gap-2">
          <select value={method} onChange={e => setMethod(e.target.value)} className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-indigo-500/50">
            {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/webhook" className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50" />
          <button onClick={handleTest} disabled={loading} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50">
            <Send className="w-4 h-4" />{loading ? "Sending..." : "Send"}
          </button>
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">Headers (JSON)</label>
          <textarea value={headersRaw} onChange={e => setHeadersRaw(e.target.value)} rows={3} className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white font-mono placeholder:text-slate-500 outline-none focus:border-indigo-500/50 resize-none" />
        </div>
        {method !== "GET" && (
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Body</label>
            <textarea value={body} onChange={e => setBody(e.target.value)} rows={4} className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white font-mono placeholder:text-slate-500 outline-none focus:border-indigo-500/50 resize-none" />
          </div>
        )}
      </div>
      {result && (
        <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4 space-y-4">
          <div className="flex items-center gap-4">
            <span className={`text-2xl font-bold ${statusColor(result.status)}`}>{result.status ?? "Error"}</span>
            <span className="text-sm text-slate-400">{result.statusText}</span>
            <span className="ml-auto text-xs text-slate-500">{result.latencyMs}ms</span>
          </div>
          {result.error && <p className="text-sm text-red-400">{result.error}</p>}
          {result.body && (
            <div>
              <p className="text-xs text-slate-400 mb-2">Response Body</p>
              <pre className="bg-black/30 rounded-lg p-3 text-xs text-green-300 overflow-auto max-h-64">{result.body}</pre>
            </div>
          )}
          {result.headers && Object.keys(result.headers).length > 0 && (
            <div>
              <p className="text-xs text-slate-400 mb-2">Response Headers</p>
              <div className="space-y-1">
                {Object.entries(result.headers).map(([k, v]) => (
                  <div key={k} className="flex gap-2 text-xs">
                    <span className="text-slate-400 font-mono">{k}:</span>
                    <span className="text-slate-300 font-mono truncate">{v}</span>
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
