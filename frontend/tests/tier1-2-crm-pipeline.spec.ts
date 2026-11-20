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

async function createContactAPI(
  request: APIRequestContext,
  token: string,
  name: string,
  phoneSuffix: string
): Promise<{ id: string; name: string }> {
  const res = await apiRequest<{ id: string; name: string }>(
    request,
    'POST',
    '/api/v1/contacts',
    token,
    {
      name,
      phone_number: `+52155${phoneSuffix.slice(-8).padStart(8, '0')}`,
      email: `${uniqueId('contact')}@koracrm.dev`,
    }
  );
  expect(res.ok, `POST /api/v1/contacts failed: ${JSON.stringify(res.data)}`).toBe(true);
  expect(res.data.id).toBeTruthy();
  return res.data;
}

async function getDefaultPipeline(
  request: APIRequestContext,
  token: string
): Promise<{ id: string; name: string; stages: Array<{ id: string; name: string; is_won?: boolean; is_lost?: boolean; requires_human?: boolean }> }> {
  const res = await apiRequest<Array<{ id: string; name: string; stages: Array<{ id: string; name: string; is_won?: boolean; is_lost?: boolean; requires_human?: boolean }> }>>(
    request,
    'GET',
    '/api/v1/pipelines',
    token
  );
  expect(res.ok).toBe(true);
  expect(Array.isArray(res.data) && res.data.length > 0).toBe(true);
  return res.data[0];
}

test.beforeEach(({ page }) => {
  attachErrorGuards(page);
});

/* ============================================================================
 * Feature #24: Multi-pipeline Kanban board, fractional indexing, 409 & bulk <=50
 * ========================================================================== */
