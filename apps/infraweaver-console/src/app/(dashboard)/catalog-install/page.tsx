"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function CatalogInstallRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/apps?tab=catalog"); }, [router]);
  return null;
}
