# Bloque 2: Motor LLM Real por Tenant (S17/S19), Presupuestos/Trazas de IA y Canal WhatsApp Evolution Go (S22)

* **Author:** daveestudioinf-cmyk
* **Date:** 2026-11-18

## Overview

Habilitar el motor de IA real multi-tenant de KoraCRM (`S17`/`S19`/`F03`) junto con el ciclo completo de conexión y eventos en tiempo real de WhatsApp vía Evolution Go (`S22`/`F02`). Cada organización podrá configurar sus propias credenciales de proveedor LLM cifradas en reposo (OpenAI, Anthropic, Gemini, OpenRouter o endpoint compatible OpenAI), definir un presupuesto mensual con alerta al 80% y corte duro (`hard_stop`) al 100%, ejecutar turnos de agente con contexto RAG + memoria organizacional + catálogo de productos + trazabilidad completa (`ai_agent_runs` y `ai_invocations`), y despachar respuestas salientes por Evolution Go respetando el límite anti-ban (`AllowOutbound`).

## Analysis

### Contradicciones y Riesgos Identificados

1. **Seguridad de credenciales LLM vs. usabilidad:** Almacenar API keys de múltiples tenants exige cifrado autenticado en reposo (`AES-256-GCM`) con clave derivada de variable de entorno (`AI_ENCRYPTION_KEY`, con fallback seguro en dev/test) y nunca devolver el secreto en `GET` (solo máscara tipo `sk-••••1234`).
2. **Desacople de esquema existente (`000001_init_schema.up.sql`) vs. alcance Bloque 2:**
   - `ai_agents` existe, pero carece de `temperature` y `handoff_enabled` / `max_tokens`.
   - `ai_budgets` existe con `monthly_cap_cents` y `alert_80_sent`, pero faltan `spent_cents`, `warn_at_percent` y `hard_stop` (y la vista espera `monthly_limit_cents` o compatibilidad con ambos nombres).
   - `ai_provider_credentials`, `ai_agent_runs` y `org_memory_entries` no existen en `000001_init_schema.up.sql`.
   - `db.RunMigrations` actualmente solo ejecuta `000001_init_schema.up.sql` si no existe `organizations`, por lo que ignoraría `000002_bloque2_ai_evolution.up.sql`. Debe actualizarse para registrar y aplicar migraciones pendientes en orden.
