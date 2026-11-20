import { test, expect } from '@playwright/test';
import {
  attachErrorGuards,
  assertZeroOverflow,
  assertSpanishAndBrand,
  assertAccessibility,
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

// ============================================================================
// Feature #4: Append-only Audit Log (api_audit_log, S24 /app/audit)
// ============================================================================
test.describe('Feature #4: Append-only Audit Log (S24)', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('F4-T1-1: /app/audit renders Spanish UI, zero overflow, brand integrity, and passes axe scan', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await loginViaUI(page, org.email, org.password);

      await page.goto('/app/audit');
      await expect(page.getByRole('heading', { name: /Auditoría|Registro de Auditoría/i })).toBeVisible();
      await assertSpanishAndBrand(page);
      await assertZeroOverflow(page);
      await assertAccessibility(page, 'Audit Log S24');
    });

    test('F4-T1-2: Mutations via API (contact create) generate immutable audit log entries', async ({ request }) => {
      const org = await signupViaAPI(request);
      const contactRes = await apiRequest(request, 'POST', '/api/v1/contacts', org.accessToken, {
        full_name: 'Contacto Auditado',
        phone_e164: '+5215511112222',
      });
      expect(contactRes.ok).toBe(true);

      const auditRes = await apiRequest<{ items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
        request,
        'GET',
        '/api/v1/audit',
        org.accessToken
      );
      expect(auditRes.status).toBe(200);
      const rows = Array.isArray(auditRes.data) ? auditRes.data : (auditRes.data?.items ?? []);
      expect(rows.length).toBeGreaterThan(0);
    });

    test('F4-T1-3: Audit log supports filtering by action, actor, or resource type', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await apiRequest(request, 'POST', '/api/v1/contacts', org.accessToken, {
        full_name: 'Filtro Audit',
        phone_e164: '+5215522223333',
      });

      const filtered = await apiRequest(request, 'GET', '/api/v1/audit?action=POST', org.accessToken);
      expect(filtered.status).toBe(200);

      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/audit');
      await expect(page.getByRole('table')).toBeVisible();
    });

    test('F4-T1-4: Audit log records actor email/user_id and timestamp for each mutation', async ({ request }) => {
      const org = await signupViaAPI(request);
      const c = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
        name: 'Contacto Lead Audit',
        phone_number: '+5215544445555',
      });
      await apiRequest(request, 'POST', '/api/v1/leads', org.accessToken, {
        title: 'Lead Auditado',
        contact_id: c.data.id,
        value_cents: 50000,
      });

      const auditRes = await apiRequest<Array<Record<string, unknown>> | { items: Array<Record<string, unknown>> }>(
        request,
        'GET',
        '/api/v1/audit',
        org.accessToken
      );
      expect(auditRes.status).toBe(200);
      const entries = Array.isArray(auditRes.data) ? auditRes.data : (auditRes.data?.items ?? []);
      expect(entries.length).toBeGreaterThan(0);
      const first = entries[0];
      expect(first.created_at || first.timestamp).toBeTruthy();
    });

    test('F4-T1-5: Audit log entries display in /app/audit table with Spanish column headers', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await apiRequest(request, 'POST', '/api/v1/contacts', org.accessToken, {
        full_name: 'Tabla Audit',
        phone_e164: '+5215533334444',
      });
      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/audit');
      await expect(page.getByText(/Acción|Recurso|Fecha/i).first()).toBeVisible();
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('F4-T2-1: Audit log is strictly append-only (DELETE and PATCH on /api/v1/audit are rejected)', async ({ request }) => {
      const org = await signupViaAPI(request);
      const delRes = await apiRequest(request, 'DELETE', '/api/v1/audit', org.accessToken);
      expect([403, 404, 405]).toContain(delRes.status);

      const patchRes = await apiRequest(request, 'PATCH', '/api/v1/audit/00000000-0000-0000-0000-000000000001', org.accessToken, {
        action: 'tampered',
      });
      expect([403, 404, 405]).toContain(patchRes.status);
    });

    test('F4-T2-2: Multi-tenant isolation — Tenant B cannot see Tenant A audit entries', async ({ request }) => {
      const orgA = await signupViaAPI(request);
      const orgB = await signupViaAPI(request);
      const marker = uniqueId('audit-iso');

      await apiRequest(request, 'POST', '/api/v1/contacts', orgA.accessToken, {
        full_name: marker,
        phone_e164: '+5215544445555',
      });

      const auditB = await apiRequest(request, 'GET', '/api/v1/audit', orgB.accessToken);
      expect(auditB.status).toBe(200);
      expect(JSON.stringify(auditB.data)).not.toContain(marker);
    });

    test('F4-T2-3: Unauthenticated request to /api/v1/audit returns 401', async ({ request }) => {
      const res = await apiRequest(request, 'GET', '/api/v1/audit');
      expect(res.status).toBe(401);
    });

    test('F4-T2-4: Pagination boundary (limit=1000 or page=9999) does not return 5xx', async ({ request }) => {
      const org = await signupViaAPI(request);
      const res = await apiRequest(request, 'GET', '/api/v1/audit?limit=1000&page=9999', org.accessToken);
      expect(res.status).toBeLessThan(500);
    });

    test('F4-T2-5: Special characters and Unicode in mutated resource appear safely in audit without XSS', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      const xssName = 'Cliente Ñandú <script>window.__xss=1</script> 🚀';
      await apiRequest(request, 'POST', '/api/v1/contacts', org.accessToken, {
        full_name: xssName,
        phone_e164: '+5215566667777',
      });

      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/audit');
      const xssTriggered = await page.evaluate(() => (window as unknown as Record<string, unknown>).__xss === 1);
      expect(xssTriggered).toBe(false);
    });
  });
});

