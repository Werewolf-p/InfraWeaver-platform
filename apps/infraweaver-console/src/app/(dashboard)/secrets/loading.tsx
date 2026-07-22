import { SkeletonLoader, Skeleton, SkeletonStat, SkeletonTable } from "@/components/ui/skeleton";

// Route-level loading skeleton (App Router `loading.tsx` convention).
// Renders instantly while the page's data/streamed content resolves.
export default function Loading() {
  return (
    <SkeletonLoader label="Loading" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonStat key={i} />
        ))}
      </div>
      <SkeletonTable rows={6} />
    </SkeletonLoader>
  );
}
