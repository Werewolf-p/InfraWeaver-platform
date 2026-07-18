"use client";

import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { FileText, Gauge, LayoutDashboard, ShieldAlert, Waypoints } from "lucide-react";
import { DemoBanner } from "./DummyBadge";
import { EASE_OUT } from "./motion";
import { FleetMonitoring } from "./fleet-monitoring";
import { FleetOverview } from "./fleet-overview";
import { FleetPerformance } from "./fleet-performance";
import { FleetReports } from "./fleet-reports";
import { FleetSecurity } from "./fleet-security";

export type FleetTabId = "overview" | "monitoring" | "security" | "performance" | "reports";

export const FLEET_DEMO_TABS: ReadonlyArray<{ id: FleetTabId; label: string; icon: React.ElementType }> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "monitoring", label: "Monitoring", icon: Waypoints },
  { id: "security", label: "Security", icon: ShieldAlert },
  { id: "performance", label: "Performance", icon: Gauge },
  { id: "reports", label: "Reports", icon: FileText },
];

const PANELS: Readonly<Record<FleetTabId, () => React.ReactElement>> = {
  overview: FleetOverview,
  monitoring: FleetMonitoring,
  security: FleetSecurity,
  performance: FleetPerformance,
  reports: FleetReports,
};

/**
 * The demo fleet-insights surface. Renders the "this is dummy data" banner plus
 * the panel for the active tab. `reducedMotion="user"` makes every child honour
 * the viewer's prefers-reduced-motion setting (crossfade instead of movement).
 */
export function FleetDemoArea({ tab }: { tab: FleetTabId }) {
  const Panel = PANELS[tab];
  return (
    <MotionConfig reducedMotion="user">
      <div className="space-y-5">
        <DemoBanner />
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25, ease: EASE_OUT }}
          >
            <Panel />
          </motion.div>
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