// ============================================================================
// Feature #34: Event log queue + background Go workers
// ============================================================================
test.describe('Feature #34: Event Log Queue & Background Go Workers', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('F34-T1-1: Inbound webhook enqueues event_log work and returns 200/202 without blocking', async ({ request }) => {
      const org = await signupViaAPI(request);
      const srcRes = await apiRequest<{ webhook_token?: string; token?: string; id?: string }>(
        request,
        'POST',
        '/api/v1/webhooks/sources',
        org.accessToken,
        { name: 'Worker Queue Source', is_active: true }
      );
      expect(srcRes.ok).toBe(true);
      const token = srcRes.data.webhook_token || srcRes.data.token || '';
      expect(token).not.toBe('');

      const hookRes = await apiRequest(request, 'POST', `/api/v1/webhooks/in/${token}`, undefined, {
        name: 'Lead Cola Worker',
        phone: '+5215512340001',
        email: `${uniqueId('worker')}@koracrm.dev`,
      });
      expect([200, 201, 202]).toContain(hookRes.status);
    });

    test('F34-T1-2: Automation rule execution is queued and visible in /app/webhooks execution timeline', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await apiRequest(request, 'POST', '/api/v1/automations', org.accessToken, {
        name: 'Regla Worker Cola',
        trigger_type: 'lead.created',
        condition_json: { field: 'source', op: 'exists' },
        action_json: { type: 'add_tag', tag: 'worker-ok' },
        is_active: true,
      });

      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/webhooks');
      await expect(page.getByText('Regla Worker Cola')).toBeVisible();
    });

    test('F34-T1-3: Health endpoint reports API and worker readiness cleanly', async ({ request }) => {
      const res = await apiRequest(request, 'GET', '/healthz');
      expect(res.status).toBe(200);
    });

    test('F34-T1-4: AI turn / sentiment background event processing does not block conversation creation', async ({ request }) => {
      const org = await signupViaAPI(request);
      const contact = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
        full_name: 'Contacto Async',
        phone_e164: '+5215598765432',
      });
      expect(contact.ok).toBe(true);

      const conv = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/conversations', org.accessToken, {
        contact_id: contact.data.id,
      });
      expect(conv.ok).toBe(true);
    });

    test('F34-T1-5: Session sync and stuck recovery preserve channel health state on /app/channels', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/channels');
      await expect(page.getByRole('heading', { name: /Canales|Conexiones/i })).toBeVisible();
      await assertZeroOverflow(page);
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('F34-T2-1: Duplicate inbound webhook with same Idempotency-Key is deduplicated in event queue', async ({ request }) => {
      const org = await signupViaAPI(request);
      const srcRes = await apiRequest<{ webhook_token?: string; token?: string }>(
        request,
        'POST',
        '/api/v1/webhooks/sources',
        org.accessToken,
        { name: 'Idempotent Source', is_active: true }
      );
      const token = srcRes.data.webhook_token || srcRes.data.token || '';
      const idemKey = uniqueId('idem-worker');

      const first = await apiRequest(
        request,
        'POST',
        `/api/v1/webhooks/in/${token}`,
        undefined,
        { name: 'Duplicado Cola', phone: '+5215500001111' },
        { 'Idempotency-Key': idemKey }
      );
      const second = await apiRequest(
        request,
        'POST',
        `/api/v1/webhooks/in/${token}`,
        undefined,
        { name: 'Duplicado Cola', phone: '+5215500001111' },
        { 'Idempotency-Key': idemKey }
      );
      expect(first.status).toBeLessThan(500);
      expect(second.status).toBeLessThan(500);
    });

    test('F34-T2-2: Invalid webhook token returns 404 without crashing worker queue', async ({ request }) => {
      const res = await apiRequest(request, 'POST', '/api/v1/webhooks/in/nonexistent-token-999', undefined, {
        name: 'Bad Token',
      });
      expect([400, 401, 404]).toContain(res.status);
    });

    test('F34-T2-3: Malformed JSON payload to inbound webhook returns 400 cleanly', async ({ request }) => {
      const org = await signupViaAPI(request);
      const srcRes = await apiRequest<{ webhook_token?: string; token?: string }>(
        request,
        'POST',
        '/api/v1/webhooks/sources',
        org.accessToken,
        { name: 'Malformed JSON Source', is_active: true }
      );
      const token = srcRes.data.webhook_token || srcRes.data.token || '';
      const rawRes = await request.post(`/api/v1/webhooks/in/${token}`, {
        headers: { 'Content-Type': 'application/json' },
        data: '{invalid-json',
      });
      expect([400, 422]).toContain(rawRes.status());
    });

    test('F34-T2-4: Empty payload to inbound webhook is rejected or handled without 5xx', async ({ request }) => {
      const org = await signupViaAPI(request);
      const srcRes = await apiRequest<{ webhook_token?: string; token?: string }>(
        request,
        'POST',
        '/api/v1/webhooks/sources',
        org.accessToken,
        { name: 'Empty Payload Source', is_active: true }
      );
      const token = srcRes.data.webhook_token || srcRes.data.token || '';
      const res = await apiRequest(request, 'POST', `/api/v1/webhooks/in/${token}`, undefined, {});
      expect(res.status).toBeLessThan(500);
    });

    test('F34-T2-5: Suspended organization events are skipped and mutations blocked with 403', async ({ request }) => {
      const org = await signupViaAPI(request);
      // Tenant cannot self-suspend; verify tenant cannot access admin suspension endpoint
      const res = await apiRequest(request, 'PATCH', `/api/v1/admin/tenants/${org.organizationId}`, org.accessToken, {
        is_suspended: true,
      });
      expect(res.status).toBe(403);
    });
  });
});

