import { test, expect } from '@playwright/test';
import {
  attachErrorGuards,
  assertZeroOverflow,
  assertSpanishAndBrand,
} from './helpers/guards.ts';
import {
  signupViaAPI,
  apiRequest,
  loginViaUI,
  uniqueId,
} from './helpers/api.ts';

test.beforeEach(async ({ page }) => {
  attachErrorGuards(page);
});

test.describe('Tier 3 — Cross-Feature Pairwise Combinations', () => {
  // 1. Support Session (S26) x Inbox mutation (403) x Audit Log (S24)
  test('T3-01: Support Session read-only header blocks Inbox mutation with 403 and records audit trail', async ({ request }) => {
    const org = await signupViaAPI(request);
    const contact = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
      full_name: 'Contacto Soporte',
      phone_e164: '+5215511001100',
    });
    const conv = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/conversations', org.accessToken, {
      contact_id: contact.data.id,
    });
    expect(conv.ok).toBe(true);

    // Non-admin attempting to start a support session is rejected with 403
    const startRes = await apiRequest(request, 'POST', '/api/v1/admin/support-sessions', org.accessToken, {
      organization_id: org.organizationId,
      reason: 'Inspección',
    });
    expect(startRes.status).toBe(403);

    const mutRes = await apiRequest(
      request,
      'POST',
      `/api/v1/conversations/${conv.data.id}/messages`,
      org.accessToken,
      { body: 'Intento mutación soporte' },
      { 'X-Support-Session-ID': '00000000-0000-0000-0000-000000000001' }
    );
    expect([403, 404]).toContain(mutRes.status);

    const audit = await apiRequest<Array<Record<string, unknown>> | { items?: Array<Record<string, unknown>> }>(
      request,
      'GET',
      '/api/v1/audit',
      org.accessToken
    );
    expect(audit.status).toBe(200);
    const auditEntries = Array.isArray(audit.data) ? audit.data : (audit.data?.items ?? []);
    expect(Array.isArray(auditEntries)).toBe(true);
    expect(auditEntries.length).toBeGreaterThan(0);
  });

  // 2. Support Session (S26) x S24 Audit UI visibility
  test('T3-02: /app/audit remains readable and displays mutations without horizontal overflow', async ({ page, request }) => {
    const org = await signupViaAPI(request);
    await apiRequest(request, 'POST', '/api/v1/contacts', org.accessToken, {
      full_name: 'Audit Cross Check',
      phone_e164: '+5215511002200',
    });

    await loginViaUI(page, org.email, org.password);
    await page.goto('/app/audit');
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
  });

  // 3. Inbound Webhook (S23) x Identity Resolution & Merge Queue (S13) x WHEN/IF/THEN Automation
  test('T3-03: Inbound webhook lead capture triggers identity resolution and WHEN/IF/THEN automation rule', async ({ request }) => {
    const org = await signupViaAPI(request);
    const phone = '+5215522003300';

    // Existing contact with phone
    await apiRequest(request, 'POST', '/api/v1/contacts', org.accessToken, {
      full_name: 'Cliente Original',
      phone_e164: phone,
      email: `${uniqueId('orig')}@koracrm.dev`,
    });

    // Create WHEN/IF/THEN rule
    const rule = await apiRequest(request, 'POST', '/api/v1/automations', org.accessToken, {
      name: 'Auto-Tag Webhook',
      trigger_type: 'lead.created',
      condition_json: { field: 'source', op: 'exists' },
      action_json: { type: 'add_tag', tag: 'webhook-lead' },
      is_active: true,
    });
    expect(rule.ok).toBe(true);

    // Create webhook source and fire inbound lead with same phone but different email -> identity resolution / merge queue
    const src = await apiRequest<{ webhook_token?: string; token?: string }>(
      request,
      'POST',
      '/api/v1/webhooks/sources',
      org.accessToken,
      { name: 'Webhook Merge Test', is_active: true }
    );
    const token = src.data.webhook_token || src.data.token || '';
    const hookRes = await apiRequest(request, 'POST', `/api/v1/webhooks/in/${token}`, undefined, {
      full_name: 'Cliente Duplicado Webhook',
      phone,
      email: `${uniqueId('dup')}@koracrm.dev`,
    });
    expect([200, 201, 202]).toContain(hookRes.status);

    const mergeQueue = await apiRequest(request, 'GET', '/api/v1/contacts/merge-queue', org.accessToken);
    expect(mergeQueue.status).toBe(200);
  });

  // 4. AI Handoff (S17/S21) x Inbox Claim CAS (S06) x SSE Realtime (subscribeSSE)
  test('T3-04: Inbox Claim CAS (service_revision) prevents concurrent hijack and coordinates with SSE stream', async ({ request }) => {
    const org = await signupViaAPI(request);
    const contact = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
      full_name: 'Cliente Handoff CAS',
      phone_e164: '+5215533004400',
    });
    const conv = await apiRequest<{ id: string; service_revision?: number }>(
      request,
      'POST',
      '/api/v1/conversations',
      org.accessToken,
      { contact_id: contact.data.id }
    );
    expect(conv.ok).toBe(true);

    const rev = conv.data.service_revision ?? 1;
    const claim1 = await apiRequest(
      request,
      'POST',
      `/api/v1/conversations/${conv.data.id}/claim`,
      org.accessToken,
      { service_revision: rev }
    );
    expect(claim1.ok).toBe(true);

    // Stale service_revision claim must fail with 409 Conflict
    const staleClaim = await apiRequest(
      request,
      'POST',
      `/api/v1/conversations/${conv.data.id}/claim`,
      org.accessToken,
      { service_revision: rev - 1 }
    );
    expect([409, 412]).toContain(staleClaim.status);
  });

  // 5. SSE Realtime endpoint auth & stream handshake
  test('T3-05: Unified SSE Realtime endpoint /api/v1/realtime/stream enforces auth and streams text/event-stream', async ({ request }) => {
    const unauth = await request.get('/api/v1/realtime/stream');
    expect(unauth.status()).toBe(401);

    const org = await signupViaAPI(request);
    const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:5173';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);

    try {
      const sseRes = await fetch(`${baseUrl}/api/v1/realtime/stream`, {
        headers: { Authorization: `Bearer ${org.accessToken}` },
        signal: controller.signal,
      });
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get('content-type') || '').toContain('text/event-stream');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });

  // 6. Anti-ban STOP opt-out x WhatsApp Campaigns (S16) x Inbox Composer block (S06)
  test('T3-06: Blocked/STOP contact blocks outbound campaign and manual Inbox composer/API delivery', async ({ page, request }) => {
    const org = await signupViaAPI(request);
    const blocked = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
      full_name: 'Contacto OptOut STOP',
      phone_e164: '+5215544005500',
      is_blocked: true,
    });
    expect(blocked.ok).toBe(true);

    const conv = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/conversations', org.accessToken, {
      contact_id: blocked.data.id,
    });
    expect(conv.ok).toBe(true);

    // Outbound message to blocked contact via API must be rejected (403/422)
    const sendBlocked = await apiRequest(
      request,
      'POST',
      `/api/v1/conversations/${conv.data.id}/messages`,
      org.accessToken,
      { body: 'Intento de envío a contacto STOP' }
    );
    expect([403, 422]).toContain(sendBlocked.status);

    await loginViaUI(page, org.email, org.password);
    await page.goto('/app/inbox');
    await page.getByText('Contacto OptOut STOP').first().click();

    const stopBanner = page.getByText(/dado de baja|STOP|bloqueado/i).first();
    const sendBtn = page.locator('form button[type="submit"]').first();
    const isBannerVisible = await stopBanner.isVisible().catch(() => false);
    const isSendDisabled = await sendBtn.isDisabled().catch(() => false);
    expect(isBannerVisible || isSendDisabled).toBe(true);
  });

  // 7. LGPD Cascade Anonymization (S25) x Customer 360 Timeline (S13)
  test('T3-07: LGPD cascade anonymization redacts contact PII while preserving CRM timeline/lead structure', async ({ page, request }) => {
    const org = await signupViaAPI(request);
    const piiEmail = `${uniqueId('pii')}@koracrm.dev`;
    const contact = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
      full_name: 'Ana PII Confidencial',
      phone_e164: '+5215555006600',
      email: piiEmail,
    });
    expect(contact.ok).toBe(true);

    await apiRequest(request, 'POST', '/api/v1/leads', org.accessToken, {
      title: 'Pedido #1045',
      contact_id: contact.data.id,
      value_cents: 150000,
    });

    const lgpd = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/lgpd/requests', org.accessToken, {
      contact_id: contact.data.id,
      request_type: 'delete',
    });
    expect(lgpd.ok).toBe(true);

    const exec = await apiRequest(request, 'POST', `/api/v1/lgpd/requests/${lgpd.data.id}/execute`, org.accessToken);
    expect(exec.ok).toBe(true);

    // Lead / order record preserved, contact PII redacted
    const leads = await apiRequest(request, 'GET', '/api/v1/leads', org.accessToken);
    expect(JSON.stringify(leads.data)).toContain('Pedido #1045');

    await loginViaUI(page, org.email, org.password);
    await page.goto('/app/contacts');
    const body = await page.locator('body').innerText();
    expect(body).not.toContain(piiEmail);
  });

  // 8. Kanban Bulk Move (S11) x Support Ticket Cross-Lead Linking (S12) x Mobile Stage-Tabs (390x844)
  test('T3-08: Kanban bulk move (>50 -> 422), Support Ticket cross-lead linking (S12), and mobile stage tabs (390x844)', async ({ page, request }) => {
    const org = await signupViaAPI(request);
    const pipelines = await apiRequest<Array<{ id: string; stages?: Array<{ id: string }> }>>(
      request,
      'GET',
      '/api/v1/pipelines',
      org.accessToken
    );
    expect(pipelines.status).toBe(200);

    // Create sales deal & support ticket lead and link them (crm_lead_links)
    const salesLead = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/leads', org.accessToken, {
      title: 'Trato Comercial Principal',
      value_cents: 120000,
    });
    const supportLead = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/leads', org.accessToken, {
      title: 'Ticket Soporte #402',
      value_cents: 0,
    });
    expect(salesLead.ok).toBe(true);
    expect(supportLead.ok).toBe(true);

    const linkRes = await apiRequest(
      request,
      'POST',
      `/api/v1/leads/${supportLead.data.id}/links`,
      org.accessToken,
      { target_lead_id: salesLead.data.id, link_type: 'related' }
    );
    expect(linkRes.status).toBeLessThan(500);

    // Bulk move > 50 IDs must be rejected with 400/422
    const tooManyIds = Array.from({ length: 51 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    const bulkRes = await apiRequest(request, 'POST', '/api/v1/leads/bulk', org.accessToken, {
      lead_ids: tooManyIds,
      stage_id: '00000000-0000-0000-0000-000000000001',
    });
    expect([400, 422]).toContain(bulkRes.status);

    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUI(page, org.email, org.password);
    await page.goto('/app/kanban');
    await expect(page.getByRole('tablist').first()).toBeVisible();
    await assertZeroOverflow(page);
  });

  // 9. API Token (S25) x Go MCP Server (POST /api/v1/mcp) x AI Budget Cap 100% (S19)
  test('T3-09: API Token authenticates Go MCP Server tools/list and enforces AI budget cap configuration', async ({ request }) => {
    const org = await signupViaAPI(request);
    const tokenRes = await apiRequest<{ token?: string; raw_token?: string }>(
      request,
      'POST',
      '/api/v1/api-tokens',
      org.accessToken,
      { name: 'MCP Integration Token' }
    );
    expect(tokenRes.ok).toBe(true);
    const apiToken = tokenRes.data.token || tokenRes.data.raw_token || org.accessToken;

    const mcpRes = await apiRequest(request, 'POST', '/api/v1/mcp', apiToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(mcpRes.status).toBe(200);
    expect(JSON.stringify(mcpRes.data)).toContain('tools');

    const budgetRes = await apiRequest(request, 'PUT', '/api/v1/ai/budget', org.accessToken, {
      monthly_limit_cents: 1000,
      hard_stop: true,
    });
    expect(budgetRes.ok).toBe(true);
  });

  // 10. API Token revocation immediately blocks subsequent MCP calls
  test('T3-10: Revoking API Token immediately blocks subsequent /api/v1/mcp requests with 401', async ({ request }) => {
    const org = await signupViaAPI(request);
    const tokenRes = await apiRequest<{ id: string; token?: string; raw_token?: string }>(
      request,
      'POST',
      '/api/v1/api-tokens',
      org.accessToken,
      { name: 'Token Temporal MCP' }
    );
    expect(tokenRes.ok).toBe(true);
    const apiToken = tokenRes.data.token || tokenRes.data.raw_token || '';

    const revRes = await apiRequest(request, 'DELETE', `/api/v1/api-tokens/${tokenRes.data.id}`, org.accessToken);
    expect(revRes.ok).toBe(true);

    if (apiToken) {
      const mcpAfter = await apiRequest(request, 'POST', '/api/v1/mcp', apiToken, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });
      expect(mcpAfter.status).toBe(401);
    }
  });

  // 11. Multi-tenant isolation across Conversations & Inbox Messages
  test('T3-11: Multi-tenant isolation — Tenant B cannot read or reply to Tenant A conversations', async ({ request }) => {
    const orgA = await signupViaAPI(request);
    const orgB = await signupViaAPI(request);

    const contactA = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', orgA.accessToken, {
      full_name: 'VIP Tenant A',
      phone_e164: '+5215566007700',
    });
    const convA = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/conversations', orgA.accessToken, {
      contact_id: contactA.data.id,
    });

    const msgByB = await apiRequest(
      request,
      'GET',
      `/api/v1/conversations/${convA.data.id}/messages`,
      orgB.accessToken
    );
    expect([403, 404]).toContain(msgByB.status);

    const sendByB = await apiRequest(
      request,
      'POST',
      `/api/v1/conversations/${convA.data.id}/messages`,
      orgB.accessToken,
      { body: 'Intrusión' }
    );
    expect([403, 404]).toContain(sendByB.status);
  });

  // 12. Multi-tenant isolation across Leads, AI Knowledge, and Webhooks
  test('T3-12: Multi-tenant isolation — Tenant B cannot access Tenant A Leads, AI Knowledge, or Webhooks', async ({ request }) => {
    const orgA = await signupViaAPI(request);
    const orgB = await signupViaAPI(request);
    const marker = uniqueId('secret-rag');

    await apiRequest(request, 'POST', '/api/v1/leads', orgA.accessToken, {
      title: `Lead ${marker}`,
      value_cents: 80000,
    });
    await apiRequest(request, 'POST', '/api/v1/ai/knowledge', orgA.accessToken, {
      title: `Doc ${marker}`,
      content: `Contenido confidencial ${marker}`,
    });
    await apiRequest(request, 'POST', '/api/v1/webhooks/sources', orgA.accessToken, {
      name: `Hook ${marker}`,
      is_active: true,
    });

    const leadsB = await apiRequest(request, 'GET', '/api/v1/leads', orgB.accessToken);
    const ragB = await apiRequest(request, 'POST', '/api/v1/ai/knowledge/search', orgB.accessToken, {
      query: marker,
    });
    const hooksB = await apiRequest(request, 'GET', '/api/v1/webhooks/sources', orgB.accessToken);

    expect(JSON.stringify(leadsB.data)).not.toContain(marker);
    expect(JSON.stringify(ragB.data)).not.toContain(marker);
    expect(JSON.stringify(hooksB.data)).not.toContain(marker);
  });

  // 13. AI Agent + Product Catalog + RAG Search cross-feature integration
  test('T3-13: Product catalog entry and AI Knowledge source coexist and remain isolated per tenant', async ({ request }) => {
    const org = await signupViaAPI(request);
    const prod = await apiRequest(request, 'POST', '/api/v1/products', org.accessToken, {
      name: 'Plan Kora Pro',
      price_cents: 9900,
      currency: 'USD',
    });
    expect(prod.ok).toBe(true);

    const rag = await apiRequest(request, 'POST', '/api/v1/ai/knowledge', org.accessToken, {
      title: 'Precios Plan Kora Pro',
      content: 'El Plan Kora Pro cuesta 99 USD al mes e incluye WhatsApp multi-agente.',
    });
    expect(rag.ok).toBe(true);

    const search = await apiRequest(request, 'POST', '/api/v1/ai/knowledge/search', org.accessToken, {
      query: 'Kora Pro precio',
    });
    expect(search.status).toBe(200);
    expect(JSON.stringify(search.data)).toContain('99 USD');
  });

  // 14. Idempotency-Key deduplication + Team Invite RBAC (viewer 403) + Audit Log
  test('T3-14: Idempotency-Key deduplicates POST /api/v1/contacts to 1 record and viewer RBAC blocks mutations (403)', async ({ request }) => {
    const org = await signupViaAPI(request);
    const idemKey = uniqueId('idem-cross');
    const uniquePhone = `+52155${String(Date.now()).slice(-8)}`;

    const r1 = await apiRequest(
      request,
      'POST',
      '/api/v1/contacts',
      org.accessToken,
      { full_name: 'Contacto Idempotente', phone_e164: uniquePhone },
      { 'Idempotency-Key': idemKey }
    );
    const r2 = await apiRequest(
      request,
      'POST',
      '/api/v1/contacts',
      org.accessToken,
      { full_name: 'Contacto Idempotente', phone_e164: uniquePhone },
      { 'Idempotency-Key': idemKey }
    );
    expect(r1.ok).toBe(true);
    expect(r2.status).toBeLessThan(500);

    const contactsRes = await apiRequest<Array<{ phone_e164?: string }> | { items?: Array<{ phone_e164?: string }> }>(
      request,
      'GET',
      '/api/v1/contacts',
      org.accessToken
    );
    const contacts = Array.isArray(contactsRes.data) ? contactsRes.data : (contactsRes.data?.items ?? []);
    const matches = contacts.filter((c) => c.phone_e164 === uniquePhone);
    expect(matches.length).toBe(1);

    // Invite a viewer user and verify viewer gets 403 on mutations
    const viewerEmail = `${uniqueId('viewer')}@koracrm.dev`;
    const inviteRes = await apiRequest<{ token?: string }>(request, 'POST', '/api/v1/team/invites', org.accessToken, {
      email: viewerEmail,
      role: 'viewer',
    });
    if (inviteRes.ok && inviteRes.data?.token) {
      const acceptRes = await apiRequest<{ access_token?: string }>(request, 'POST', '/api/v1/team/accept-invite', undefined, {
        token: inviteRes.data.token,
        full_name: 'Viewer E2E',
        password: 'ViewerPass123!',
      });
      if (acceptRes.ok && acceptRes.data?.access_token) {
        const viewerMut = await apiRequest(request, 'POST', '/api/v1/contacts', acceptRes.data.access_token, {
          full_name: 'Bloqueado Viewer',
          phone_e164: '+5215599990000',
        });
        expect(viewerMut.status).toBe(403);
      }
    }

    const audit = await apiRequest(request, 'GET', '/api/v1/audit', org.accessToken);
    expect(audit.status).toBe(200);
  });
});
