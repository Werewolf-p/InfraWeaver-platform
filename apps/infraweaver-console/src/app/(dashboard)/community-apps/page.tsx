"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function CommunityAppsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/apps?tab=community"); }, [router]);
  return null;
}
