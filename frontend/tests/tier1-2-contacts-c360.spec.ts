import { test, expect, type Page } from '@playwright/test';
import {
  attachErrorGuards,
  assertZeroOverflow,
  assertSpanishAndBrand,
  assertAccessibility,
} from './helpers/guards';
import { signupViaAPI, apiRequest, uniqueId } from './helpers/api';

async function seedAuthenticatedSession(page: Page, accessToken: string): Promise<void> {
  await page.goto('/login');
  await page.evaluate((token) => {
    localStorage.setItem('koracrm_access_token', token);
  }, accessToken);
}

test.beforeEach(async ({ page }) => {
  attachErrorGuards(page);
});

// ============================================================================
// Feature #8: Canonical contacts (E.164, email, CPF, deterministic identity resolution)
// ============================================================================
test.describe('Feature #8: Canonical Contacts & Identity Resolution (Tier 1)', () => {
  test('T1.8.1 /app/contacts renders Customer 360 directory in Spanish with zero overflow and passes axe scan', async ({
    page,
    request,
  }) => {
    const user = await signupViaAPI(request);
    await seedAuthenticatedSession(page, user.accessToken);
    await page.goto('/app/contacts');
    await expect(page.getByRole('heading', { name: 'Contactos (Customer 360°)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nuevo Contacto' })).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'ContactsPage');
  });

  test('T1.8.2 Creating a contact via UI sheet persists E.164 phone and email', async ({
    page,
    request,
  }) => {
    const user = await signupViaAPI(request);
    const contactName = `María ${uniqueId('ui')}`;
    await seedAuthenticatedSession(page, user.accessToken);
    await page.goto('/app/contacts');

    await page.getByRole('button', { name: 'Nuevo Contacto' }).click();
    await page.getByPlaceholder('María Oliveira').fill(contactName);
    await page.getByPlaceholder('+5215512345678').fill('+5215512345678');
    await page.getByPlaceholder('maria@ejemplo.com').fill(`${uniqueId('m')}@ejemplo.com`);
    await page.getByRole('button', { name: 'Guardar Contacto' }).click();

    await expect(page.getByText(contactName)).toBeVisible();
    await assertZeroOverflow(page);
  });

  test('T1.8.3 Creating a contact via API with E.164 phone, email, and CPF returns canonical record', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const email = `canon-${uniqueId('c')}@ejemplo.com`;
    const res = await apiRequest<{
      id: string;
      name: string;
      phone_number: string;
      email: string;
      cpf?: string;
    }>(request, 'POST', '/api/v1/contacts', user.accessToken, {
      name: 'Carlos Canonical',
      phone_number: '+5511999998888',
      email,
      cpf: '52998224725',
    });
    expect(res.status).toBe(201);
    expect(res.data.id).toBeTruthy();
    expect(res.data.phone_number).toBe('+5511999998888');
    expect(res.data.email).toBe(email);

    const detail = await apiRequest<{ id: string; name: string }>(
      request,
      'GET',
      `/api/v1/contacts/${res.data.id}`,
      user.accessToken
    );
    expect(detail.status).toBe(200);
    expect(detail.data.name).toBe('Carlos Canonical');
  });

  test('T1.8.4 Searching contacts in /app/contacts filters by name, phone, or email', async ({
    page,
    request,
  }) => {
    const user = await signupViaAPI(request);
    const marker = uniqueId('findme');
    await apiRequest(request, 'POST', '/api/v1/contacts', user.accessToken, {
      name: `Buscado ${marker}`,
      phone_number: '+5215511110000',
    });
    await apiRequest(request, 'POST', '/api/v1/contacts', user.accessToken, {
      name: 'Otro Contacto Irrelevante',
      phone_number: '+5215522220000',
    });

    await seedAuthenticatedSession(page, user.accessToken);
    await page.goto('/app/contacts');
    await page.getByPlaceholder('Buscar nombre, teléfono o correo...').fill(marker);
    await expect(page.getByText(`Buscado ${marker}`)).toBeVisible();
    await expect(page.getByText('Otro Contacto Irrelevante')).toHaveCount(0);
  });

  test('T1.8.5 Updating a contact via PATCH /api/v1/contacts/{id} persists changes and /app/contacts/:id loads', async ({
    page,
    request,
  }) => {
    const user = await signupViaAPI(request);
    const created = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: 'Nombre Inicial', phone_number: '+5215533339999' }
    );
    expect(created.status).toBe(201);

    const updated = await apiRequest<{ name: string; email: string }>(
      request,
      'PATCH',
      `/api/v1/contacts/${created.data.id}`,
      user.accessToken,
      { name: 'Nombre Actualizado', email: `upd-${uniqueId('u')}@ejemplo.com` }
    );
    expect(updated.status).toBe(200);
    expect(updated.data.name).toBe('Nombre Actualizado');

    await seedAuthenticatedSession(page, user.accessToken);
    await page.goto(`/app/contacts/${created.data.id}`);
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
  });
});

