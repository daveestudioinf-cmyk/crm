# Bloque 2: Motor LLM Real por Tenant (S17/S19), Presupuestos/Trazas de IA y Canal WhatsApp Evolution Go (S22)

* **Author:** daveestudioinf-cmyk
* **Status:** Approved (Goldfish Round 1 Resolved)
* **Date:** 2026-11-18

--------------------------------------------------------------------------------

## Overview

Implementar el motor de ejecución real de agentes de IA por organización (`S17`, `S19`, flujo `F03`) y completar el ciclo de vida de conexiones WhatsApp con Evolution Go (`S22`, flujo `F02`) en KoraCRM. Cada tenant podrá:

1. Registrar credenciales de proveedores LLM (`openai`, `anthropic`, `gemini`, `openrouter`, `openai_compatible`) cifradas con `AES-256-GCM` en reposo (`ai_provider_credentials`), sin exponer secretos en lecturas ni respuestas de mutación.
2. Configurar y monitorear su presupuesto mensual de IA (`ai_budgets`) con alerta al 80% y corte duro automático (`hard_stop`) al 100%, disparando handoff a humano si el saldo se agota.
3. Ejecutar turnos reales en `ai.Runner.RunAgentTurn` inyectando contexto RAG (`SearchRAG`), memoria organizacional (`org_memory_entries`), catálogo (`catalog_products`) y el `system_prompt` del agente activo (`ai_agents`), registrando trazas completas en `ai_agent_runs` y `ai_invocations`, reservando e incrementando el gasto atómicamente y enviando la respuesta por WhatsApp (`EvolutionClient.SendText`) bajo límite anti-ban (`AllowOutbound`).
4. Administrar instancias WhatsApp en Evolution Go (creación con prefijo de tenant y rollback si falla el proveedor, código QR, reconexión, ajuste de `warmup_daily_limit`, desconexión/eliminación) con actualizaciones en tiempo real por SSE (`realtime.Hub`) ante eventos autenticados de webhook (`connection.update`, `QRCODE_UPDATED` y `messages.upsert`).
5. Operar todo desde la PWA en español (`AIPage.tsx` y `ChannelsPage` en `OperationsPages.tsx`) con cero scroll horizontal en Desktop (`1280x800`) y Mobile (`390x844`), preservando íntegramente las garantías de aislamiento y soporte del Bloque 1 (`RequireTenantAccess`, `is_suspended`, `support_readonly`, auditoría, y SSE compatible con `X-Support-Session-ID`).

## The Problem

Actualmente, KoraCRM cuenta con un prototipo parcial de IA y WhatsApp:

1. **Turno IA simulado (`backend/internal/ai/handlers.go`):** `RunAgentTurn` no consulta ningún proveedor LLM ni carga la configuración de `ai_agents` (prompt, modelo, temperatura); solo devuelve el primer chunk de `SearchRAG` o un texto estático en inglés, no registra `ai_agent_runs`, no verifica presupuesto (`ai_budgets`), no consulta `org_memory_entries` ni `catalog_products`, no evalúa `crm_stages.requires_human` y no despacha el mensaje saliente por Evolution Go.
2. **Sin gestión de credenciales LLM ni presupuestos editables:** No existe tabla `ai_provider_credentials`, ni cifrado en reposo, ni endpoints para configurar presupuesto mensual, memoria organizacional o editar agentes existentes (`PATCH /api/v1/ai/agents/{id}`).
3. **Migraciones estáticas (`backend/internal/db/db.go`):** `RunMigrations` solo ejecuta `000001_init_schema.up.sql` si la tabla `organizations` no existe, `cmd/api` ignora errores de migración y `cmd/worker` no las ejecuta. Cualquier migración `000002_*` sería ignorada.
4. **Ciclo incompleto e inseguro de Evolution Go (`backend/internal/whatsapp/`):** `EvolutionWebhook` no valida secreto de webhook; `CreateChannel` deja filas huérfanas si falla Evolution Go; faltan endpoints para actualizar `warmup_daily_limit`, desconectar y eliminar instancia; y `EvolutionWebhook` no publica eventos SSE (`channel.updated`).
5. **UI limitada y SSE incompatible con soporte en `ChannelsPage`:** `AIPage.tsx` no permite editar agentes, gestionar credenciales LLM, visualizar la barra de presupuesto 80%/100% ni inspeccionar trazas. `ChannelsPage` no permite ajustar `warmup_daily_limit`, desconectar/eliminar canales ni refrescar vía SSE con cabeceras de sesión de soporte.

