# RBAC v2 design

## Goals
- Keep Azure-style built-in roles and scoped assignments.
- Support platform-wide and per-game-server delegation.
- Remain backward compatible with legacy role IDs and current Authentik group mappings.

## Built-in roles
- `platform-owner`
- `platform-admin`
- `platform-operator`
- `platform-viewer`
- `game-server-admin`
- `game-server-operator`
- `game-server-viewer`

## Scope model
- `/` for full platform scope
- `/game-hub/` for all game-hub resources
- `/game-hub/servers/<name>` for a single server

## Storage model
Assignments live in `users.yaml` per user with:
- `id`
- `roleId`
- `scope`
- `principalType`
- `principalId`
- `grantedBy`
- `grantedAt`
- optional `expiresAt`

## Compatibility
- Legacy game-hub role IDs are mapped to new built-ins through aliases.
- Existing Authentik groups still resolve through legacy platform role helpers where needed.

## API surface
- `GET /api/security/roles`
- `GET/POST/DELETE /api/users-config/[username]/rbac`
- rewritten `/api/rbac/roles`
- rewritten `/api/rbac/assignments`
- rewritten `/api/rbac/my-permissions`

## Enforcement points
- Shared permission evaluation in `src/lib/rbac.ts`
- game-hub scoped helpers in `src/lib/game-hub.ts`
- users config normalization in `src/lib/users-config.ts`
