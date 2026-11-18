# Bloque 1: Consola Super-Admin (S26), Suspensión de Tenants y Sesiones de Soporte

* **Author:** daveestudioinf-cmyk
* **Status:** Approved
* **Date:** 2026-11-18

--------------------------------------------------------------------------------

## Overview

Habilitar la consola de gobernanza cross-tenant **Super-Admin (pantalla `S26` `/admin/*`)** en KoraCRM y hacer cumplir en tiempo de ejecución el aislamiento, la suspensión de organizaciones y las sesiones temporales de soporte definidas en el esquema de base de datos (`000001_init_schema.up.sql`), manteniendo la API REST y el servidor MCP completamente desacoplados.

## The Problem

Aunque el esquema SQL inicial de KoraCRM ya incluye las columnas y tablas de plataforma (`users.is_platform_admin`, `organizations.is_suspended`, `platform_support_sessions` y `api_audit_log.support_session_id`), actualmente no existe ningún enforcement en el backend en Go ni interfaz en el frontend:

1. **Organizaciones suspendidas siguen activas:** `auth.Middleware.RequireAuth` no consulta `organizations.is_suspended`. Un tenant suspendido sigue operando vía JWT, `api_tokens` (`crm_*`), `/api/v1/mcp`, `cmd/mcp` (stdio), webhooks entrantes (WhatsApp y captura de leads) y el worker en segundo plano (`cmd/worker`).
2. **Sin rutas ni middleware de Plataforma:** No existe `RequirePlatformAdmin` ni endpoints `/api/v1/admin/*` para listar organizaciones, suspenderlas/reactivarlas o consultar métricas globales.
3. **Sin sesiones temporales de soporte auditadas (flujo `F08`):** `Identity.SupportSessID` existe en `internal/auth/auth.go`, pero nunca se valida ni se propaga a `api_audit_log.support_session_id` (ni se restringe el modo `support_readonly`).

## Goals

* Hacer cumplir `organizations.is_suspended = false` en toda superficie de acceso del tenant: `RequireTenantAccess` (JWT y `api_tokens`), `/api/v1/mcp`, `cmd/mcp` (stdio, validado en cada llamada RPC), webhooks entrantes (`WAHAWebhook`, `EvolutionWebhook`, `InboundLeadCapture`) y `cmd/worker`.
* Separar la autenticación base (`Authenticate`) del plano de plataforma (`/api/v1/admin/*` con `RequirePlatformAdmin` validado en PostgreSQL) y del plano de tenant (`/api/v1/*` con `RequireTenantAccess`).
* Implementar sesiones temporales de soporte (`platform_support_sessions`) con TTL máximo de 1 hora, exclusivamente en modo `support_readonly` en Bloque 1 (bloqueo de mutaciones `POST`/`PUT`/`PATCH`/`DELETE`), header explícito `X-Support-Session-ID` aceptado solo con JWT humano, `id.Role = "admin"` sintético para inspección, permiso de lectura sobre tenants suspendidos para diagnóstico, y registro obligatorio de `support_session_id` e `ip_address` en `api_audit_log`.
* Construir la vista `/admin` en español en la PWA React y el banner global `ActiveSupportSessionBanner` en `AppShell` con cuenta regresiva del TTL y botón de cierre anticipado.

## Non-Goals

* Implementar llamadas HTTP reales a proveedores LLM, cifrado de `ai_provider_credentials` o cambios de presupuesto en `ai_budgets` (corresponde al Bloque 2).
* Habilitar en la UI de Bloque 1 el modo de soporte con escritura (`full`) — la UI se limita a `support_readonly` aunque la columna SQL soporte el enum.
* Exponer herramientas de administración (`/admin/*`) o gestión de sesiones de soporte dentro del servidor MCP (`cmd/mcp` o `/api/v1/mcp`).
* Construir pantallas secundarias de CRM fuera de `S26` (campañas, agenda, productos UI).

## Critical User Journeys (CUJs)

### CUJ 1: Suspensión inmediata de un tenant (API, MCP, Webhooks y Worker)

* **Given**: Un usuario con `users.is_platform_admin = true` autenticado en `/admin` y una organización activa con tokens `crm_*`, webhooks y sesiones WhatsApp activas (`WORKING`).
* **When**: El Super-Admin suspende la organización desde `/admin` (`PATCH /api/v1/admin/tenants/{id}`).
* **Then**: La organización queda con `is_suspended = true`, se registra el evento en `api_audit_log` bajo el `target_organization_id`, y cualquier petición posterior del tenant vía JWT, `api_tokens`, `/api/v1/mcp`, `cmd/mcp` (en cada llamada RPC), webhooks entrantes o `cmd/worker` es rechazada (`403 tenant_suspended` en HTTP / error en MCP / omisión en worker).

