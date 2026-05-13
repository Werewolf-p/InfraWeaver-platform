InfraWeaver uses scoped RBAC so platform owners can grant exactly the access a user needs without handing out blanket admin rights.

## Platform roles

| Role | Typical use | Key permissions |
| --- | --- | --- |
| `platform-owner` | Full platform ownership | `*` |
| `platform-admin` | Day-to-day platform administration | apps, config, users, cluster, security, game hub |
| `platform-operator` | Safe operational workflows | sync, read access, catalog updates, cluster visibility |
| `platform-viewer` | Read-only platform visibility | health, apps, security, infra, game hub read |

## Game Hub roles

| Role | What it allows |
| --- | --- |
| `game-server-admin` | Full control of the scoped server(s), including console, files, start/stop, scaling, and admin actions |
| `game-server-operator` | Operate a server without full administration; includes console, files, start, and stop |
| `game-server-viewer` | Read-only access to status and player information |

## Wiki roles

| Role | What it allows |
| --- | --- |
| `wiki-viewer` | Explicit wiki read access for scoped assignments or future access controls |
| `wiki-editor` | Shows the **Edit on GitHub** action and grants wiki edit capability |

## Scoped assignments

InfraWeaver assignments are evaluated against a scope tree.

### Cluster-wide

Scope `/` applies everywhere.

### Game-Hub-wide

Scope `/game-hub/` grants access across all game servers.

### Per-server

Scope `/game-hub/servers/<name>` limits access to one server.

### Wiki

Scope `/wiki` can be used to grant edit rights without also granting platform administration.

## Assigning roles to users

1. Open **Users**.
2. Select the user you want to update.
3. Open the role assignments panel.
4. Choose a role, then choose the correct scope.
5. Save the assignment.

Role assignments are stored in `users.yaml`, which means access changes are reviewable and survive pod restarts.

## What each permission allows

Permissions are intentionally granular. A few examples:

- `game-hub:read` — list and inspect accessible game servers
- `game-hub:console` — send console commands and read interactive output
- `game-hub:files` — open, edit, and upload files inside the mounted game data path
- `game-hub:start` / `game-hub:stop` — power controls
- `users:read` / `users:write` — view or change platform user configuration
- `wiki:read` — view wiki pages
- `wiki:edit` — show edit affordances and allow wiki maintenance workflows

> **Note:** Platform roles and scoped assignments combine. A user can be a platform viewer at `/` and still be a game server admin for a single server.