3. **Presupuesto atómico y concurrencia en `worker`:** Si dos mensajes llegan simultáneamente para el mismo tenant cerca del 100% del presupuesto, una lectura sin bloqueo podría exceder `monthly_limit_cents`. El incremento de `ai_budgets.spent_cents` y la verificación de `hard_stop` deben ejecutarse en PostgreSQL de forma atómica (`UPDATE ... RETURNING` o transacción).
4. **Handoff y envío WhatsApp en `RunAgentTurn`:** `cmd/worker/main.go` actualmente invoca `ai.RunAgentTurn(ctx, pool, hub, orgID, p.ConversationID, p.Body)` sin acceso a `EvolutionClient` ni `RDB` para `AllowOutbound`. Además, cuando `RunAgentTurn` dispara handoff (solicitud de humano, tema crítico, presupuesto agotado, error de proveedor o etapa `crm_stages.requires_human = true`), debe transicionar la conversación a `pending`, registrar la traza en `ai_agent_runs`/`ai_invocations` y publicar `conversation.handoff` por SSE.
5. **Determinismo en tests / sin API key externa:** En entornos locales o CI/E2E donde el tenant no configuró API key externa (o usa proveedor `internal` / `mock`), el motor debe usar un fallback determinista local sin fallar, mientras que con API key configurada ejecuta el cliente HTTP real (con `base_url` configurable para pruebas con `httptest.Server`).
6. **Preservación de garantías del Bloque 1:** Todos los endpoints nuevos en `/api/v1/ai/*` y `/api/v1/channels/*` heredan `RequireTenantAccess` (bloqueo `403 tenant_suspended` y `403 support_readonly` en mutaciones), y `cmd/worker` sigue omitiendo tenants suspendidos antes de ejecutar `ai.RunAgentTurn`.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * Migración `000002_bloque2_ai_evolution.up.sql` + `db.RunMigrations` versionado (`schema_migrations`).
  * Cifrado `AES-256-GCM` para `ai_provider_credentials` con CRUD en `/api/v1/ai/providers` (sin exponer secretos en `GET`).
  * Gestión de presupuesto mensual en `/api/v1/ai/budget` y `/api/v1/ai/usage` (`monthly_limit_cents`, `spent_cents`, `warn_at_percent`, `hard_stop`, `alert_80_sent`).
  * CRUD completo de `ai_agents` (`GET`, `POST`, `PATCH`) y `org_memory_entries` (`GET`, `POST`, `DELETE`) + visor de trazas (`/api/v1/ai/runs`).
  * Motor `ai.RunAgentTurn` con cliente HTTP real (OpenAI Chat Completions / Anthropic / Gemini / OpenRouter), inyección de RAG + memoria + catálogo, fallback local determinista, trazabilidad en `ai_agent_runs` + `ai_invocations`, incremento atómico de presupuesto, handoff automático y despacho saliente por `EvolutionClient.SendText` con `AllowOutbound`.
  * Ciclo completo WhatsApp Evolution Go en `/api/v1/channels` (crear con prefijo de tenant, QR, reconectar, actualizar `warmup_daily_limit`, desconectar/eliminar, y `EvolutionWebhook` publicando eventos SSE `channel.updated`).
  * UI en español en `AIPage.tsx` (`S17`/`S19`) y `OperationsPages.tsx` (`ChannelsPage` `S22`) sin scroll horizontal en Desktop (`1280x800`) y Mobile (`390x844`).
* **Out-of-Scope Non-Goals:**
  * Streaming token-a-token por SSE hacia el cliente final (las respuestas se envían como mensajes completos de WhatsApp).
  * Ejecución autónoma de herramientas MCP desde `RunAgentTurn` (corresponde a un bloque posterior de tool-calling avanzado).
  * Soporte de Meta Cloud API oficial o envío de audio/imágenes multimedia salientes (solo texto en Bloque 2).

## Alternatives Weighed

1. **Almacenar API keys en texto plano o solo en variables de entorno globales:**
   * *Rejected by author:* Rompe el modelo multi-tenant SaaS donde cada organización trae su propia clave (`BYOK`) y expone credenciales ante fugas de solo lectura en BD.
2. **Crear una tabla nueva `ai_budgets_v2` en lugar de extender `ai_budgets`:**
   * *Rejected by author:* Duplicaría la fuente de verdad respecto a `000001_init_schema.up.sql`. Es más limpio extender `ai_budgets` con `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` y sincronizar `monthly_cap_cents` / `monthly_limit_cents`.
3. **Delegar el envío de WhatsApp saliente del turno IA a un segundo evento en `event_log`:**
   * *Rejected by author:* Agrega latencia innecesaria en conversación en tiempo real. Despachar directamente desde `RunAgentTurn` cuando la sesión `evolution_go` está `WORKING` y `AllowOutbound` lo permite mantiene el flujo simple y atómico.

## Key Decisions & Staging for Next Steps

* Cifrado `AES-256-GCM` usando `SHA-256(AI_ENCRYPTION_KEY)` (o `JWT_SECRET` como fallback solo si `AI_ENCRYPTION_KEY` no está definida, documentando la variable dedicada).
* `ai.TurnDependencies` (o struct `ai.Runner`) que encapsula `Pool`, `Hub`, `Evolution`, `Throttle` (`AllowOutbound`) y `EncryptionKey` para que tanto `cmd/worker` como tests unitarios/integración puedan invocar `RunAgentTurn` limpiamente.
* En `AIPage.tsx`, organizar con pestañas claras en español: **Agente IA**, **Proveedores LLM**, **Presupuesto**, **Trazas** y **Conocimiento RAG**.
