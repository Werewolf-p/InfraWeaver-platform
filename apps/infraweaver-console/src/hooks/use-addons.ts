"use client";
import { useState, useEffect, useCallback } from "react";
import { ADDONS, type Addon } from "@/lib/addons";

const STORAGE_KEY = "infraweaver-addons";

export function useAddons() {
  const [addons, setAddons] = useState<Addon[]>(ADDONS);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const enabledIds: string[] = JSON.parse(stored);
        setAddons(ADDONS.map(addon => ({
          ...addon,
          enabled: enabledIds.includes(addon.id) ? true : (addon.id === 'port-routing' ? true : ADDONS.find(a => a.id === addon.id)?.enabled ?? false),
        })));
      } else {
        // First load: persist defaults
        const defaultEnabled = ADDONS.filter(a => a.enabled).map(a => a.id);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(defaultEnabled));
      }
    } catch {}
  }, []);

  const enableAddon = useCallback((id: string) => {
    setAddons(prev => {
      const next = prev.map(a => a.id === id ? { ...a, enabled: true } : a);
      try {
        const enabledIds = next.filter(a => a.enabled).map(a => a.id);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(enabledIds));
        window.dispatchEvent(new CustomEvent("addon-changed", { detail: { id, enabled: true } }));
      } catch {}
      return next;
    });
  }, []);

  const disableAddon = useCallback((id: string) => {
    setAddons(prev => {
      const next = prev.map(a => a.id === id ? { ...a, enabled: false } : a);
      try {
        const enabledIds = next.filter(a => a.enabled).map(a => a.id);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(enabledIds));
        window.dispatchEvent(new CustomEvent("addon-changed", { detail: { id, enabled: false } }));
      } catch {}
      return next;
    });
  }, []);

  const isEnabled = useCallback((id: string) => {
    return addons.find(a => a.id === id)?.enabled ?? false;
  }, [addons]);

  return { addons, enableAddon, disableAddon, isEnabled, mounted };
}
