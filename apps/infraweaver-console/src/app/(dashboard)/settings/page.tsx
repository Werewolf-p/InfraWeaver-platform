"use client";
import { motion } from "framer-motion";
import { Bell, RefreshCw, Palette } from "lucide-react";

export default function SettingsPage() {
  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-white">Settings</h2>
        <p className="text-sm text-slate-400">Console preferences and configuration</p>
      </div>
      <div className="max-w-2xl space-y-4">
        {[
          { icon: RefreshCw, title: "Polling Interval", description: "How often to refresh cluster data", value: "30 seconds" },
          { icon: Palette, title: "Theme", description: "Console color theme", value: "Dark (Slate)" },
          { icon: Bell, title: "Notifications", description: "Alert preferences", value: "Enabled" },
        ].map(setting => (
          <motion.div
            key={setting.title}
            whileHover={{ x: 2 }}
            className="bg-white/5 border border-white/10 rounded-xl p-5 flex items-center justify-between"
          >
            <div className="flex items-center gap-4">
              <div className="w-9 h-9 rounded-lg bg-indigo-500/20 flex items-center justify-center">
                <setting.icon className="w-4 h-4 text-indigo-400" />
              </div>
              <div>
                <p className="text-sm font-medium text-white">{setting.title}</p>
                <p className="text-xs text-slate-400">{setting.description}</p>
              </div>
            </div>
            <span className="text-sm text-slate-300 bg-white/5 border border-white/10 px-3 py-1 rounded-lg">{setting.value}</span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
