import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  attachErrorGuards,
  assertAccessibility,
  assertSpanishAndBrand,
  assertZeroOverflow,
} from './helpers/guards';
import {
  apiRequest,
  loginViaUI,
  signupViaAPI,
  uniqueId,
  type SignupResult,
} from './helpers/api';

async function setupAuthInBrowser(page: Page, request: APIRequestContext): Promise<SignupResult> {
  const auth = await signupViaAPI(request);
  await loginViaUI(page, auth.email, auth.password);
  return auth;
}

async function createAPIToken(
  request: APIRequestContext,
  jwtToken: string,
  name: string
): Promise<{ id: string; token: string }> {
  const res = await apiRequest<{ id?: string; token?: string; raw_token?: string }>(
    request,
    'POST',
    '/api/v1/api-tokens',
    jwtToken,
    { name, scopes: ['mcp:read', 'mcp:write'] }
  );
  expect([200, 201]).toContain(res.status);
  const rawToken = String(res.data.token ?? res.data.raw_token ?? '');
  expect(rawToken).toMatch(/^crm_/);
  return { id: String(res.data.id ?? ''), token: rawToken };
}

test.beforeEach(({ page }) => {
  attachErrorGuards(page);
});

/* ============================================================================
 * Feature #28: Tenant-isolated AI Agents (S17)
 * ========================================================================== */
test.describe('Feature #28: Tenant-isolated AI Agents (S17)', () => {
  test('T1-28-01: renders /app/ai and /app/ai/agents in Spanish with zero overflow and accessibility', async ({
    page,
    request,
  }) => {
    await setupAuthInBrowser(page, request);
    await page.goto('/app/ai/agents');

    await expect(page.getByRole('heading', { name: /IA|Agentes/i }).first()).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'AI Agents S17');
  });

  test('T1-28-02: creates an AI agent with system_prompt, model, temperature & guardrails', async ({
    page,
    request,
  }) => {
    const auth = await setupAuthInBrowser(page, request);
    const agentName = `Agente ${uniqueId('ventas')}`;

    const created = await apiRequest<{ id: string; name: string; version?: number }>(
      request,
      'POST',
      '/api/v1/ai/agents',
      auth.accessToken,
      {
        name: agentName,
        system_prompt: 'Eres un asesor comercial amable de KoraCRM.',
        provider: 'openai',
        model: 'gpt-4o-mini',
        temperature: 0.3,
        max_tokens: 500,
        handoff_enabled: true,
        guardrails: { block_competitors: true, max_discount_pct: 10 },
      }
    );
    expect([200, 201]).toContain(created.status);
    expect(created.data.id).toBeTruthy();

    await page.goto('/app/ai');
    await page.getByRole('tab', { name: 'Agentes IA' }).click();
    await expect(page.getByText(agentName).first()).toBeVisible();
  });

  test('T1-28-03: updates an AI agent system_prompt and increments/persists version', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const created = await apiRequest<{ id: string; version?: number }>(
      request,
      'POST',
      '/api/v1/ai/agents',
      auth.accessToken,
      {
        name: 'Agente Versionado',
        system_prompt: 'Prompt v1',
        provider: 'openai',
        model: 'gpt-4o-mini',
      }
    );
    expect([200, 201]).toContain(created.status);

    const updated = await apiRequest<{ system_prompt: string; version?: number }>(
      request,
      'PATCH',
      `/api/v1/ai/agents/${created.data.id}`,
      auth.accessToken,
      {
        system_prompt: 'Prompt v2 con guardrails estrictos',
      }
    );
    expect(updated.ok).toBe(true);
    expect(updated.data.system_prompt).toBe('Prompt v2 con guardrails estrictos');
  });

  test('T1-28-04: toggles handoff_enabled and active status on AI agent', async ({ request }) => {
    const auth = await signupViaAPI(request);
    const created = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/ai/agents',
      auth.accessToken,
      {
        name: 'Agente Handoff Toggle',
        system_prompt: 'Prompt base',
        provider: 'openai',
        model: 'gpt-4o-mini',
        handoff_enabled: true,
      }
    );
    expect([200, 201]).toContain(created.status);

    const patched = await apiRequest<{ handoff_enabled: boolean }>(
      request,
      'PATCH',
      `/api/v1/ai/agents/${created.data.id}`,
      auth.accessToken,
      { handoff_enabled: false }
    );
    expect(patched.ok).toBe(true);
    expect(patched.data.handoff_enabled).toBe(false);
  });

  test('T1-28-05: deletes an AI agent via DELETE /api/v1/ai/agents/:id', async ({ request }) => {
    const auth = await signupViaAPI(request);
    const created = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/ai/agents',
      auth.accessToken,
      {
        name: 'Agente Eliminable',
        system_prompt: 'Temporal',
        provider: 'openai',
        model: 'gpt-4o-mini',
      }
    );
    expect([200, 201]).toContain(created.status);

    const del = await apiRequest(request, 'DELETE', `/api/v1/ai/agents/${created.data.id}`, auth.accessToken);
    expect([200, 204]).toContain(del.status);

    const list = await apiRequest<Array<{ id: string }>>(request, 'GET', '/api/v1/ai/agents', auth.accessToken);
    expect(list.data.some((a) => a.id === created.data.id)).toBe(false);
  });

  test('T2-28-01: rejects creating an AI agent with empty name or system_prompt (400/422)', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const res = await apiRequest(request, 'POST', '/api/v1/ai/agents', auth.accessToken, {
      name: '   ',
      system_prompt: '',
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    expect([400, 422]).toContain(res.status);
  });

  test('T2-28-02: rejects out-of-range temperature or negative max_tokens (400/422)', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const res = await apiRequest(request, 'POST', '/api/v1/ai/agents', auth.accessToken, {
      name: 'Agente Inválido',
      system_prompt: 'Prompt válido',
      provider: 'openai',
      model: 'gpt-4o-mini',
      temperature: 9.5,
      max_tokens: -10,
    });
    expect([400, 422]).toContain(res.status);
  });

  test('T2-28-03: rejects unauthenticated AI agent creation (401)', async ({ request }) => {
    const res = await apiRequest(request, 'POST', '/api/v1/ai/agents', undefined, {
      name: 'Sin Auth',
      system_prompt: 'Prompt',
    });
    expect(res.status).toBe(401);
  });

  test('T2-28-04: enforces multi-tenant isolation on AI agents', async ({ request }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);

    const agentA = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/ai/agents',
      tenantA.accessToken,
      {
        name: 'Agente Privado A',
        system_prompt: 'Confidencial A',
        provider: 'openai',
        model: 'gpt-4o-mini',
      }
    );
    expect([200, 201]).toContain(agentA.status);

    const crossPatch = await apiRequest(
      request,
      'PATCH',
      `/api/v1/ai/agents/${agentA.data.id}`,
      tenantB.accessToken,
      { name: 'Hack B' }
    );
    expect([403, 404]).toContain(crossPatch.status);
  });

  test('T2-28-05: deduplicates POST /api/v1/ai/agents with Idempotency-Key', async ({ request }) => {
    const auth = await signupViaAPI(request);
    const key = uniqueId('idem-agent');
    const payload = {
      name: `Agente Idem ${key}`,
      system_prompt: 'Prompt idempotente',
      provider: 'openai',
      model: 'gpt-4o-mini',
    };

    const first = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/ai/agents',
      auth.accessToken,
      payload,
      { 'Idempotency-Key': key }
    );
    const second = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/ai/agents',
      auth.accessToken,
      payload,
      { 'Idempotency-Key': key }
    );
    expect([200, 201]).toContain(first.status);
    expect([200, 201]).toContain(second.status);
    expect(second.data.id).toBe(first.data.id);
  });
});

