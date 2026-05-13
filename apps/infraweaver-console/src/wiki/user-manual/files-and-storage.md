InfraWeaver exposes file and storage workflows in a way that stays close to Kubernetes concepts without forcing every operator to open kubectl first.

## Files in the Game Hub

Each game server mounts a persistent volume into its container. The Files tab lets you inspect that mounted path directly.

Common uses include:

- editing `.properties`, `.json`, `.yaml`, or `.cfg` files
- uploading mods, maps, or save files
- deleting stale logs or backups
- validating that a generated file actually landed on disk

## Storage fundamentals

Under the hood, most persistent data is backed by Longhorn PVCs. The console surfaces PVC information indirectly through server setup flows and directly through storage-oriented pages.

## Safe editing workflow

1. Stop the server or trigger a save if the game supports it.
2. Download a backup copy of the file you plan to change.
3. Make the edit in the Files tab.
4. Save and restart the workload if needed.
5. Watch logs for parse errors or startup failures.

> **Warning:** Editing files while a world is actively writing data can corrupt saves or leave partial configuration changes in place.

## Uploading content

Upload is best for:

- maps and worlds
- plugin jars or mod files
- static configuration bundles

Large uploads should still be planned. A UI upload is convenient, but it is not a replacement for versioned, reviewable configuration when the file is critical.

## Storage troubleshooting tips

If a file change does not stick:

- confirm you are editing the mounted data path rather than a temporary container path
- check PVC health and attachment state
- verify the container did not restart into a new pod with a different failing init path
- confirm Longhorn has not marked the volume degraded