## Goals

* Actualizar `db.RunMigrations` con bloqueo asesor PostgreSQL (`pg_advisory_lock`) y tabla `schema_migrations` para aplicar migraciones `.up.sql` ordenadas e idempotentes desde `cmd/api` y `cmd/worker` (fail-fast en error).
* Implementar cifrado `AES-256-GCM` en `backend/internal/ai/crypto.go` usando `AI_ENCRYPTION_KEY` (con derivación SHA-256) y exponer CRUD de `ai_provider_credentials` protegido por rol `manager`/`admin`, devolviendo solo `api_key_mask` en `GET` y `POST`.
* Extender `ai_budgets` con `monthly_limit_cents`, `spent_cents`, `warn_at_percent`, `hard_stop`, `alert_80_sent` y `period_start` (con backfill desde `ai_invocations` del mes actual), reserva/incremento atómico en PostgreSQL y reset mensual atómico.
* Implementar cliente HTTP real multi-proveedor (`openai`, `anthropic`, `gemini`, `openrouter`, `openai_compatible`) en `backend/internal/ai/llm.go` con sanitización de errores (eliminando API keys en URLs como Gemini `?key=...`) y fallback local determinista cuando no haya credencial externa activa.
* Implementar `ai.Runner.RunAgentTurn` completo: validación de `force_human`/`is_blocked`/`crm_stages.requires_human`, disparadores de handoff, reserva atómica de presupuesto (`hard_stop`), carga de agente activo + RAG + `org_memory_entries` + `catalog_products` + historial reciente, trazas en `ai_agent_runs` + `ai_invocations`, chunking a 4096 caracteres y envío saliente por `EvolutionClient.SendText` respetando `AllowOutbound`.
* Completar el ciclo Evolution Go en `backend/internal/whatsapp/`: validación de secreto en `EvolutionWebhook`, manejo de `QRCODE_UPDATED`, `connection.update` (`open`, `connecting`, `close`) y `messages.upsert` (ignorando grupos `@g.us` y `status@broadcast`), rollback en `CreateChannel`, `PATCH /api/v1/channels/{id}`, `POST /api/v1/channels/{id}/disconnect`, `DELETE /api/v1/channels/{id}` y publicación SSE `channel.updated` / `channel.deleted`.
* Renovar `AIPage.tsx` (`S17`/`S19`) y `ChannelsPage` (`S22`) 100% en español, usando `fetch()` `ReadableStream` para SSE con `Authorization` + `X-Support-Session-ID`, responsivos y sin scroll horizontal en `1280x800` y `390x844`.

## Non-Goals

* Streaming de tokens en tiempo real hacia el navegador o WhatsApp.
* Tool-calling autónomo desde `RunAgentTurn` hacia herramientas MCP externas.
* Envío/recepción de archivos multimedia (audio, imagen, PDF) por Evolution Go en este bloque.
* Facturación automática con Stripe por exceso de consumo de IA.

## Critical User Journeys (CUJs)

### CUJ 1: Configuración de Proveedor LLM, Presupuesto y Agente IA (`S17` / `S19`)

* **Given**: Un administrador/manager de tenant autenticado navega a `/app/ai`.
* **When**: Configura una credencial OpenAI (`sk-...`), ajusta el presupuesto mensual (`monthly_limit_cents`, `warn_at_percent = 80`, `hard_stop = true`) y edita el agente IA (nombre, prompt, modelo, temperatura, max_tokens, handoff).
* **Then**: La API cifra `api_key_encrypted` con AES-256-GCM y devuelve solo la máscara (`sk-••••...`) tanto en `POST` como en `GET /api/v1/ai/providers`; el presupuesto y el agente quedan persistidos y visibles en la barra de consumo y tarjetas de agente.

