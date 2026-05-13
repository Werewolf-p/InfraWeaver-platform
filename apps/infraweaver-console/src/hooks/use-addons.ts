"use client";
import { useState, useEffect, useCallback } from "react";
import { ADDONS, type Addon } from "@/lib/addons";

interface AddonChangeDetail {
  addons?: Addon[];
}

async function fetchAddons() {
  const res = await fetch("/api/addons", { cache: "no-store" });
  if (!res.ok) {
    const error = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(error?.error ?? "Failed to load addons");
  }
  return res.json() as Promise<Addon[]>;
}

async function updateAddon(id: string, enabled: boolean) {
  const res = await fetch(`/api/addons/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(error?.error ?? "Failed to update addon");
  }

  return res.json() as Promise<Addon[]>;
}

export function useAddons() {
  const [addons, setAddons] = useState<Addon[]>(ADDONS);
  const [mounted, setMounted] = useState(false);

  const publishAddons = useCallback((nextAddons: Addon[]) => {
    setAddons(nextAddons);
    window.dispatchEvent(new CustomEvent<AddonChangeDetail>("addon-changed", { detail: { addons: nextAddons } }));
  }, []);

  useEffect(() => {
    let active = true;

    fetchAddons()
      .then((nextAddons) => {
        if (active) {
          setAddons(nextAddons);
          setMounted(true);
        }
      })
      .catch(() => {
        if (active) {
          setAddons(ADDONS);
          setMounted(true);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const handleAddonChanged = (event: Event) => {
      const detail = (event as CustomEvent<AddonChangeDetail>).detail;
      if (detail?.addons) {
        setAddons(detail.addons);
      }
    };

    window.addEventListener("addon-changed", handleAddonChanged);
    return () => window.removeEventListener("addon-changed", handleAddonChanged);
  }, []);

  const enableAddon = useCallback(async (id: string) => {
    publishAddons(await updateAddon(id, true));
  }, [publishAddons]);

  const disableAddon = useCallback(async (id: string) => {
    publishAddons(await updateAddon(id, false));
  }, [publishAddons]);

  const isEnabled = useCallback((id: string) => {
    return addons.find((addon) => addon.id === id)?.enabled ?? false;
  }, [addons]);

  return { addons, enableAddon, disableAddon, isEnabled, mounted };
}
