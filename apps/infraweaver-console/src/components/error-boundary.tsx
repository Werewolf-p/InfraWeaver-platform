"use client";
import React from "react";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  requestId: string;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, requestId: "" };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
      requestId: `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const { requestId } = this.state;
    console.error("[ErrorBoundary] Caught error:", error.message, info.componentStack);
    fetch("/api/errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: error.message,
        stack: error.stack,
        url: typeof window !== "undefined" ? window.location.href : "",
        requestId,
      }),
    }).catch(() => {});
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, requestId: "" });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <FallbackUI
          error={this.state.error}
          requestId={this.state.requestId}
          onReset={this.handleReset}
        />
      );
    }
    return this.props.children;
  }
}

interface FallbackUIProps {
  error: Error | null;
  requestId: string;
  onReset: () => void;
}

export function FallbackUI({ error, requestId, onReset }: FallbackUIProps) {
  return (
    <div role="alert" className="flex min-h-[400px] flex-col items-center justify-center gap-4 rounded-2xl border border-red-500/20 bg-red-500/5 p-8 text-center">
      <AlertTriangle className="h-12 w-12 text-red-400" aria-hidden="true" />
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Something went wrong</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-white/60">
          This part of the console hit an unexpected error. Your data is safe — try again or reload the page.
        </p>
        {error?.message ? (
          <p className="mt-2 rounded-lg bg-black/20 px-3 py-2 font-mono text-xs text-gray-500 dark:text-white/50">{error.message}</p>
        ) : null}
        <p className="mt-2 font-mono text-xs text-gray-400 dark:text-white/40">Reference: {requestId}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          onClick={onReset}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-red-500/20 px-4 py-2 text-sm text-red-300 transition-colors hover:bg-red-500/30 touch-manipulation"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Try again
        </button>
        <button
          onClick={() => { if (typeof window !== "undefined") window.location.reload(); }}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:border-white/10 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white touch-manipulation"
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          Reload page
        </button>
      </div>
    </div>
  );
}

export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  fallback?: React.ReactNode,
) {
  const WrappedComponent = (props: P) => (
    <ErrorBoundary fallback={fallback}>
      <Component {...props} />
    </ErrorBoundary>
  );
  WrappedComponent.displayName = `withErrorBoundary(${Component.displayName ?? Component.name})`;
  return WrappedComponent;
}