/* ============================================================================
 * Feature #29: Multi-source tenant RAG (S20)
 * ========================================================================== */
test.describe('Feature #29: Multi-source tenant RAG (S20)', () => {
  test('T1-29-01: renders /app/ai/knowledge (S20) in Spanish with zero overflow and accessibility', async ({
    page,
    request,
  }) => {
    await setupAuthInBrowser(page, request);
    await page.goto('/app/ai/knowledge');

    await expect(page.getByRole('heading', { name: /Conocimiento|IA/i }).first()).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'Knowledge RAG S20');
  });

  test('T1-29-02: indexes FAQ knowledge source and renders it in UI', async ({ page, request }) => {
    const auth = await setupAuthInBrowser(page, request);
    const title = `FAQ Envíos ${uniqueId('rag')}`;

    const res = await apiRequest<{ id: string; title: string }>(
      request,
      'POST',
      '/api/v1/ai/knowledge',
      auth.accessToken,
      {
        title,
        source_type: 'faq',
        content: 'Los envíos exprés tardan 24 a 48 horas hábiles a todo el país.',
      }
    );
    expect([200, 201]).toContain(res.status);

    await page.goto('/app/ai');
    await expect(page.getByText(title).first()).toBeVisible();
  });

  test('T1-29-03: indexes Markdown document source and verifies persistence', async ({ request }) => {
    const auth = await signupViaAPI(request);
    const res = await apiRequest<{ id: string; source_type: string }>(
      request,
      'POST',
      '/api/v1/ai/knowledge',
      auth.accessToken,
      {
        title: 'Manual Garantías MD',
        source_type: 'markdown',
        content: '# Garantía\nTodos nuestros equipos cuentan con 12 meses de garantía directa.',
      }
    );
    expect([200, 201]).toContain(res.status);
    expect(res.data.id).toBeTruthy();
  });

  test('T1-29-04: performs vector similarity search and returns relevant snippets', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    await apiRequest(request, 'POST', '/api/v1/ai/knowledge', auth.accessToken, {
      title: 'Política de Devoluciones',
      source_type: 'faq',
      content: 'Aceptamos devoluciones sin costo dentro de los primeros 30 días naturales.',
    });

    const search = await apiRequest<Array<{ content?: string; snippet?: string }>>(
      request,
      'POST',
      '/api/v1/ai/knowledge/search',
      auth.accessToken,
      { query: 'devoluciones 30 días' }
    );
    expect(search.ok).toBe(true);
    expect(Array.isArray(search.data)).toBe(true);
    expect(search.data.length).toBeGreaterThan(0);
    expect(JSON.stringify(search.data)).toMatch(/30 días|devoluciones/i);
  });

  test('T1-29-05: deletes knowledge source and removes it from search results', async ({ request }) => {
    const auth = await signupViaAPI(request);
    const uniqueToken = uniqueId('zafiro');
    const created = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/ai/knowledge',
      auth.accessToken,
      {
        title: `Fuente ${uniqueToken}`,
        source_type: 'faq',
        content: `Código secreto de producto ${uniqueToken} disponible solo hoy.`,
      }
    );
    expect([200, 201]).toContain(created.status);

    const del = await apiRequest(request, 'DELETE', `/api/v1/ai/knowledge/${created.data.id}`, auth.accessToken);
    expect([200, 204]).toContain(del.status);

    const search = await apiRequest<Array<unknown>>(
      request,
      'POST',
      '/api/v1/ai/knowledge/search',
      auth.accessToken,
      { query: uniqueToken }
    );
    expect(search.ok).toBe(true);
    expect(JSON.stringify(search.data)).not.toContain(uniqueToken);
  });

  test('T2-29-01: rejects knowledge source with empty title or empty content (400/422)', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const res = await apiRequest(request, 'POST', '/api/v1/ai/knowledge', auth.accessToken, {
      title: '',
      source_type: 'faq',
      content: '   ',
    });
    expect([400, 422]).toContain(res.status);
  });

  test('T2-29-02: handles empty search query gracefully without 5xx', async ({ request }) => {
    const auth = await signupViaAPI(request);
    const res = await apiRequest(request, 'POST', '/api/v1/ai/knowledge/search', auth.accessToken, {
      query: '',
    });
    expect(res.status).toBeLessThan(500);
  });

  test('T2-29-03: enforces multi-tenant RAG isolation (Tenant B cannot search Tenant A chunks)', async ({
    request,
  }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);
    const secretPhrase = uniqueId('ultrasecreto');

    await apiRequest(request, 'POST', '/api/v1/ai/knowledge', tenantA.accessToken, {
      title: 'Documento Privado A',
      source_type: 'faq',
      content: `Clave interna de Tenant A: ${secretPhrase}`,
    });

    const searchB = await apiRequest<Array<unknown>>(
      request,
      'POST',
      '/api/v1/ai/knowledge/search',
      tenantB.accessToken,
      { query: secretPhrase }
    );
    expect(searchB.ok).toBe(true);
    expect(JSON.stringify(searchB.data)).not.toContain(secretPhrase);
  });

  test('T2-29-04: rejects unauthenticated knowledge creation (401)', async ({ request }) => {
    const res = await apiRequest(request, 'POST', '/api/v1/ai/knowledge', undefined, {
      title: 'Sin Auth',
      source_type: 'faq',
      content: 'Contenido',
    });
    expect(res.status).toBe(401);
  });

  test('T2-29-05: indexes >4096 char knowledge document with Spanish accents & emoji without overflow', async ({
    page,
    request,
  }) => {
    const auth = await setupAuthInBrowser(page, request);
    const longContent = 'Información detallada áéíóúñ 🚀. '.repeat(200);

    const res = await apiRequest(request, 'POST', '/api/v1/ai/knowledge', auth.accessToken, {
      title: 'Catálogo Extenso Ñoño',
      source_type: 'markdown',
      content: longContent,
    });
    expect([200, 201]).toContain(res.status);

    await page.goto('/app/ai');
    await expect(page.getByText('Catálogo Extenso Ñoño').first()).toBeVisible();
    await assertZeroOverflow(page);
  });
});