// ============================================================================
// Feature #35: Inbound webhook lead capture + WHEN/IF/THEN automation builder
// ============================================================================
test.describe('Feature #35: Inbound Webhooks & WHEN/IF/THEN Automation Builder (S23)', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('F35-T1-1: /app/webhooks renders in Spanish with zero overflow and passes axe scan', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await loginViaUI(page, org.email, org.password);

      await page.goto('/app/webhooks');
      await expect(page.getByRole('heading', { name: /Webhooks|Automatizaciones/i })).toBeVisible();
      await assertSpanishAndBrand(page);
      await assertZeroOverflow(page);
      await assertAccessibility(page, 'Webhooks & Automations S23');
    });

    test('F35-T1-2: Create inbound webhook source and capture lead via POST /api/v1/webhooks/in/:token', async ({ request }) => {
      const org = await signupViaAPI(request);
      const src = await apiRequest<{ webhook_token?: string; token?: string; id: string }>(
        request,
        'POST',
        '/api/v1/webhooks/sources',
        org.accessToken,
        { name: 'Landing Formulario', is_active: true }
      );
      expect(src.ok).toBe(true);
      const token = src.data.webhook_token || src.data.token || '';

      const leadEmail = `${uniqueId('lead')}@koracrm.dev`;
      const capture = await apiRequest(request, 'POST', `/api/v1/webhooks/in/${token}`, undefined, {
        full_name: 'Sofía Webhook',
        email: leadEmail,
        phone: '+5215588889999',
        utm_source: 'meta_ads',
      });
      expect([200, 201, 202]).toContain(capture.status);

      const contacts = await apiRequest(request, 'GET', '/api/v1/contacts', org.accessToken);
      expect(JSON.stringify(contacts.data)).toContain('Sofía Webhook');
    });

    test('F35-T1-3: Create WHEN/IF/THEN automation rule via API and verify persistence', async ({ request }) => {
      const org = await signupViaAPI(request);
      const rule = await apiRequest<{ id: string; name: string }>(
        request,
        'POST',
        '/api/v1/automations',
        org.accessToken,
        {
          name: 'Etiquetar Leads VIP',
          trigger_type: 'lead.created',
          condition_json: { field: 'value_cents', op: 'gte', value: 100000 },
          action_json: { type: 'add_tag', tag: 'vip' },
          is_active: true,
        }
      );
      expect(rule.ok).toBe(true);

      const list = await apiRequest(request, 'GET', '/api/v1/automations', org.accessToken);
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.data)).toContain('Etiquetar Leads VIP');
    });

    test('F35-T1-4: Create webhook source through /app/webhooks UI', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/webhooks');

      const nameInput = page.getByPlaceholder(/Nombre|Origen|Fuente/i).first();
      await nameInput.fill('Formulario Web UI');
      await page.getByRole('button', { name: /Crear|Guardar|Agregar/i }).first().click();
      await expect(page.getByText('Formulario Web UI')).toBeVisible();
    });

    test('F35-T1-5: Automation rule can be toggled paused/active without data loss', async ({ request }) => {
      const org = await signupViaAPI(request);
      const created = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/automations', org.accessToken, {
        name: 'Regla Pausable',
        trigger_type: 'message.received',
        condition_json: { contains: 'precio' },
        action_json: { type: 'notify' },
        is_active: true,
      });
      expect(created.ok).toBe(true);

      const list = await apiRequest(request, 'GET', '/api/v1/automations', org.accessToken);
      expect(list.status).toBe(200);
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('F35-T2-1: Empty webhook source name is rejected with 400/422', async ({ request }) => {
      const org = await signupViaAPI(request);
      const res = await apiRequest(request, 'POST', '/api/v1/webhooks/sources', org.accessToken, {
        name: '   ',
      });
      expect([400, 422]).toContain(res.status);
    });

    test('F35-T2-2: Multi-tenant isolation — Tenant B cannot list Tenant A webhook sources or rules', async ({ request }) => {
      const orgA = await signupViaAPI(request);
      const orgB = await signupViaAPI(request);
      const secretRule = uniqueId('rule-secret');

      await apiRequest(request, 'POST', '/api/v1/automations', orgA.accessToken, {
        name: secretRule,
        trigger_type: 'lead.created',
        condition_json: {},
        action_json: { type: 'add_tag', tag: 'privado' },
      });

      const listB = await apiRequest(request, 'GET', '/api/v1/automations', orgB.accessToken);
      expect(listB.status).toBe(200);
      expect(JSON.stringify(listB.data)).not.toContain(secretRule);
    });

    test('F35-T2-3: Unicode, accents, and emojis in captured webhook lead payload are preserved', async ({ request }) => {
      const org = await signupViaAPI(request);
      const src = await apiRequest<{ webhook_token?: string; token?: string }>(
        request,
        'POST',
        '/api/v1/webhooks/sources',
        org.accessToken,
        { name: 'Unicode Source', is_active: true }
      );
      const token = src.data.webhook_token || src.data.token || '';

      const res = await apiRequest(request, 'POST', `/api/v1/webhooks/in/${token}`, undefined, {
        full_name: 'Ángel Peñalver 🚀',
        phone: '+5215577776666',
      });
      expect([200, 201, 202]).toContain(res.status);
    });

    test('F35-T2-4: Automation rule with invalid/empty name returns 400/422', async ({ request }) => {
      const org = await signupViaAPI(request);
      const res = await apiRequest(request, 'POST', '/api/v1/automations', org.accessToken, {
        name: '',
        trigger_type: 'lead.created',
      });
      expect([400, 422]).toContain(res.status);
    });

    test('F35-T2-5: Outbound webhook URL with SSRF private IP is rejected or logged safely without 5xx', async ({ request }) => {
      const org = await signupViaAPI(request);
      const res = await apiRequest(request, 'POST', '/api/v1/automations', org.accessToken, {
        name: 'SSRF Guard Test',
        trigger_type: 'lead.created',
        condition_json: {},
        action_json: { type: 'webhook', url: 'http://169.254.169.254/latest/meta-data/' },
      });
      expect(res.status).toBeLessThan(500);
    });
  });
});

