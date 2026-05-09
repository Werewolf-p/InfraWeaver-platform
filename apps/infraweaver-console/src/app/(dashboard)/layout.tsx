"use client";
import { useState } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/topbar";
import { MobileNav } from "@/components/ui/mobile-nav";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/auth/signin");
    }
  }, [status, router]);

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-950">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <>
      {/* Aurora background — visible globally behind the dashboard */}
      <div className="aurora-bg" aria-hidden="true">
        <div className="aurora-blob aurora-blob-1" />
        <div className="aurora-blob aurora-blob-2" />
        <div className="aurora-blob aurora-blob-3" />
      </div>

      <div className="flex h-screen overflow-hidden">
        {/* Desktop sidebar */}
        <Sidebar variant="desktop" />

        {/* Mobile sidebar drawer (conditional) */}
        {mobileOpen && (
          <Sidebar variant="mobile" onClose={() => setMobileOpen(false)} />
        )}

        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <TopBar onMenuOpen={() => setMobileOpen(true)} />
          <main className="flex-1 overflow-y-auto p-4 md:p-6" style={{ paddingBottom: "max(env(safe-area-inset-bottom) + 72px, 80px)" }}>
            <div className="md:pb-0">
              {children}
            </div>
          </main>
        </div>
      </div>

      {/* Mobile bottom navigation */}
      <MobileNav />
    </>
  );
}