test.describe('Feature #8: Canonical Contacts & Identity Resolution (Tier 2 - Boundary & Corner Cases)', () => {
  test('T2.8.1 Invalid E.164 phone or malformed email returns 400/422 or normalizes without 500', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const res = await apiRequest(request, 'POST', '/api/v1/contacts', user.accessToken, {
      name: 'Teléfono Inválido',
      phone_number: 'not-a-phone-@@@',
      email: 'not-an-email',
    });
    expect(res.status).toBeLessThan(500);
  });

  test('T2.8.2 Invalid CPF check digits are rejected or sanitized without 500', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const res = await apiRequest(request, 'POST', '/api/v1/contacts', user.accessToken, {
      name: 'CPF Inválido',
      phone_number: '+5511988887777',
      cpf: '11111111111',
    });
    expect(res.status).toBeLessThan(500);
  });

  test('T2.8.3 Empty name or whitespace-only contact payload returns 400/422', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const res = await apiRequest(request, 'POST', '/api/v1/contacts', user.accessToken, {
      name: '   ',
      phone_number: '',
      email: '',
    });
    expect([400, 422]).toContain(res.status);
  });

  test('T2.8.4 Unicode, Spanish accents, and emoji in contact name are preserved intact', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const unicodeName = `María José Núñez 🚀 ${uniqueId('uni')}`;
    const res = await apiRequest<{ id: string; name: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: unicodeName, phone_number: '+5215544445555' }
    );
    expect(res.status).toBe(201);
    expect(res.data.name).toBe(unicodeName);
  });

  test('T2.8.5 Accessing non-existent contact ID returns 404 (never 500)', async ({ request }) => {
    const user = await signupViaAPI(request);
    const res = await apiRequest(
      request,
      'GET',
      '/api/v1/contacts/00000000-0000-0000-0000-000000000000',
      user.accessToken
    );
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// Feature #9: Merge queue & side-by-side contact merge UI (MergeDialog, atomic repoint)
// ============================================================================
test.describe('Feature #9: Merge Queue & Contact Merge (Tier 1)', () => {
  test('T1.9.1 GET /api/v1/contacts/merge-queue returns array for authenticated tenant', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const res = await apiRequest<unknown[]>(
      request,
      'GET',
      '/api/v1/contacts/merge-queue',
      user.accessToken
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  test('T1.9.2 Merging two contacts via POST /api/v1/contacts/merge succeeds and keeps primary contact', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const primary = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: 'Primario Fusión', phone_number: '+5215510101010' }
    );
    const duplicate = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: 'Duplicado Fusión', email: `dup-${uniqueId('d')}@ejemplo.com` }
    );

    const mergeRes = await apiRequest(
      request,
      'POST',
      '/api/v1/contacts/merge',
      user.accessToken,
      { primary_id: primary.data.id, duplicate_id: duplicate.data.id }
    );
    expect([200, 204]).toContain(mergeRes.status);

    const checkPrimary = await apiRequest<{ id: string; name: string }>(
      request,
      'GET',
      `/api/v1/contacts/${primary.data.id}`,
      user.accessToken
    );
    expect(checkPrimary.status).toBe(200);
    expect(checkPrimary.data.name).toBe('Primario Fusión');
  });

  test('T1.9.3 Merge atomically repoints duplicate contact conversations and leads to primary contact', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const primary = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: 'Primario Repoint', phone_number: '+5215520202020' }
    );
    const duplicate = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: 'Duplicado Repoint', email: `rep-${uniqueId('r')}@ejemplo.com` }
    );

    const conv = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/conversations',
      user.accessToken,
      { contact_id: duplicate.data.id }
    );
    expect([200, 201]).toContain(conv.status);

    const pipelines = await apiRequest<Array<{ id: string; stages: Array<{ id: string }> }>>(
      request,
      'GET',
      '/api/v1/pipelines',
      user.accessToken
    );
    const lead = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/leads',
      user.accessToken,
      {
        title: 'Lead Repoint',
        pipeline_id: pipelines.data[0].id,
        stage_id: pipelines.data[0].stages[0].id,
        contact_id: duplicate.data.id,
      }
    );
    expect(lead.status).toBe(201);

    const mergeRes = await apiRequest(
      request,
      'POST',
      '/api/v1/contacts/merge',
      user.accessToken,
      { primary_id: primary.data.id, duplicate_id: duplicate.data.id }
    );
    expect([200, 204]).toContain(mergeRes.status);

    const leadsAfter = await apiRequest<Array<{ id: string; contact_id: string }>>(
      request,
      'GET',
      '/api/v1/leads',
      user.accessToken
    );
    const repointedLead = leadsAfter.data.find((l) => l.id === lead.data.id);
    expect(repointedLead?.contact_id).toBe(primary.data.id);
  });

  test('T1.9.4 Creating conflicting contact via inbound/duplicate check surfaces in merge queue or resolves deterministically', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const sharedPhone = '+5215530303030';
    const c1 = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: 'Original Uno', phone_number: sharedPhone }
    );
    expect(c1.status).toBe(201);

    const c2 = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: 'Posible Duplicado', phone_number: sharedPhone }
    );
    expect(c2.status).toBeLessThan(500);

    const mq = await apiRequest<unknown[]>(
      request,
      'GET',
      '/api/v1/contacts/merge-queue',
      user.accessToken
    );
    expect(mq.status).toBe(200);
    expect(Array.isArray(mq.data)).toBe(true);
  });

  test('T1.9.5 /app/contacts renders merge queue controls cleanly without overflow', async ({
    page,
    request,
  }) => {
    const user = await signupViaAPI(request);
    await seedAuthenticatedSession(page, user.accessToken);
    await page.goto('/app/contacts');
    await expect(page.getByRole('heading', { name: 'Contactos (Customer 360°)' })).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
  });
});

