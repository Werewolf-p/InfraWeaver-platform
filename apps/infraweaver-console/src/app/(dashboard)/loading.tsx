import { Loader2 } from "lucide-react";

export default function DashboardLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0f0f0f]">
      <Loader2 className="h-10 w-10 animate-spin text-[#0078D4]" />
    </div>
  );
}
