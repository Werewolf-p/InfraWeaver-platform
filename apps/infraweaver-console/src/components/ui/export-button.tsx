"use client";
import { useState } from "react";
import { Download, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

type ExportFormat = "csv" | "json" | "yaml";

interface ExportButtonProps {
  getData: (format: ExportFormat) => string | Promise<string>;
  filename?: string;
  className?: string;
  formats?: ExportFormat[];
}

export function ExportButton({ getData, filename = "export", className, formats = ["csv", "json"] }: ExportButtonProps) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const handleExport = async (format: ExportFormat) => {
    setExporting(true);
    setOpen(false);
    try {
      const content = await getData(format);
      const mimeMap: Record<ExportFormat, string> = {
        csv: "text/csv",
        json: "application/json",
        yaml: "text/yaml",
      };
      const blob = new Blob([content], { type: mimeMap[format] });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filename}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className={cn("relative", className)}>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={exporting}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 hover:bg-gray-100 dark:hover:bg-white/10 text-gray-600 dark:text-white/70 hover:text-gray-900 dark:hover:text-white transition-all"
      >
        <Download className="w-3.5 h-3.5" />
        Export
        <ChevronDown className="w-3 h-3 opacity-50" />
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -4, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.97 }}
              transition={{ duration: 0.1 }}
              className="absolute right-0 top-9 z-30 w-28 rounded-lg border border-gray-200 dark:border-white/10 bg-neutral-900 shadow-xl overflow-hidden"
            >
              {formats.map(f => (
                <button
                  key={f}
                  onClick={() => void handleExport(f)}
                  className="w-full px-3 py-2 text-left text-xs text-gray-600 dark:text-white/70 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/10 uppercase font-medium transition-colors"
                >
                  {f}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