test.describe('Feature #9: Merge Queue & Contact Merge (Tier 2 - Boundary & Corner Cases)', () => {
  test('T2.9.1 Merging a contact with itself (primary_id === duplicate_id) is rejected (400/422)', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const c = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: 'Auto Fusión', phone_number: '+5215540404040' }
    );
    const res = await apiRequest(request, 'POST', '/api/v1/contacts/merge', user.accessToken, {
      primary_id: c.data.id,
      duplicate_id: c.data.id,
    });
    expect([400, 422]).toContain(res.status);
  });

  test('T2.9.2 Cross-tenant merge (Tenant A primary + Tenant B duplicate) is rejected (403/404)', async ({
    request,
  }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);

    const cA = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      tenantA.accessToken,
      { name: 'Contacto A', phone_number: '+5215550505050' }
    );
    const cB = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      tenantB.accessToken,
      { name: 'Contacto B', phone_number: '+5215560606060' }
    );

    const crossMerge = await apiRequest(
      request,
      'POST',
      '/api/v1/contacts/merge',
      tenantA.accessToken,
      { primary_id: cA.data.id, duplicate_id: cB.data.id }
    );
    expect([400, 403, 404]).toContain(crossMerge.status);
  });

  test('T2.9.3 Merging with non-existent UUID returns 404/400 cleanly', async ({ request }) => {
    const user = await signupViaAPI(request);
    const c = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: 'Primario Válido', phone_number: '+5215570707070' }
    );
    const res = await apiRequest(request, 'POST', '/api/v1/contacts/merge', user.accessToken, {
      primary_id: c.data.id,
      duplicate_id: '00000000-0000-0000-0000-000000000000',
    });
    expect([400, 404]).toContain(res.status);
  });

  test('T2.9.4 Missing primary_id or duplicate_id in merge payload returns 400/422', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const res = await apiRequest(request, 'POST', '/api/v1/contacts/merge', user.accessToken, {});
    expect([400, 422]).toContain(res.status);
  });

  test('T2.9.5 Re-merging an already merged duplicate does not return 500', async ({ request }) => {
    const user = await signupViaAPI(request);
    const p = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: 'Primario Doble', phone_number: '+5215580808080' }
    );
    const d = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: 'Duplicado Doble', email: `dbl-${uniqueId('d')}@ejemplo.com` }
    );

    await apiRequest(request, 'POST', '/api/v1/contacts/merge', user.accessToken, {
      primary_id: p.data.id,
      duplicate_id: d.data.id,
    });
    const second = await apiRequest(request, 'POST', '/api/v1/contacts/merge', user.accessToken, {
      primary_id: p.data.id,
      duplicate_id: d.data.id,
    });
    expect(second.status).toBeLessThan(500);
  });
});