### CUJ 2: Turno IA Real, Trazabilidad, Presupuesto Atómico y Handoff (`F03`)

* **Given**: Un contacto envía un mensaje entrante por webhook (`WAHAWebhook` o `EvolutionWebhook` autenticado) a una conversación en estado `ai_handling` con sesión `evolution_go` en estado `WORKING`.
* **When**: `cmd/worker` procesa el evento `ai.turn` (verificando primero `is_suspended = false`).
* **Then**:
  - Si el presupuesto alcanzó el 100% con `hard_stop = true`, o el mensaje solicita humano / toca tema crítico / está en etapa `requires_human`, la conversación pasa a `pending`, se registra la traza en `ai_agent_runs` + `ai_invocations` y se publica `conversation.handoff` por SSE.
  - Si procede responder, el motor reserva 1 centavo atómicamente si `hard_stop = true`, inyecta RAG + memoria + catálogo + historial, invoca al LLM configurado (o fallback local determinista si no hay API key), ajusta el costo final en `ai_budgets.spent_cents`, registra tokens/latencia/costo, guarda el mensaje saliente y lo envía (en chunks de hasta 4096 caracteres) por `EvolutionClient.SendText` si `AllowOutbound` lo permite.

### CUJ 3: Ciclo Completo WhatsApp Evolution Go con SSE (`S22` / `F02`)

* **Given**: Un usuario en `/app/connections` crea una sesión `evolution_go`.
* **When**: Consulta el QR (`GET /api/v1/channels/{id}/qr`), actualiza `warmup_daily_limit` (`PATCH /api/v1/channels/{id}`), recibe un webhook `connection.update` (`open`, `connecting`, `close`) o `QRCODE_UPDATED`, reconecta o desconecta/elimina la instancia.
* **Then**: `EvolutionWebhook` valida el secreto del canal, actualiza `channel_sessions` y publica `channel.updated` por `realtime.Hub`; la UI recibe el evento vía `fetch` SSE (compatible con `X-Support-Session-ID`) y actualiza el indicador de salud (`WORKING`, `SCAN_QR_CODE`, `FAILED`, `STOPPED`) sin recargar.

--------------------------------------------------------------------------------

## Technical Plan (Architecture)

```text
Webhook Inbound (Evolution / WAHA)
        │  (valida webhook_secret / HMAC y verifica is_suspended = false)
        ▼
  ingestInbound ──► event_log ('ai.turn')
                        │
                        ▼
               cmd/worker (drainEvents)
                        │  (verifica is_suspended = false)
                        ▼
               ai.Runner.RunAgentTurn
                 ├── 1. Verifica contacto (force_human/is_blocked), etapa requires_human y triggers rápidos
                 ├── 2. Reserva atómica de presupuesto (reset mensual + UPDATE WHERE spent < limit)
                 ├── 3. Carga ai_agents activo (ORDER BY updated_at DESC) + RAG + memoria + catálogo + historial
                 ├── 4. Resuelve credencial activa (decrypt AES-GCM) o DeterministicLocalProvider
                 ├── 5. Ejecuta LLM HTTP (OpenAI / Anthropic / Gemini / OpenRouter)
                 │        └─ error -> sanitiza API key, reembolsa reserva, handoff ('provider_error')
                 ├── 6. Persiste ai_agent_runs + ai_invocations + ajusta spent_cents final y alert_80_sent
                 └── 7. Guarda mensaje outbound 'ai' -> Hub.Publish('message.created')
                          └─ si sesión evolution_go == 'WORKING' y AllowOutbound -> chunk 4096 + SendText
```

### 1. Base de Datos y Migraciones (`backend/internal/db/db.go`, `backend/migrations/000002_bloque2_ai_evolution.up.sql`)

