# Honeybot Helm chart

Deploys Honeybot as a single Kubernetes Deployment for k3s or any standard cluster.

Honeybot has no inbound HTTP server, so the chart does not create a Service or Ingress. The pod connects outbound to Discord and model providers.

## Install

Build and push an image first:

```bash
docker build -f docker/Dockerfile -t ghcr.io/YOUR_ORG/honeybot:0.1.0 .
docker push ghcr.io/YOUR_ORG/honeybot:0.1.0
```

Generate a 32-byte encryption key:

```bash
openssl rand -base64 32
```

Install:

```bash
helm upgrade --install honeybot ./charts/honeybot \
  --namespace honeybot --create-namespace \
  --set image.repository=ghcr.io/YOUR_ORG/honeybot \
  --set image.tag=0.1.0 \
  --set secrets.discordToken='YOUR_DISCORD_TOKEN' \
  --set secrets.openrouterApiKey='YOUR_OPENROUTER_KEY' \
  --set secrets.apiKeyEncryptionKey='BASE64_32_BYTE_KEY' \
  --set env.GLOBAL_AUTH_TEAM_ID='YOUR_DISCORD_APP_TEAM_ID'
```

For user-list global admin mode instead of Discord team mode:

```bash
--set env.GLOBAL_AUTH_MODE=users \
--set env.GLOBAL_AUTH_USER_IDS='123456789,987654321'
```

## Persistence

The chart creates a ReadWriteOnce PVC mounted at `/app/data` by default. SQLite, stored evidence images, and persistent admin verbose state live there.

Defaults:

```yaml
persistence:
  enabled: true
  accessModes: [ReadWriteOnce]
  size: 1Gi
```

Use an existing claim:

```yaml
persistence:
  existingClaim: honeybot-data
```

## Existing Secret

If you manage secrets outside Helm:

```yaml
secret:
  create: false
  existingSecret: honeybot-secret
  keys:
    discordToken: DISCORD_TOKEN
    openrouterApiKey: OPENROUTER_API_KEY
    apiKeyEncryptionKey: API_KEY_ENCRYPTION_KEY
```

The Secret must contain the keys above.

## k3s notes

- `replicaCount` should stay `1`; Honeybot uses SQLite on a single-writer PVC.
- The Deployment uses `Recreate` strategy to avoid two pods writing to the same SQLite database during upgrades.
- The image runs as UID/GID `10001`; the chart sets `fsGroup: 10001` so k3s-created volumes are writable.