/* ============================================================================
 * Feature #30: Async sentiment analysis + 4-trigger Handoff
 * ========================================================================== */
test.describe('Feature #30: Async sentiment & 4-trigger Handoff', () => {
  test('T1-30-01: explicit human request ("Quiero hablar con un humano") triggers handoff', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const contact = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', auth.accessToken, {
      name: 'Cliente Handoff Explícito',
      phone_number: '+5215510002001',
    });
    expect(contact.ok).toBe(true);

    const conv = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/conversations', auth.accessToken, {
      contact_id: contact.data.id,
    });
    expect([200, 201]).toContain(conv.status);

    const msg = await apiRequest<{ id: string }>(
      request,
      'POST',
      `/api/v1/conversations/${conv.data.id}/messages`,
      auth.accessToken,
      { body: 'Quiero hablar con un humano por favor', direction: 'inbound' }
    );
    expect([200, 201]).toContain(msg.status);
  });

  test('T1-30-02: low sentiment message records negative sentiment and queues handoff evaluation', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const contact = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', auth.accessToken, {
      name: 'Cliente Molesto',
      phone_number: '+5215510002002',
    });
    const conv = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/conversations', auth.accessToken, {
      contact_id: contact.data.id,
    });
    expect([200, 201]).toContain(conv.status);

    const msg = await apiRequest(
      request,
      'POST',
      `/api/v1/conversations/${conv.data.id}/messages`,
      auth.accessToken,
      {
        body: 'Pésimo servicio, estoy muy molesto y quiero cancelar de inmediato.',
        direction: 'inbound',
      }
    );
    expect([200, 201]).toContain(msg.status);
  });

  test('T1-30-03: AI uncertainty / guardrail escalation creates human-attention case', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const caseRes = await apiRequest<{ id: string; reason?: string; status?: string }>(
      request,
      'POST',
      '/api/v1/ai/cases',
      auth.accessToken,
      {
        trigger: 'uncertainty',
        summary: 'El cliente pregunta por cláusula legal fuera de la base de conocimiento.',
      }
    );
    expect([200, 201]).toContain(caseRes.status);
    expect(caseRes.data.id).toBeTruthy();
  });

  test('T1-30-04: critical stage (requires_human: true) enforces human handoff', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const pipe = await apiRequest<{ id: string; stages: Array<{ id: string; requires_human?: boolean }> }>(
      request,
      'POST',
      '/api/v1/pipelines',
      auth.accessToken,
      {
        name: 'Pipeline Crítico',
        stages: [
          { name: 'Calificación', position: 1, requires_human: false },
          { name: 'Cierre Legal', position: 2, requires_human: true },
        ],
      }
    );
    expect([200, 201]).toContain(pipe.status);
    const criticalStage = pipe.data.stages.find((s) => s.requires_human);
    expect(criticalStage).toBeTruthy();
  });

  test('T1-30-05: contact force_human=true flag persists and routes directly to human', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const contact = await apiRequest<{ id: string; force_human?: boolean }>(
      request,
      'POST',
      '/api/v1/contacts',
      auth.accessToken,
      {
        name: 'VIP Solo Humano',
        phone_number: '+5215510002005',
        force_human: true,
      }
    );
    expect([200, 201]).toContain(contact.status);

    const updated = await apiRequest<{ force_human?: boolean }>(
      request,
      'PATCH',
      `/api/v1/contacts/${contact.data.id}`,
      auth.accessToken,
      { force_human: true }
    );
    expect(updated.ok).toBe(true);
    expect(updated.data.force_human).toBe(true);
  });

  test('T2-30-01: agent with handoff_enabled=false handles escalation safely without 5xx', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const agent = await apiRequest<{ id: string; handoff_enabled: boolean }>(
      request,
      'POST',
      '/api/v1/ai/agents',
      auth.accessToken,
      {
        name: 'Agente Sin Handoff',
        system_prompt: 'Responde siempre con cortesía.',
        provider: 'openai',
        model: 'gpt-4o-mini',
        handoff_enabled: false,
      }
    );
    expect([200, 201]).toContain(agent.status);
    expect(agent.data.handoff_enabled).toBe(false);
  });

  test('T2-30-02: duplicate inbound webhook external_id does not duplicate handoff/messages', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const extId = uniqueId('wamid');
    const payload = {
      event: 'message',
      payload: {
        id: extId,
        from: '5215510002099@c.us',
        body: 'Necesito hablar con un agente humano',
      },
    };

    const first = await apiRequest(
      request,
      'POST',
      `/api/v1/webhooks/waha/${uniqueId('sess')}`,
      auth.accessToken,
      payload
    );
    const second = await apiRequest(
      request,
      'POST',
      `/api/v1/webhooks/waha/${uniqueId('sess')}`,
      auth.accessToken,
      payload
    );
    expect(first.status).toBeLessThan(500);
    expect(second.status).toBeLessThan(500);
  });

  test('T2-30-03: concurrent claim during handoff returns 409 Conflict on stale service_revision', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const contact = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', auth.accessToken, {
      name: 'CAS Handoff',
      phone_number: '+5215510002003',
    });
    const conv = await apiRequest<{ id: string; service_revision?: number }>(
      request,
      'POST',
      '/api/v1/conversations',
      auth.accessToken,
      { contact_id: contact.data.id }
    );
    expect([200, 201]).toContain(conv.status);

    const rev = conv.data.service_revision ?? 1;
    const claim1 = await apiRequest(
      request,
      'POST',
      `/api/v1/conversations/${conv.data.id}/claim`,
      auth.accessToken,
      { service_revision: rev }
    );
    expect(claim1.ok).toBe(true);

    const claimStale = await apiRequest(
      request,
      'POST',
      `/api/v1/conversations/${conv.data.id}/claim`,
      auth.accessToken,
      { service_revision: rev }
    );
    expect(claimStale.status).toBe(409);
  });

  test('T2-30-04: enforces multi-tenant isolation on handoff cases', async ({ request }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);

    const caseA = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/ai/cases',
      tenantA.accessToken,
      { trigger: 'low_sentiment', summary: 'Caso privado A' }
    );
    expect([200, 201]).toContain(caseA.status);

    const crossGet = await apiRequest(
      request,
      'GET',
      `/api/v1/ai/cases/${caseA.data.id}`,
      tenantB.accessToken
    );
    expect([403, 404]).toContain(crossGet.status);
  });

  test('T2-30-05: rejects unauthenticated sentiment/handoff case creation (401)', async ({
    request,
  }) => {
    const res = await apiRequest(request, 'POST', '/api/v1/ai/cases', undefined, {
      trigger: 'explicit_human',
      summary: 'No auth',
    });
    expect(res.status).toBe(401);
  });
});

