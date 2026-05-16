# Enterprise usability improvements — 2026-05

## Scope
- Hardened key InfraWeaver console workflows for faster triage, safer destructive actions, and clearer status feedback.
- Focused on dashboard usability in:
  - `apps`
  - `apps/[name]`
  - `cluster`
  - `config-maps`
  - `home`
  - `pods`
  - `secrets`
  - `users`

## What shipped
- Apps list/detail flows now use clearer action patterns, safer confirmations, and relative timestamps.
- Cluster maintenance actions now require confirmation and node metadata is easier to scan/copy.
- Secrets and ConfigMaps management now support search-first workflows, relative age displays, and safer deletion UX.
- Pods page now uses relative timestamps and confirms bulk restart/delete actions before execution.
- Users page now uses the shared search input for consistency.
- Home dashboard received the enterprise usability refresh already reflected in the working tree and was kept in this validation pass.

## UX patterns reinforced
- Shared `SearchInput` for consistent discoverability.
- Shared `ConfirmDialog` for destructive or high-impact actions.
- Shared `RelativeTime` for readable timestamps.
- `ActionsMenu` for dense row/card actions where space is constrained.
- Copy affordances where operators frequently reuse identifiers.

## Validation
- `cd apps/infraweaver-console && npx tsc --noEmit` ✅

## Notes
- Preserved the existing typed delete flow on the users page because it is stricter than a generic confirmation dialog.
- Added requested memory file after final TypeScript validation.