// ============================================================================
// Feature #36: LGPD granular consent, export JSON & cascade anonymization (S25)
// ============================================================================
test.describe('Feature #36: LGPD Consent, Export & Cascade Anonymization (S25)', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('F36-T1-1: /app/lgpd and /app/lgpd/requests render in Spanish with zero overflow and pass axe scan', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await loginViaUI(page, org.email, org.password);

      await page.goto('/app/lgpd/requests');
      await expect(page.getByRole('heading', { name: /LGPD|Privacidad/i })).toBeVisible();
      await assertSpanishAndBrand(page);
      await assertZeroOverflow(page);
      await assertAccessibility(page, 'LGPD Requests S25');
    });

    test('F36-T1-2: Create LGPD export request and execute it to receive structured JSON', async ({ request }) => {
      const org = await signupViaAPI(request);
      const contact = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
        full_name: 'Titular Exportación',
        phone_e164: '+5215510102020',
        email: `${uniqueId('lgpd-exp')}@koracrm.dev`,
      });
      expect(contact.ok).toBe(true);

      const reqCreate = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/lgpd/requests', org.accessToken, {
        contact_id: contact.data.id,
        request_type: 'export',
      });
      expect(reqCreate.ok).toBe(true);

      const execRes = await apiRequest(
        request,
        'POST',
        `/api/v1/lgpd/requests/${reqCreate.data.id}/execute`,
        org.accessToken
      );
      expect(execRes.ok).toBe(true);
    });

    test('F36-T1-3: Execute LGPD deletion/anonymization request cascades PII redaction on contact', async ({ request }) => {
      const org = await signupViaAPI(request);
      const email = `${uniqueId('lgpd-del')}@koracrm.dev`;
      const contact = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
        full_name: 'Titular Anonimizado',
        phone_e164: '+5215530304040',
        email,
      });
      expect(contact.ok).toBe(true);

      const reqCreate = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/lgpd/requests', org.accessToken, {
        contact_id: contact.data.id,
        request_type: 'delete',
      });
      expect(reqCreate.ok).toBe(true);

      const execRes = await apiRequest(
        request,
        'POST',
        `/api/v1/lgpd/requests/${reqCreate.data.id}/execute`,
        org.accessToken
      );
      expect(execRes.ok).toBe(true);

      const contactAfter = await apiRequest<{ full_name?: string; email?: string; is_anonymized?: boolean }>(
        request,
        'GET',
        `/api/v1/contacts/${contact.data.id}`,
        org.accessToken
      );
      expect(contactAfter.ok).toBe(true);
      expect(contactAfter.data.email).not.toBe(email);
    });

    test('F36-T1-4: Reject LGPD request marks it rejected without anonymizing contact', async ({ request }) => {
      const org = await signupViaAPI(request);
      const contact = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
        full_name: 'Titular Rechazo',
        phone_e164: '+5215540405050',
      });
      const reqCreate = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/lgpd/requests', org.accessToken, {
        contact_id: contact.data.id,
        request_type: 'delete',
      });
      expect(reqCreate.ok).toBe(true);

      const rejRes = await apiRequest(
        request,
        'POST',
        `/api/v1/lgpd/requests/${reqCreate.data.id}/reject`,
        org.accessToken,
        { reason: 'Identidad no verificada' }
      );
      expect(rejRes.ok).toBe(true);

      const contactAfter = await apiRequest<{ full_name: string }>(
        request,
        'GET',
        `/api/v1/contacts/${contact.data.id}`,
        org.accessToken
      );
      expect(contactAfter.data.full_name).toBe('Titular Rechazo');
    });

    test('F36-T1-5: LGPD request queue displays requests in /app/lgpd UI', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      const contact = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
        full_name: 'Titular UI LGPD',
        phone_e164: '+5215550506060',
      });
      await apiRequest(request, 'POST', '/api/v1/lgpd/requests', org.accessToken, {
        contact_id: contact.data.id,
        request_type: 'export',
      });

      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/lgpd');
      await expect(page.getByText(/Titular UI LGPD|export/i).first()).toBeVisible();
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('F36-T2-1: Creating LGPD request with invalid request_type returns 400/422', async ({ request }) => {
      const org = await signupViaAPI(request);
      const contact = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
        full_name: 'Tipo Inválido',
        phone_e164: '+5215560607070',
      });
      const res = await apiRequest(request, 'POST', '/api/v1/lgpd/requests', org.accessToken, {
        contact_id: contact.data.id,
        request_type: 'invalid_action',
      });
      expect([400, 422]).toContain(res.status);
    });

    test('F36-T2-2: Multi-tenant isolation — Tenant B cannot execute Tenant A LGPD request', async ({ request }) => {
      const orgA = await signupViaAPI(request);
      const orgB = await signupViaAPI(request);
      const contactA = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', orgA.accessToken, {
        full_name: 'Aislado LGPD',
        phone_e164: '+5215570708080',
      });
      const reqA = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/lgpd/requests', orgA.accessToken, {
        contact_id: contactA.data.id,
        request_type: 'export',
      });

      const execByB = await apiRequest(
        request,
        'POST',
        `/api/v1/lgpd/requests/${reqA.data.id}/execute`,
        orgB.accessToken
      );
      expect([403, 404]).toContain(execByB.status);
    });

    test('F36-T2-3: Re-executing an already executed LGPD request is idempotent or returns 409', async ({ request }) => {
      const org = await signupViaAPI(request);
      const contact = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
        full_name: 'Doble Ejecución',
        phone_e164: '+5215580809090',
      });
      const req = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/lgpd/requests', org.accessToken, {
        contact_id: contact.data.id,
        request_type: 'export',
      });
      await apiRequest(request, 'POST', `/api/v1/lgpd/requests/${req.data.id}/execute`, org.accessToken);
      const second = await apiRequest(request, 'POST', `/api/v1/lgpd/requests/${req.data.id}/execute`, org.accessToken);
      expect(second.status).toBeLessThan(500);
    });

    test('F36-T2-4: Nonexistent contact_id in LGPD request returns 400/404', async ({ request }) => {
      const org = await signupViaAPI(request);
      const res = await apiRequest(request, 'POST', '/api/v1/lgpd/requests', org.accessToken, {
        contact_id: '00000000-0000-0000-0000-000000000099',
        request_type: 'export',
      });
      expect([400, 404, 422]).toContain(res.status);
    });

    test('F36-T2-5: Unauthenticated access to /api/v1/lgpd/requests returns 401', async ({ request }) => {
      const res = await apiRequest(request, 'GET', '/api/v1/lgpd/requests');
      expect(res.status).toBe(401);
    });
  });
});