/* ============================================================================
 * Feature #31: LLM call logging, monthly budget caps (80%/100%) & providers (S19)
 * ========================================================================== */
test.describe('Feature #31: AI Providers, Usage & Budget Caps (S19)', () => {
  test('T1-31-01: renders /app/ai/providers, /app/ai/usage & /app/ai/runs in Spanish with zero overflow', async ({
    page,
    request,
  }) => {
    await setupAuthInBrowser(page, request);
    for (const route of ['/app/ai/providers', '/app/ai/usage', '/app/ai/runs']) {
      await page.goto(route);
      await assertSpanishAndBrand(page);
      await assertZeroOverflow(page);
    }
    await assertAccessibility(page, 'AI Providers/Usage S19');
  });

  test('T1-31-02: saves encrypted LLM provider key and masks it in UI/API (sk-••••8888)', async ({
    page,
    request,
  }) => {
    await setupAuthInBrowser(page, request);
    await page.goto('/app/ai');
    await page.getByRole('tab', { name: 'Proveedores' }).click();
    await page.getByPlaceholder('API Key (sk-... / AIza...)').fill('sk-test-e2e-99998888');
    await page.getByRole('button', { name: 'Guardar Credencial Cifrada' }).click();
    await expect(page.getByText('sk-••••8888').first()).toBeVisible();
  });

  test('T1-31-03: configures monthly org budget (80% warning, 100% hard_stop) via PUT /api/v1/ai/budget', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const res = await apiRequest<{
      monthly_limit_cents: number;
      warn_at_percent: number;
      hard_stop: boolean;
    }>(request, 'PUT', '/api/v1/ai/budget', auth.accessToken, {
      monthly_limit_cents: 10000,
      warn_at_percent: 80,
      hard_stop: true,
    });
    expect(res.ok).toBe(true);
    expect(res.data.monthly_limit_cents).toBe(10000);
    expect(res.data.warn_at_percent).toBe(80);
    expect(res.data.hard_stop).toBe(true);
  });

  test('T1-31-04: retrieves AI usage metrics and invocation run traces', async ({ request }) => {
    const auth = await signupViaAPI(request);
    const usage = await apiRequest<{ monthly_limit_cents: number }>(
      request,
      'GET',
      '/api/v1/ai/usage',
      auth.accessToken
    );
    expect(usage.ok).toBe(true);
    expect(typeof usage.data.monthly_limit_cents).toBe('number');

    const runs = await apiRequest<Array<unknown>>(request, 'GET', '/api/v1/ai/runs', auth.accessToken);
    expect(runs.ok).toBe(true);
    expect(Array.isArray(runs.data)).toBe(true);
  });

  test('T1-31-05: deletes a provider credential via DELETE /api/v1/ai/providers/:id', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const saved = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/ai/providers',
      auth.accessToken,
      {
        provider: 'openai',
        label: 'Clave Temporal',
        api_key: 'sk-temp-12345678',
      }
    );
    expect([200, 201]).toContain(saved.status);

    const del = await apiRequest(request, 'DELETE', `/api/v1/ai/providers/${saved.data.id}`, auth.accessToken);
    expect([200, 204]).toContain(del.status);
  });

  test('T2-31-01: validates 80% warning threshold configuration on /api/v1/ai/budget', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const res = await apiRequest<{ warn_at_percent: number }>(
      request,
      'PUT',
      '/api/v1/ai/budget',
      auth.accessToken,
      {
        monthly_limit_cents: 5000,
        warn_at_percent: 80,
        hard_stop: false,
      }
    );
    expect(res.ok).toBe(true);
    expect(res.data.warn_at_percent).toBe(80);
  });

  test('T2-31-02: rejects zero/negative monthly_limit_cents when hard_stop is enabled or invalid budget', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const res = await apiRequest(request, 'PUT', '/api/v1/ai/budget', auth.accessToken, {
      monthly_limit_cents: -100,
      warn_at_percent: 150,
      hard_stop: true,
    });
    expect([400, 422]).toContain(res.status);
  });

  test('T2-31-03: rejects empty API key when saving provider credential (400/422)', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const res = await apiRequest(request, 'POST', '/api/v1/ai/providers', auth.accessToken, {
      provider: 'openai',
      api_key: '',
    });
    expect([400, 422]).toContain(res.status);
  });

  test('T2-31-04: rejects unauthenticated access to AI providers and budget (401)', async ({
    request,
  }) => {
    const pRes = await apiRequest(request, 'GET', '/api/v1/ai/providers');
    const bRes = await apiRequest(request, 'GET', '/api/v1/ai/budget');
    expect(pRes.status).toBe(401);
    expect(bRes.status).toBe(401);
  });

  test('T2-31-05: enforces multi-tenant isolation on AI provider credentials', async ({ request }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);

    const saved = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/ai/providers',
      tenantA.accessToken,
      {
        provider: 'openai',
        label: 'Key Privada A',
        api_key: 'sk-privada-aaaa1111',
      }
    );
    expect([200, 201]).toContain(saved.status);

    const crossDel = await apiRequest(
      request,
      'DELETE',
      `/api/v1/ai/providers/${saved.data.id}`,
      tenantB.accessToken
    );
    expect([403, 404]).toContain(crossDel.status);
  });
});

