## Adding a feature to InfraWeaver Console

Most features follow the same vertical slice:

1. a dashboard page in `src/app/(dashboard)/...`
2. supporting UI in `src/components/`
3. shared logic in `src/lib/`
4. an API route in `src/app/api/` when server-side data or mutations are needed
5. RBAC wiring so the feature does not become implicitly public to every admin tool user
6. documentation updates in the wiki

## Recommended workflow

### 1. Define the operator story

Write down the exact action the operator wants to take. Example: “I need to see node pressure before deploying a new game server.”

### 2. Add or update server-side logic

Place Kubernetes, Cloudflare, GitHub, or Prometheus calls in `src/lib/` or an API route, not directly in a client component.

### 3. Add the page or component

Pages under `(dashboard)` should look and behave like the rest of the console:

- use the shared layout
- use `PageHeader`
- reuse existing cards, tables, and badges where possible

### 4. Add RBAC checks

Every mutation route must have an intentional permission gate. Read-only routes should still be reviewed for overexposure.

### 5. Add navigation

Update `nav-config.ts`, route labels, and any search or favorites surfaces that depend on the central nav model.

### 6. Document the feature

Update the wiki whenever you add:

- a new route
- a new operator workflow
- a new environment variable
- a new RBAC role or permission

## Example API pattern

```typescript
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "infra:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ ok: true });
}
```

## Maintenance mindset

Prefer composable helpers and narrow API routes over one giant feature module. InfraWeaver grows cleanly when domain logic stays in `src/lib/` and UI code stays focused on presentation.
