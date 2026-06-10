The `/dns` page is the operator-friendly layer on top of managed Cloudflare DNS records. It focuses on records owned by InfraWeaver and intentionally keeps the workflow simple: list, add, edit, and delete.

## `/dns` page overview

The DNS page shows managed records with their:

- hostname
- type (`A`, `AAAA`, `CNAME`, `TXT`, or `SRV` where supported)
- current value or content
- TTL
- whether the record is internal or public
- creation and update timestamps when Cloudflare provides them

## Internal DNS vs public DNS

InfraWeaver uses two practical DNS zones:

### Internal DNS — `*.int.example.com`

Internal records are intended for trusted access paths such as NetBird-connected clients, internal dashboards, and private game endpoints.

Use internal DNS when:

- the service should only be reachable over VPN
- you are testing a service before public exposure
- you want a stable internal hostname for operators and automation

### Public DNS — `*.example.com`

Public records are for services intentionally exposed outside the VPN.

Use public DNS when:

- a web app should be reachable from the internet
- you have already placed the app behind Traefik + Authentik or another hardened path
- TLS and policy controls are ready

> **Warning:** Public DNS should be the last step in the exposure workflow, not the first. Verify ingress, authentication, and health before creating a public record.

## Adding a DNS record

1. Open **DNS**.
2. Click **Add record**.
3. Enter the short hostname, value, record type, and TTL.
4. Choose whether the record is internal or public.
5. Save the record.

InfraWeaver expands the short name into the managed zone automatically.

## Editing and deleting records

Existing records can be patched inline from the list view or from a record dialog. Typical edits include changing the target IP, updating TTL, or swapping a service endpoint during maintenance.

Delete a record when:

- a temporary test service has been retired
- a hostname is being re-used for a different service later
- the old record is causing confusion or stale routing

## How Cloudflare integration works

The console talks to the Cloudflare API using the configured `CLOUDFLARE_API_TOKEN`. The DNS page only exposes records that match the managed naming rules defined in the app, which prevents the UI from becoming a generic full-zone editor.

InfraWeaver stores no secret DNS credentials in the repo. The token comes from the deployment environment.

## DNS for game servers

Game Hub pages include a quick-add helper so you can create a hostname while reviewing the server itself. Use that shortcut when you already know the server is healthy and simply need a memorable endpoint for players.