### CUJ 2: Sesión temporal de soporte auditada (TTL 1h, Read-Only)

* **Given**: Un Platform Admin en `/admin` que necesita diagnosticar un incidente en una organización objetivo (activa o suspendida).
* **When**: Inicia una sesión de soporte con motivo obligatorio (`POST /api/v1/admin/support-sessions`, TTL <= 1h, `mode = 'support_readonly'`) y navega en `/app/*` enviando `X-Support-Session-ID`.
* **Then**: `AppShell` muestra `ActiveSupportSessionBanner` con el tiempo restante; las lecturas (`GET`) funcionan con `id.Role = "admin"` y quedan auditadas con `support_session_id`; las mutaciones (`POST`/`PATCH`/`PUT`/`DELETE`) son rechazadas con `403 support_readonly`; y al pulsar "Salir de soporte" (`POST /api/v1/admin/support-sessions/{id}/end`, que ignora `X-Support-Session-ID` y usa el plano `/admin/*`) o al expirar la hora, el acceso se revoca de inmediato.

--------------------------------------------------------------------------------

## Technical Plan (Architecture)

La arquitectura separa el **plano de plataforma (`/api/v1/admin/*`)** del **plano de tenant (`/api/v1/*` y MCP)** mediante middlewares independientes en `cmd/api/main.go`, sin alterar el esquema `000001_init_schema.up.sql`.

```text
Cliente / Admin Browser                    Agente Externo (MCP)
        │                                          │
        ├──► /api/v1/admin/*                       ├──► POST /api/v1/mcp  o  cmd/mcp (stdio)
        │       │                                  │       │
        │       ▼                                  │       ▼
        │   Authenticate + RequirePlatformAdmin    │   mcpserver.HandleRPC
        │   - Valida users.is_platform_admin en BD │   - Rechaza X-Support-Session-ID (403 en HTTP)
        │   - Ignora X-Support-Session-ID          │   - Verifica organizations.is_suspended = false
        │   - Ignora is_suspended de org propia    │     en CADA invocación RPC
        │       │                                  │
        │       ▼                                  └──► Solo datos CRM del tenant
        │   internal/admin/handlers.go
        │     - GET   /api/v1/admin/tenants (paginado)
        │     - PATCH /api/v1/admin/tenants/{id}
        │     - POST  /api/v1/admin/support-sessions
        │     - POST  /api/v1/admin/support-sessions/{id}/end
        │     - GET   /api/v1/admin/metrics
        │
        └──► /api/v1/* (plano de tenant)
                │
                ▼
            Authenticate + RequireTenantAccess
              1. Resuelve JWT o api_token (crm_*).
              2. Si trae X-Support-Session-ID:
                 - Si AuthType != "jwt" -> 403 support_session_jwt_only.
                 - Ignora X-Organization-ID.
                 - Verifica users.is_platform_admin = true y platform_support_sessions
                   (admin_user_id, ended_at IS NULL, expires_at > now()).
                 - Fija id.OrganizationID = target_org_id, id.Role = "admin",
                   id.SupportSessID = session_id, id.SupportMode = mode.
                 - Si mode == 'support_readonly' y método != GET/HEAD/OPTIONS -> 403 support_readonly.
                 - Permite leer tenants con is_suspended = true solo en modo support_readonly.
              3. Si NO hay sesión de soporte:
                 - Verifica organizations.is_suspended = false (si true -> 403 tenant_suspended).
              4. WriteAudit persiste actor_user_id, organization_id (target), support_session_id e ip_address.
```

### Componentes principales

1. **Middleware y Auth (`backend/internal/auth/auth.go` y `handlers.go`):**
   * `Authenticate`: resuelve JWT o `api_token` (`crm_*`), extrae `RemoteIP` (procesado por `chi/middleware.RealIP` + `net.SplitHostPort`) y construye la identidad base sin consultar `is_suspended` ni `X-Support-Session-ID`.
   * `RequirePlatformAdmin`: exige `AuthType == "jwt"` (`403 platform_admin_jwt_only` si es `api_token`) y consulta `users.is_platform_admin` en PostgreSQL en cada petición a `/api/v1/admin/*`.
   * `RequireTenantAccess`: protege `/api/v1/*` del tenant. Valida `X-Support-Session-ID` (solo JWT, prioridad sobre `X-Organization-ID`, `id.Role = "admin"`, bloqueo de escritura en `support_readonly`, excepción de lectura sobre org suspendida y registro automático de `WriteAudit` por petición de soporte) o, en tráfico normal, exige `organizations.is_suspended = false`.
   * `WriteAudit`: persiste `support_session_id` e `ip_address`; en acciones de plataforma recibe explícitamente el `target_organization_id` afectado.
   * `handlers.go`: `Login`, `VerifyMFA` y `Me` incluyen `is_platform_admin` en el JSON de usuario.

