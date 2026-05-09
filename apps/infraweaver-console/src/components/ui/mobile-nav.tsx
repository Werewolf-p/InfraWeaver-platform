"use client";
import { usePathname, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { LayoutDashboard, Box, Activity, FileText, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const mobileNavItems = [
  { href: "/",        icon: LayoutDashboard, label: "Dashboard" },
  { href: "/apps",    icon: Box,             label: "Apps" },
  { href: "/health",  icon: Activity,        label: "Health" },
  { href: "/logs",    icon: FileText,        label: "Logs" },
  { href: "/settings",icon: Settings,        label: "Settings" },
];

export function MobileNav() {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <nav
      aria-label="Mobile navigation"
      className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-slate-950/90 backdrop-blur-md border-t border-white/10 flex items-center justify-around px-2 pb-safe"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 8px)" }}
    >
      {mobileNavItems.map((item) => {
        const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
        return (
          <motion.button
            key={item.href}
            whileTap={{ scale: 0.88 }}
            onClick={() => router.push(item.href)}
            className="relative flex flex-col items-center justify-center gap-0.5 min-w-[56px] min-h-[48px] px-3 py-2 rounded-xl transition-colors"
          >
            {isActive && (
              <motion.div
                layoutId="mobile-nav-pill"
                className="absolute inset-0 bg-indigo-500/20 rounded-xl border border-indigo-500/30"
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
              />
            )}
            <item.icon
              className={cn(
                "w-5 h-5 relative",
                isActive ? "text-indigo-400" : "text-slate-500"
              )}
            />
            <span
              className={cn(
                "text-[10px] font-medium relative",
                isActive ? "text-indigo-300" : "text-slate-600"
              )}
            >
              {item.label}
            </span>
          </motion.button>
        );
      })}
    </nav>
  );
}
