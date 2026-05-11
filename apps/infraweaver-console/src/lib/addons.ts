export interface AddonNavItem {
  href: string;
  label: string;
  icon: string; // lucide icon name as string
  group: string; // which nav group to inject into
}

export interface Addon {
  id: string;
  name: string;
  description: string;
  icon: string; // lucide icon name
  category: 'infrastructure' | 'gaming' | 'networking' | 'monitoring';
  enabled: boolean;
  navItems?: AddonNavItem[];
  requiresSetup?: boolean;
  setupPath?: string;
}

export const ADDONS: Addon[] = [
  {
    id: 'game-hub',
    name: 'Game Hub',
    description: 'Deploy and manage game servers (Minecraft, Terraria, Valheim, etc.) directly on Kubernetes',
    icon: 'Gamepad2',
    category: 'gaming',
    enabled: false,
    requiresSetup: true,
    setupPath: '/game-hub/setup',
    navItems: [{ href: '/game-hub', label: 'Game Hub', icon: 'Gamepad2', group: 'services' }],
  },
  {
    id: 'port-routing',
    name: 'Port Routing',
    description: 'TCP/UDP port routing for dedicated VMs and game servers via DNS routing',
    icon: 'Network',
    category: 'networking',
    enabled: true,
    navItems: [{ href: '/gameservers', label: 'Port Routing', icon: 'Network', group: 'services' }],
  },
];