2. **Dominio Super-Admin (`backend/internal/admin/handlers.go`):**
   * `GET /api/v1/admin/tenants`: lista organizaciones paginadas (`limit <= 100`, `offset >= 0`) con filtro `q`, `is_suspended` y conteos.
   * `PATCH /api/v1/admin/tenants/{id}`: recibe `{"is_suspended": bool, "reason": string}`, actualiza `organizations.is_suspended` y registra auditoría en el `target_organization_id` dentro de una transacción atómica.
   * `POST /api/v1/admin/support-sessions`: exige `reason` no vacío, valida `mode IN ('support_readonly', 'full')` y `1 <= ttl_minutes <= 60` (default 60), inserta en `platform_support_sessions` y audita sobre el `target_organization_id` dentro de una transacción atómica.
   * `POST /api/v1/admin/support-sessions/{id}/end`: marca `ended_at = now()` y audita sobre el `target_organization_id` dentro de una transacción atómica.
   * `GET /api/v1/admin/metrics`: KPIs globales cross-tenant.

3. **Corte uniforme de suspensión en Worker, Webhooks y MCP:**
   * `backend/cmd/worker/main.go`: al inicio de cada evento de tenant en `drainEvents` (incluyendo `ai.turn` — cola de turnos IA), verifica `organizations.is_suspended = false`; si está suspendida, marca `skipped_suspended`.
   * `backend/internal/whatsapp/handlers.go`: `EvolutionWebhook` / `WAHAWebhook` rechazan con `403 tenant_suspended` (omitiendo ingestión y encolado `ai.turn`) si `is_suspended = true`.
   * `backend/internal/automation/handlers.go`: `InboundLeadCapture` (`/api/v1/webhooks/in/{token}`) rechaza con `403 tenant_suspended` si `is_suspended = true`.
   * `backend/internal/mcpserver/server.go` y `backend/cmd/mcp/main.go`: `HandleRPC` verifica `organizations.is_suspended = false` en **cada invocación** RPC; `cmd/mcp/main.go` exige `CRM_API_TOKEN` válido (sin fallback a la primera organización). En `/api/v1/mcp`, `X-Support-Session-ID` es rechazado con `403`.

4. **Frontend PWA en español (`frontend/src/`):**
   * `frontend/src/lib/api.ts`: gestiona `supportSession` en `sessionStorage`, adjunta `X-Support-Session-ID` únicamente en llamadas fuera de `/admin/*`, limpia el estado ante `403 support_session_invalid`, y tipa `is_platform_admin` en `User`.
   * `frontend/src/pages/AdminPage.tsx`: ruta `/admin` protegida para `is_platform_admin`, con KPIs, tabla paginada de tenants, botón Suspender/Activar y modal para iniciar sesión de soporte `support_readonly` (1h, motivo obligatorio).
   * `frontend/src/components/shell/AppShell.tsx`: muestra `ActiveSupportSessionBanner` arriba cuando hay sesión activa (con cuenta regresiva y botón "Salir de soporte" hacia `POST /api/v1/admin/support-sessions/{id}/end`).

--------------------------------------------------------------------------------

## Alternatives Considered

### Alternative A: Emitir un JWT nuevo de impersonación por cada sesión de soporte
* **Pros:** Evita consultar `platform_support_sessions` en cada petición HTTP.
* **Cons:** Un JWT emitido no puede revocarse al instante si el administrador cierra la sesión anticipadamente o si se le revoca `is_platform_admin` en BD.
* **Reason for Rejection:** Rejected by author: las sesiones de soporte requieren revocación inmediata en servidor y auditoría diferenciada (`support_session_id`).

### Alternative B: Exponer herramientas de Super-Admin (`/admin/*`) dentro del servidor MCP
* **Pros:** Permitiría suspender tenants desde agentes externos conectados por MCP.
* **Cons:** Acopla la gobernanza de plataforma a `api_tokens` de un solo tenant.
* **Reason for Rejection:** Rejected by author: el servidor MCP debe permanecer acotado al plano de datos del tenant.

