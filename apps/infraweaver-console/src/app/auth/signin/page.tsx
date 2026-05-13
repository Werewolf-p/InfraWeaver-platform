"use client";
import { signIn } from "next-auth/react";
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

function getCallbackUrl() {
  if (typeof window === "undefined") return "/";
  const value = new URLSearchParams(window.location.search).get("callbackUrl");
  return value?.startsWith("/") ? value : "/";
}

export default function SignInPage() {
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4 relative overflow-hidden">
      {/* Aurora background */}
      <div className="aurora-bg" aria-hidden="true">
        <div className="aurora-blob aurora-blob-1" />
        <div className="aurora-blob aurora-blob-2" />
        <div className="aurora-blob aurora-blob-3" />
      </div>

      {/* Dot grid */}
      <GridDots />

      <div className="w-full max-w-4xl relative z-10 grid md:grid-cols-2 gap-8 items-center">
        {/* Left: branding + features */}
        <motion.div
          initial={{ opacity: 0, x: -30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="hidden md:flex flex-col gap-8"
        >
          {/* Logo wordmark */}
          <div className="flex items-center gap-4">
            <motion.div
              animate={{ boxShadow: ["0 0 20px rgba(99,102,241,0.3)", "0 0 40px rgba(99,102,241,0.6)", "0 0 20px rgba(99,102,241,0.3)"] }}
              transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
              className="w-14 h-14 rounded-2xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center"
            >
              <Terminal className="w-7 h-7 text-indigo-400" />
            </motion.div>
            <div>
              <h1 className="text-3xl font-black text-white tracking-tight">InfraWeaver</h1>
              <p className="text-sm text-indigo-400 font-medium">Platform Console</p>
            </div>
          </div>

          <p className="text-slate-400 text-base leading-relaxed">
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
                <span className="text-sm text-slate-300">{f.text}</span>
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
          {/* Gradient border card */}
          <div className="relative rounded-2xl p-px gradient-border">
            <div className="bg-slate-900/90 backdrop-blur-xl rounded-2xl p-8">
              {/* Mobile logo */}
              <div className="flex items-center gap-3 mb-8 md:hidden">
                <div className="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center">
                  <Terminal className="w-5 h-5 text-indigo-400" />
                </div>
                <div>
                  <h1 className="text-xl font-bold text-white">InfraWeaver</h1>
                  <p className="text-xs text-indigo-400">Platform Console</p>
                </div>
              </div>

              <h2 className="text-xl font-bold text-white mb-1">Welcome back</h2>
              <p className="text-sm text-slate-400 mb-8">
                Sign in with your Authentik account to access the platform console.
              </p>

              {/* Sign in button */}
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => signIn("authentik", { callbackUrl: getCallbackUrl() })}
                className="relative w-full group overflow-hidden flex items-center justify-center gap-3 py-3.5 px-6 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm transition-colors shadow-lg shadow-indigo-500/25"
              >
                {/* Shimmer effect */}
                <span className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-r from-transparent via-white/10 to-transparent -skew-x-12 translate-x-[-100%] group-hover:translate-x-[200%] duration-700" />
                <LogIn className="w-4 h-4 relative" />
                <span className="relative">Sign in with Authentik</span>
              </motion.button>

              {/* Divider */}
              <div className="flex items-center gap-3 my-6">
                <div className="flex-1 h-px bg-white/5" />
                <span className="text-xs text-slate-600">or</span>
                <div className="flex-1 h-px bg-white/5" />
              </div>

              {/* Secondary GitHub button (UI only - Authentik handles OAuth) */}
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => signIn("authentik", { callbackUrl: getCallbackUrl() })}
                className="w-full flex items-center justify-center gap-3 py-3 px-6 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 font-medium text-sm transition-colors"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.2 11.38.6.1.82-.26.82-.57v-2c-3.34.72-4.04-1.6-4.04-1.6-.54-1.38-1.33-1.74-1.33-1.74-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49 1 .1-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 3-.4c1.02 0 2.04.13 3 .4 2.3-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.68.82.57C20.56 21.8 24 17.3 24 12c0-6.63-5.37-12-12-12z" />
                </svg>
                Continue via GitHub (SSO)
              </motion.button>

              {/* Footer */}
              <p className="text-xs text-slate-600 text-center mt-6">
                Protected by{" "}
                <span className="text-slate-500">Authentik</span>
                {" · "}
                <span className="text-slate-500">v2025.1</span>
              </p>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