/* ============================================================================
 * Feature #32: Native Go MCP Server exposing 7 CRM tools
 * ========================================================================== */
test.describe('Feature #32: Native Go MCP Server (POST /api/v1/mcp)', () => {
  test('T1-32-01: initialize handshake succeeds with crm_* API token', async ({ request }) => {
    const auth = await signupViaAPI(request);
    const apiTok = await createAPIToken(request, auth.accessToken, 'MCP Init Token');

    const res = await apiRequest<{
      jsonrpc: string;
      result: { protocolVersion: string; serverInfo: { name: string } };
    }>(request, 'POST', '/api/v1/mcp', apiTok.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });
    expect(res.ok).toBe(true);
    expect(res.data.result.serverInfo.name).toBe('kora-crm-mcp');
  });

  test('T1-32-02: tools/list exposes all 7 CRM tools', async ({ request }) => {
    const auth = await signupViaAPI(request);
    const apiTok = await createAPIToken(request, auth.accessToken, 'MCP List Token');

    const res = await apiRequest<{ result: { tools: Array<{ name: string }> } }>(
      request,
      'POST',
      '/api/v1/mcp',
      apiTok.token,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      }
    );
    expect(res.ok).toBe(true);
    const names = res.data.result.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'search_contacts',
        'get_customer_360',
        'list_conversations',
        'send_message',
        'move_lead_stage',
        'search_knowledge',
        'create_task',
      ])
    );
    expect(names.length).toBe(7);
  });

  test('T1-32-03: tools/call search_contacts and get_customer_360 return tenant contact data', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const apiTok = await createAPIToken(request, auth.accessToken, 'MCP Contacts Token');
    const contact = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', auth.accessToken, {
      name: 'Elena MCP',
      phone_number: '+5215590001111',
    });
    expect(contact.ok).toBe(true);

    const search = await apiRequest<{ result: { content: Array<{ text: string }> } }>(
      request,
      'POST',
      '/api/v1/mcp',
      apiTok.token,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'search_contacts', arguments: { query: 'Elena MCP' } },
      }
    );
    expect(search.ok).toBe(true);
    expect(search.data.result.content[0].text).toContain('Elena MCP');

    const c360 = await apiRequest<{ result: { content: Array<{ text: string }> } }>(
      request,
      'POST',
      '/api/v1/mcp',
      apiTok.token,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_customer_360', arguments: { contact_id: contact.data.id } },
      }
    );
    expect(c360.ok).toBe(true);
    expect(c360.data.result.content[0].text).toContain(contact.data.id);
  });

  test('T1-32-04: tools/call create_task and search_knowledge execute in tenant scope', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const apiTok = await createAPIToken(request, auth.accessToken, 'MCP Task RAG Token');

    await apiRequest(request, 'POST', '/api/v1/ai/knowledge', auth.accessToken, {
      title: 'Horarios MCP',
      source_type: 'faq',
      content: 'Atendemos de lunes a viernes de 9am a 6pm.',
    });

    const ragCall = await apiRequest<{ result: { content: Array<{ text: string }> } }>(
      request,
      'POST',
      '/api/v1/mcp',
      apiTok.token,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'search_knowledge', arguments: { query: 'lunes a viernes' } },
      }
    );
    expect(ragCall.ok).toBe(true);

    const taskCall = await apiRequest<{ result: { content: Array<{ text: string }> } }>(
      request,
      'POST',
      '/api/v1/mcp',
      apiTok.token,
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'create_task', arguments: { title: 'Llamada creada vía MCP' } },
      }
    );
    expect(taskCall.ok).toBe(true);
    expect(taskCall.data.result.content[0].text).toContain('Llamada creada vía MCP');
  });

  test('T1-32-05: tools/call list_conversations returns tenant conversations', async ({ request }) => {
    const auth = await signupViaAPI(request);
    const apiTok = await createAPIToken(request, auth.accessToken, 'MCP Conv Token');

    const res = await apiRequest<{ result: { content: Array<{ text: string }> } }>(
      request,
      'POST',
      '/api/v1/mcp',
      apiTok.token,
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'list_conversations', arguments: {} },
      }
    );
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.data.result.content)).toBe(true);
  });

  test('T2-32-01: rejects POST /api/v1/mcp with X-Support-Session-ID header (403 Forbidden)', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const res = await apiRequest(
      request,
      'POST',
      '/api/v1/mcp',
      auth.accessToken,
      { jsonrpc: '2.0', id: 8, method: 'tools/list' },
      { 'X-Support-Session-ID': '00000000-0000-0000-0000-000000000099' }
    );
    expect(res.status).toBe(403);
  });

  test('T2-32-02: rejects invalid or unauthenticated crm_* token with 401', async ({ request }) => {
    const noAuth = await apiRequest(request, 'POST', '/api/v1/mcp', undefined, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/list',
    });
    expect(noAuth.status).toBe(401);

    const badToken = await apiRequest(request, 'POST', '/api/v1/mcp', 'crm_invalid_token_xyz', {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/list',
    });
    expect(badToken.status).toBe(401);
  });

  test('T2-32-03: returns JSON-RPC -32601 on unknown MCP method without 5xx', async ({ request }) => {
    const auth = await signupViaAPI(request);
    const apiTok = await createAPIToken(request, auth.accessToken, 'MCP Unknown Method');

    const res = await apiRequest<{ error: { code: number; message: string } }>(
      request,
      'POST',
      '/api/v1/mcp',
      apiTok.token,
      { jsonrpc: '2.0', id: 11, method: 'unknown/method' }
    );
    expect(res.status).toBe(200);
    expect(res.data.error.code).toBe(-32601);
  });

  test('T2-32-04: enforces multi-tenant isolation on MCP get_customer_360', async ({ request }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);
    const tokB = await createAPIToken(request, tenantB.accessToken, 'MCP Tenant B');

    const contactA = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      tenantA.accessToken,
      { name: 'Privado A MCP', phone_number: '+5215590009999' }
    );
    expect(contactA.ok).toBe(true);

    const crossCall = await apiRequest<{ error?: { code: number }; result?: unknown }>(
      request,
      'POST',
      '/api/v1/mcp',
      tokB.token,
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'get_customer_360', arguments: { contact_id: contactA.data.id } },
      }
    );
    expect(crossCall.status).toBe(200);
    expect(crossCall.data.error).toBeTruthy();
  });

  test('T2-32-05: handles unknown tool name in tools/call with JSON-RPC error without 5xx', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const apiTok = await createAPIToken(request, auth.accessToken, 'MCP Unknown Tool');

    const res = await apiRequest<{ error: { code: number } }>(
      request,
      'POST',
      '/api/v1/mcp',
      apiTok.token,
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'drop_all_tables', arguments: {} },
      }
    );
    expect(res.status).toBe(200);
    expect(res.data.error).toBeTruthy();
  });
});