### Alternative C: Acoplar `is_suspended` y `X-Support-Session-ID` dentro de un único `RequireAuth` con excepciones por URL
* **Pros:** Menos middlewares en `cmd/api/main.go`.
* **Cons:** Provoca deadlock al cerrar sesión `support_readonly` vía `POST /api/v1/admin/support-sessions/{id}/end` si `apiFetch` envía `X-Support-Session-ID`, y falla si la organización propia del admin está suspendida.
* **Reason for Rejection:** Rejected by author: separar `Authenticate` de `RequireTenantAccess` y `RequirePlatformAdmin` elimina excepciones por URL y evita el deadlock.

--------------------------------------------------------------------------------

## Risks & Mitigations

* **Fallo de auditoría en sesiones de soporte:** Si `WriteAudit` falla al registrar una operación en `platform_support_sessions` o acciones `/admin/*`, el handler revierte la transacción SQL y falla cerrado (`500`) en suspensión/creación/cierre de sesiones para no dejar cambios ni accesos sin rastro.
* **Auto-suspensión del Super-Admin:** Como `/api/v1/admin/*` usa `Authenticate + RequirePlatformAdmin` sin validar `is_suspended` de la organización propia del admin, un administrador no queda bloqueado fuera de `/admin` aunque suspenda su propio tenant de prueba.
* **Escalabilidad de `/admin/tenants` y `/admin/metrics`:** `GET /api/v1/admin/tenants` impone paginación (`limit <= 100`) con ordenamiento por `created_at DESC`; `GET /api/v1/admin/metrics` usa consultas agregadas simples acotadas.
* **Extracción de IP detrás de Caddy:** Se usa `middleware.RealIP` de `chi` (ya activo en `cmd/api/main.go`) combinado con `net.SplitHostPort(r.RemoteAddr)`.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Target Files to Create/Modify

#### 1. `backend/internal/auth/auth.go` (Modify)
* **Type / Scope:** Go Auth & Plan Separation Middlewares.
* **Proposed Changes:**
  * Añadir `SupportMode string` y `RemoteIP string` a `Identity`.
  * Refactorizar `RequireAuth` en `Authenticate` (identidad base JWT o `api_token` + `RemoteIP`) y `RequireTenantAccess` (plano de tenant: rechazar `X-Support-Session-ID` si `AuthType != "jwt"`, ignorar `X-Organization-ID` cuando haya sesión de soporte, validar `platform_support_sessions` + `users.is_platform_admin`, fijar `id.Role = "admin"`, bloquear `POST`/`PUT`/`PATCH`/`DELETE` en `support_readonly`, exigir `organizations.is_suspended = false` salvo lectura en `support_readonly`, y registrar `WriteAudit` en cada petición con `X-Support-Session-ID`). Mantener `RequireAuth` como alias compuesto `Authenticate` + `RequireTenantAccess` si algún caller lo necesita, o cablear explícitamente en `main.go`.
  * Añadir `RequirePlatformAdmin` (exige `AuthType == "jwt"` y valida `users.is_platform_admin` en PostgreSQL).
  * Actualizar `WriteAudit` para insertar `support_session_id` e `ip_address`.

#### 2. `backend/internal/auth/handlers.go` (Modify)
* **Type / Scope:** Go Auth JSON Payloads.
* **Proposed Changes:**
  * Incluir `is_platform_admin` en la respuesta `user` de `Login`, `VerifyMFA` y `Me`.

#### 3. `backend/internal/admin/handlers.go` (Create)
* **Type / Scope:** Go Platform Admin HTTP Handlers.
* **Proposed Changes:**
  * Implementar `ListTenants` (paginado `limit <= 100`), `UpdateTenantStatus` (audita sobre `target_organization_id` en transacción atómica), `StartSupportSession` (valida `reason != ""`, `mode IN ('support_readonly','full')`, `1 <= ttl_minutes <= 60`, audita sobre `target_organization_id` en transacción atómica), `EndSupportSession` (audita sobre `target_organization_id` en transacción atómica) y `GetMetrics`.

#### 4. `backend/cmd/api/main.go` (Modify)
* **Type / Scope:** Go HTTP Router Wiring.
* **Proposed Changes:**
  * Registrar `/api/v1/admin/*` con `Authenticate` + `RequirePlatformAdmin` (sin `RequireTenantAccess`) y `/api/v1/auth/me` con `Authenticate` para que un Super-Admin conserve su perfil en la PWA incluso si su propia organización está suspendida.
  * Registrar rutas de tenant con `Authenticate` + `RequireTenantAccess`, y rechazar `X-Support-Session-ID` en `POST /api/v1/mcp`.