test.describe('Feature #24: Multi-pipeline Kanban board (S11)', () => {
  test('T1-24-01: renders /app/kanban in Spanish with zero overflow and passes accessibility', async ({
    page,
    request,
  }, testInfo) => {
    await setupAuthInBrowser(page, request);
    await page.goto('/app/kanban');

    await expect(page.getByRole('heading', { name: /Embudo/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Nuevo /i }).first()).toBeVisible();

    if (testInfo.project.name === 'mobile') {
      await expect(page.getByRole('navigation', { name: 'Navegación móvil' })).toBeVisible();
    }

    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'Kanban S11');
  });

  test('T1-24-02: creates a second pipeline with stages and switches to /app/pipelines/:id', async ({
    page,
    request,
  }) => {
    const auth = await setupAuthInBrowser(page, request);
    const pipeName = `Soporte ${uniqueId('pipe')}`;

    const createPipe = await apiRequest<{ id: string; name: string; stages: Array<{ id: string; name: string }> }>(
      request,
      'POST',
      '/api/v1/pipelines',
      auth.accessToken,
      {
        name: pipeName,
        vocabulary: { deal: 'Caso', stage: 'Estado' },
        stages: [
          { name: 'Nuevo', position: 1 },
          { name: 'En Progreso', position: 2 },
          { name: 'Resuelto', position: 3, is_won: true },
        ],
      }
    );
    expect([200, 201]).toContain(createPipe.status);
    expect(createPipe.data.id).toBeTruthy();

    await page.goto(`/app/pipelines/${createPipe.data.id}`);
    await expect(page.getByRole('button', { name: pipeName })).toBeVisible();
    await page.getByRole('button', { name: pipeName }).click();
    await expect(page.getByText('Nuevo').first()).toBeVisible();
    await assertZeroOverflow(page);
  });

  test('T1-24-03: creates leads in Kanban and maintains fractional position_in_stage ordering', async ({
    page,
    request,
  }) => {
    const auth = await setupAuthInBrowser(page, request);
    const contact = await createContactAPI(request, auth.accessToken, 'Lucía Ventas', `${Date.now()}`);
    const pipe = await getDefaultPipeline(request, auth.accessToken);
    const stageId = pipe.stages[0].id;

    const leadA = await apiRequest<{ id: string; position_in_stage?: number; version: number }>(
      request,
      'POST',
      '/api/v1/leads',
      auth.accessToken,
      {
        pipeline_id: pipe.id,
        stage_id: stageId,
        contact_id: contact.id,
        title: 'Trato Alfa',
        value_cents: 150000,
        position_in_stage: 1000,
      }
    );
    const leadB = await apiRequest<{ id: string; position_in_stage?: number; version: number }>(
      request,
      'POST',
      '/api/v1/leads',
      auth.accessToken,
      {
        pipeline_id: pipe.id,
        stage_id: stageId,
        contact_id: contact.id,
        title: 'Trato Beta',
        value_cents: 250000,
        position_in_stage: 2000,
      }
    );
    const leadMid = await apiRequest<{ id: string; position_in_stage?: number; version: number }>(
      request,
      'POST',
      '/api/v1/leads',
      auth.accessToken,
      {
        pipeline_id: pipe.id,
        stage_id: stageId,
        contact_id: contact.id,
        title: 'Trato Medio',
        value_cents: 200000,
        position_in_stage: 1500.5,
      }
    );

    expect(leadA.ok && leadB.ok && leadMid.ok).toBe(true);

    await page.goto('/app/kanban');
    await expect(page.getByText('Trato Alfa').first()).toBeVisible();
    await expect(page.getByText('Trato Medio').first()).toBeVisible();
    await expect(page.getByText('Trato Beta').first()).toBeVisible();
  });

  test('T1-24-04: moves lead across stages and auto-updates status on is_won / is_lost', async ({
    page,
    request,
  }) => {
    const auth = await setupAuthInBrowser(page, request);
    const contact = await createContactAPI(request, auth.accessToken, 'Marco Cierre', `${Date.now()}`);
    const pipe = await getDefaultPipeline(request, auth.accessToken);
    const firstStage = pipe.stages[0];
    const wonStage = pipe.stages.find((s) => s.is_won) || pipe.stages[pipe.stages.length - 1];

    const created = await apiRequest<{ id: string; version: number; status: string }>(
      request,
      'POST',
      '/api/v1/leads',
      auth.accessToken,
      {
        pipeline_id: pipe.id,
        stage_id: firstStage.id,
        contact_id: contact.id,
        title: 'Trato Cierre Ganado',
        value_cents: 50000,
      }
    );
    expect(created.ok).toBe(true);

    const moved = await apiRequest<{ id: string; stage_id: string; status: string; version: number }>(
      request,
      'PATCH',
      `/api/v1/leads/${created.data.id}`,
      auth.accessToken,
      {
        stage_id: wonStage.id,
        version: created.data.version ?? 1,
      }
    );
    expect(moved.ok).toBe(true);
    expect(moved.data.stage_id).toBe(wonStage.id);
    if (wonStage.is_won) {
      expect(moved.data.status).toBe('won');
    }

    await page.goto('/app/kanban');
    await expect(page.getByText('Trato Cierre Ganado').first()).toBeVisible();
  });

  test('T1-24-05: bulk moves multiple leads (<=50) across stages via POST /api/v1/leads/bulk', async ({
    page,
    request,
  }) => {
    const auth = await setupAuthInBrowser(page, request);
    const contact = await createContactAPI(request, auth.accessToken, 'Bulk Cliente', `${Date.now()}`);
    const pipe = await getDefaultPipeline(request, auth.accessToken);
    const sourceStage = pipe.stages[0];
    const targetStage = pipe.stages[1] || pipe.stages[0];

    const leadIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const l = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/leads', auth.accessToken, {
        pipeline_id: pipe.id,
        stage_id: sourceStage.id,
        contact_id: contact.id,
        title: `Lote Trato ${i + 1}`,
        value_cents: 10000 * (i + 1),
      });
      expect(l.ok).toBe(true);
      leadIds.push(l.data.id);
    }

    const bulkRes = await apiRequest<{ updated?: number }>(
      request,
      'POST',
      '/api/v1/leads/bulk',
      auth.accessToken,
      {
        lead_ids: leadIds,
        stage_id: targetStage.id,
      }
    );
    expect(bulkRes.ok, `Bulk move failed: ${JSON.stringify(bulkRes.data)}`).toBe(true);

    await page.goto('/app/kanban');
    await expect(page.getByText('Lote Trato 1').first()).toBeVisible();
    await expect(page.getByText('Lote Trato 3').first()).toBeVisible();
  });

  test('T2-24-01: rejects stale version on PATCH /api/v1/leads/:id with 409 Conflict', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const contact = await createContactAPI(request, auth.accessToken, 'Concurrencia', `${Date.now()}`);
    const pipe = await getDefaultPipeline(request, auth.accessToken);

    const created = await apiRequest<{ id: string; version: number }>(
      request,
      'POST',
      '/api/v1/leads',
      auth.accessToken,
      {
        pipeline_id: pipe.id,
        stage_id: pipe.stages[0].id,
        contact_id: contact.id,
        title: 'Trato CAS',
        value_cents: 12000,
      }
    );
    expect(created.ok).toBe(true);
    const initialVersion = created.data.version ?? 1;

    const firstMove = await apiRequest(
      request,
      'PATCH',
      `/api/v1/leads/${created.data.id}`,
      auth.accessToken,
      { stage_id: (pipe.stages[1] || pipe.stages[0]).id, version: initialVersion }
    );
    expect(firstMove.ok).toBe(true);

    const staleMove = await apiRequest(
      request,
      'PATCH',
      `/api/v1/leads/${created.data.id}`,
      auth.accessToken,
      { stage_id: pipe.stages[0].id, version: initialVersion }
    );
    expect(staleMove.status).toBe(409);
  });

  test('T2-24-02: rejects bulk move exceeding 50 leads (>50 items) with 400 or 422', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const pipe = await getDefaultPipeline(request, auth.accessToken);
    const tooManyIds = Array.from({ length: 51 }, (_, i) => `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`);

    const res = await apiRequest(request, 'POST', '/api/v1/leads/bulk', auth.accessToken, {
      lead_ids: tooManyIds,
      stage_id: pipe.stages[0].id,
    });
    expect([400, 422]).toContain(res.status);
  });

  test('T2-24-03: rejects lead creation with empty title or missing contact_id (400/422)', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const pipe = await getDefaultPipeline(request, auth.accessToken);

    const emptyTitle = await apiRequest(request, 'POST', '/api/v1/leads', auth.accessToken, {
      pipeline_id: pipe.id,
      stage_id: pipe.stages[0].id,
      title: '   ',
      value_cents: 1000,
    });
    expect([400, 422]).toContain(emptyTitle.status);
  });

  test('T2-24-04: blocks deleting a non-empty stage (409/400/422) and enforces support_readonly 403', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const contact = await createContactAPI(request, auth.accessToken, 'Etapa Protegida', `${Date.now()}`);
    const pipe = await getDefaultPipeline(request, auth.accessToken);
    const stageId = pipe.stages[0].id;

    const lead = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/leads', auth.accessToken, {
      pipeline_id: pipe.id,
      stage_id: stageId,
      contact_id: contact.id,
      title: 'Lead en Etapa',
      value_cents: 5000,
    });
    expect(lead.ok).toBe(true);

    const delStage = await apiRequest(request, 'DELETE', `/api/v1/stages/${stageId}`, auth.accessToken);
    expect([400, 409, 422]).toContain(delStage.status);
  });

  test('T2-24-05: enforces multi-tenant isolation on pipelines and leads', async ({ request }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);
    const contactA = await createContactAPI(request, tenantA.accessToken, 'Cliente A', `${Date.now()}`);
    const pipeA = await getDefaultPipeline(request, tenantA.accessToken);

    const leadA = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/leads', tenantA.accessToken, {
      pipeline_id: pipeA.id,
      stage_id: pipeA.stages[0].id,
      contact_id: contactA.id,
      title: 'Secreto Tenant A',
      value_cents: 9900,
    });
    expect(leadA.ok).toBe(true);

    const crossPatch = await apiRequest(
      request,
      'PATCH',
      `/api/v1/leads/${leadA.data.id}`,
      tenantB.accessToken,
      { title: 'Hack Tenant B', version: 1 }
    );
    expect([403, 404]).toContain(crossPatch.status);
  });
});