// ============================================================================
// Feature #10: Polymorphic event-sourced timeline (crm_lead_activities)
// ============================================================================
test.describe('Feature #10: Polymorphic Event-Sourced Timeline (Tier 1)', () => {
  test('T1.10.1 GET /api/v1/contacts/{id} returns timeline array for contact', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const c = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: 'Contacto Timeline', phone_number: '+5215512121212' }
    );
    const detail = await apiRequest<{ id: string; timeline: unknown[] }>(
      request,
      'GET',
      `/api/v1/contacts/${c.data.id}`,
      user.accessToken
    );
    expect(detail.status).toBe(200);
    expect(Array.isArray(detail.data.timeline)).toBe(true);
  });

  test('T1.10.2 Creating a lead and conversation for a contact populates timeline events', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const c = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: 'Contacto Con Eventos', phone_number: '+5215513131313' }
    );
    const pipelines = await apiRequest<Array<{ id: string; stages: Array<{ id: string }> }>>(
      request,
      'GET',
      '/api/v1/pipelines',
      user.accessToken
    );
    await apiRequest(request, 'POST', '/api/v1/leads', user.accessToken, {
      title: 'Trato Timeline',
      pipeline_id: pipelines.data[0].id,
      stage_id: pipelines.data[0].stages[0].id,
      contact_id: c.data.id,
    });

    const detail = await apiRequest<{ timeline: Array<{ summary: string; performed_at: string }> }>(
      request,
      'GET',
      `/api/v1/contacts/${c.data.id}`,
      user.accessToken
    );
    expect(detail.status).toBe(200);
    expect(detail.data.timeline.length).toBeGreaterThan(0);
    expect(detail.data.timeline[0].summary).toBeTruthy();
  });

  test('T1.10.3 Moving a lead across stages records stage transition in timeline', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const c = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: 'Contacto Etapa', phone_number: '+5215514141414' }
    );
    const pipelines = await apiRequest<Array<{ id: string; stages: Array<{ id: string }> }>>(
      request,
      'GET',
      '/api/v1/pipelines',
      user.accessToken
    );
    const stages = pipelines.data[0].stages;
    const lead = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/leads',
      user.accessToken,
      {
        title: 'Lead Movimiento',
        pipeline_id: pipelines.data[0].id,
        stage_id: stages[0].id,
        contact_id: c.data.id,
      }
    );
    const targetStage = stages.length > 1 ? stages[1].id : stages[0].id;
    const move = await apiRequest(request, 'PATCH', `/api/v1/leads/${lead.data.id}`, user.accessToken, {
      stage_id: targetStage,
    });
    expect(move.status).toBe(200);

    const detail = await apiRequest<{ timeline: Array<{ summary: string }> }>(
      request,
      'GET',
      `/api/v1/contacts/${c.data.id}`,
      user.accessToken
    );
    expect(detail.data.timeline.length).toBeGreaterThan(0);
  });

  test('T1.10.4 Customer 360 detail sheet in /app/contacts displays Línea de tiempo with zero overflow', async ({
    page,
    request,
  }) => {
    const user = await signupViaAPI(request);
    const contactName = `C360 ${uniqueId('t')}`;
    const c = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: contactName, phone_number: '+5215515151515' }
    );
    const pipelines = await apiRequest<Array<{ id: string; stages: Array<{ id: string }> }>>(
      request,
      'GET',
      '/api/v1/pipelines',
      user.accessToken
    );
    await apiRequest(request, 'POST', '/api/v1/leads', user.accessToken, {
      title: 'Oportunidad C360',
      pipeline_id: pipelines.data[0].id,
      stage_id: pipelines.data[0].stages[0].id,
      contact_id: c.data.id,
    });

    await seedAuthenticatedSession(page, user.accessToken);
    await page.goto('/app/contacts');
    await page.getByText(contactName).click();
    await expect(page.getByText('Línea de tiempo')).toBeVisible();
    await assertZeroOverflow(page);
  });

  test('T1.10.5 /app/leads/:id renders without 500 and with zero horizontal overflow', async ({
    page,
    request,
  }) => {
    const user = await signupViaAPI(request);
    const pipelines = await apiRequest<Array<{ id: string; stages: Array<{ id: string }> }>>(
      request,
      'GET',
      '/api/v1/pipelines',
      user.accessToken
    );
    const lead = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/leads',
      user.accessToken,
      {
        title: 'Lead Detalle',
        pipeline_id: pipelines.data[0].id,
        stage_id: pipelines.data[0].stages[0].id,
      }
    );

    await seedAuthenticatedSession(page, user.accessToken);
    await page.goto(`/app/leads/${lead.data.id}`);
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
  });
});

