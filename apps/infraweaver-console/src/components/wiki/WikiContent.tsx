"use client";

import React, { useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, Check, Copy, Info, Link2 } from "lucide-react";

function flattenText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (React.isValidElement(node)) {
    return flattenText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

function slugifyHeading(text: string) {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function Heading({ level, children }: { level: 2 | 3 | 4; children: React.ReactNode }) {
  const text = flattenText(children).trim();
  const id = slugifyHeading(text);
  const className =
    level === 2
      ? "mt-10 scroll-mt-28 text-2xl font-semibold text-gray-900 dark:text-white"
      : level === 3
        ? "mt-8 scroll-mt-28 text-xl font-semibold text-gray-900 dark:text-white"
        : "mt-6 scroll-mt-28 text-lg font-semibold text-slate-100";
  const tag = level === 2 ? "h2" : level === 3 ? "h3" : "h4";

  return React.createElement(
    tag,
    { id, className },
    <span className="group inline-flex items-center gap-2">
      <span>{children}</span>
      <a
        href={`#${id}`}
        className="rounded-md border border-transparent p-1 text-slate-500 opacity-0 transition hover:border-white/10 hover:bg-gray-100 dark:hover:bg-white/5 hover:text-blue-300 group-hover:opacity-100"
        aria-label={`Link to ${text}`}
      >
        <Link2 className="h-3.5 w-3.5" />
      </a>
    </span>,
  );
}

function CodeBlock({ className, children, inline }: { className?: string; children?: React.ReactNode; inline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const code = String(children ?? "").replace(/\n$/, "");
  const language = className?.replace(/^language-/, "") ?? "text";

  if (inline) {
    return <code className="rounded bg-[#0d1117] px-1.5 py-0.5 font-mono text-[0.95em] text-blue-200">{children}</code>;
  }

  async function copyToClipboard() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="my-6 overflow-hidden rounded-2xl border border-gray-200 dark:border-white/10 bg-[#0b0f14] shadow-sm">
      <div className="flex items-center justify-between border-b border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/[0.03] px-4 py-2 text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
        <span>{language}</span>
        <button
          type="button"
          onClick={() => void copyToClipboard()}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium normal-case tracking-normal text-slate-700 dark:text-slate-300 transition hover:bg-gray-100 dark:hover:bg-white/[0.08] hover:text-gray-900 dark:hover:text-white"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-sm leading-6 text-slate-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function BlockQuote({ children }: { children: React.ReactNode }) {
  const text = flattenText(children).trim().toLowerCase();
  const isWarning = text.startsWith("warning:");
  const isNote = text.startsWith("note:") || text.startsWith("screenshot callout:");
  const icon = isWarning ? AlertTriangle : Info;
  const styles = isWarning
    ? "border-amber-500/40 bg-amber-500/10 text-amber-50"
    : isNote
      ? "border-blue-500/40 bg-blue-500/10 text-blue-50"
      : "border-slate-500/30 bg-gray-100 dark:bg-white/[0.03] text-slate-100";

  return (
    <blockquote className={`my-6 rounded-2xl border-l-4 px-5 py-4 ${styles}`}>
      <div className="flex items-start gap-3">
        {React.createElement(icon, { className: "mt-0.5 h-4 w-4 shrink-0" })}
        <div className="min-w-0 text-sm leading-7 [&_p]:m-0 [&_p+_p]:mt-3">{children}</div>
      </div>
    </blockquote>
  );
}

export function WikiContent({ content }: { content: string }) {
  return (
    <div className="text-[15px] leading-7 text-slate-800 dark:text-slate-200">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <Heading level={4}>{children}</Heading>,
          h2: ({ children }) => <Heading level={2}>{children}</Heading>,
          h3: ({ children }) => <Heading level={3}>{children}</Heading>,
          h4: ({ children }) => <Heading level={4}>{children}</Heading>,
          p: ({ children }) => <p className="mt-4 text-slate-800 dark:text-slate-200">{children}</p>,
          ul: ({ children }) => <ul className="mt-4 list-disc space-y-2 pl-6 marker:text-blue-300">{children}</ul>,
          ol: ({ children }) => <ol className="mt-4 list-decimal space-y-2 pl-6 marker:text-blue-300">{children}</ol>,
          li: ({ children }) => <li className="pl-1 text-slate-800 dark:text-slate-200">{children}</li>,
          hr: () => <hr className="my-8 border-gray-200 dark:border-white/10" />,
          a: ({ href, children }) => {
            const isExternal = Boolean(href && /^https?:\/\//.test(href));
            if (!href) return <span>{children}</span>;
            if (isExternal) {
              return (
                <a href={href} target="_blank" rel="noreferrer" className="font-medium text-blue-300 underline decoration-blue-400/40 underline-offset-4 transition hover:text-blue-200">
                  {children}
                </a>
              );
            }
            return (
              <Link href={href} className="font-medium text-blue-300 underline decoration-blue-400/40 underline-offset-4 transition hover:text-blue-200">
                {children}
              </Link>
            );
          },
          blockquote: ({ children }) => <BlockQuote>{children}</BlockQuote>,
          code: (props) => {
            const { className, children } = props;
            const inline = "inline" in props ? Boolean((props as { inline?: boolean }).inline) : false;
            return <CodeBlock className={className} inline={inline}>{children}</CodeBlock>;
          },
          strong: ({ children }) => <strong className="font-semibold text-gray-900 dark:text-white">{children}</strong>,
          table: ({ children }) => (
            <div className="my-6 overflow-x-auto rounded-2xl border border-gray-200 dark:border-white/10">
              <table className="min-w-full border-collapse text-left text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-gray-100 dark:bg-white/[0.04] text-slate-800 dark:text-slate-200">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-white/10">{children}</tbody>,
          tr: ({ children }) => <tr className="align-top">{children}</tr>,
          th: ({ children }) => <th className="px-4 py-3 font-semibold">{children}</th>,
          td: ({ children }) => <td className="px-4 py-3 text-slate-700 dark:text-slate-300">{children}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
