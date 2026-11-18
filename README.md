# KoraCRM — AI WhatsApp Sales OS

Clean-room, decoupled, multi-tenant WhatsApp CRM & AI Sales OS built with **Go**, **PostgreSQL 16 + pgvector**, **Redis**, **MinIO**, **Evolution Go / WAHA**, and **React + Vite + TanStack Router + Tailwind CSS (PWA)**.

## Architecture
- `backend/`:
  - `cmd/api`: REST API (`/api/v1/*`), SSE Realtime Hub, Evolution Go / WAHA / Lead Webhooks, HTTP MCP endpoint (`/api/v1/mcp`).
  - `cmd/mcp`: Native Go MCP Server (`stdio` JSON-RPC 2.0) exposing 7 CRM tools.
  - `cmd/worker`: Background `event_log` worker for AI turns, RAG, and handoffs.
  - `migrations/`: PostgreSQL schema (32 multi-tenant tables).
- `frontend/`: Mobile-first PWA (3-column desktop / 2-step mobile Inbox, Kanban, Customer 360°, AI/RAG, Channels, LGPD).
- `deploy/`: Dockerfiles, `docker-compose.yml` (dev), `docker-compose.prod.yml` (full stack + Caddy TLS), and `DEPLOY.md`.
- `replica/`: Clean-room recon, differentiation, architecture, design tokens, brand, and parity artifacts.

## Quick Start (Docker Compose)
```bash
cd deploy
docker compose -f docker-compose.prod.yml up -d --build
```
See [`deploy/DEPLOY.md`](deploy/DEPLOY.md) for DNS, TLS, and MCP token setup.