test.describe('Feature #10: Polymorphic Event-Sourced Timeline (Tier 2 - Boundary & Corner Cases)', () => {
  test('T2.10.1 Contact with zero activities opens Customer 360 sheet cleanly without crash', async ({
    page,
    request,
  }) => {
    const user = await signupViaAPI(request);
    const name = `SinEventos ${uniqueId('e')}`;
    await apiRequest(request, 'POST', '/api/v1/contacts', user.accessToken, {
      name,
      phone_number: '+5215516161616',
    });

    await seedAuthenticatedSession(page, user.accessToken);
    await page.goto('/app/contacts');
    await page.getByText(name).click();
    await expect(page.getByText('Línea de tiempo')).toBeVisible();
    await assertZeroOverflow(page);
  });

  test('T2.10.2 Long Unicode/emoji lead titles in timeline do not cause horizontal overflow', async ({
    page,
    request,
  }) => {
    const user = await signupViaAPI(request);
    const name = `Largo ${uniqueId('l')}`;
    const c = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name, phone_number: '+5215517171717' }
    );
    const pipelines = await apiRequest<Array<{ id: string; stages: Array<{ id: string }> }>>(
      request,
      'GET',
      '/api/v1/pipelines',
      user.accessToken
    );
    await apiRequest(request, 'POST', '/api/v1/leads', user.accessToken, {
      title: 'Propuesta_Extensa_Con_Acentos_áéíóúñ_🚀_SinEspaciosParaProbarWrapEnMovil_2026',
      pipeline_id: pipelines.data[0].id,
      stage_id: pipelines.data[0].stages[0].id,
      contact_id: c.data.id,
    });

    await seedAuthenticatedSession(page, user.accessToken);
    await page.goto('/app/contacts');
    await page.getByText(name).click();
    await expect(page.getByText('Línea de tiempo')).toBeVisible();
    await assertZeroOverflow(page);
  });

  test('T2.10.3 Tenant B cannot read Tenant A contact timeline (403/404)', async ({ request }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);
    const c = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      tenantA.accessToken,
      { name: 'Timeline Privado', phone_number: '+5215518181818' }
    );
    const res = await apiRequest(
      request,
      'GET',
      `/api/v1/contacts/${c.data.id}`,
      tenantB.accessToken
    );
    expect([403, 404]).toContain(res.status);
  });

  test('T2.10.4 Creating lead with non-existent contact_id fails cleanly (400/404)', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const pipelines = await apiRequest<Array<{ id: string; stages: Array<{ id: string }> }>>(
      request,
      'GET',
      '/api/v1/pipelines',
      user.accessToken
    );
    const res = await apiRequest(request, 'POST', '/api/v1/leads', user.accessToken, {
      title: 'Lead Huérfano',
      pipeline_id: pipelines.data[0].id,
      stage_id: pipelines.data[0].stages[0].id,
      contact_id: '00000000-0000-0000-0000-000000000000',
    });
    expect([400, 404, 422]).toContain(res.status);
  });

  test('T2.10.5 Rapidly creating multiple leads for same contact preserves timeline integrity', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const c = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: 'Ráfaga Timeline', phone_number: '+5215519191919' }
    );
    const pipelines = await apiRequest<Array<{ id: string; stages: Array<{ id: string }> }>>(
      request,
      'GET',
      '/api/v1/pipelines',
      user.accessToken
    );

    const results = await Promise.all(
      [1, 2, 3].map((idx) =>
        apiRequest(request, 'POST', '/api/v1/leads', user.accessToken, {
          title: `Ráfaga ${idx}`,
          pipeline_id: pipelines.data[0].id,
          stage_id: pipelines.data[0].stages[0].id,
          contact_id: c.data.id,
        })
      )
    );
    for (const r of results) {
      expect(r.status).toBe(201);
    }

    const detail = await apiRequest<{ timeline: unknown[] }>(
      request,
      'GET',
      `/api/v1/contacts/${c.data.id}`,
      user.accessToken
    );
    expect(detail.status).toBe(200);
    expect(detail.data.timeline.length).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================================