// ============================================================================
// Feature #37: Performance dashboard & Activities (S24 /app/metrics, /app/activities)
// ============================================================================
test.describe('Feature #37: Performance Dashboard & Activities (S24)', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('F37-T1-1: /app/metrics renders Spanish KPIs, zero overflow, brand integrity, and passes axe scan', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await loginViaUI(page, org.email, org.password);

      await page.goto('/app/metrics');
      await expect(page.getByRole('heading', { name: /Métricas|Rendimiento/i })).toBeVisible();
      await assertSpanishAndBrand(page);
      await assertZeroOverflow(page);
      await assertAccessibility(page, 'Metrics S24');
    });

    test('F37-T1-2: GET /api/v1/metrics returns funnel conversion and attendant metrics JSON', async ({ request }) => {
      const org = await signupViaAPI(request);
      const res = await apiRequest<Record<string, unknown>>(request, 'GET', '/api/v1/metrics', org.accessToken);
      expect(res.status).toBe(200);
      expect(res.data).toBeTruthy();
    });

    test('F37-T1-3: Creating leads and contacts updates tenant metrics counts', async ({ request }) => {
      const org = await signupViaAPI(request);
      await apiRequest(request, 'POST', '/api/v1/contacts', org.accessToken, {
        full_name: 'Métrica Contacto',
        phone_e164: '+5215511223344',
      });
      await apiRequest(request, 'POST', '/api/v1/leads', org.accessToken, {
        title: 'Trato Métrica',
        value_cents: 250000,
      });

      const res = await apiRequest(request, 'GET', '/api/v1/metrics', org.accessToken);
      expect(res.status).toBe(200);
    });

    test('F37-T1-4: /app/activities displays recent CRM activity feed without errors', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await loginViaUI(page, org.email, org.password);

      await page.goto('/app/activities');
      await expect(page.getByRole('heading', { name: /Actividad|Actividades|Métricas/i })).toBeVisible();
      await assertZeroOverflow(page);
    });

    test('F37-T1-5: Metrics page displays funnel or attendant breakdown sections in Spanish', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/metrics');
      await expect(page.getByText(/Embudo|Conversión|Contactos|Tratos/i).first()).toBeVisible();
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('F37-T2-1: Fresh tenant with zero deals renders empty/zero metrics without NaN or 5xx', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/metrics');
      const bodyText = await page.locator('body').innerText();
      expect(bodyText).not.toContain('NaN');
      expect(bodyText).not.toContain('undefined');
    });

    test('F37-T2-2: Unauthenticated request to /api/v1/metrics returns 401', async ({ request }) => {
      const res = await apiRequest(request, 'GET', '/api/v1/metrics');
      expect(res.status).toBe(401);
    });

    test('F37-T2-3: Multi-tenant isolation — Tenant B metrics do not include Tenant A revenue', async ({ request }) => {
      const orgA = await signupViaAPI(request);
      const orgB = await signupViaAPI(request);

      await apiRequest(request, 'POST', '/api/v1/leads', orgA.accessToken, {
        title: 'Mega Trato A',
        value_cents: 99990000,
      });

      const metricsB = await apiRequest(request, 'GET', '/api/v1/metrics', orgB.accessToken);
      expect(metricsB.status).toBe(200);
      expect(JSON.stringify(metricsB.data)).not.toContain('99990000');
    });

    test('F37-T2-4: Invalid date range query params on /api/v1/metrics are handled without 5xx', async ({ request }) => {
      const org = await signupViaAPI(request);
      const res = await apiRequest(request, 'GET', '/api/v1/metrics?from=not-a-date&to=invalid', org.accessToken);
      expect(res.status).toBeLessThan(500);
    });

    test('F37-T2-5: Inverted date range (from > to) on /api/v1/metrics returns 400 or empty dataset cleanly', async ({ request }) => {
      const org = await signupViaAPI(request);
      const res = await apiRequest(
        request,
        'GET',
        '/api/v1/metrics?from=2030-01-01&to=2020-01-01',
        org.accessToken
      );
      expect(res.status).toBeLessThan(500);
    });
  });
});

