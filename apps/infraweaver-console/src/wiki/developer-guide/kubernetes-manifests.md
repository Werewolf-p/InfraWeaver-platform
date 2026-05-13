## Manifest layout

InfraWeaver keeps Kubernetes manifests close to the application and catalog structure so operators can reason about runtime state from the repo layout.

Common directories include:

- `kubernetes/catalog/<app>/manifests/`
- `kubernetes/bootstrap/`
- `kubernetes/catalog/game-hub/servers/`

## Common manifest types

### Deployment

Used for the console itself, stateless services, and most game server workloads.

### Service

Exposes HTTP, TCP, or UDP traffic internally or externally.

### PersistentVolumeClaim

Used when an app or game server needs persistent storage.

### IngressRoute

Traefik-specific ingress objects route HTTP(S) traffic and integrate with middleware such as Authentik.

### ExternalSecret

Connects OpenBao values to Kubernetes Secrets without checking the secret material into git.

## Naming and labels

Use predictable names and labels so UI queries and operators can find related resources quickly.

Recommended conventions:

- `app: <name>`
- `infraweaver.io/type: <category>`
- `infraweaver.io/source: <feature>`
- `infraweaver/game: "true"` for game server resources

## Example deployment pattern

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: infraweaver-console
  namespace: platform
spec:
  replicas: 1
  selector:
    matchLabels:
      app: infraweaver-console
  template:
    metadata:
      labels:
        app: infraweaver-console
    spec:
      serviceAccountName: infraweaver-console
      containers:
        - name: web
          image: onedev.rlservers.com/infraweaver/infraweaver-console:main-<sha>
          envFrom:
            - secretRef:
                name: infraweaver-console-env
```

## Game Hub manifest specifics

Game Hub server manifests are more opinionated than generic apps. They often include:

- priority class assignment
- persistent game data mounts
- generated egg metadata annotations
- TCP or UDP service definitions based on the selected egg
- safer liveness and readiness probes for long-running game processes

## Review guidelines

Before merging a manifest change, check:

- namespace correctness
- secret references
- resource requests and limits
- storage class choice
- ingress hostnames and middleware
- labels and annotations expected by the console
