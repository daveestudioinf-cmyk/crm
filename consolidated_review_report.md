# Reporte Consolidado de Revisión EGM — `super-admin-bloque-1.md`

* **Documento revisado:** [super-admin-bloque-1.md](file:///home/antigravity/crm-go/docs/designs/super-admin-bloque-1.md)
* **Rango evaluado:** `FeatureRange` (líneas 1–139), `DetailedRange` (líneas 140–227)
* **Etapas ejecutadas:** Stage 5 (Zoom Out + Inventive Catalyst), Stage 6 (Comprehension), Stage 7 (Design Critic), Stage 9 (Implementation Readiness)

---

## Resumen de Paráfrasis (Stage 6 — Comprehension)

* **Qué propone:** Habilitar la consola Super-Admin (`S26` `/admin`), hacer cumplir `organizations.is_suspended = false` en JWT, `api_tokens`, MCP (`/api/v1/mcp` y `cmd/mcp`), webhooks entrantes y `cmd/worker`, e implementar sesiones temporales de soporte (`platform_support_sessions`, TTL <= 1h, `support_readonly` por defecto, `X-Support-Session-ID`) auditadas en `api_audit_log`.
* **Sistema actual:** Las tablas/columnas (`users.is_platform_admin`, `organizations.is_suspended`, `platform_support_sessions`, `api_audit_log.support_session_id`) existen en `000001_init_schema.up.sql`, pero no tienen enforcement en Go ni UI en la PWA.

---

## Hallazgos Priorizados y Deduplicados

### 🔴 Blocker

1. **B1 — Deadlock al cerrar sesión `support_readonly` y acoplamiento de planos en `RequireAuth`**
   * **Fuentes:** Inventive Catalyst #1, Zoom Out #1, Implementation Readiness #2, Design Critic #8.
   * **Problema:** `apiFetch` inyecta `X-Support-Session-ID` en todas las llamadas mientras haya sesión activa; al presionar "Salir de soporte" (`POST /api/v1/admin/support-sessions/{id}/end`), `/api/v1/admin/*` pasa por `RequireAuth`, que evaluaría `X-Support-Session-ID` y bloquearía el `POST` con `403 support_readonly`. Además, inspeccionar `r.URL.Path` dentro de `RequireAuth` para exceptuar `/admin/` es frágil.
   * **Corrección requerida:** Separar la autenticación base (`Authenticate`) del middleware de acceso al tenant (`RequireTenantAccess`: `X-Support-Session-ID`, `support_readonly`, `is_suspended`). El grupo `/api/v1/admin/*` usa solo `Authenticate` + `RequirePlatformAdmin` (ignora `X-Support-Session-ID` y `is_suspended`), y `apiFetch` no envía `X-Support-Session-ID` hacia `/admin/*`.

2. **B2 — Escalación de privilegios al combinar `api_tokens` (`crm_*`) con `X-Support-Session-ID`**
   * **Fuentes:** Design Critic #1, Comprehension #4, Implementation Readiness #6.
   * **Problema:** El flujo de `RequireAuth` no prohíbe usar `X-Support-Session-ID` cuando la autenticación viene de un `api_token` (`crm_*`) ni en `/api/v1/mcp`, y no define prioridad frente a `X-Organization-ID`.
   * **Corrección requerida:** Aceptar `X-Support-Session-ID` **únicamente** con autenticación JWT de sesión humana (rechazar con `403` si viene con `api_token` o en `/api/v1/mcp`), e ignorar `X-Organization-ID` cuando `X-Support-Session-ID` esté presente.

3. **B3 — `WriteAudit` en acciones de plataforma escribe el `OrganizationID` equivocado**
   * **Fuentes:** Implementation Readiness #1, Zoom Out #4.
   * **Problema:** `api_audit_log.organization_id` es `NOT NULL`. En endpoints `/admin/tenants/{id}` o `/admin/support-sessions`, `id.OrganizationID` apunta a la organización propia del admin, contaminando su log en lugar de registrar la organización objetivo (`target_organization_id`).
   * **Corrección requerida:** En `internal/admin/handlers.go`, pasar explícitamente el `target_organization_id` afectado a `WriteAudit` (y en métricas globales usar un evento de sistema o no contaminar otros tenants).

4. **B4 — `auth.Handlers` (`Login`, `VerifyMFA`, `Me`) omitido en el plan para `is_platform_admin`**
   * **Fuentes:** Implementation Readiness #3, Comprehension #5.
   * **Problema:** El frontend depende de `user.is_platform_admin` para mostrar el enlace y proteger `/admin`, pero el plan no incluye actualizar `backend/internal/auth/handlers.go` para devolver `is_platform_admin` en las respuestas de `Login`, `VerifyMFA` y `Me`.
   * **Corrección requerida:** Incluir `backend/internal/auth/handlers.go` en el plan detallado para exponer `is_platform_admin` en el objeto `user`.

---

### 🟡 Major

5. **M1 — Ambigüedad de "bypass admin" sobre `is_suspended` en sesiones de soporte**
   * **Fuentes:** Inventive Catalyst #3, Comprehension #1, Design Critic #1.
   * **Problema:** No queda claro si un Super-Admin puede abrir sesión de soporte `support_readonly` para diagnosticar un tenant ya suspendido (`is_suspended = true`).
   * **Corrección requerida:** Definir explícitamente que una sesión `support_readonly` válida puede leer un tenant suspendido para diagnóstico (manteniendo bloqueados JWT normales, `api_tokens`, webhooks, `cmd/worker` y modo `full`).

6. **M2 — `id.Role` sintético indefinido durante sesiones de soporte**
   * **Fuentes:** Design Critic #2, Implementation Readiness #6.
   * **Problema:** Al cambiar `id.OrganizationID` al tenant objetivo, `id.Role` conserva el rol de la organización propia del admin (que podría ser `viewer` o no existir en `user_organizations` del destino), causando `403 insufficient role`.
   * **Corrección requerida:** Asignar `id.Role = "admin"` al resolver una sesión de soporte válida (acotado por `support_readonly` en métodos mutantes).

7. **M3 — Cobertura incompleta de `is_suspended` (`InboundLeadCapture`, `cmd/mcp` continuo y `cmd/worker`)**
   * **Fuentes:** Zoom Out #2, Implementation Readiness #4 & #5, Design Critic #4 & #9, Inventive Catalyst #2.
   * **Problema:** Falta cubrir `POST /api/v1/webhooks/in/{token}` (`automation/handlers.go`), validar `is_suspended` en cada invocación RPC de `cmd/mcp` (no solo al arranque) y eliminar el fallback sin token en `cmd/mcp/main.go`.
   * **Corrección requerida:** Añadir validación de `is_suspended` en `InboundLeadCapture`, en `mcpserver.Server.HandleRPC` (por cada llamada) y en todo job procesado por `cmd/worker/main.go`.

8. **M4 — Modo `full` y `RequireReadOnlyGuard` (YAGNI y falta de salvaguardas)**
   * **Fuentes:** Zoom Out #3, Design Critic #3, Comprehension #9.
   * **Problema:** El modal de `AdminPage.tsx` ofrece modo `full` sin un CUJ que lo justifique en Bloque 1 y sin validar `reason` obligatorio o enum `mode` en backend.
   * **Corrección requerida:** Limitar la UI del Bloque 1 a `support_readonly` (validando `reason != ""`, `mode IN ('support_readonly', 'full')` y `1 <= ttl_minutes <= 60` en backend) e integrar el bloqueo de escritura en el middleware de tenant.

9. **M5 — Falta sección `Risks & Mitigations`, paginación/caché en `/admin/*` y estrategia E2E**
   * **Fuentes:** Design Critic #6 & #7, Implementation Readiness #7.
   * **Problema:** Falta definir qué ocurre si falla `WriteAudit` en soporte (fail-closed), límites de paginación en `GET /admin/tenants` y cómo crea el test E2E un usuario `is_platform_admin = true`.
   * **Corrección requerida:** Añadir `Risks & Mitigations`, paginación (`limit <= 100`) en `/admin/tenants`, y fixture SQL/helper de `is_platform_admin` en `frontend/tests/e2e.spec.ts`.

---

### 🟢 Nit

10. **N1 — Extracción de `ip_address` detrás de Caddy / proxy inverso:** Usar `net.SplitHostPort` sobre `r.RemoteAddr` (ya procesado por `chi/middleware.RealIP` en `cmd/api/main.go:62`) en lugar de `r.RemoteAddr` crudo (Design Critic #5, Implementation Readiness #8).
11. **N2 — Glosario de términos y prefijos de ruta:** Aclarar inline `S26`, `F08`, `WORKING`, `ai.turn`, y usar consistentemente `/api/v1/admin/...` en todo el documento (Comprehension #7 & #9).

---

## Matriz de Trazabilidad

| ID Consolidado | Stage 5 (Zoom Out / Catalyst) | Stage 6 (Comprehension) | Stage 7 (Design Critic) | Stage 9 (Readiness) |
| :--- | :--- | :--- | :--- | :--- |
| **B1** | Catalyst #1, Zoom Out #1 | #2 | #8 | #2 |
| **B2** | — | #4 | #1 | #6 |
| **B3** | Zoom Out #4 | — | — | #1 |
| **B4** | — | #5 | — | #3 |
| **M1** | Catalyst #3 | #1 | #1 | — |
| **M2** | — | — | #2 | #6 |
| **M3** | Zoom Out #2, Catalyst #2 | #3 | #4, #9 | #4, #5 |
| **M4** | Zoom Out #3 | #9 | #3 | #1 |
| **M5** | — | — | #6, #7 | #7 |
| **N1–N2** | — | #7, #8, #9 | #5 | #8 |