* **`db.RunMigrations`**: Adquiere `pg_advisory_lock(84729103)` en la conexión y lo libera con `pg_advisory_unlock`. Crea `schema_migrations (version text PRIMARY KEY, applied_at timestamptz DEFAULT now())`. Si `organizations` ya existe y `000001_init_schema.up.sql` no está en `schema_migrations`, la inserta como ya aplicada. Luego lee `*.up.sql` ordenados alfabéticamente y aplica cada migración pendiente en su propia transacción. Tanto `cmd/api` como `cmd/worker` llaman `RunMigrations` al iniciar y abortan con `log.Fatalf` si falla.
* **`000002_bloque2_ai_evolution.up.sql`**:
  * `ALTER TABLE ai_agents`: agrega `temperature double precision NOT NULL DEFAULT 0.3`, `max_tokens int NOT NULL DEFAULT 500`, `handoff_enabled boolean NOT NULL DEFAULT true`.
  * `ALTER TABLE ai_budgets`: agrega `monthly_limit_cents bigint NOT NULL DEFAULT 5000`, `spent_cents bigint NOT NULL DEFAULT 0`, `warn_at_percent int NOT NULL DEFAULT 80`, `hard_stop boolean NOT NULL DEFAULT true`, `period_start timestamptz NOT NULL DEFAULT date_trunc('month', now())`; sincroniza `monthly_limit_cents = monthly_cap_cents` y hace backfill de `spent_cents` sumando `ai_invocations.cost_cents` del mes actual.
  * `CREATE TABLE ai_provider_credentials`: `id uuid PK`, `organization_id uuid FK`, `provider text NOT NULL`, `label text NOT NULL DEFAULT ''`, `base_url text NOT NULL DEFAULT ''`, `default_model text NOT NULL DEFAULT ''`, `api_key_encrypted text NOT NULL`, `api_key_mask text NOT NULL`, `is_active boolean NOT NULL DEFAULT true`, `created_at`, `updated_at`, `UNIQUE (organization_id, provider)`.
  * `CREATE TABLE org_memory_entries`: `id uuid PK`, `organization_id uuid FK`, `category text NOT NULL DEFAULT 'general'`, `content text NOT NULL`, `is_active boolean NOT NULL DEFAULT true`, `created_at timestamptz DEFAULT now()`.
  * `CREATE TABLE ai_agent_runs`: `id uuid PK`, `organization_id uuid FK`, `agent_id uuid FK NULL`, `conversation_id uuid FK NULL`, `status text NOT NULL CHECK (status IN ('completed','handoff','blocked_budget','failed'))`, `provider text NOT NULL`, `model text NOT NULL`, `input_preview text NOT NULL DEFAULT ''`, `output_preview text NOT NULL DEFAULT ''`, `handoff_reason text`, `error_message text`, `prompt_tokens int NOT NULL DEFAULT 0`, `completion_tokens int NOT NULL DEFAULT 0`, `cost_cents int NOT NULL DEFAULT 0`, `latency_ms int NOT NULL DEFAULT 0`, `created_at timestamptz NOT NULL DEFAULT now()`.
  * `ALTER TABLE ai_invocations`: agrega `run_id uuid REFERENCES ai_agent_runs(id) ON DELETE SET NULL`, `status text NOT NULL DEFAULT 'completed'`, `error_message text`.

### 2. Cifrado, Proveedores LLM y RBAC (`backend/internal/ai/crypto.go`, `llm.go`, `handlers.go`)

* **`crypto.go`**:
  * `EncryptAPIKey(keySeed, plaintext)` y `DecryptAPIKey(keySeed, ciphertextB64)` usando `AES-256-GCM` con nonce aleatorio de 12 bytes y clave derivada `sha256.Sum256([]byte(keySeed))`.
  * `MaskAPIKey(raw)`: si `len(raw) <= 8`, devuelve `"••••"`; de lo contrario devuelve `raw[:3] + "••••" + raw[len(raw)-4:]`.
