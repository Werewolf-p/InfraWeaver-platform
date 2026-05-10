"use client";
import React from "react";
import { AlertTriangle, RefreshCw, Home, Copy, ChevronDown } from "lucide-react";

interface State { hasError: boolean; error?: Error; showStack: boolean }

export class ErrorBoundary extends React.Component<{ children: React.ReactNode; fallback?: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode; fallback?: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, showStack: false };
  }
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, showStack: false };
  }
  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      const msg = this.state.error?.message ?? "An unexpected error occurred";
      const stack = this.state.error?.stack ?? "";
      return (
        <div className="flex flex-col items-center justify-center p-8 bg-white/5 border border-white/10 rounded-xl text-center">
          <AlertTriangle className="w-8 h-8 text-red-400 mb-3" />
          <h3 className="text-sm font-semibold text-white mb-1">Something went wrong</h3>
          <p className="text-xs text-slate-400 mb-4 max-w-sm">{msg}</p>
          <div className="flex items-center gap-2 mb-4">
            <button
              onClick={() => this.setState({ hasError: false, showStack: false })}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-slate-300 hover:text-white transition-colors"
            >
              <RefreshCw className="w-3 h-3" /> Try Again
            </button>
            <a
              href="/"
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-slate-300 hover:text-white transition-colors"
            >
              <Home className="w-3 h-3" /> Go Home
            </a>
            <button
              onClick={() => void navigator.clipboard.writeText(`${msg}\n\n${stack}`)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-slate-300 hover:text-white transition-colors"
            >
              <Copy className="w-3 h-3" /> Copy Error
            </button>
          </div>
          {stack && (
            <div className="w-full max-w-xl text-left">
              <button
                onClick={() => this.setState(s => ({ showStack: !s.showStack }))}
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 mb-2 transition-colors"
              >
                <ChevronDown className={`w-3 h-3 transition-transform ${this.state.showStack ? "rotate-180" : ""}`} />
                {this.state.showStack ? "Hide" : "Show"} stack trace
              </button>
              {this.state.showStack && (
                <pre className="text-[10px] text-red-300/70 bg-red-500/5 border border-red-500/20 rounded-lg p-3 overflow-auto max-h-48 whitespace-pre-wrap">
                  {stack}
                </pre>
              )}
            </div>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