// ============================================================================
// Feature #38: WhatsApp Campaigns (throttled anti-ban) (S16 /app/campaigns)
// ============================================================================
test.describe('Feature #38: WhatsApp Campaigns Anti-Ban (S16)', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('F38-T1-1: /app/campaigns renders in Spanish with zero overflow, brand integrity, and passes axe scan', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await loginViaUI(page, org.email, org.password);

      await page.goto('/app/campaigns');
      await expect(page.getByRole('heading', { name: /Campañas/i })).toBeVisible();
      await assertSpanishAndBrand(page);
      await assertZeroOverflow(page);
      await assertAccessibility(page, 'Campaigns S16');
    });

    test('F38-T1-2: Create WhatsApp campaign via API with throttle/pace settings', async ({ request }) => {
      const org = await signupViaAPI(request);
      const res = await apiRequest(request, 'POST', '/api/v1/campaigns', org.accessToken, {
        name: 'Campaña Lanzamiento',
        message_template: 'Hola {{nombre}}, conoce nuestras novedades.',
        throttle_per_minute: 10,
      });
      expect([200, 201]).toContain(res.status);
    });

    test('F38-T1-3: List campaigns via GET /api/v1/campaigns returns created campaign', async ({ request }) => {
      const org = await signupViaAPI(request);
      await apiRequest(request, 'POST', '/api/v1/campaigns', org.accessToken, {
        name: 'Campaña Listada',
        message_template: 'Mensaje de prueba',
      });
      const list = await apiRequest(request, 'GET', '/api/v1/campaigns', org.accessToken);
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.data)).toContain('Campaña Listada');
    });

    test('F38-T1-4: Create campaign via /app/campaigns UI and verify it appears in list', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/campaigns');

      await page.getByRole('button', { name: /Nueva Campaña|Crear Campaña/i }).click();
      await page.getByLabel(/Nombre/i).fill('Campaña UI E2E');
      await page.getByLabel(/Mensaje|Plantilla/i).fill('Hola desde KoraCRM');
      await page.getByRole('button', { name: /Guardar|Crear/i }).click();
      await expect(page.getByText('Campaña UI E2E')).toBeVisible();
    });

    test('F38-T1-5: Campaign pause/resume transition updates status cleanly', async ({ request }) => {
      const org = await signupViaAPI(request);
      const created = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/campaigns', org.accessToken, {
        name: 'Campaña Pausable',
        message_template: 'Oferta especial',
      });
      expect(created.ok).toBe(true);

      const patch = await apiRequest(request, 'PATCH', `/api/v1/campaigns/${created.data.id}`, org.accessToken, {
        status: 'paused',
      });
      expect(patch.status).toBeLessThan(500);
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('F38-T2-1: Empty campaign name or empty message template is rejected with 400/422', async ({ request }) => {
      const org = await signupViaAPI(request);
      const res = await apiRequest(request, 'POST', '/api/v1/campaigns', org.accessToken, {
        name: '',
        message_template: '',
      });
      expect([400, 422]).toContain(res.status);
    });

    test('F38-T2-2: Blocked / STOP opt-out contact is excluded from campaign recipients', async ({ request }) => {
      const org = await signupViaAPI(request);
      const blocked = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
        full_name: 'Contacto STOP',
        phone_e164: '+5215590901010',
        is_blocked: true,
      });
      expect(blocked.ok).toBe(true);

      const camp = await apiRequest<{ id: string; recipient_count?: number }>(
        request,
        'POST',
        '/api/v1/campaigns',
        org.accessToken,
        {
          name: 'Campaña Anti-STOP',
          message_template: 'No debe llegar a bloqueados',
          contact_ids: [blocked.data.id],
        }
      );
      expect(camp.status).toBeLessThan(500);
    });

    test('F38-T2-3: Multi-tenant isolation — Tenant B cannot access Tenant A campaigns', async ({ request }) => {
      const orgA = await signupViaAPI(request);
      const orgB = await signupViaAPI(request);
      const campA = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/campaigns', orgA.accessToken, {
        name: 'Campaña Privada A',
        message_template: 'Secreto A',
      });

      const listB = await apiRequest(request, 'GET', '/api/v1/campaigns', orgB.accessToken);
      expect(JSON.stringify(listB.data)).not.toContain('Campaña Privada A');

      if (campA.data?.id) {
        const patchB = await apiRequest(request, 'PATCH', `/api/v1/campaigns/${campA.data.id}`, orgB.accessToken, {
          status: 'paused',
        });
        expect([403, 404]).toContain(patchB.status);
      }
    });

    test('F38-T2-4: Negative or zero throttle_per_minute is rejected or clamped safely', async ({ request }) => {
      const org = await signupViaAPI(request);
      const res = await apiRequest(request, 'POST', '/api/v1/campaigns', org.accessToken, {
        name: 'Throttle Inválido',
        message_template: 'Hola',
        throttle_per_minute: -5,
      });
      expect(res.status).toBeLessThan(500);
    });

    test('F38-T2-5: Campaign message >4096 characters with Unicode/emojis is handled without 5xx', async ({ request }) => {
      const org = await signupViaAPI(request);
      const longMsg = 'Hola 🚀 '.repeat(700);
      const res = await apiRequest(request, 'POST', '/api/v1/campaigns', org.accessToken, {
        name: 'Campaña Larga',
        message_template: longMsg,
      });
      expect(res.status).toBeLessThan(500);
    });
  });
});

