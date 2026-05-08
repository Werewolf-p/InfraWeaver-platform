"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useRBAC } from "@/hooks/use-rbac";
import { getRole } from "@/lib/rbac";
import { Users, Shield, Eye } from "lucide-react";
import { cn } from "@/lib/utils";

export default function UsersPage() {
  const { can } = useRBAC();

  const { data: users, isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const res = await fetch("/api/config/users");
      if (!res.ok) throw new Error("Failed to load users");
      return res.json();
    },
    enabled: can("users:read"),
  });

  const roleColors = {
    admin: "bg-red-500/10 text-red-400 border border-red-500/20",
    operator: "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20",
    viewer: "bg-blue-500/10 text-blue-400 border border-blue-500/20",
    unknown: "bg-slate-500/10 text-slate-400 border border-slate-500/20",
  };

  const roleIcons = {
    admin: Shield,
    operator: Users,
    viewer: Eye,
    unknown: Eye,
  };

  if (!can("users:read")) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400">
        <div className="text-center">
          <Shield className="w-10 h-10 mb-3 mx-auto opacity-30" />
          <p>Insufficient permissions</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-white">Users</h2>
        <p className="text-sm text-slate-400">Platform users and their roles</p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => <div key={i} className="h-36 rounded-xl bg-white/5 animate-pulse" />)}
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
        >
          {users?.map((user: { username: string; email?: string; groups?: string[] }) => {
            const role = getRole(user.groups ?? []);
            const RoleIcon = roleIcons[role];
            return (
              <motion.div
                key={user.username}
                whileHover={{ scale: 1.01 }}
                className="bg-white/5 border border-white/10 rounded-xl p-5"
              >
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center font-bold text-indigo-300">
                    {user.username?.[0]?.toUpperCase() ?? "?"}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">{user.username}</p>
                    <p className="text-xs text-slate-400">{user.email ?? "No email"}</p>
                  </div>
                </div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs text-slate-500">Role</span>
                  <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium flex items-center gap-1", roleColors[role])}>
                    <RoleIcon className="w-3 h-3" />
                    {role}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {(user.groups ?? []).map((group: string) => (
                    <span key={group} className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-white/5">
                      {group}
                    </span>
                  ))}
                </div>
              </motion.div>
            );
          })}
        </motion.div>
      )}
    </div>
  );
}
