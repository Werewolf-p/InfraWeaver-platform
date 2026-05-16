"use client";
import { SessionProvider } from "next-auth/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { createQueryClient } from "@/lib/query-client";
import { useState, createContext, useContext, useEffect, type ReactNode } from "react";
import { SettingsProvider } from "@/contexts/settings-context";
import { ClusterProvider } from "@/contexts/cluster-context";
import { KeyboardShortcutsProvider } from "@/components/ui/keyboard-shortcuts-modal";
import { OnboardingWizard } from "@/components/ui/onboarding-wizard";

// ─── Theme Context ───────────────────────────────────────────────────────────

type Theme = "dark" | "system";
type Density = "compact" | "comfortable" | "spacious";

interface ThemeContextValue {
  theme: Theme;
  density: Density;
  setTheme: (t: Theme) => void;
  setDensity: (d: Density) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "dark",
  density: "comfortable",
  setTheme: () => {},
  setDensity: () => {},
});

export function useThemeContext() {
  return useContext(ThemeContext);
}

function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");
  const [density, setDensityState] = useState<Density>("comfortable");

  useEffect(() => {
    try {
      const t = localStorage.getItem("iw-theme") as Theme | null;
      const d = localStorage.getItem("iw-density") as Density | null;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (t) setThemeState(t);
      if (d) setDensityState(d);
    } catch {}
  }, []);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    try { localStorage.setItem("iw-theme", t); } catch {}
    const root = document.documentElement;
    if (t === "system") {
      root.classList.remove("dark", "light");
    } else {
      root.classList.remove("light");
      root.classList.add(t === "dark" ? "" : "light");
    }
  };

  const setDensity = (d: Density) => {
    setDensityState(d);
    try { localStorage.setItem("iw-density", d); } catch {}
    const body = document.body;
    body.classList.remove("density-compact", "density-comfortable", "density-spacious");
    body.classList.add(`density-${d}`);
  };

  useEffect(() => {
    document.body.classList.add("noise-bg");
    document.body.classList.add(`density-${density}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, density, setTheme, setDensity }}>
      {children}
    </ThemeContext.Provider>
  );
}

// ─── Providers ───────────────────────────────────────────────────────────────

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => createQueryClient());

  return (
    <SessionProvider>
      <QueryClientProvider client={queryClient}>
        <SettingsProvider>
          <ClusterProvider>
            <ThemeProvider>
              {children}
              <KeyboardShortcutsProvider />
              <OnboardingWizard />
              <Toaster richColors position="top-right" />
            </ThemeProvider>
          </ClusterProvider>
        </SettingsProvider>
      </QueryClientProvider>
    </SessionProvider>
  );
}