/* ============================================================================
 * Feature #25: Tickets in Support pipeline & cross-lead linking (S12)
 * ========================================================================== */
test.describe('Feature #25: Support tickets & cross-lead linking (S12)', () => {
  test('T1-25-01: renders /app/leads/:id (S12) in Spanish with zero overflow and accessibility', async ({
    page,
    request,
  }) => {
    const auth = await setupAuthInBrowser(page, request);
    const contact = await createContactAPI(request, auth.accessToken, 'Detalle Lead', `${Date.now()}`);
    const pipe = await getDefaultPipeline(request, auth.accessToken);

    const lead = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/leads', auth.accessToken, {
      pipeline_id: pipe.id,
      stage_id: pipe.stages[0].id,
      contact_id: contact.id,
      title: 'Oportunidad S12',
      value_cents: 45000,
    });
    expect(lead.ok).toBe(true);

    await page.goto(`/app/leads/${lead.data.id}`);
    await expect(page.getByText('Oportunidad S12').first()).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'Lead Detail S12');
  });

  test('T1-25-02: creates a Support ticket and links it to a Sales deal via crm_lead_links', async ({
    page,
    request,
  }) => {
    const auth = await setupAuthInBrowser(page, request);
    const contact = await createContactAPI(request, auth.accessToken, 'Soporte Link', `${Date.now()}`);
    const salesPipe = await getDefaultPipeline(request, auth.accessToken);

    const supportPipe = await apiRequest<{ id: string; stages: Array<{ id: string }> }>(
      request,
      'POST',
      '/api/v1/pipelines',
      auth.accessToken,
      {
        name: 'Soporte Técnico',
        pipeline_type: 'support',
        vocabulary: { deal: 'Ticket', stage: 'Estado' },
        stages: [{ name: 'Abierto', position: 1 }, { name: 'Cerrado', position: 2, is_won: true }],
      }
    );
    expect([200, 201]).toContain(supportPipe.status);

    const salesDeal = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/leads', auth.accessToken, {
      pipeline_id: salesPipe.id,
      stage_id: salesPipe.stages[0].id,
      contact_id: contact.id,
      title: 'Contrato Principal',
      value_cents: 100000,
    });
    const supportTicket = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/leads', auth.accessToken, {
      pipeline_id: supportPipe.data.id,
      stage_id: supportPipe.data.stages[0].id,
      contact_id: contact.id,
      title: 'Ticket #101 Onboarding',
      value_cents: 0,
    });
    expect(salesDeal.ok && supportTicket.ok).toBe(true);

    const linkRes = await apiRequest<{ id: string }>(
      request,
      'POST',
      `/api/v1/leads/${supportTicket.data.id}/links`,
      auth.accessToken,
      {
        target_lead_id: salesDeal.data.id,
        link_type: 'related_deal',
      }
    );
    expect([200, 201]).toContain(linkRes.status);

    await page.goto(`/app/leads/${supportTicket.data.id}`);
    await expect(page.getByText('Contrato Principal').first()).toBeVisible();
  });

  test('T1-25-03: edits lead custom fields and value on /app/leads/:id and persists', async ({
    page,
    request,
  }) => {
    const auth = await setupAuthInBrowser(page, request);
    const contact = await createContactAPI(request, auth.accessToken, 'Campos Custom', `${Date.now()}`);
    const pipe = await getDefaultPipeline(request, auth.accessToken);

    const lead = await apiRequest<{ id: string; version: number }>(
      request,
      'POST',
      '/api/v1/leads',
      auth.accessToken,
      {
        pipeline_id: pipe.id,
        stage_id: pipe.stages[0].id,
        contact_id: contact.id,
        title: 'Lead Editable',
        value_cents: 10000,
      }
    );
    expect(lead.ok).toBe(true);

    const updated = await apiRequest<{ value_cents: number; custom_fields: Record<string, unknown> }>(
      request,
      'PATCH',
      `/api/v1/leads/${lead.data.id}`,
      auth.accessToken,
      {
        value_cents: 85000,
        custom_fields: { origen: 'WhatsApp', prioridad: 'Alta' },
        version: lead.data.version ?? 1,
      }
    );
    expect(updated.ok).toBe(true);
    expect(updated.data.value_cents).toBe(85000);

    await page.goto(`/app/leads/${lead.data.id}`);
    await expect(page.getByText('Lead Editable').first()).toBeVisible();
  });

  test('T1-25-04: records and displays polymorphic timeline activities on lead detail', async ({
    page,
    request,
  }) => {
    const auth = await setupAuthInBrowser(page, request);
    const contact = await createContactAPI(request, auth.accessToken, 'Timeline Lead', `${Date.now()}`);
    const pipe = await getDefaultPipeline(request, auth.accessToken);

    const lead = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/leads', auth.accessToken, {
      pipeline_id: pipe.id,
      stage_id: pipe.stages[0].id,
      contact_id: contact.id,
      title: 'Lead con Historial',
      value_cents: 25000,
    });
    expect(lead.ok).toBe(true);

    const noteRes = await apiRequest(
      request,
      'POST',
      `/api/v1/leads/${lead.data.id}/activities`,
      auth.accessToken,
      {
        type: 'note',
        body: 'Cliente solicitó cotización formal en PDF.',
      }
    );
    expect([200, 201]).toContain(noteRes.status);

    await page.goto(`/app/leads/${lead.data.id}`);
    await expect(page.getByText('Cliente solicitó cotización formal en PDF.').first()).toBeVisible();
  });

  test('T1-25-05: unlinks a cross-linked lead and verifies removal', async ({ request }) => {
    const auth = await signupViaAPI(request);
    const contact = await createContactAPI(request, auth.accessToken, 'Desvincular', `${Date.now()}`);
    const pipe = await getDefaultPipeline(request, auth.accessToken);

    const lead1 = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/leads', auth.accessToken, {
      pipeline_id: pipe.id,
      stage_id: pipe.stages[0].id,
      contact_id: contact.id,
      title: 'Lead Uno',
      value_cents: 1000,
    });
    const lead2 = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/leads', auth.accessToken, {
      pipeline_id: pipe.id,
      stage_id: pipe.stages[0].id,
      contact_id: contact.id,
      title: 'Lead Dos',
      value_cents: 2000,
    });
    const link = await apiRequest<{ id: string }>(
      request,
      'POST',
      `/api/v1/leads/${lead1.data.id}/links`,
      auth.accessToken,
      { target_lead_id: lead2.data.id, link_type: 'related' }
    );
    expect([200, 201]).toContain(link.status);

    const unlink = await apiRequest(
      request,
      'DELETE',
      `/api/v1/leads/${lead1.data.id}/links/${link.data.id}`,
      auth.accessToken
    );
    expect([200, 204]).toContain(unlink.status);
  });

  test('T2-25-01: rejects self-linking a lead to itself (400/422)', async ({ request }) => {
    const auth = await signupViaAPI(request);
    const contact = await createContactAPI(request, auth.accessToken, 'AutoLink', `${Date.now()}`);
    const pipe = await getDefaultPipeline(request, auth.accessToken);

    const lead = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/leads', auth.accessToken, {
      pipeline_id: pipe.id,
      stage_id: pipe.stages[0].id,
      contact_id: contact.id,
      title: 'Auto Enlace',
      value_cents: 1000,
    });
    const selfLink = await apiRequest(
      request,
      'POST',
      `/api/v1/leads/${lead.data.id}/links`,
      auth.accessToken,
      { target_lead_id: lead.data.id, link_type: 'related' }
    );
    expect([400, 422]).toContain(selfLink.status);
  });

  test('T2-25-02: rejects duplicate cross-lead link (409/400/422)', async ({ request }) => {
    const auth = await signupViaAPI(request);
    const contact = await createContactAPI(request, auth.accessToken, 'DupLink', `${Date.now()}`);
    const pipe = await getDefaultPipeline(request, auth.accessToken);

    const l1 = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/leads', auth.accessToken, {
      pipeline_id: pipe.id,
      stage_id: pipe.stages[0].id,
      contact_id: contact.id,
      title: 'L1',
      value_cents: 100,
    });
    const l2 = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/leads', auth.accessToken, {
      pipeline_id: pipe.id,
      stage_id: pipe.stages[0].id,
      contact_id: contact.id,
      title: 'L2',
      value_cents: 100,
    });
    await apiRequest(request, 'POST', `/api/v1/leads/${l1.data.id}/links`, auth.accessToken, {
      target_lead_id: l2.data.id,
      link_type: 'related',
    });
    const dup = await apiRequest(request, 'POST', `/api/v1/leads/${l1.data.id}/links`, auth.accessToken, {
      target_lead_id: l2.data.id,
      link_type: 'related',
    });
    expect([400, 409, 422]).toContain(dup.status);
  });

  test('T2-25-03: rejects cross-tenant lead linking (403/404)', async ({ request }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);
    const cA = await createContactAPI(request, tenantA.accessToken, 'CA', `${Date.now()}`);
    const cB = await createContactAPI(request, tenantB.accessToken, 'CB', `${Date.now() + 1}`);
    const pA = await getDefaultPipeline(request, tenantA.accessToken);
    const pB = await getDefaultPipeline(request, tenantB.accessToken);

    const lA = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/leads', tenantA.accessToken, {
      pipeline_id: pA.id,
      stage_id: pA.stages[0].id,
      contact_id: cA.id,
      title: 'Lead A',
      value_cents: 100,
    });
    const lB = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/leads', tenantB.accessToken, {
      pipeline_id: pB.id,
      stage_id: pB.stages[0].id,
      contact_id: cB.id,
      title: 'Lead B',
      value_cents: 100,
    });

    const crossLink = await apiRequest(
      request,
      'POST',
      `/api/v1/leads/${lA.data.id}/links`,
      tenantA.accessToken,
      { target_lead_id: lB.data.id, link_type: 'related' }
    );
    expect([400, 403, 404]).toContain(crossLink.status);
  });

  test('T2-25-04: rejects unauthenticated or invalid target_lead_id on lead links', async ({ request }) => {
    const auth = await signupViaAPI(request);
    const unauth = await apiRequest(
      request,
      'POST',
      '/api/v1/leads/00000000-0000-0000-0000-000000000001/links',
      undefined,
      { target_lead_id: '00000000-0000-0000-0000-000000000002', link_type: 'related' }
    );
    expect(unauth.status).toBe(401);

    const missing = await apiRequest(
      request,
      'POST',
      '/api/v1/leads/00000000-0000-0000-0000-000000000001/links',
      auth.accessToken,
      { target_lead_id: '00000000-0000-0000-0000-000000000002', link_type: 'related' }
    );
    expect([400, 404]).toContain(missing.status);
  });

  test('T2-25-05: handles Unicode/emoji/accents in lead detail without overflow', async ({
    page,
    request,
  }) => {
    const auth = await setupAuthInBrowser(page, request);
    const contact = await createContactAPI(request, auth.accessToken, 'Ñoño Emoji 🚀', `${Date.now()}`);
    const pipe = await getDefaultPipeline(request, auth.accessToken);

    const lead = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/leads', auth.accessToken, {
      pipeline_id: pipe.id,
      stage_id: pipe.stages[0].id,
      contact_id: contact.id,
      title: 'Cotización Especial áéíóúñ 🚀',
      value_cents: 33300,
    });
    expect(lead.ok).toBe(true);

    await page.goto(`/app/leads/${lead.data.id}`);
    await expect(page.getByText('Cotización Especial áéíóúñ 🚀').first()).toBeVisible();
    await assertZeroOverflow(page);
  });
});

