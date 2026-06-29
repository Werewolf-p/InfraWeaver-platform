import type { AddonManifest } from "@/lib/addon-sdk/types";

const manifest: AddonManifest = {
  id: "wordpress-manager",
  name: "WordPress Manager",
  version: "1.1.0",
  description: "Provision secure WordPress sites with auto-generated secrets, DNS, Traefik, a plugin manager, and Authentik SSO",
  icon: "Globe",
  category: "infrastructure",
  author: "InfraWeaver",
  apiVersion: "1",
  defaultEnabled: false,
  requiresSetup: false,

  navItems: [
    { href: "/wordpress", label: "WordPress", icon: "Globe", group: "addons", description: "Provision and manage secure WordPress sites" },
  ],

  // Inject a WordPress management tab into the pod detail page — but only on
  // WordPress pods (matched by the component label). The tab derives the site
  // from the pod's infraweaver.io/site label and renders the full site panel.
  podTabs: [
    { value: "wordpress", label: "WordPress", icon: "Globe", component: "components/pod-tab", matchLabels: { "infraweaver.io/component": "wordpress" }, permission: "wordpress:read" },
  ],

  pages: [
    { path: "/wordpress",        component: "pages/index",       title: "WordPress Manager", group: "infrastructure", requiredPermissions: ["wordpress:read"] },
    { path: "/wordpress/[site]", component: "pages/site-detail", title: "WordPress Site",    group: "infrastructure", requiredPermissions: ["wordpress:read"] },
  ],

  permissions: [
    { id: "wordpress:read",  description: "View WordPress sites and their status" },
    { id: "wordpress:write", description: "Create sites and manage plugins and SSO" },
    { id: "wordpress:admin", description: "Full management including deleting sites" },
  ],
  scopePrefix: "/wordpress/",

  k8s: {
    namespace: "wordpress",
    ownsLabels: { "infraweaver/wordpress": "true" },
  },
};

export default manifest;
