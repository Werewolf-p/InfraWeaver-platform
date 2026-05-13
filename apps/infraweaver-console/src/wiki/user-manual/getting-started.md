InfraWeaver Console is the day-to-day control plane for the homelab cluster. It brings game servers, community apps, DNS, storage, health signals, and access management into one authenticated dashboard so operators do not have to jump between ArgoCD, Kubernetes dashboards, Grafana, and Cloudflare tabs.

## What InfraWeaver Console is for

Use the console when you need to:

- deploy or manage a game server from the Game Hub
- inspect cluster health, nodes, quotas, and uptime
- install community apps into the cluster catalog
- manage DNS records for internal or public access
- grant users scoped access to servers and platform features

> **Note:** InfraWeaver is an operations console, not a public landing page. Most routes assume you are already connected through NetBird or coming through the Traefik + Authentik entrypoint.

## Logging in with Authentik SSO

1. Open the InfraWeaver Console URL provided by the platform owner.
2. If you are not already authenticated, you will be redirected to Authentik.
3. Sign in with your InfraWeaver account.
4. After a successful login, NextAuth creates a session cookie and returns you to the dashboard.

If login fails, confirm that:

- your account exists in Authentik
- you are assigned to the expected group such as `platform-users`
- your browser is not blocking the authentication redirect or secure cookies

## Understanding the sidebar navigation

The left sidebar is grouped by workflow rather than by Kubernetes resource type.

### Overview

Home, Dashboard, and Platform Status summarize what is happening right now.

### Applications

Apps and Activity Log focus on deployments and recent changes.

### Infrastructure and Monitoring

DNS, storage, certificates, health, uptime, and security all live here. These pages help you answer, “Is the platform healthy?” before you change anything.

### Gaming

The Game Hub is where you deploy and operate game servers. Server-level tabs provide console access, files, live metrics, RBAC, and DNS helpers.

### Settings

Use Users, RBAC, and Addons to manage who can access which features.

## Quick start: deploy your first game server

1. Open **Game Hub** from the sidebar.
2. Click **New Server**.
3. In **Browse Eggs**, choose a built-in egg like Minecraft Java or a Pelican catalog egg.
4. In **Configure Variables**, review required environment variables such as `EULA`, server name, world name, or password.
5. In **Resources**, choose memory, CPU, storage, storage class, and optional DNS hostname.
6. In **Deploy**, review the generated summary and confirm.
7. Wait for the deployment, PVC, Service, and ConfigMap to be created in the `game-hub` namespace.

> **Warning:** Do not over-allocate memory just because a node still has free RAM. Game servers run with lower priority than platform-critical services. Overcommit can still cause noisy neighbor problems.

## Understanding the home dashboard

The dashboard is designed to answer four questions quickly:

### Is the cluster healthy?

Health and node widgets summarize overall status and surface degradations early.

### Are core services online?

Platform status cards pull together service health, availability, and recent incidents.

### Where should I go next?

The sidebar, quick actions, and favorites help you jump directly into the area that needs attention.

### What changed recently?

Activity timelines, logs, and recent pages give you short-term context so you can correlate a deployment or config change with a new issue.

## First-day checklist

- Confirm you can open Dashboard, Game Hub, DNS, and Users.
- Verify your role assignments on the Users page.
- Deploy a small test server before deploying a large production world.
- Create or verify a DNS record for the service you plan to expose.
- Bookmark the Wiki so operational steps are always close by.