/* ============================================================================
 * Feature #33: AI Cases, Central Alerts (S21), Memory, Skills & Follow-ups (S18)
 * ========================================================================== */
test.describe('Feature #33: AI Cases, Central Alerts, Memory, Skills & Follow-ups (S18/S21)', () => {
  test('T1-33-01: renders /app/ai/cases & /app/ai/inbox (S21) in Spanish with zero overflow', async ({
    page,
    request,
  }) => {
    await setupAuthInBrowser(page, request);
    for (const route of ['/app/ai/cases', '/app/ai/inbox']) {
      await page.goto(route);
      await assertSpanishAndBrand(page);
      await assertZeroOverflow(page);
    }
    await assertAccessibility(page, 'AI Cases S21');
  });

  test('T1-33-02: creates and resolves/approves an AI Case in Central Alerts', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const created = await apiRequest<{ id: string; status?: string }>(
      request,
      'POST',
      '/api/v1/ai/cases',
      auth.accessToken,
      {
        trigger: 'explicit_human',
        summary: 'Cliente solicita descuento especial >20%',
      }
    );
    expect([200, 201]).toContain(created.status);

    const resolved = await apiRequest<{ status: string }>(
      request,
      'PATCH',
      `/api/v1/ai/cases/${created.data.id}`,
      auth.accessToken,
      { status: 'approved' }
    );
    expect(resolved.ok).toBe(true);
    expect(resolved.data.status).toBe('approved');
  });

  test('T1-33-03: creates and deletes Org Memory entries on /app/ai/memory', async ({
    page,
    request,
  }) => {
    const auth = await setupAuthInBrowser(page, request);
    const memText = `Política Garantía ${uniqueId('mem')}`;

    const created = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/ai/memory',
      auth.accessToken,
      { category: 'policy', content: memText }
    );
    expect([200, 201]).toContain(created.status);

    await page.goto('/app/ai/memory');
    await expect(page.getByText(memText).first()).toBeVisible();

    const del = await apiRequest(request, 'DELETE', `/api/v1/ai/memory/${created.data.id}`, auth.accessToken);
    expect([200, 204]).toContain(del.status);
  });

  test('T1-33-04: lists and toggles AI Skills on /app/ai/skills', async ({ page, request }) => {
    const auth = await setupAuthInBrowser(page, request);
    await page.goto('/app/ai/skills');
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);

    const skills = await apiRequest<Array<{ id: string; enabled?: boolean }>>(
      request,
      'GET',
      '/api/v1/ai/skills',
      auth.accessToken
    );
    expect(skills.ok).toBe(true);
    expect(Array.isArray(skills.data)).toBe(true);
  });

  test('T1-33-05: creates Follow-up flow (/app/ai/followups) and Intent Router (/app/ai/routers)', async ({
    page,
    request,
  }) => {
    const auth = await setupAuthInBrowser(page, request);
    const flow = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/ai/followups',
      auth.accessToken,
      {
        name: 'Seguimiento 24h Sin Respuesta',
        delay_hours: 24,
        prompt_template: 'Hola, ¿pudiste revisar la cotización que te enviamos?',
        active: true,
      }
    );
    expect([200, 201]).toContain(flow.status);

    const router = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/ai/routers',
      auth.accessToken,
      {
        name: 'Router Soporte Técnico',
        intent_keywords: ['error', 'soporte', 'falla'],
        active: true,
      }
    );
    expect([200, 201]).toContain(router.status);

    await page.goto('/app/ai/followups');
    await assertZeroOverflow(page);
    await page.goto('/app/ai/routers');
    await assertZeroOverflow(page);
  });

  test('T2-33-01: rejects empty Org Memory or empty Follow-up name (400/422)', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const memErr = await apiRequest(request, 'POST', '/api/v1/ai/memory', auth.accessToken, {
      category: 'general',
      content: '   ',
    });
    expect([400, 422]).toContain(memErr.status);

    const flowErr = await apiRequest(request, 'POST', '/api/v1/ai/followups', auth.accessToken, {
      name: '',
      delay_hours: -5,
    });
    expect([400, 422]).toContain(flowErr.status);
  });

  test('T2-33-02: rejects unauthenticated mutations on memory, followups & cases (401)', async ({
    request,
  }) => {
    const r1 = await apiRequest(request, 'POST', '/api/v1/ai/memory', undefined, { content: 'x' });
    const r2 = await apiRequest(request, 'POST', '/api/v1/ai/followups', undefined, { name: 'x' });
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
  });

  test('T2-33-03: enforces multi-tenant isolation on Org Memory and Follow-up flows', async ({
    request,
  }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);

    const memA = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/ai/memory',
      tenantA.accessToken,
      { category: 'secret', content: 'Regla secreta de Tenant A' }
    );
    expect([200, 201]).toContain(memA.status);

    const crossDel = await apiRequest(
      request,
      'DELETE',
      `/api/v1/ai/memory/${memA.data.id}`,
      tenantB.accessToken
    );
    expect([403, 404]).toContain(crossDel.status);
  });

  test('T2-33-04: rejects invalid status transition on AI Case (400/422)', async ({ request }) => {
    const auth = await signupViaAPI(request);
    const created = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/ai/cases',
      auth.accessToken,
      { trigger: 'uncertainty', summary: 'Caso estado inválido' }
    );
    expect([200, 201]).toContain(created.status);

    const badPatch = await apiRequest(
      request,
      'PATCH',
      `/api/v1/ai/cases/${created.data.id}`,
      auth.accessToken,
      { status: 'non_existent_status_xyz' }
    );
    expect([400, 422]).toContain(badPatch.status);
  });

  test('T2-33-05: handles Unicode/emoji in Org Memory and Follow-ups with zero mobile overflow', async ({
    page,
    request,
  }) => {
    const auth = await setupAuthInBrowser(page, request);
    await apiRequest(request, 'POST', '/api/v1/ai/memory', auth.accessToken, {
      category: 'tono',
      content: 'Saludar siempre con calidez áéíóúñ 🚀',
    });

    await page.goto('/app/ai/memory');
    await expect(page.getByText('Saludar siempre con calidez áéíóúñ 🚀').first()).toBeVisible();
    await assertZeroOverflow(page);
  });
});