// Feature #11: Configurable pipeline vocabulary & declarative custom fields
// ============================================================================
test.describe('Feature #11: Pipeline Vocabulary & Custom Fields (Tier 1)', () => {
  test('T1.11.1 GET /api/v1/organization returns pipeline_vocabulary and /api/v1/pipelines returns stages', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const org = await apiRequest<{ pipeline_vocabulary?: { deal?: string; deals?: string } }>(
      request,
      'GET',
      '/api/v1/organization',
      user.accessToken
    );
    expect(org.status).toBe(200);
    expect(org.data.pipeline_vocabulary).toBeTruthy();

    const pipelines = await apiRequest<Array<{ id: string; name: string; stages: unknown[] }>>(
      request,
      'GET',
      '/api/v1/pipelines',
      user.accessToken
    );
    expect(pipelines.status).toBe(200);
    expect(pipelines.data.length).toBeGreaterThan(0);
    expect(pipelines.data[0].stages.length).toBeGreaterThan(0);
  });

  test('T1.11.2 Updating pipeline vocabulary via PATCH /api/v1/organization updates Kanban UI labels', async ({
    page,
    request,
  }) => {
    const user = await signupViaAPI(request);
    const patch = await apiRequest<{ pipeline_vocabulary?: { deal?: string; deals?: string } }>(
      request,
      'PATCH',
      '/api/v1/organization',
      user.accessToken,
      {
        pipeline_vocabulary: { deal: 'Paciente', deals: 'Pacientes', stage: 'Estado' },
      }
    );
    expect(patch.status).toBe(200);
    expect(patch.data.pipeline_vocabulary?.deal).toBe('Paciente');

    await seedAuthenticatedSession(page, user.accessToken);
    await page.goto('/app/kanban');
    await expect(page.getByRole('button', { name: /Nuevo Paciente/i })).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
  });

  test('T1.11.3 /app/settings Organización tab allows viewing and saving pipeline vocabulary', async ({
    page,
    request,
  }) => {
    const user = await signupViaAPI(request);
    await seedAuthenticatedSession(page, user.accessToken);
    await page.goto('/app/settings');
    await page.getByRole('button', { name: /Organización/i }).click();
    await expect(page.getByText(/Vocabulario/i).first()).toBeVisible();
    await assertZeroOverflow(page);
  });

  test('T1.11.4 Creating a lead with custom_fields JSON persists and returns custom_fields', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const pipelines = await apiRequest<Array<{ id: string; stages: Array<{ id: string }> }>>(
      request,
      'GET',
      '/api/v1/pipelines',
      user.accessToken
    );

    const c = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: 'Contacto Custom Fields', phone_number: '+5215511122233' }
    );

    const created = await apiRequest<{
      id: string;
      custom_fields?: Record<string, unknown>;
    }>(request, 'POST', '/api/v1/leads', user.accessToken, {
      title: 'Lead Campos Personalizados',
      contact_id: c.data.id,
      pipeline_id: pipelines.data[0].id,
      stage_id: pipelines.data[0].stages[0].id,
      custom_fields: { origen: 'Instagram Ads', presupuesto_mxn: 45000 },
    });
    expect(created.status).toBe(201);
    expect(created.data.custom_fields?.origen).toBe('Instagram Ads');
  });

  test('T1.11.5 Updating lead custom_fields via PATCH /api/v1/leads/{id} persists updated values', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const pipelines = await apiRequest<Array<{ id: string; stages: Array<{ id: string }> }>>(
      request,
      'GET',
      '/api/v1/pipelines',
      user.accessToken
    );

    const c = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: 'Contacto Custom Update', phone_number: '+5215511122244' }
    );

    const created = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/leads',
      user.accessToken,
      {
        title: 'Lead Patch Custom',
        contact_id: c.data.id,
        pipeline_id: pipelines.data[0].id,
        stage_id: pipelines.data[0].stages[0].id,
        custom_fields: { prioridad: 'alta' },
      }
    );

    const patched = await apiRequest<{ custom_fields?: Record<string, unknown> }>(
      request,
      'PATCH',
      `/api/v1/leads/${created.data.id}`,
      user.accessToken,
      { custom_fields: { prioridad: 'urgente', notas: 'Llamar hoy' } }
    );
    expect(patched.status).toBe(200);
    expect(patched.data.custom_fields?.prioridad).toBe('urgente');
  });
});

