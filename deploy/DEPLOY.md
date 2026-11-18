# KoraCRM Production Deployment Guide

## 1. DNS & TLS
- Point an `A` record for your domain (e.g., `crm.yourdomain.com`) to your VPS public IP.
- Caddy automatically provisions and renews Let's Encrypt TLS certificates when `CRM_DOMAIN=crm.yourdomain.com` is set.

## 2. Environment Variables
Create `.env` in `deploy/`:
```env
CRM_DOMAIN=crm.yourdomain.com
FRONTEND_ORIGIN=https://crm.yourdomain.com
POSTGRES_USER=postgres
POSTGRES_PASSWORD=strong-random-password
POSTGRES_DB=koracrm
JWT_SECRET=at-least-32-bytes-random-secret-key
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=strong-minio-password
```

## 3. Launch Production Stack
```bash
cd deploy
docker compose -f docker-compose.prod.yml up -d --build
```

## 4. Verify Health
- `curl https://crm.yourdomain.com/healthz` -> `{"status":"ok"}`
- Open `https://crm.yourdomain.com` -> Installable PWA + Signup / Login.

## 5. Connect Native Go MCP Server
Generate an API token in **Settings -> MCP API Tokens** (`crm_...`), then point any MCP client to `POST https://crm.yourdomain.com/api/v1/mcp` with `Authorization: Bearer crm_<token>`, or run `cmd/mcp` over stdio with `CRM_API_TOKEN=crm_<token>`.