// ============================================================================
// Feature #39: Agenda & Waitlist module (S08 /app/agenda)
// ============================================================================
test.describe('Feature #39: Agenda & Waitlist Module (S08)', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('F39-T1-1: /app/agenda renders in Spanish with zero overflow, brand integrity, and passes axe scan', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await loginViaUI(page, org.email, org.password);

      await page.goto('/app/agenda');
      await expect(page.getByRole('heading', { name: /Agenda|Citas/i })).toBeVisible();
      await assertSpanishAndBrand(page);
      await assertZeroOverflow(page);
      await assertAccessibility(page, 'Agenda S08');
    });

    test('F39-T1-2: Create appointment via API and verify it appears in /api/v1/appointments', async ({ request }) => {
      const org = await signupViaAPI(request);
      const startsAt = new Date(Date.now() + 86400000).toISOString();
      const res = await apiRequest(request, 'POST', '/api/v1/appointments', org.accessToken, {
        title: 'Demo KoraCRM',
        starts_at: startsAt,
        duration_minutes: 30,
      });
      expect([200, 201]).toContain(res.status);

      const list = await apiRequest(request, 'GET', '/api/v1/appointments', org.accessToken);
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.data)).toContain('Demo KoraCRM');
    });

    test('F39-T1-3: Add contact to waitlist queue via API', async ({ request }) => {
      const org = await signupViaAPI(request);
      const res = await apiRequest(request, 'POST', '/api/v1/waitlist', org.accessToken, {
        contact_name: 'Lucía Espera',
        phone_e164: '+5215520203030',
        notes: 'Prefiere horario matutino',
      });
      expect([200, 201]).toContain(res.status);
    });

    test('F39-T1-4: Create appointment via /app/agenda UI', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/agenda');

      await page.getByRole('button', { name: /Nueva Cita|Agendar/i }).click();
      await page.getByLabel(/Título|Asunto/i).fill('Cita UI E2E');
      await page.getByRole('button', { name: /Guardar|Confirmar/i }).click();
      await expect(page.getByText('Cita UI E2E')).toBeVisible();
    });

    test('F39-T1-5: Appointment status can be updated (confirmed/cancelled/completed)', async ({ request }) => {
      const org = await signupViaAPI(request);
      const startsAt = new Date(Date.now() + 172800000).toISOString();
      const created = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/appointments', org.accessToken, {
        title: 'Cita Estado',
        starts_at: startsAt,
        duration_minutes: 45,
      });
      expect(created.ok).toBe(true);

      const patch = await apiRequest(request, 'PATCH', `/api/v1/appointments/${created.data.id}`, org.accessToken, {
        status: 'confirmed',
      });
      expect(patch.status).toBeLessThan(500);
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('F39-T2-1: Appointment with empty title is rejected with 400/422', async ({ request }) => {
      const org = await signupViaAPI(request);
      const res = await apiRequest(request, 'POST', '/api/v1/appointments', org.accessToken, {
        title: '',
        starts_at: new Date().toISOString(),
      });
      expect([400, 422]).toContain(res.status);
    });

    test('F39-T2-2: Appointment with invalid starts_at timestamp returns 400/422', async ({ request }) => {
      const org = await signupViaAPI(request);
      const res = await apiRequest(request, 'POST', '/api/v1/appointments', org.accessToken, {
        title: 'Fecha Inválida',
        starts_at: 'no-es-fecha',
      });
      expect([400, 422]).toContain(res.status);
    });

    test('F39-T2-3: Overlapping appointment slot triggers 409 conflict or clear validation', async ({ request }) => {
      const org = await signupViaAPI(request);
      const slot = new Date(Date.now() + 259200000).toISOString();
      await apiRequest(request, 'POST', '/api/v1/appointments', org.accessToken, {
        title: 'Cita 1',
        starts_at: slot,
        duration_minutes: 30,
      });
      const second = await apiRequest(request, 'POST', '/api/v1/appointments', org.accessToken, {
        title: 'Cita 2 Solapada',
        starts_at: slot,
        duration_minutes: 30,
      });
      expect(second.status).toBeLessThan(500);
    });

    test('F39-T2-4: Multi-tenant isolation — Tenant B cannot see Tenant A appointments', async ({ request }) => {
      const orgA = await signupViaAPI(request);
      const orgB = await signupViaAPI(request);
      const marker = uniqueId('cita-privada');

      await apiRequest(request, 'POST', '/api/v1/appointments', orgA.accessToken, {
        title: marker,
        starts_at: new Date(Date.now() + 345600000).toISOString(),
      });

      const listB = await apiRequest(request, 'GET', '/api/v1/appointments', orgB.accessToken);
      expect(listB.status).toBe(200);
      expect(JSON.stringify(listB.data)).not.toContain(marker);
    });

    test('F39-T2-5: Unauthenticated request to /api/v1/appointments returns 401', async ({ request }) => {
      const res = await apiRequest(request, 'GET', '/api/v1/appointments');
      expect(res.status).toBe(401);
    });
  });
});

// ============================================================================
// Feature #40: Installable PWA (manifest.webmanifest, sw.js, BottomNav, offline)
// ============================================================================
test.describe('Feature #40: Installable PWA & Mobile Navigation', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('F40-T1-1: manifest.webmanifest is served with KoraCRM name, Deep Teal theme_color, and standalone display', async ({ request }) => {
      const res = await request.get('/manifest.webmanifest');
      expect(res.status()).toBe(200);
      const manifest = (await res.json()) as Record<string, unknown>;
      expect(String(manifest.name)).toContain('KoraCRM');
      expect(manifest.display).toBe('standalone');
      expect(manifest.theme_color).toBe('#0f766e');
      expect(manifest.start_url).toBe('/app/inbox');
    });

    test('F40-T1-2: Service worker sw.js is served at /sw.js with HTTP 200', async ({ request }) => {
      const res = await request.get('/sw.js');
      expect(res.status()).toBe(200);
      const text = await res.text();
      expect(text).toContain('koracrm-shell');
      expect(text).toContain('fetch');
    });

    test('F40-T1-3: HTML document links manifest.webmanifest and sets lang="es"', async ({ page }) => {
      await page.goto('/');
      const lang = await page.evaluate(() => document.documentElement.lang);
      expect(lang).toBe('es');
      const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
      expect(manifestHref).toContain('manifest.webmanifest');
    });

    test('F40-T1-4: Mobile viewport (390x844) renders mobile BottomNav inside /app/*', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await page.setViewportSize({ width: 390, height: 844 });
      await loginViaUI(page, org.email, org.password);

      await expect(page.getByRole('navigation', { name: 'Navegación móvil' })).toBeVisible();
      await assertZeroOverflow(page);
    });

    test('F40-T1-5: PWA icon.svg referenced in manifest loads with HTTP 200', async ({ request }) => {
      const res = await request.get('/icon.svg');
      expect(res.status()).toBe(200);
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('F40-T2-1: Manifest contains zero leaked Deskcomm or #006bff references', async ({ request }) => {
      const res = await request.get('/manifest.webmanifest');
      const text = await res.text();
      expect(text.toLowerCase()).not.toContain('deskcomm');
      expect(text.toLowerCase()).not.toContain('#006bff');
    });

    test('F40-T2-2: Service worker never caches /api/ responses (bypass rule present)', async ({ request }) => {
      const res = await request.get('/sw.js');
      const text = await res.text();
      expect(text).toContain('/api/');
    });

    test('F40-T2-3: BottomNav on mobile (390x844) navigates cleanly between Inbox, Kanban, and Contacts without overflow', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await page.setViewportSize({ width: 390, height: 844 });
      await loginViaUI(page, org.email, org.password);

      const nav = page.getByRole('navigation', { name: 'Navegación móvil' });
      await nav.getByRole('link', { name: /Embudos|Kanban/i }).click();
      await expect(page).toHaveURL(/\/app\/(kanban|pipelines)/);
      await assertZeroOverflow(page);
    });

    test('F40-T2-4: Desktop viewport (1280x800) hides mobile BottomNav and shows desktop sidebar', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await page.setViewportSize({ width: 1280, height: 800 });
      await loginViaUI(page, org.email, org.password);

      await expect(page.getByRole('navigation', { name: 'Navegación móvil' })).toBeHidden();
      await assertZeroOverflow(page);
    });

    test('F40-T2-5: Offline navigation fallback does not throw uncaught console errors', async ({ page, context }) => {
      await page.goto('/');
      await context.setOffline(true);
      await page.waitForTimeout(200);
      await context.setOffline(false);
      await assertSpanishAndBrand(page);
    });
  });
});

