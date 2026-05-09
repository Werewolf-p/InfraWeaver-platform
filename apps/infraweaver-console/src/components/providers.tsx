"use client";
import { SessionProvider } from "next-auth/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { useState } from "react";
import { SettingsProvider } from "@/contexts/settings-context";
import { CommandPalette } from "@/components/ui/command-palette";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { retry: 2, staleTime: 10000 },
    },
  }));

  return (
    <SessionProvider>
      <QueryClientProvider client={queryClient}>
        <SettingsProvider>
          {children}
          <CommandPalette />
          <Toaster richColors position="top-right" />
        </SettingsProvider>
      </QueryClientProvider>
    </SessionProvider>
  );
}
