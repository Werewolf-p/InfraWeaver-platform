"use client";
import { signIn } from "next-auth/react";
import { motion } from "framer-motion";
import { Terminal, LogIn } from "lucide-react";

export default function SignInPage() {
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-8 shadow-2xl">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center">
              <Terminal className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">InfraWeaver Console</h1>
              <p className="text-xs text-slate-400">Platform Management</p>
            </div>
          </div>
          <p className="text-sm text-slate-400 mb-6">Sign in with your Authentik account to access the platform console.</p>
          <button
            onClick={() => signIn("authentik", { callbackUrl: "/" })}
            className="w-full flex items-center justify-center gap-3 py-3 px-6 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white font-semibold text-sm transition-colors"
          >
            <LogIn className="w-4 h-4" />
            Sign in with Authentik
          </button>
        </div>
      </motion.div>
    </div>
  );
}