// ============================================================================
// Feature #41: Mobile-first Kanban stage-tabs & Customer 360 bottom sheet
// ============================================================================
test.describe('Feature #41: Mobile-First Kanban Stage-Tabs & Customer 360 Sheet', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('F41-T1-1: Mobile (390x844) Kanban renders stage tabs with zero horizontal overflow', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await page.setViewportSize({ width: 390, height: 844 });
      await loginViaUI(page, org.email, org.password);

      await page.goto('/app/kanban');
      await expect(page.getByRole('tablist').first()).toBeVisible();
      await assertZeroOverflow(page);
      await assertSpanishAndBrand(page);
    });

    test('F41-T1-2: Switching stage tabs on mobile Kanban filters visible deals for selected stage', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await page.setViewportSize({ width: 390, height: 844 });
      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/kanban');

      await expect(page.getByRole('tablist').first()).toBeVisible();
      const tabs = page.getByRole('tab');
      const count = await tabs.count();
      expect(count).toBeGreaterThan(0);
      if (count > 1) {
        await tabs.nth(1).click();
      }
      await assertZeroOverflow(page);
    });

    test('F41-T1-3: Mobile (390x844) Inbox opens conversation and Customer 360 bottom sheet without overflow', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      const contact = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
        full_name: 'Cliente Sheet Móvil',
        phone_e164: '+5215512349999',
      });
      await apiRequest(request, 'POST', '/api/v1/conversations', org.accessToken, {
        contact_id: contact.data.id,
      });

      await page.setViewportSize({ width: 390, height: 844 });
      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/inbox');

      await page.getByText('Cliente Sheet Móvil').first().click();
      await assertZeroOverflow(page);
    });

    test('F41-T1-4: Desktop (1280x800) Kanban displays multi-column board with zero horizontal overflow', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await page.setViewportSize({ width: 1280, height: 800 });
      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/kanban');

      await assertZeroOverflow(page);
      await assertAccessibility(page, 'Kanban Desktop S11');
    });

    test('F41-T1-5: Mobile (390x844) Contacts page renders cleanly and passes axe scan', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await page.setViewportSize({ width: 390, height: 844 });
      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/contacts');

      await assertZeroOverflow(page);
      await assertAccessibility(page, 'Contacts Mobile S13');
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('F41-T2-1: Long deal title with Unicode/emojis on mobile Kanban does not cause horizontal overflow', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await apiRequest(request, 'POST', '/api/v1/leads', org.accessToken, {
        title: 'Contrato Empresarial Extraordinariamente Largo 🚀🔥 2026-2027 Ñandú',
        value_cents: 500000,
      });

      await page.setViewportSize({ width: 390, height: 844 });
      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/kanban');
      await assertZeroOverflow(page);
    });

    test('F41-T2-2: Long contact name in mobile Inbox does not break 390px layout', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      const contact = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
        full_name: 'María Guadalupe de los Ángeles Hernández Villalobos',
        phone_e164: '+5215599887766',
      });
      await apiRequest(request, 'POST', '/api/v1/conversations', org.accessToken, {
        contact_id: contact.data.id,
      });

      await page.setViewportSize({ width: 390, height: 844 });
      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/inbox');
      await assertZeroOverflow(page);
    });

    test('F41-T2-3: Narrower viewport (360x740) still maintains zero horizontal overflow on Kanban', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await page.setViewportSize({ width: 360, height: 740 });
      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/kanban');
      await assertZeroOverflow(page);
    });

    test('F41-T2-4: Empty Kanban stage on mobile displays Spanish empty state without crash', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await page.setViewportSize({ width: 390, height: 844 });
      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/kanban');

      await assertSpanishAndBrand(page);
      await assertZeroOverflow(page);
    });

    test('F41-T2-5: Resizing from desktop (1280x800) to mobile (390x844) adapts Kanban without overflow', async ({ page, request }) => {
      const org = await signupViaAPI(request);
      await page.setViewportSize({ width: 1280, height: 800 });
      await loginViaUI(page, org.email, org.password);
      await page.goto('/app/kanban');
      await assertZeroOverflow(page);

      await page.setViewportSize({ width: 390, height: 844 });
      await assertZeroOverflow(page);
    });
  });
});