* **`config.go`**: Agrega `AIEncryptionKey` (`AI_ENCRYPTION_KEY`, fallback a `JWTSecret` en desarrollo).
* **`llm.go`**:
  * `CallLLM(ctx, LLMRequest) (LLMResponse, error)`:
    * `openai`, `openrouter`, `openai_compatible`: `POST {base_url}/chat/completions` con `Authorization: Bearer {api_key}`.
    * `anthropic`: `POST {base_url}/v1/messages` con `x-api-key` y `anthropic-version: 2023-06-01`.
    * `gemini`: `POST {base_url}/v1beta/models/{model}:generateContent?key={api_key}`.
  * `sanitizeLLMError(err, apiKey)`: reemplaza cualquier ocurrencia de `apiKey` (y `key=...`) por `[REDACTED]` antes de retornar o persistir errores.
  * Modo determinista local (`internal` / sin credencial activa): construye una respuesta útil en español basada en los chunks RAG, memoria organizacional y catálogo recuperados, sin llamadas de red externas.
* **Endpoints en `/api/v1/ai/*`** (protegidos por `RequireTenantAccess`, y mutaciones sensibles protegidas con `auth.RequireRole("manager")`):
  * `GET /ai/agents`, `POST /ai/agents` (`manager+`), `PATCH /ai/agents/{id}` (`manager+`, incrementa `version`): todos incluyen `temperature`, `max_tokens`, `handoff_enabled`, `is_active`, `version`.
  * `GET /ai/providers`, `POST /ai/providers` (`manager+`), `DELETE /ai/providers/{id}` (`manager+`):
    * `POST` hace upsert por `(organization_id, provider)`. Si `api_key` viene vacío y ya existe registro para ese proveedor, conserva `api_key_encrypted` y `api_key_mask` existentes; si es nuevo, exige `api_key` no vacío (`400`).
    * Tanto `GET` como `POST` devuelven únicamente `id, provider, label, base_url, default_model, api_key_mask, is_active, created_at, updated_at` (nunca `api_key_encrypted` ni `api_key`).
  * `GET /ai/budget`, `PUT /ai/budget` (`manager+`), `GET /ai/usage`: leen y actualizan `ai_budgets` (`monthly_limit_cents`, `spent_cents`, `warn_at_percent`, `hard_stop`, `alert_80_sent`, `pct`), manteniendo `monthly_cap_cents = LEAST(monthly_limit_cents, 2147483647)` sincronizado y manejando `pgx.ErrNoRows` con valores por defecto (`5000`, `80`, `true`).
  * `GET /ai/runs`: lista últimas 50 ejecuciones de `ai_agent_runs`.
  * `GET /ai/memory`, `POST /ai/memory` (`manager+`), `DELETE /ai/memory/{id}` (`manager+`).

### 3. Motor `ai.Runner.RunAgentTurn` y Worker (`backend/internal/ai/runner.go`, `backend/cmd/worker/main.go`)

* `ai.Runner` agrupa `Pool`, `Hub` (con guarda `if r.Hub != nil`), `EncryptionKey`, `Outbound WhatsAppSender` (solo asignado en `worker` cuando `evoClient != nil`, además de guarda `if c == nil` en `EvolutionClient.SendText`) y `Throttle OutboundThrottle` (`AllowOutbound`).
* `RunAgentTurn(ctx, orgID, convID, body) error`:
  1. Verifica contacto/conversación (`force_human`, `is_blocked`, etapa `crm_stages.requires_human`).
  2. Evalúa triggers rápidos de handoff si el agente activo tiene `handoff_enabled`: solicitud de humano (`humano`, `asesor`, `atendente`, `persona`, `agent`) o tema crítico (`procon`, `demanda`, `reembolso`, `refund`, `lawsuit`).
  3. **Presupuesto atómico (sin TOCTOU):**
     * `INSERT INTO ai_budgets (organization_id) VALUES ($1) ON CONFLICT DO NOTHING`.
     * Reset mensual atómico: `UPDATE ai_budgets SET spent_cents = 0, alert_80_sent = false, period_start = date_trunc('month', now()), updated_at = now() WHERE organization_id = $1 AND period_start < date_trunc('month', now())`.
     * Reserva atómica de 1 centavo: `UPDATE ai_budgets SET spent_cents = spent_cents + 1, updated_at = now() WHERE organization_id = $1 AND (NOT hard_stop OR spent_cents < monthly_limit_cents) RETURNING monthly_limit_cents, spent_cents, warn_at_percent, hard_stop`. Si no devuelve filas (`ErrNoRows`), el presupuesto está agotado con `hard_stop = true`: registra `ai_agent_runs` (`blocked_budget`) + `ai_invocations` y dispara handoff (`budget_exceeded`).
  4. Carga agente activo (`ORDER BY updated_at DESC, created_at DESC LIMIT 1`, con configuración default si no hay ninguno), RAG (`SearchRAG`), `org_memory_entries` (top 5), `catalog_products` activos (top 8) e historial reciente de `messages` (últimos 6).
  5. Resuelve credencial activa de `ai_provider_credentials` según `agent.provider` (o cualquier activa); descifra con `DecryptAPIKey`.
  6. Ejecuta LLM (o fallback local si no hay credencial). Si falla el proveedor externo, reembolsa el centavo reservado (`GREATEST(spent_cents - 1, 0)`), registra run `failed` con error sanitizado, dispara handoff `provider_error` y publica `conversation.handoff`.
  7. Inserta `ai_agent_runs` + `ai_invocations` (con `run_id`), ajusta `spent_cents` con `delta = max(costCents, 1) - 1` (o si es fallback local con costo 0, reembolsa 1 si no hubo costo) y actualiza `alert_80_sent = true` si `spent_cents * 100 >= monthly_limit_cents * warn_at_percent`.
  8. Inserta mensaje outbound `sender_type = 'ai'`, actualiza `conversations.last_message_at/preview` y publica `message.created` en `Hub`.
  9. Si la conversación tiene un `channel_session` `evolution_go` en estado `WORKING` y `Throttle.AllowOutbound` lo permite, divide en chunks de hasta 4096 caracteres y llama `Outbound.SendText`.
