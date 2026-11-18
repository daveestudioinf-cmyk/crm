# Motor LLM Real por Tenant (S17/S19) y Consola Super-Admin (S26) en KoraCRM

* **Author:** daveestudioinf-cmyk
* **Date:** 2026-11-18

## Overview

Incorporar a KoraCRM dos capacidades faltantes respecto al mapa original de DeskcommCRM ([`recon-map.md`](file:///home/antigravity/crm-go/replica/recon-map.md)):
1. **Motor LLM real por tenant (S17 / S19):** permitir que cada organización configure sus propias credenciales de proveedor LLM cifradas (`ai_provider_credentials`), ejecute turnos reales de IA con contexto RAG, respete un presupuesto mensual en `ai_budgets` (alerta al 80% y bloqueo con traspaso humano al 100%) y envíe las respuestas por WhatsApp vía Evolution Go.
2. **Consola Super-Admin de plataforma (S26 `/admin/*`):** directorio de tenants, suspensión/reactivación de organizaciones (`is_suspended`), KPIs globales de uso y sesiones temporales de soporte con TTL máximo de 1 hora auditadas en `api_audit_log`.

Todo se mantiene desacoplado entre el backend en Go, la PWA en React y el servidor MCP (`cmd/mcp` y `/api/v1/mcp`), sin exponer lógica `/admin/*` ni secretos LLM a través de MCP.

## Analysis

Los 5 revisores Goldfish detectaron 7 riesgos principales sobre el código actual en `/home/antigravity/crm-go`:

1. **Credenciales LLM por tenant inexistentes y riesgo de cifrado (`ai_provider_credentials`):**
   * La tabla `ai_provider_credentials` no existe en `000001_init_schema.up.sql` y `config.Config` no tiene clave maestra de cifrado.
   * Usar `JWT_SECRET` para cifrar API keys rompería las credenciales al rotar sesiones. Se requiere una clave dedicada `AI_CREDENTIALS_MASTER_KEY` (AES-256-GCM con `nonce` único, `key_version` y `organization_id` como AAD), sin devolver nunca el secreto en respuestas HTTP ni en sesiones de soporte `support_readonly`.
2. **Condiciones de carrera y pérdida de precisión en `ai_budgets` (80% / 100%):**
   * Hoy `RunAgentTurn` no consulta `ai_budgets`, fija `cost_cents = 1` y `ai_budgets` no tiene periodo mensual (`period_month`) ni `alert_100_sent`.
   * En modelos económicos (por ejemplo `gpt-4o-mini`), redondear por turno a `int` trunca a `0` o sobrestima el gasto; además, `SUM()` por turno degrada y permite carreras TOCTOU entre webhooks paralelos.
   * Solución: guardar precisión en `cost_microcents` (`bigint`) en `ai_invocations`, añadir `period_month` + `spent_microcents` + `reserved_microcents` + `alert_100_sent` en `ai_budgets`, hacer reserva atómica O(1) antes de llamar al LLM y conciliar al terminar.
3. **Desconexión entre `cmd/worker`, `ai.RunAgentTurn` y `EvolutionClient`:**
   * `cmd/worker/main.go` procesa hasta 10 eventos cada 2s en bucle secuencial, sin `EvolutionClient`, sin `RDB` (Redis) y marcando `event_log.status = 'done'` aunque falle el turno.
   * Una llamada LLM lenta (5–20s) bloquea a todos los tenants; ráfagas del mismo contacto generan respuestas múltiples; y un reintento tras `SendText` puede duplicar mensajes en WhatsApp.
   * Solución: pool acotado de workers con serialización/coalescing por `conversation_id`, timeout por turno (20–25s), outbox idempotente en `messages` (`sending` -> `sent`/`failed`), chequeo optimista de `conversations.status == 'ai_handling'` y `service_revision` antes de enviar, y respeto estricto de `AllowOutbound` (`warmup_daily_limit`).
4. **Falta de enforcement en runtime para `is_suspended` y `platform_support_sessions`:**
   * Aunque el esquema ya tiene `organizations.is_suspended`, `users.is_platform_admin`, `platform_support_sessions` y `api_audit_log.support_session_id`, `auth.Middleware.RequireAuth` y `auth.WriteAudit` no los validan ni los propagan.
   * Un tenant suspendido sigue operando por JWT, `api_tokens`, `/api/v1/mcp`, `cmd/mcp` y webhooks de WhatsApp.
   * Solución: middleware dedicado `RequirePlatformAdmin` (verificado en BD), bloqueo `403 tenant_suspended` en `RequireAuth` / `cmd/mcp` / `cmd/worker`, validación explícita de `X-Support-Session-ID` (`expires_at > now()`, `ended_at IS NULL`, máx. 1h), bloqueo de mutaciones cuando `mode = 'support_readonly'` y propagación de `support_session_id` + `ip_address` a `api_audit_log`.
5. **Desacoplamiento y no-duplicación entre Inbox, Worker y MCP:**
   * `mcpserver.callTool("send_message")` hoy solo inserta en `messages` sin despachar por WhatsApp. Si el motor LLM y MCP duplican clientes Evolution, se pierde el throttle anti-ban.
   * Solución: extraer un servicio/función única de envío outbound WhatsApp (con `AllowOutbound` + `EvolutionClient`) usada por Inbox, Worker y MCP, manteniendo `internal/mcpserver` sin dependencias hacia el motor LLM.
6. **Presupuesto de contexto RAG y versionado de embeddings:**
   * `SearchRAG` lee hasta 500 `ai_chunks` con hash de 64 dimensiones; sin límite de historial/tokens el costo crece sin control. Limitar ventana de mensajes y top-K chunks, y versionar `embedding_model` para futuras migraciones a embeddings vectoriales reales.
7. **Observabilidad, rollouts y fallos silenciosos:**
   * `RunAgentTurn` y `EvolutionClient.do` descartan errores hoy. Se requiere propagar `trace_id` desde `event_log` hacia `ai_invocations`, registrar `latency_ms` y categorías de error (`auth`, `rate_limit`, `upstream`, `budget`), y mantener un interruptor `AI_ENGINE_MODE=stub|llm` para rollback inmediato.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * Migración SQL aditiva para `ai_provider_credentials`, campos de precisión/periodo en `ai_budgets` / `ai_invocations` y columnas de reintento/error en `event_log`.
  * Cifrado AES-256-GCM de credenciales LLM por tenant con `AI_CREDENTIALS_MASTER_KEY` y enmascaramiento en API.
  * Cliente HTTP LLM multi-proveedor en Go (OpenAI-compatible / OpenRouter / Gemini / Anthropic), cálculo de costos por tabla de tarifas, control de presupuesto 80%/100% y respuesta por Evolution Go con outbox idempotente y worker pool.
  * Endpoints `/api/v1/admin/*` (`RequirePlatformAdmin`), enforcement de `is_suspended` (API, Worker y MCP) y sesiones de soporte auditadas de 1h (`support_readonly` por defecto).
  * Vistas en español en el frontend PWA: `/app/ai/providers` + `/app/ai/usage` (`S19`), editor de agentes (`S17`) y `/admin` (`S26`) con `ActiveSupportSessionBanner`.
* **Out-of-Scope Non-Goals:**
  * Configurar un LLM único centralizado desde Super-Admin oculto al cliente (descartado por decisión del usuario para mantener el modelo por tenant de DeskcommCRM).
  * Exponer herramientas de administración `/admin/*` o lectura de credenciales LLM dentro del servidor MCP.
  * Reemplazar el sistema de embeddings hash 64-dim actual por llamadas externas de embedding en esta misma iteración (solo se versiona `embedding_model`).

## Alternatives Weighed

* **Usar clave global única (`cfg.OpenAIKey`) controlada desde Super-Admin:** Descartado por el usuario para mantener la paridad con el diseño por tenant (S19) de DeskcommCRM.
* **Cifrar credenciales LLM usando `JWT_SECRET`:** Rechazado por riesgo de acoplamiento; rotar `JWT_SECRET` invalidaría todas las claves guardadas de los clientes.
* **Calcular consumo con `SUM(cost_cents)` por cada turno:** Rechazado por precisión insuficiente (`int` trunca costos < 1 centavo) y riesgo de condición de carrera TOCTOU en ráfagas concurrentes.

## Key Decisions & Staging for Next Steps

1. Separar la ejecución técnica en dos bloques ordenados o entregables claros dentro del diseño (`/egm-draft`):
   * **Bloque 1 (Gobernanza y Seguridad Base):** Enforcement de `is_suspended`, `RequirePlatformAdmin`, sesiones de soporte TTL 1h, auditoría con `support_session_id` y endpoints/UI `/admin`.
   * **Bloque 2 (Motor LLM + Presupuesto + Evolution Go):** `ai_provider_credentials` cifradas, `ai_budgets` en microcents con reserva atómica, cliente HTTP LLM, worker pool con outbox idempotente y UI `S17/S19`.
2. Mantener un feature flag `AI_ENGINE_MODE=stub|llm` y fallback a clave/handoff definido para rollout sin interrumpir los webhooks entrantes.