#### 5. `backend/internal/whatsapp/handlers.go` y `backend/internal/automation/handlers.go` (Modify)
* **Type / Scope:** Inbound Webhook Suspension Guards.
* **Proposed Changes:**
  * En `EvolutionWebhook` / `WAHAWebhook`: responder `403 tenant_suspended` (omitiendo ingestión y encolado `ai.turn`) si `organizations.is_suspended = true`.
  * En `InboundLeadCapture` (`/api/v1/webhooks/in/{token}`): responder `403 tenant_suspended` si `organizations.is_suspended = true`.

#### 6. `backend/cmd/worker/main.go` (Modify)
* **Type / Scope:** Background Worker Suspension Guard.
* **Proposed Changes:**
  * Verificar `organizations.is_suspended = false` al inicio de cada evento en `drainEvents`; si está suspendida, marcar `skipped_suspended`.

#### 7. `backend/internal/mcpserver/server.go` y `backend/cmd/mcp/main.go` (Modify)
* **Type / Scope:** MCP Suspension Guard.
* **Proposed Changes:**
  * En `mcpserver.Server.HandleRPC`: verificar `organizations.is_suspended = false` en cada invocación RPC antes de ejecutar `tools/call`.
  * En `cmd/mcp/main.go`: exigir `CRM_API_TOKEN` válido (eliminar fallback `SELECT id FROM organizations LIMIT 1`) y verificar `is_suspended = false` al arranque.

#### 8. `backend/internal/auth/auth_test.go` (Modify)
* **Type / Scope:** Go Unit & Integration Tests.
* **Proposed Changes:**
  * Probar: `403 tenant_suspended` (JWT y `api_token`), rechazo de `X-Support-Session-ID` con `api_token`, `RequirePlatformAdmin`, ciclo completo de `platform_support_sessions` (TTL, `support_readonly` bloqueando `POST`, lectura en tenant suspendido, cierre anticipado con `X-Support-Session-ID` presente en el cliente sin deadlock) y `support_session_id` en `api_audit_log`.

#### 9. `frontend/src/lib/api.ts` (Modify)
* **Type / Scope:** Frontend API Client & Support Session State.
* **Proposed Changes:**
  * Añadir `is_platform_admin` al tipo `User`, gestionar `supportSession` en `sessionStorage`, enviar `X-Support-Session-ID` solo en rutas fuera de `/admin/*`, limpiar sesión ante `403 support_session_invalid`, y añadir funciones tipadas para `/admin/*`.

#### 10. `frontend/src/pages/AdminPage.tsx` (Create)
* **Type / Scope:** Frontend Super-Admin Console (`S26`) en español.
* **Proposed Changes:**
  * Vista `/admin` con KPIs globales, tabla paginada de tenants, botón Suspender/Activar y modal para iniciar sesión de soporte en modo `Solo lectura (1h)` con motivo obligatorio.

#### 11. `frontend/src/components/shell/AppShell.tsx` y `frontend/src/App.tsx` (Modify)
* **Type / Scope:** AppShell Support Banner & Routing.
* **Proposed Changes:**
  * Renderizar `ActiveSupportSessionBanner` arriba cuando haya sesión activa (con cuenta regresiva y botón "Salir de soporte"). Mostrar enlace "Super-Admin" si `user.is_platform_admin` es `true`. Registrar `/admin` en `App.tsx`.

#### 12. `frontend/tests/e2e.spec.ts` (Modify)
* **Type / Scope:** Playwright E2E Verification.
* **Proposed Changes:**
  * Promover el usuario de prueba a `is_platform_admin = true` mediante fixture SQL en el test, verificar `/admin`, iniciar sesión de soporte `support_readonly`, validar `ActiveSupportSessionBanner` en desktop (`1280x800`) y mobile (`390x844`), suspender/reactivar un tenant y cerrar sesión de soporte.

### Verification Plan

* **Compilation/Build (Backend):** `cd /home/antigravity/crm-go/backend && go vet ./...`
* **Unit & Integration Tests (Backend):** `cd /home/antigravity/crm-go/backend && go test ./...` (contra PostgreSQL en `127.0.0.1:5432`)
* **Typecheck & Build (Frontend):** `cd /home/antigravity/crm-go/frontend && npx tsc --noEmit && pnpm build`
* **E2E Verification:** `cd /home/antigravity/crm-go/frontend && npx playwright test --reporter=list` (Desktop `1280x800` y Mobile `390x844` sin scroll horizontal)

--------------------------------------------------------------------------------

*Drafted with EGM*