* En `cmd/worker/main.go`, si `RunAgentTurn` retorna error técnico inesperado, marca `event_log.status = 'failed'` con `last_error`; si completa o hace handoff controlado, marca `'done'`.

### 4. Canal WhatsApp Evolution Go (`backend/internal/whatsapp/evolution.go`, `handlers.go`, `cmd/api/main.go`)

* `EvolutionClient`: agrega `LogoutInstance(ctx, instanceName)` (`DELETE /instance/logout/{name}`) y `DeleteInstance(ctx, instanceName)` (`DELETE /instance/delete/{name}`), tolerando 404; agrega guarda `if c == nil` en `SendText`. En `CreateInstance` incluye `webhookSecret` en `webhook.headers` (`X-Webhook-Secret`) y en la URL (`?secret=...`).
* `whatsapp.Handler` (con guarda `if h.Hub != nil` en todas las publicaciones):
  * `CreateChannel`: si `h.Evolution.CreateInstance` falla, elimina la fila recién insertada en `channel_sessions` antes de responder `502`.
  * `UpdateChannel` (`PATCH /api/v1/channels/{id}`, `manager+`): actualiza `warmup_daily_limit` (`1 <= limit <= 5000`) y publica `channel.updated`.
  * `ReconnectChannel` (`POST /api/v1/channels/{id}/reconnect`, `manager+`): si `provider == "evolution_go"` y `h.Evolution != nil`, llama `ConnectQR`; si tiene éxito, fija `SCAN_QR_CODE` y devuelve QR; si falla, fija `FAILED` y devuelve `502`. Si `h.Evolution == nil`, fija `WORKING`. Publica `channel.updated`.
  * `DisconnectChannel` (`POST /api/v1/channels/{id}/disconnect`, `manager+`): llama `Evolution.LogoutInstance` si aplica, marca `status = 'STOPPED'` y publica `channel.updated`.
  * `DeleteChannel` (`DELETE /api/v1/channels/{id}`, `manager+`): llama `Evolution.DeleteInstance` si aplica, elimina de `channel_sessions` y publica `channel.deleted`.
  * `EvolutionWebhook`:
    * Autentica el webhook validando `X-Webhook-Secret` o `?secret=` contra `channel_sessions.webhook_secret` (o `apikey` contra `h.Evolution.APIKey` si está configurado), respondiendo `401 unauthorized_webhook` si no coincide.
    * Verifica `is_suspended` (`403 tenant_suspended`).
    * Maneja `QRCODE_UPDATED` (`status = 'SCAN_QR_CODE'` + `channel.updated`), `connection.update` (`open` -> `WORKING` preservando `phone_number` si `WUID` viene vacío y anteponiendo `+`; `connecting` -> `SCAN_QR_CODE`; `close` -> `FAILED`; publica `channel.updated`), y `messages.upsert` (ignora `@g.us` y `status@broadcast`).