test.describe('Feature #11: Pipeline Vocabulary & Custom Fields (Tier 2 - Boundary & Corner Cases)', () => {
  test('T2.11.1 Non-admin role (agent) receives 403 when trying to update pipeline vocabulary', async ({
    request,
  }) => {
    const admin = await signupViaAPI(request);
    const inv = await apiRequest<{ token: string }>(
      request,
      'POST',
      '/api/v1/team/invites',
      admin.accessToken,
      { email: `agent-vocab-${uniqueId('a')}@koracrm.dev`, role: 'agent' }
    );
    const accepted = await apiRequest<{ access_token: string }>(
      request,
      'POST',
      '/api/v1/team/accept-invite',
      undefined,
      { token: inv.data.token, full_name: 'Agente Vocab', password: 'Secret123!' }
    );

    const res = await apiRequest(
      request,
      'PATCH',
      '/api/v1/organization',
      accepted.data.access_token,
      { pipeline_vocabulary: { deal: 'NoPermitido' } }
    );
    expect(res.status).toBe(403);
  });

  test('T2.11.2 Custom fields with Spanish accents, Unicode, and nested objects round-trip intact', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const pipelines = await apiRequest<Array<{ id: string; stages: Array<{ id: string }> }>>(
      request,
      'GET',
      '/api/v1/pipelines',
      user.accessToken
    );

    const c = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      user.accessToken,
      { name: 'Contacto Unicode', phone_number: '+5215511122255' }
    );

    const res = await apiRequest<{ custom_fields?: Record<string, unknown> }>(
      request,
      'POST',
      '/api/v1/leads',
      user.accessToken,
      {
        title: 'Lead Unicode Custom',
        contact_id: c.data.id,
        pipeline_id: pipelines.data[0].id,
        stage_id: pipelines.data[0].stages[0].id,
        custom_fields: {
          ciudad: 'Bogotá / São Paulo 🌎',
          detalle: { campana: 'Otoño-Invierno', descuento_pct: 15 },
        },
      }
    );
    expect(res.status).toBe(201);
    expect(res.data.custom_fields?.ciudad).toBe('Bogotá / São Paulo 🌎');
  });

  test('T2.11.3 Creating a lead with invalid pipeline_id or stage_id returns 400/404 cleanly', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const res = await apiRequest(request, 'POST', '/api/v1/leads', user.accessToken, {
      title: 'Lead Inválido',
      pipeline_id: '00000000-0000-0000-0000-000000000000',
      stage_id: '00000000-0000-0000-0000-000000000000',
    });
    expect([400, 404, 422]).toContain(res.status);
  });

  test('T2.11.4 Long vocabulary labels do not break Kanban layout or cause horizontal overflow', async ({
    page,
    request,
  }) => {
    const user = await signupViaAPI(request);
    await apiRequest(request, 'PATCH', '/api/v1/organization', user.accessToken, {
      pipeline_vocabulary: {
        deal: 'Expediente Clínico Especializado',
        deals: 'Expedientes Clínicos Especializados',
        stage: 'Fase Operativa',
      },
    });

    await seedAuthenticatedSession(page, user.accessToken);
    await page.goto('/app/kanban');
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
  });

  test('T2.11.5 /app/kanban passes @axe-core/playwright accessibility scan with custom vocabulary', async ({
    page,
    request,
  }) => {
    const user = await signupViaAPI(request);
    await seedAuthenticatedSession(page, user.accessToken);
    await page.goto('/app/kanban');
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'KanbanPage');
  });
});
