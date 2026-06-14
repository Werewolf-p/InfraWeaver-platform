import type { AddonManifest } from "@/lib/addon-sdk/types";

const manifest: AddonManifest = {
  id: "game-hub",
  name: "Game Hub",
  version: "1.0.0",
  description: "Deploy and manage game servers (Minecraft, Terraria, Valheim, etc.) directly on Kubernetes",
  icon: "Gamepad2",
  category: "gaming",
  author: "InfraWeaver",
  apiVersion: "1",
  defaultEnabled: true,
  requiresSetup: true,
  setupPath: "/game-hub/setup",

  navItems: [
    { href: "/game-hub", label: "Game Hub", icon: "Gamepad2", group: "gaming" },
  ],

  pages: [
    { path: "/game-hub",        component: "pages/index",         title: "Game Hub",           group: "gaming", requiredPermissions: ["game-hub:read"] },
    { path: "/game-hub/setup",  component: "pages/setup",         title: "Game Hub Setup",     group: "gaming", requiredPermissions: ["game-hub:admin"] },
    { path: "/game-hub/new",    component: "pages/new",           title: "New Game Server",    group: "gaming", requiredPermissions: ["game-hub:admin"] },
    { path: "/game-hub/create", component: "pages/create",        title: "Create Game Server", group: "gaming", requiredPermissions: ["game-hub:admin"] },
    { path: "/game-hub/[name]", component: "pages/server-detail", title: "Server Detail",      group: "gaming", requiredPermissions: ["game-hub:read"] },
  ],

  permissions: [
    { id: "game-hub:read",  description: "View game servers and their status" },
    { id: "game-hub:write", description: "Create and configure game servers" },
    { id: "game-hub:admin", description: "Full game server management including delete and stop" },
  ],
  scopePrefix: "/game-hub/",

  k8s: {
    namespace: "game-hub",
    ownsLabels: { "infraweaver/game": "true" },
  },
};

export default manifest;