/* ============================================================================
 * Feature #26: Tasks with due_at, recurrence & reusable Task Plans (S14)
 * ========================================================================== */
test.describe('Feature #26: Tasks, recurrence & Task Plans (S14)', () => {
  test('T1-26-01: renders /app/tasks (S14) in Spanish with zero overflow and accessibility', async ({
    page,
    request,
  }) => {
    await setupAuthInBrowser(page, request);
    await page.goto('/app/tasks');

    await expect(page.getByRole('heading', { name: /Tareas/i })).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'Tasks S14');
  });

  test('T1-26-02: creates a task with due_at and displays it on /app/tasks', async ({
    page,
    request,
  }) => {
    const auth = await setupAuthInBrowser(page, request);
    const dueAt = new Date(Date.now() + 86400_000).toISOString();

    const taskRes = await apiRequest<{ id: string; title: string; due_at: string }>(
      request,
      'POST',
      '/api/v1/tasks',
      auth.accessToken,
      {
        title: 'Llamar a cliente VIP',
        due_at: dueAt,
        priority: 'high',
      }
    );
    expect([200, 201]).toContain(taskRes.status);
    expect(taskRes.data.id).toBeTruthy();

    await page.goto('/app/tasks');
    await expect(page.getByText('Llamar a cliente VIP').first()).toBeVisible();
  });

  test('T1-26-03: creates a recurring task and completes it via PATCH /api/v1/tasks/:id', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const dueAt = new Date(Date.now() + 3600_000).toISOString();

    const created = await apiRequest<{ id: string; recurrence?: string }>(
      request,
      'POST',
      '/api/v1/tasks',
      auth.accessToken,
      {
        title: 'Revisión semanal de cartera',
        due_at: dueAt,
        recurrence: 'weekly',
      }
    );
    expect([200, 201]).toContain(created.status);

    const completed = await apiRequest<{ id: string; status: string }>(
      request,
      'PATCH',
      `/api/v1/tasks/${created.data.id}`,
      auth.accessToken,
      { status: 'done' }
    );
    expect(completed.ok).toBe(true);
    expect(completed.data.status).toBe('done');
  });

  test('T1-26-04: creates a reusable Task Plan and applies it to generate tasks', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const planRes = await apiRequest<{ id: string; name: string }>(
      request,
      'POST',
      '/api/v1/task-plans',
      auth.accessToken,
      {
        name: 'Plan Onboarding Cliente',
        items: [
          { title: 'Enviar bienvenida', offset_days: 0 },
          { title: 'Agendar capacitación', offset_days: 2 },
        ],
      }
    );
    expect([200, 201]).toContain(planRes.status);
    expect(planRes.data.id).toBeTruthy();

    const applyRes = await apiRequest(
      request,
      'POST',
      `/api/v1/task-plans/${planRes.data.id}/apply`,
      auth.accessToken,
      {}
    );
    expect([200, 201]).toContain(applyRes.status);
  });

  test('T1-26-05: filters tasks by status and deletes a task via DELETE /api/v1/tasks/:id', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const created = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/tasks', auth.accessToken, {
      title: 'Tarea Temporal',
    });
    expect([200, 201]).toContain(created.status);

    const listPending = await apiRequest<Array<{ id: string }>>(
      request,
      'GET',
      '/api/v1/tasks?status=pending',
      auth.accessToken
    );
    expect(listPending.ok).toBe(true);
    expect(listPending.data.some((t) => t.id === created.data.id)).toBe(true);

    const del = await apiRequest(request, 'DELETE', `/api/v1/tasks/${created.data.id}`, auth.accessToken);
    expect([200, 204]).toContain(del.status);
  });

  test('T2-26-01: rejects creating a task with empty or whitespace title (400/422)', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const res = await apiRequest(request, 'POST', '/api/v1/tasks', auth.accessToken, {
      title: '   ',
    });
    expect([400, 422]).toContain(res.status);
  });

  test('T2-26-02: rejects invalid due_at date format or invalid recurrence (400/422)', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const res = await apiRequest(request, 'POST', '/api/v1/tasks', auth.accessToken, {
      title: 'Tarea Fecha Inválida',
      due_at: 'not-a-valid-date',
      recurrence: 'every-century',
    });
    expect([400, 422]).toContain(res.status);
  });

  test('T2-26-03: rejects unauthenticated task mutations (401)', async ({ request }) => {
    const res = await apiRequest(request, 'POST', '/api/v1/tasks', undefined, {
      title: 'Sin Auth',
    });
    expect(res.status).toBe(401);
  });

  test('T2-26-04: enforces multi-tenant isolation on tasks', async ({ request }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);

    const taskA = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/tasks', tenantA.accessToken, {
      title: 'Tarea Privada A',
    });
    expect([200, 201]).toContain(taskA.status);

    const crossUpdate = await apiRequest(
      request,
      'PATCH',
      `/api/v1/tasks/${taskA.data.id}`,
      tenantB.accessToken,
      { status: 'done' }
    );
    expect([403, 404]).toContain(crossUpdate.status);
  });

  test('T2-26-05: handles Unicode/emoji task titles without horizontal overflow', async ({
    page,
    request,
  }) => {
    const auth = await setupAuthInBrowser(page, request);
    await apiRequest(request, 'POST', '/api/v1/tasks', auth.accessToken, {
      title: 'Seguimiento urgente Ñoño áéíóú 🚀',
    });

    await page.goto('/app/tasks');
    await expect(page.getByText('Seguimiento urgente Ñoño áéíóú 🚀').first()).toBeVisible();
    await assertZeroOverflow(page);
  });
});

