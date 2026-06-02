"use client";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Terminal, ShieldCheck, Activity, GitBranch, Network, LogIn } from "lucide-react";

const features = [
  { icon: Activity,    text: "Real-time cluster monitoring" },
  { icon: GitBranch,   text: "ArgoCD GitOps integration" },
  { icon: ShieldCheck, text: "RBAC access control" },
  { icon: Network,     text: "Zero-trust networking" },
];

const DOTS_COLS = 24;
const DOTS_ROWS = 16;

function GridDots() {
  return (
    <svg
      className="absolute inset-0 w-full h-full opacity-[0.04] pointer-events-none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {Array.from({ length: DOTS_ROWS }).map((_, row) =>
        Array.from({ length: DOTS_COLS }).map((_, col) => (
          <circle
            key={`${row}-${col}`}
            cx={`${(col / (DOTS_COLS - 1)) * 100}%`}
            cy={`${(row / (DOTS_ROWS - 1)) * 100}%`}
            r="1"
            fill="white"
          />
        ))
      )}
    </svg>
  );
}

export default function SignInPage() {
  const [signInHref, setSignInHref] = useState("/api/auth/start");

  useEffect(() => {
    const callbackUrl = new URLSearchParams(window.location.search).get("callbackUrl");
    const safe = callbackUrl?.startsWith("/") ? callbackUrl : "/";
    setSignInHref(`/api/auth/start?callbackUrl=${encodeURIComponent(safe)}`);
  }, []);

  return (
    <div className="min-h-screen bg-slate-100 dark:bg-slate-950 flex items-center justify-center p-4 relative overflow-hidden">
      <div className="aurora-bg" aria-hidden="true">
        <div className="aurora-blob aurora-blob-1" />
        <div className="aurora-blob aurora-blob-2" />
        <div className="aurora-blob aurora-blob-3" />
      </div>

      <GridDots />

      <div className="w-full max-w-4xl relative z-10 grid md:grid-cols-2 gap-8 items-center">
        {/* Left: branding + features */}
        <motion.div
          initial={{ opacity: 0, x: -30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="hidden md:flex flex-col gap-8"
        >
          <div className="flex items-center gap-4">
            <motion.div
              animate={{ boxShadow: ["0 0 20px rgba(99,102,241,0.3)", "0 0 40px rgba(99,102,241,0.6)", "0 0 20px rgba(99,102,241,0.3)"] }}
              transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
              className="w-14 h-14 rounded-2xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center"
            >
              <Terminal className="w-7 h-7 text-indigo-400" />
            </motion.div>
            <div>
              <h1 className="text-3xl font-black text-gray-900 dark:text-white tracking-tight">InfraWeaver</h1>
              <p className="text-sm text-indigo-400 font-medium">Platform Console</p>
            </div>
          </div>

          <p className="text-slate-500 dark:text-slate-400 text-base leading-relaxed">
            Your unified homelab control plane. Manage Kubernetes workloads, monitor health,
            edit configs, and enforce access control — all in one place.
          </p>

          <div className="space-y-3">
            {features.map((f, i) => (
              <motion.div
                key={f.text}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.2 + i * 0.1, duration: 0.4 }}
                className="flex items-center gap-3"
              >
                <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center flex-shrink-0">
                  <f.icon className="w-4 h-4 text-indigo-400" />
                </div>
                <span className="text-sm text-slate-700 dark:text-slate-300">{f.text}</span>
              </motion.div>
            ))}
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-600">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 live-dot" />
            <span>All systems operational</span>
          </div>
        </motion.div>

        {/* Right: login card */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
        >
          <div className="relative rounded-2xl p-px gradient-border">
            <div className="bg-slate-900/90 backdrop-blur-xl rounded-2xl p-8">
              {/* Mobile logo */}
              <div className="flex items-center gap-3 mb-8 md:hidden">
                <div className="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center">
                  <Terminal className="w-5 h-5 text-indigo-400" />
                </div>
                <div>
                  <h1 className="text-xl font-bold text-gray-900 dark:text-white">InfraWeaver</h1>
                  <p className="text-xs text-indigo-400">Platform Console</p>
                </div>
              </div>

              <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-1">Welcome back</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mb-8">
                Sign in with your Authentik account to access the platform console.
              </p>

              {/*
               * Plain anchor link — no JS in the auth path.
               * Clicking navigates to /api/auth/start which calls signIn() server-side:
               *   1. Generates PKCE / state / nonce, sets auth cookies
               *   2. 302 → Authentik authorization URL
               * No CSRF dance, no server action redirect issues, no async user-gesture loss.
               */}
              <motion.a
                href={signInHref}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
                className="relative w-full group overflow-hidden flex items-center justify-center gap-3 py-3.5 px-6 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm transition-colors shadow-lg shadow-indigo-500/25"
              >
                <span className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-r from-transparent via-white/10 to-transparent -skew-x-12 translate-x-[-100%] group-hover:translate-x-[200%] duration-700" />
                <LogIn className="w-4 h-4 relative" />
                <span className="relative">Sign in with Authentik</span>
              </motion.a>

              <p className="text-xs text-slate-600 text-center mt-6">
                Protected by{" "}
                <span className="text-slate-500">Authentik</span>
                {" · "}
                <span className="text-slate-500">v2026</span>
              </p>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