### 5. Frontend PWA en Español (`frontend/src/pages/AIPage.tsx`, `OperationsPages.tsx`, `lib/api.ts`)

* **`lib/api.ts`**: Agrega interfaces TypeScript de Bloque 2 y helper `subscribeSSE(onEvent)` usando `fetch('/api/v1/realtime/stream')` con `Authorization` y `X-Support-Session-ID` + lectura de `ReadableStream` (compatible con sesiones de soporte del Bloque 1).
* **`AIPage.tsx` (`S17`/`S19`)**:
  * Pestañas responsivas (`flex-wrap`) en español: **Conocimiento RAG**, **Agente IA**, **Proveedores LLM**, **Presupuesto** y **Trazas** (manteniendo **Conocimiento RAG** accesible sin romper flujos existentes, o actualizando `e2e.spec.ts` para navegar por las pestañas).
  * **Agente IA**: selector/lista, crear o editar agente (nombre, proveedor, modelo, temperatura, max_tokens, prompt, toggle handoff).
  * **Proveedores LLM**: formulario de credencial (`openai`, `anthropic`, `gemini`, `openrouter`, `openai_compatible`, `base_url`, `default_model`, `api_key` opcional en edición), lista con máscara (`api_key_mask`) y eliminar.
  * **Presupuesto**: tarjeta con barra de progreso (verde `< 80%`, ámbar `>= 80%`, rojo `>= 100%`) y formulario para editar `monthly_limit_cents`, `warn_at_percent` y `hard_stop`.
  * **Trazas**: visor de `ai_agent_runs` (fecha, estado, proveedor/modelo, tokens, costo, latencia, motivo de handoff o error) + sección de memoria organizacional (`org_memory_entries`).
* **`ChannelsPage` (`OperationsPages.tsx`, `S22`)**:
  * Suscripción vía `subscribeSSE` a `channel.updated` y `channel.deleted`.
  * Modal/panel de QR que muestra imagen `qr_base64` si existe o `qr_payload` como texto/código cuando no hay imagen.
  * Tarjetas con `flex-wrap` y `min-w-0` para cero overflow en `390x844`, punto de salud (`WORKING`, `SCAN_QR_CODE`, `FAILED`, `STOPPED`), input de `warmup_daily_limit` con botón guardar, y acciones **Reconectar**, **Ver QR**, **Desconectar**, **Eliminar**.

--------------------------------------------------------------------------------

## Alternatives Considered

1. **Usar `go-openai` u otros SDKs externos por proveedor:**
   * *Rejected by author:* Aumenta dependencias y superficie de ruptura. Las APIs REST de OpenAI, Anthropic y Gemini son contratos JSON simples que se cubren con `net/http` estándar en ~150 líneas, facilitando pruebas con `httptest.Server`.
2. **Almacenar la API key en `ai_agents` directamente:**
   * *Rejected by author:* Duplica secretos si hay varios agentes usando el mismo proveedor y complica la rotación de llaves. Centralizar en `ai_provider_credentials` por `(organization_id, provider)` sigue el diseño de `recon-map.md` (`S19`).
3. **Usar `EventSource` en `ChannelsPage`:**
   * *Rejected by author:* `EventSource` no permite enviar cabeceras `X-Support-Session-ID` ni `Authorization`, rompiendo las sesiones de soporte del Bloque 1. `fetch()` con `ReadableStream` resuelve ambos casos uniformemente.

--------------------------------------------------------------------------------

## Detailed Implementation