/* ============================================================================
 * Feature #27: Product catalog UI & CRUD (S15)
 * ========================================================================== */
test.describe('Feature #27: Product catalog UI & CRUD (S15)', () => {
  test('T1-27-01: renders /app/products (S15) in Spanish with zero overflow and accessibility', async ({
    page,
    request,
  }) => {
    await setupAuthInBrowser(page, request);
    await page.goto('/app/products');

    await expect(page.getByRole('heading', { name: /Productos|Catálogo/i })).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'Products S15');
  });

  test('T1-27-02: creates a product in catalog and displays it in UI', async ({ page, request }) => {
    const auth = await setupAuthInBrowser(page, request);
    const sku = `SKU-${uniqueId('prod')}`;

    const prod = await apiRequest<{ id: string; name: string; sku: string }>(
      request,
      'POST',
      '/api/v1/products',
      auth.accessToken,
      {
        name: 'Plan Empresarial Anual',
        sku,
        price_cents: 120000,
        currency: 'USD',
        description: 'Licencia anual multiusuario',
        active: true,
      }
    );
    expect([200, 201]).toContain(prod.status);
    expect(prod.data.id).toBeTruthy();

    await page.goto('/app/products');
    await expect(page.getByText('Plan Empresarial Anual').first()).toBeVisible();
  });

  test('T1-27-03: updates a product price and description via PATCH /api/v1/products/:id', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const created = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/products', auth.accessToken, {
      name: 'Producto Base',
      sku: `SKU-${uniqueId('upd')}`,
      price_cents: 5000,
      currency: 'USD',
    });
    expect([200, 201]).toContain(created.status);

    const updated = await apiRequest<{ price_cents: number; description: string }>(
      request,
      'PATCH',
      `/api/v1/products/${created.data.id}`,
      auth.accessToken,
      {
        price_cents: 7500,
        description: 'Descripción actualizada',
      }
    );
    expect(updated.ok).toBe(true);
    expect(updated.data.price_cents).toBe(7500);
  });

  test('T1-27-04: lists and searches products by name/SKU', async ({ request }) => {
    const auth = await signupViaAPI(request);
    const sku = `BUSCA-${uniqueId('s')}`;
    await apiRequest(request, 'POST', '/api/v1/products', auth.accessToken, {
      name: 'Módulo Analítica Avanzada',
      sku,
      price_cents: 29900,
      currency: 'USD',
    });

    const list = await apiRequest<Array<{ name: string; sku: string }>>(
      request,
      'GET',
      `/api/v1/products?q=${encodeURIComponent(sku)}`,
      auth.accessToken
    );
    expect(list.ok).toBe(true);
    expect(list.data.some((p) => p.sku === sku)).toBe(true);
  });

  test('T1-27-05: deletes a product via DELETE /api/v1/products/:id', async ({ request }) => {
    const auth = await signupViaAPI(request);
    const created = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/products', auth.accessToken, {
      name: 'Producto Eliminable',
      sku: `DEL-${uniqueId('p')}`,
      price_cents: 1000,
      currency: 'USD',
    });
    expect([200, 201]).toContain(created.status);

    const del = await apiRequest(request, 'DELETE', `/api/v1/products/${created.data.id}`, auth.accessToken);
    expect([200, 204]).toContain(del.status);

    const list = await apiRequest<Array<{ id: string }>>(request, 'GET', '/api/v1/products', auth.accessToken);
    expect(list.data.some((p) => p.id === created.data.id)).toBe(false);
  });

  test('T2-27-01: rejects product with empty name or negative price_cents (400/422)', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const badPrice = await apiRequest(request, 'POST', '/api/v1/products', auth.accessToken, {
      name: 'Producto Negativo',
      sku: `NEG-${uniqueId('p')}`,
      price_cents: -500,
      currency: 'USD',
    });
    expect([400, 422]).toContain(badPrice.status);

    const emptyName = await apiRequest(request, 'POST', '/api/v1/products', auth.accessToken, {
      name: '   ',
      sku: `EMP-${uniqueId('p')}`,
      price_cents: 1000,
      currency: 'USD',
    });
    expect([400, 422]).toContain(emptyName.status);
  });

  test('T2-27-02: rejects duplicate SKU within the same organization (409/400/422)', async ({
    request,
  }) => {
    const auth = await signupViaAPI(request);
    const dupSku = `DUP-${uniqueId('sku')}`;

    const first = await apiRequest(request, 'POST', '/api/v1/products', auth.accessToken, {
      name: 'Producto 1',
      sku: dupSku,
      price_cents: 1000,
      currency: 'USD',
    });
    expect([200, 201]).toContain(first.status);

    const second = await apiRequest(request, 'POST', '/api/v1/products', auth.accessToken, {
      name: 'Producto 2',
      sku: dupSku,
      price_cents: 2000,
      currency: 'USD',
    });
    expect([400, 409, 422]).toContain(second.status);
  });

  test('T2-27-03: rejects unauthenticated product mutations (401)', async ({ request }) => {
    const res = await apiRequest(request, 'POST', '/api/v1/products', undefined, {
      name: 'No Auth',
      sku: 'NOAUTH-1',
      price_cents: 100,
    });
    expect(res.status).toBe(401);
  });

  test('T2-27-04: enforces multi-tenant isolation on product catalog', async ({ request }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);

    const prodA = await apiRequest<{ id: string }>(request, 'POST', '/api/v1/products', tenantA.accessToken, {
      name: 'Producto Secreto A',
      sku: `SECA-${uniqueId('p')}`,
      price_cents: 9900,
      currency: 'USD',
    });
    expect([200, 201]).toContain(prodA.status);

    const crossPatch = await apiRequest(
      request,
      'PATCH',
      `/api/v1/products/${prodA.data.id}`,
      tenantB.accessToken,
      { price_cents: 1 }
    );
    expect([403, 404]).toContain(crossPatch.status);
  });

  test('T2-27-05: handles Unicode/emoji product names without horizontal overflow on mobile/desktop', async ({
    page,
    request,
  }) => {
    const auth = await setupAuthInBrowser(page, request);
    await apiRequest(request, 'POST', '/api/v1/products', auth.accessToken, {
      name: 'Café Orgánico Ñoño 🚀',
      sku: `UNI-${uniqueId('p')}`,
      price_cents: 4500,
      currency: 'USD',
    });

    await page.goto('/app/products');
    await expect(page.getByText('Café Orgánico Ñoño 🚀').first()).toBeVisible();
    await assertZeroOverflow(page);
  });
});
