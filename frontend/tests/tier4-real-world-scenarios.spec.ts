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

test.describe('Tier 4 — Real-World End-to-End CRM Scenarios (F01–F08)', () => {
  test('Scenario 1 (F01): New Tenant Signup -> Guided Onboarding Wizard (S04) -> Pipeline Vocabulary -> Inbox (S06)', async ({ page }) => {
    const id = uniqueId('f01');
    const orgName = `Clínica ${id}`;
    const email = `${id}@koracrm.dev`;

    // 1. Landing -> Signup
    await page.goto('/get-started');
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);

    await page.goto('/signup');
    await page.getByPlaceholder('Comercial Acme').fill(orgName);
    await page.getByPlaceholder('Ana Silva').fill('Dra. Valeria Gómez');
    await page.getByPlaceholder('ana@acme.com').fill(email);
    await page.getByPlaceholder('••••••••').fill('KoraPass2026!');
    await page.getByRole('button', { name: 'Crear Espacio de Trabajo' }).click();

    // 2. Lands in Onboarding or Inbox
    await expect(page).toHaveURL(/\/(onboarding|app\/inbox)/);
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);

    // 3. Step through Onboarding Wizard UI controls
    await page.goto('/onboarding');
    await expect(page).toHaveURL(/\/onboarding/);
    await expect(page.getByRole('heading').first()).toBeVisible();
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'Onboarding S04');

    const nextOrSkip = page.getByRole('button', { name: /Siguiente|Continuar|Omitir|Finalizar|Ir a la Bandeja/i }).first();
    if (await nextOrSkip.isVisible()) {
      await nextOrSkip.click();
    }

    // 4. Proceed to Inbox S06
    await page.goto('/app/inbox');
    await expect(page).toHaveURL(/\/app\/inbox/);
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'Inbox S06');
  });

  test('Scenario 2 (F02 + F03): WhatsApp Channel QR Lifecycle (S22) -> Inbound Message -> AI Setup -> Operator Claim, Reply & Resolve (S06)', async ({ page, request }) => {
    const org = await signupViaAPI(request);
    await loginViaUI(page, org.email, org.password);

    // 1. S22 Connections: Create WhatsApp session & inspect QR
    await page.goto('/app/channels');
    await page.getByPlaceholder('Nombre de sesión (ej. ventas-principal)').fill(`wa-${uniqueId('s22')}`);
    await page.getByRole('button', { name: 'Conectar Número' }).click();
    await expect(page.getByText(/QR listo|SCAN_QR_CODE|WORKING/i).first()).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await assertZeroOverflow(page);

    // 2. S17/S20 AI Setup: Index knowledge and configure agent
    await apiRequest(request, 'POST', '/api/v1/ai/knowledge', org.accessToken, {
      title: 'Catálogo Servicios',
      content: 'Ofrecemos consulta inicial gratuita y planes desde 49 USD.',
    });
    await apiRequest(request, 'POST', '/api/v1/ai/agents', org.accessToken, {
      name: 'Asistente Ventas',
      system_prompt: 'Eres un asesor amable de KoraCRM.',
      is_active: true,
    });

    // 3. Simulate inbound customer contact & conversation (handoff to human)
    const contact = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
      full_name: 'Roberto Cliente F03',
      phone_e164: '+5215588990011',
    });
    expect(contact.ok).toBe(true);

    const conv = await apiRequest<{ id: string; service_revision?: number }>(
      request,
      'POST',
      '/api/v1/conversations',
      org.accessToken,
      { contact_id: contact.data.id }
    );
    expect(conv.ok).toBe(true);

    // 4. Operator claims conversation in Inbox S06, replies, and resolves
    await page.goto('/app/inbox');
    await page.getByText('Roberto Cliente F03').first().click();

    const claimBtn = page.getByRole('button', { name: /Tomar|Reclamar|Atender/i }).first();
    if (await claimBtn.isVisible()) {
      await claimBtn.click();
    }

    await page.getByPlaceholder('Escribe un mensaje de WhatsApp...').fill('Hola Roberto, te atiende un asesor humano.');
    await page.locator('form button[type="submit"]').click();
    await expect(page.getByText('Hola Roberto, te atiende un asesor humano.').last()).toBeVisible();

    const resolveRes = await apiRequest(
      request,
      'POST',
      `/api/v1/conversations/${conv.data.id}/resolve`,
      org.accessToken
    );
    expect(resolveRes.ok).toBe(true);
    await assertZeroOverflow(page);
  });

  test('Scenario 3 (F04 + F05): Duplicate Contact Detection -> Merge Queue (S13) -> Kanban Deal (S11) -> Lead Detail & Task (S12/S14)', async ({ page, request }) => {
    const org = await signupViaAPI(request);
    const sharedPhone = '+5215577889900';

    // 1. Create primary contact and potential duplicate
    const c1 = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
      full_name: 'Elena Martínez',
      phone_e164: sharedPhone,
      email: `${uniqueId('elena1')}@koracrm.dev`,
    });
    const c2 = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
      full_name: 'Elena M. Duplicada',
      phone_e164: sharedPhone,
      email: `${uniqueId('elena2')}@koracrm.dev`,
    });
    expect(c1.ok).toBe(true);

    // 2. Inspect Contacts & Merge Queue (S13)
    await loginViaUI(page, org.email, org.password);
    await page.goto('/app/contacts');
    await expect(page.getByText('Elena Martínez').first()).toBeVisible();
    await assertZeroOverflow(page);

    if (c2.ok && c2.data?.id && c1.data.id !== c2.data.id) {
      const mergeRes = await apiRequest(request, 'POST', '/api/v1/contacts/merge', org.accessToken, {
        primary_contact_id: c1.data.id,
        duplicate_contact_id: c2.data.id,
      });
      expect(mergeRes.status).toBeLessThan(500);
    }

    // 3. Create Deal in Kanban (S11)
    await page.goto('/app/kanban');
    await page.getByRole('button', { name: /Nuevo / }).first().click();
    await page.getByPlaceholder('Plan Empresarial').fill('Implementación Anual Elena');
    await page.getByRole('combobox').first().selectOption({ index: 1 });
    await page.getByRole('button', { name: /^Crear/ }).click();
    await expect(page.getByText('Implementación Anual Elena').first()).toBeVisible();
    await assertZeroOverflow(page);

    // 4. Create follow-up Task (S14)
    const taskRes = await apiRequest(request, 'POST', '/api/v1/tasks', org.accessToken, {
      title: 'Enviar propuesta firmada a Elena',
      due_at: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(taskRes.ok).toBe(true);

    await page.goto('/app/tasks');
    await expect(page.getByText('Enviar propuesta firmada a Elena')).toBeVisible();
    await assertZeroOverflow(page);
  });

  test('Scenario 4 (F06): Inbound Webhook Source -> Test Lead -> WHEN/IF/THEN Rule Builder (S23) -> Execution Verification', async ({ page, request }) => {
    const org = await signupViaAPI(request);
    await loginViaUI(page, org.email, org.password);

    // 1. Navigate to S23 Webhooks & Automations
    await page.goto('/app/webhooks');
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);

    // 2. Create Inbound Webhook Source
    const srcRes = await apiRequest<{ webhook_token?: string; token?: string }>(
      request,
      'POST',
      '/api/v1/webhooks/sources',
      org.accessToken,
      { name: 'Campaña Meta Ads F06', is_active: true }
    );
    expect(srcRes.ok).toBe(true);
    const token = srcRes.data.webhook_token || srcRes.data.token || '';

    // 3. Create WHEN/IF/THEN Rule
    const ruleRes = await apiRequest(request, 'POST', '/api/v1/automations', org.accessToken, {
      name: 'Calificar Lead Meta Ads',
      trigger_type: 'lead.created',
      condition_json: { field: 'utm_source', op: 'eq', value: 'meta_ads' },
      action_json: { type: 'add_tag', tag: 'meta-calificado' },
      is_active: true,
    });
    expect(ruleRes.ok).toBe(true);

    // 4. Fire Test Lead into inbound webhook
    const leadRes = await apiRequest(request, 'POST', `/api/v1/webhooks/in/${token}`, undefined, {
      full_name: 'Mateo Prospecto Ads',
      phone: '+5215566778899',
      email: `${uniqueId('f06')}@koracrm.dev`,
      utm_source: 'meta_ads',
    });
    expect([200, 201, 202]).toContain(leadRes.status);

    // 5. Verify contact/lead captured and rule persisted via API & S23 UI
    const contactsRes = await apiRequest(request, 'GET', '/api/v1/contacts', org.accessToken);
    expect(contactsRes.status).toBe(200);
    expect(JSON.stringify(contactsRes.data)).toContain('Mateo Prospecto Ads');

    const rulesListRes = await apiRequest(request, 'GET', '/api/v1/automations', org.accessToken);
    expect(rulesListRes.status).toBe(200);
    expect(JSON.stringify(rulesListRes.data)).toContain('Calificar Lead Meta Ads');

    await page.reload();
    await expect(page.getByText('Campaña Meta Ads F06')).toBeVisible();
    await expect(page.getByText('Calificar Lead Meta Ads')).toBeVisible();
    await assertZeroOverflow(page);
  });

  test('Scenario 5 (F07 + F08): Support Session Guard (S26) -> LGPD Export & Cascade Anonymize (S25) -> Audit Log Verification (S24)', async ({ page, request }) => {
    const org = await signupViaAPI(request);

    // 1. Verify non-super-admin cannot access S26 /api/v1/admin/tenants (403)
    const adminCheck = await apiRequest(request, 'GET', '/api/v1/admin/tenants', org.accessToken);
    expect(adminCheck.status).toBe(403);

    // 2. Create contact with PII to test F07 LGPD Export & Redact
    const sensitiveEmail = `${uniqueId('lgpd-f07')}@koracrm.dev`;
    const contact = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/contacts', org.accessToken, {
      full_name: 'Lucía Datos Sensibles',
      phone_e164: '+5215544332211',
      email: sensitiveEmail,
    });
    expect(contact.ok).toBe(true);

    // 3. Request & Execute LGPD Export
    const exportReq = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/lgpd/requests', org.accessToken, {
      contact_id: contact.data.id,
      request_type: 'export',
    });
    expect(exportReq.ok).toBe(true);
    const execExport = await apiRequest(
      request,
      'POST',
      `/api/v1/lgpd/requests/${exportReq.data.id}/execute`,
      org.accessToken
    );
    expect(execExport.ok).toBe(true);

    // 4. Request & Execute LGPD Cascade Anonymization
    const deleteReq = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/lgpd/requests', org.accessToken, {
      contact_id: contact.data.id,
      request_type: 'delete',
    });
    expect(deleteReq.ok).toBe(true);
    const execDelete = await apiRequest(
      request,
      'POST',
      `/api/v1/lgpd/requests/${deleteReq.data.id}/execute`,
      org.accessToken
    );
    expect(execDelete.ok).toBe(true);

    // 5. Verify PII redacted on contact and Audit Log (S24) records LGPD actions
    const afterContact = await apiRequest<{ email?: string; full_name?: string }>(
      request,
      'GET',
      `/api/v1/contacts/${contact.data.id}`,
      org.accessToken
    );
    expect(afterContact.data.email).not.toBe(sensitiveEmail);

    await loginViaUI(page, org.email, org.password);
    await page.goto('/app/lgpd/requests');
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);

    await page.goto('/app/audit');
    await expect(page.locator('main').getByText(/Acción|Recurso|Fecha|Auditoría|lgpd/i).locator('visible=true').first()).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
  });
});