### Archivos a Crear
1. `backend/migrations/000002_bloque2_ai_evolution.up.sql`: Esquema Bloque 2 (`ai_agents` cols, `ai_budgets` cols + backfill, `ai_provider_credentials`, `org_memory_entries`, `ai_agent_runs`, `ai_invocations` cols).
2. `backend/internal/ai/crypto.go`: Cifrado `AES-256-GCM`, descifrado y `MaskAPIKey`.
3. `backend/internal/ai/llm.go`: Cliente HTTP multi-proveedor (OpenAI, Anthropic, Gemini, OpenRouter), sanitización de errores con API keys y fallback determinista local.
4. `backend/internal/ai/runner.go`: `ai.Runner` y `RunAgentTurn` completo (triggers, reserva atómica de presupuesto, contexto RAG/memoria/catálogo/historial, handoff, trazas y despacho Evolution Go en chunks de 4096).
5. `backend/internal/ai/ai_test.go`: Pruebas unitarias y de integración con PostgreSQL + `httptest.Server` (cifrado, máscara, presupuesto `hard_stop` y concurrencia, handoff, LLM real simulado, sanitización de error Gemini, trazas).
6. `backend/internal/whatsapp/handlers_test.go`: Pruebas de prefijo de tenant, rollback en `CreateChannel`, `warmup_daily_limit`, `ReconnectChannel`, `DisconnectChannel`, `DeleteChannel` y `EvolutionWebhook` (autenticación `401`, `connection.update`, `QRCODE_UPDATED`, ignorar `@g.us`).

### Archivos a Modificar
1. `backend/internal/config/config.go`: Agregar `AIEncryptionKey`.
2. `backend/internal/db/db.go`: Actualizar `RunMigrations` con `pg_advisory_lock` y `schema_migrations` para ejecutar `000001` y `000002` ordenadamente.
3. `backend/internal/ai/handlers.go`: Actualizar `ListAgents` y `CreateAgent` con nuevas columnas; agregar `UpdateAgent` (`PATCH /ai/agents/{id}`), handlers de `providers`, `budget`, `GetUsage`, `runs`, `memory`; remover el antiguo `RunAgentTurn` simulado.
4. `backend/internal/whatsapp/evolution.go`: Agregar `LogoutInstance`, `DeleteInstance`, guarda `if c == nil` en `SendText` y `webhook.headers` en `CreateInstance`.
5. `backend/internal/whatsapp/handlers.go`: Agregar `UpdateChannel`, `DisconnectChannel`, `DeleteChannel`; actualizar `CreateChannel` (rollback en error), `ReconnectChannel`, y `EvolutionWebhook` (validación de secreto, `QRCODE_UPDATED`, `connecting`, `+phone`, filtro `@g.us`, `Hub.Publish` con guarda `nil`).
6. `backend/cmd/api/main.go`: Fallar rápido si `RunMigrations` falla, pasar `AIEncryptionKey` a `ai.Handler` y registrar rutas `/api/v1/ai/*` y `/api/v1/channels/*` con `auth.RequireRole("manager")` en mutaciones sensibles.
7. `backend/cmd/worker/main.go`: Ejecutar `db.RunMigrations`, inicializar `rdb`, `evoClient` (asignado a `Outbound` solo si `!= nil`), `whatsapp.Handler` (throttle) y `ai.Runner`; marcar `event_log` como `'failed'` si `RunAgentTurn` devuelve error.
8. `frontend/src/lib/api.ts`: Agregar interfaces TypeScript para Bloque 2 y `subscribeSSE` basado en `fetch()` + `ReadableStream`.
9. `frontend/src/pages/AIPage.tsx`: Renovar vista `S17`/`S19` en español con pestañas (Conocimiento RAG, Agente IA, Proveedores LLM, Presupuesto, Trazas/Memoria).
10. `frontend/src/pages/OperationsPages.tsx`: Renovar `ChannelsPage` (`S22`) con `subscribeSSE`, modal QR, indicador de salud, `warmup_daily_limit`, reconectar/desconectar/eliminar y diseño móvil `390x844` sin overflow.
11. `frontend/tests/e2e.spec.ts`: Ampliar suite E2E cubriendo Bloque 2 (proveedores LLM + máscara, presupuesto, agente IA, trazas, canales WhatsApp `S22`) manteniendo Bloque 1 y cero scroll horizontal en `1280x800` y `390x844`.
