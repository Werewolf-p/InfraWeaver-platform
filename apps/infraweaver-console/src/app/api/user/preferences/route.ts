import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";
import { getUserPreferences, updateUserPreferences } from "@/lib/user-preferences-server";

const dashboardLayoutSchema = z.object({
  widgets: z.record(z.string(), z.boolean()).optional(),
  navSections: z.record(z.string(), z.boolean()).optional(),
  density: z.enum(["compact", "comfortable"]).optional(),
  startPage: z.string().min(1).optional(),
});

const recentlyVisitedSchema = z.object({
  href: z.string().min(1),
  title: z.string().min(1),
  visitedAt: z.number().int().nonnegative(),
});

const recentSearchSchema = z.object({
  query: z.string().min(1),
  usedAt: z.number().int().nonnegative(),
});

const updatePreferencesSchema = z.object({
  dashboardLayout: dashboardLayoutSchema.optional(),
  pinnedApps: z.array(z.string().min(1)).optional(),
  theme: z.enum(["light", "dark", "system"]).optional(),
  recentlyVisited: z.array(recentlyVisitedSchema).max(10).optional(),
  recentSearches: z.array(recentSearchSchema).max(8).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: "No preferences provided",
});

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { preferences } = await getUserPreferences(session);
    return NextResponse.json(preferences);
  } catch (error) {
    return NextResponse.json(
      { error: safeError(error) },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!checkRateLimit(rateLimitKey("user-preferences-put", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = updatePreferencesSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid preferences payload" }, { status: 400 });
  }

  try {
    const { preferences } = await updateUserPreferences(session, parsed.data);
    return NextResponse.json(preferences);
  } catch (error) {
    return NextResponse.json(
      { error: safeError(error) },
      { status: 500 }
    );
  }
}
