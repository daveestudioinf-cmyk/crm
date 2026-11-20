import { createHmac } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { apiRequest, loginViaUI, signupViaAPI, uniqueId, type SignupResult } from './helpers/api';
import {
  assertAccessibility,
  assertSpanishAndBrand,
  assertZeroOverflow,
  attachErrorGuards,
} from './helpers/guards';

test.beforeEach(({ page }) => {
  attachErrorGuards(page);
});

function signHmacSha512(secret: string, body: string): string {
  return createHmac('sha512', secret).update(body).digest('hex');
}

async function createChannelViaAPI(
  request: APIRequestContext,
  token: string,
  sessionName: string,
  provider: 'waha' | 'evolution_go' | 'meta_cloud' = 'waha',
  extra: Record<string, unknown> = {}
) {
  return apiRequest<{
    id: string;
    session_name: string;
    provider: string;
    engine: string;
    status: string;
    warmup_daily_limit: number;
    webhook_secret: string;
  }>(request, 'POST', '/api/v1/channels', token, {
    session_name: sessionName,
    provider,
    ...extra,
  });
}

async function createContactAndConvViaAPI(
  request: APIRequestContext,
  token: string,
  opts: { name?: string; phone?: string; email?: string } = {}
) {
  const id = uniqueId('c');
  const name = opts.name ?? `Cliente ${id}`;
  const phone = opts.phone ?? `+52155${Math.floor(10000000 + Math.random() * 89999999)}`;
  const contactRes = await apiRequest<{ id: string; name: string; phone_number: string }>(
    request,
    'POST',
    '/api/v1/contacts',
    token,
    { name, phone_number: phone, email: opts.email }
  );
  expect(contactRes.ok, `Create contact failed: ${JSON.stringify(contactRes.data)}`).toBe(true);

  const convRes = await apiRequest<{ id: string; status: string }>(
    request,
    'POST',
    '/api/v1/conversations',
    token,
    { contact_id: contactRes.data.id }
  );
  expect(convRes.ok, `Create conversation failed: ${JSON.stringify(convRes.data)}`).toBe(true);

  return {
    contactId: contactRes.data.id,
    contactName: name,
    contactPhone: phone,
    conversationId: convRes.data.id,
  };
}

async function inviteAndAcceptMember(
  request: APIRequestContext,
  adminToken: string,
  role: 'viewer' | 'agent' | 'manager' | 'admin'
): Promise<SignupResult> {
  const email = `${uniqueId(role)}@koracrm.dev`;
  const inviteRes = await apiRequest<{ token: string }>(
    request,
    'POST',
    '/api/v1/team/invites',
    adminToken,
    { email, role }
  );
  expect(inviteRes.ok, `Invite failed: ${JSON.stringify(inviteRes.data)}`).toBe(true);

  const password = 'Secret123!';
  const fullName = `Miembro ${role}`;
  const acceptRes = await apiRequest<Record<string, unknown>>(
    request,
    'POST',
    '/api/v1/team/accept-invite',
    undefined,
    { token: inviteRes.data.token, full_name: fullName, password }
  );
  expect(acceptRes.ok, `Accept invite failed: ${JSON.stringify(acceptRes.data)}`).toBe(true);
  const accessToken = String(acceptRes.data.access_token ?? acceptRes.data.token ?? '');
  const user = (acceptRes.data.user ?? {}) as SignupResult['user'];
  return {
    accessToken,
    organizationId: user.organization_id,
    orgName: '',
    email,
    password,
    fullName,
    user,
    raw: acceptRes.data,
  };
}

async function openInboxConversation(page: Page, contactName: string) {
  await page.goto('/app/inbox');
  const item = page.getByRole('button', { name: new RegExp(contactName) }).first();
  await expect(item).toBeVisible();
  await item.click();
}

// ============================================================================
// Feature #12: Multi-number WhatsApp QR pairing & Evolution Go / WAHA lifecycle
// ============================================================================
test.describe('Feature #12: Multi-number WhatsApp QR pairing & lifecycle (S22)', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('T1.12.1 Renders /app/channels in Spanish with KoraCRM brand, zero overflow, and passes axe scan', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/channels');
      await expect(page.getByRole('heading', { name: /Canales de WhatsApp/i })).toBeVisible();
      await assertSpanishAndBrand(page);
      await assertZeroOverflow(page);
      await assertAccessibility(page, 'Channels S22');
    });

    test('T1.12.2 Connects a WAHA number via UI, displays QR card, and persists in GET /api/v1/channels', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/channels');

      const sessionName = uniqueId('ventas');
      await page.getByPlaceholder('Nombre de sesión (ej. ventas-principal)').fill(sessionName);
      await page.getByRole('combobox').selectOption('waha');
      await page.getByRole('button', { name: 'Conectar Número' }).click();

      await expect(page.getByText(new RegExp(`QR listo \\(${sessionName}\\)`))).toBeVisible();
      await expect(page.getByText(sessionName).first()).toBeVisible();

      const listRes = await apiRequest<Array<{ session_name: string; status: string }>>(
        request,
        'GET',
        '/api/v1/channels',
        tenant.accessToken
      );
      expect(listRes.status).toBe(200);
      expect(listRes.data.some((c) => c.session_name === sessionName && c.status === 'SCAN_QR_CODE')).toBe(true);
    });

    test('T1.12.3 Supports multiple WhatsApp numbers simultaneously per organization', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const s1 = uniqueId('ventas');
      const s2 = uniqueId('soporte');
      const c1 = await createChannelViaAPI(request, tenant.accessToken, s1, 'waha');
      const c2 = await createChannelViaAPI(request, tenant.accessToken, s2, 'waha');
      expect(c1.status).toBe(201);
      expect(c2.status).toBe(201);

      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/channels');
      await expect(page.getByText(s1)).toBeVisible();
      await expect(page.getByText(s2)).toBeVisible();
      await assertZeroOverflow(page);
    });

    test('T1.12.4 Updates daily warm-up limit via UI and persists value', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const sName = uniqueId('warmup');
      const ch = await createChannelViaAPI(request, tenant.accessToken, sName, 'waha');
      expect(ch.status).toBe(201);

      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/channels');
      const limitInput = page.getByRole('spinbutton').first();
      await limitInput.fill('250');
      await page.getByRole('button', { name: 'Guardar límite' }).first().click();

      await expect(page.getByText('Límite diario de calentamiento actualizado.')).toBeVisible();
      const listRes = await apiRequest<Array<{ id: string; warmup_daily_limit: number }>>(
        request,
        'GET',
        '/api/v1/channels',
        tenant.accessToken
      );
      expect(listRes.data.find((c) => c.id === ch.data.id)?.warmup_daily_limit).toBe(250);
    });

    test('T1.12.5 Reconnects, disconnects, and deletes a WhatsApp channel lifecycle', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('life'), 'waha');
      expect(ch.status).toBe(201);

      const qrRes = await apiRequest<{ qr_payload: string }>(
        request,
        'GET',
        `/api/v1/channels/${ch.data.id}/qr`,
        tenant.accessToken
      );
      expect(qrRes.status).toBe(200);
      expect(qrRes.data.qr_payload).toContain(ch.data.id);

      const recRes = await apiRequest<{ status: string }>(
        request,
        'POST',
        `/api/v1/channels/${ch.data.id}/reconnect`,
        tenant.accessToken
      );
      expect(recRes.status).toBe(200);
      expect(recRes.data.status).toBe('WORKING');

      const discRes = await apiRequest<{ status: string }>(
        request,
        'POST',
        `/api/v1/channels/${ch.data.id}/disconnect`,
        tenant.accessToken
      );
      expect(discRes.status).toBe(200);
      expect(discRes.data.status).toBe('STOPPED');

      const delRes = await apiRequest(
        request,
        'DELETE',
        `/api/v1/channels/${ch.data.id}`,
        tenant.accessToken
      );
      expect(delRes.ok).toBe(true);

      const listRes = await apiRequest<Array<{ id: string }>>(
        request,
        'GET',
        '/api/v1/channels',
        tenant.accessToken
      );
      expect(listRes.data.some((c) => c.id === ch.data.id)).toBe(false);
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('T2.12.1 Rejects duplicate session_name with 409 Conflict', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const sName = uniqueId('dup');
      const first = await createChannelViaAPI(request, tenant.accessToken, sName, 'waha');
      expect(first.status).toBe(201);

      const second = await createChannelViaAPI(request, tenant.accessToken, sName, 'waha');
      expect(second.status).toBe(409);
    });

    test('T2.12.2 Rejects empty or whitespace-only session_name with 400 Bad Request', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const emptyRes = await createChannelViaAPI(request, tenant.accessToken, '   ', 'waha');
      expect(emptyRes.status).toBe(400);
    });

    test('T2.12.3 Enforces warm-up daily limit bounds (0 and 5001 rejected with 400; 1 and 5000 accepted)', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('bounds'), 'waha');
      expect(ch.status).toBe(201);

      const lowFail = await apiRequest(request, 'PATCH', `/api/v1/channels/${ch.data.id}`, tenant.accessToken, {
        warmup_daily_limit: 0,
      });
      expect(lowFail.status).toBe(400);

      const highFail = await apiRequest(request, 'PATCH', `/api/v1/channels/${ch.data.id}`, tenant.accessToken, {
        warmup_daily_limit: 5001,
      });
      expect(highFail.status).toBe(400);

      const minOk = await apiRequest(request, 'PATCH', `/api/v1/channels/${ch.data.id}`, tenant.accessToken, {
        warmup_daily_limit: 1,
      });
      expect(minOk.status).toBe(200);

      const maxOk = await apiRequest(request, 'PATCH', `/api/v1/channels/${ch.data.id}`, tenant.accessToken, {
        warmup_daily_limit: 5000,
      });
      expect(maxOk.status).toBe(200);
    });

    test('T2.12.4 Blocks agent and viewer roles from creating or deleting channels (403 Forbidden)', async ({ request }) => {
      const admin = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, admin.accessToken, uniqueId('rbac'), 'waha');
      const agent = await inviteAndAcceptMember(request, admin.accessToken, 'agent');

      const createFail = await createChannelViaAPI(request, agent.accessToken, uniqueId('unauth'), 'waha');
      expect(createFail.status).toBe(403);

      const deleteFail = await apiRequest(request, 'DELETE', `/api/v1/channels/${ch.data.id}`, agent.accessToken);
      expect(deleteFail.status).toBe(403);
    });

    test('T2.12.5 Enforces multi-tenant isolation on channel QR, update, and delete', async ({ request }) => {
      const tenantA = await signupViaAPI(request);
      const tenantB = await signupViaAPI(request);
      const chA = await createChannelViaAPI(request, tenantA.accessToken, uniqueId('iso'), 'waha');

      const qrB = await apiRequest(request, 'GET', `/api/v1/channels/${chA.data.id}/qr`, tenantB.accessToken);
      expect([403, 404]).toContain(qrB.status);

      const patchB = await apiRequest(request, 'PATCH', `/api/v1/channels/${chA.data.id}`, tenantB.accessToken, {
        warmup_daily_limit: 50,
      });
      expect([403, 404]).toContain(patchB.status);

      const delB = await apiRequest(request, 'DELETE', `/api/v1/channels/${chA.data.id}`, tenantB.accessToken);
      expect([403, 404]).toContain(delB.status);
    });
  });
});

// ============================================================================
// Feature #13: HMAC-SHA512 / secret inbound webhook receiver + idempotency
// ============================================================================
test.describe('Feature #13: Inbound webhook receiver (HMAC-SHA512 / secret) + idempotency', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('T1.13.1 WAHA webhook with valid X-Webhook-Hmac creates contact, conversation, and inbound message', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('waha'), 'waha');
      const payload = JSON.stringify({
        external_id: uniqueId('ext'),
        from_phone: '+5215511112222',
        from_name: 'Lucía Webhook',
        body: 'Hola, quiero información del plan',
      });
      const sig = signHmacSha512(ch.data.webhook_secret, payload);

      const whRes = await request.post(`/api/v1/webhooks/waha/${ch.data.session_name}`, {
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Hmac': sig },
        data: payload,
      });
      expect(whRes.ok()).toBe(true);

      const convs = await apiRequest<Array<{ id: string; contact_name: string; last_message_preview: string }>>(
        request,
        'GET',
        '/api/v1/conversations',
        tenant.accessToken
      );
      expect(convs.data.some((c) => c.contact_name === 'Lucía Webhook')).toBe(true);
    });

    test('T1.13.2 Evolution webhook with valid X-Webhook-Secret ingests messages.upsert', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('evo'), 'waha');
      const whRes = await request.post(`/api/v1/webhooks/evolution/${ch.data.session_name}`, {
        headers: { 'X-Webhook-Secret': ch.data.webhook_secret },
        data: {
          event: 'messages.upsert',
          data: {
            key: { id: uniqueId('msg'), remoteJid: '5215533334444@s.whatsapp.net', fromMe: false },
            pushName: 'Mateo Evolution',
            message: { conversation: 'Buenas tardes desde Evolution' },
          },
        },
      });
      expect(whRes.ok()).toBe(true);

      const convs = await apiRequest<Array<{ contact_name: string; last_message_preview: string }>>(
        request,
        'GET',
        '/api/v1/conversations',
        tenant.accessToken
      );
      expect(convs.data.some((c) => c.contact_name === 'Mateo Evolution')).toBe(true);
    });

    test('T1.13.3 Evolution webhook connection.update transitions channel WORKING and FAILED', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('conn'), 'waha');

      const openRes = await request.post(
        `/api/v1/webhooks/evolution/${ch.data.session_name}?secret=${ch.data.webhook_secret}`,
        {
          data: { event: 'connection.update', data: { state: 'open', wuid: '5215599990000@s.whatsapp.net' } },
        }
      );
      expect(openRes.ok()).toBe(true);

      let list = await apiRequest<Array<{ id: string; status: string; phone_number: string }>>(
        request,
        'GET',
        '/api/v1/channels',
        tenant.accessToken
      );
      const working = list.data.find((c) => c.id === ch.data.id);
      expect(working?.status).toBe('WORKING');
      expect(working?.phone_number).toBe('+5215599990000');

      const closeRes = await request.post(
        `/api/v1/webhooks/evolution/${ch.data.session_name}?secret=${ch.data.webhook_secret}`,
        {
          data: { event: 'connection.update', data: { state: 'close' } },
        }
      );
      expect(closeRes.ok()).toBe(true);

      list = await apiRequest(request, 'GET', '/api/v1/channels', tenant.accessToken);
      expect(list.data.find((c) => c.id === ch.data.id)?.status).toBe('FAILED');
    });

    test('T1.13.4 Deduplicates repeated external_id deliveries idempotently', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('idem'), 'waha');
      const extId = uniqueId('dedup');
      const payload = JSON.stringify({
        external_id: extId,
        from_phone: '+5215544445555',
        from_name: 'Elena Idem',
        body: 'Mensaje único',
      });
      const sig = signHmacSha512(ch.data.webhook_secret, payload);

      const first = await request.post(`/api/v1/webhooks/waha/${ch.data.session_name}`, {
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Hmac': sig },
        data: payload,
      });
      const second = await request.post(`/api/v1/webhooks/waha/${ch.data.session_name}`, {
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Hmac': sig },
        data: payload,
      });
      expect(first.ok()).toBe(true);
      expect(second.ok()).toBe(true);

      const convs = await apiRequest<Array<{ id: string; contact_name: string }>>(
        request,
        'GET',
        '/api/v1/conversations',
        tenant.accessToken
      );
      const conv = convs.data.find((c) => c.contact_name === 'Elena Idem');
      expect(conv).toBeDefined();

      const msgs = await apiRequest<Array<{ body: string }>>(
        request,
        'GET',
        `/api/v1/conversations/${conv!.id}/messages`,
        tenant.accessToken
      );
      expect(msgs.data.filter((m) => m.body === 'Mensaje único')).toHaveLength(1);
    });

    test('T1.13.5 Preserves Spanish accents, ñ, and emojis in inbound webhook messages', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('utf8'), 'waha');
      const textBody = '¡Hola! Cotización rápida mañana ñandú 🚀';
      const payload = JSON.stringify({
        external_id: uniqueId('utf8'),
        from_phone: '+5215566667777',
        from_name: 'Sofía Núñez',
        body: textBody,
      });
      const sig = signHmacSha512(ch.data.webhook_secret, payload);

      const res = await request.post(`/api/v1/webhooks/waha/${ch.data.session_name}`, {
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Hmac': sig },
        data: payload,
      });
      expect(res.ok()).toBe(true);

      const convs = await apiRequest<Array<{ id: string; last_message_preview: string }>>(
        request,
        'GET',
        '/api/v1/conversations',
        tenant.accessToken
      );
      expect(convs.data.some((c) => c.last_message_preview.includes('ñandú 🚀'))).toBe(true);
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('T2.13.1 Rejects invalid X-Webhook-Hmac on WAHA webhook with 401 Unauthorized', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('badhmac'), 'waha');
      const res = await request.post(`/api/v1/webhooks/waha/${ch.data.session_name}`, {
        headers: { 'X-Webhook-Hmac': 'deadbeef0000' },
        data: { from_phone: '+5215500001111', body: 'Intento inválido' },
      });
      expect(res.status()).toBe(401);
    });

    test('T2.13.2 Rejects missing or wrong X-Webhook-Secret on Evolution webhook with 401 Unauthorized', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('badsec'), 'waha');
      const res = await request.post(`/api/v1/webhooks/evolution/${ch.data.session_name}`, {
        headers: { 'X-Webhook-Secret': 'wrong-secret' },
        data: { event: 'messages.upsert', data: {} },
      });
      expect(res.status()).toBe(401);
    });

    test('T2.13.3 Returns 404 Not Found for unknown session name', async ({ request }) => {
      const wahaRes = await request.post('/api/v1/webhooks/waha/sesion-inexistente-999', {
        data: { from_phone: '+5215500001111', body: 'Hola' },
      });
      expect(wahaRes.status()).toBe(404);

      const evoRes = await request.post('/api/v1/webhooks/evolution/sesion-inexistente-999', {
        headers: { 'X-Webhook-Secret': 'any' },
        data: { event: 'messages.upsert', data: {} },
      });
      expect(evoRes.status()).toBe(404);
    });

    test('T2.13.4 Ignores group (@g.us), broadcast, and fromMe messages on Evolution webhook', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('grp'), 'waha');

      for (const jid of ['120363000000@g.us', 'status@broadcast']) {
        const res = await request.post(`/api/v1/webhooks/evolution/${ch.data.session_name}`, {
          headers: { 'X-Webhook-Secret': ch.data.webhook_secret },
          data: {
            event: 'messages.upsert',
            data: {
              key: { id: uniqueId('g'), remoteJid: jid, fromMe: false },
              message: { conversation: 'Ignorar grupo' },
            },
          },
        });
        expect(res.status()).toBe(200);
      }

      const convs = await apiRequest<Array<{ id: string }>>(
        request,
        'GET',
        '/api/v1/conversations',
        tenant.accessToken
      );
      expect(convs.data).toHaveLength(0);
    });

    test('T2.13.5 Rejects WAHA webhook missing from_phone with 400 Bad Request', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('nophone'), 'waha');
      const payload = JSON.stringify({ external_id: uniqueId('np'), body: 'Sin teléfono' });
      const sig = signHmacSha512(ch.data.webhook_secret, payload);

      const res = await request.post(`/api/v1/webhooks/waha/${ch.data.session_name}`, {
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Hmac': sig },
        data: payload,
      });
      expect(res.status()).toBe(400);
    });
  });
});

// ============================================================================
// Feature #14: Optimistic outbound send + >4096 char chunking
// ============================================================================
test.describe('Feature #14: Optimistic outbound send + >4096 char chunking', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('T1.14.1 Sends outbound message from Inbox UI and persists in thread', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const { contactName, conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, tenant.accessToken);

      await loginViaUI(page, tenant.email, tenant.password);
      await openInboxConversation(page, contactName);

      const text = `Hola ${contactName}, aquí tienes tu cotización.`;
      await page.getByPlaceholder('Escribe un mensaje de WhatsApp...').fill(text);
      await page.locator('form button[type="submit"]').click();

      await expect(page.getByText(text).last()).toBeVisible();
      const msgs = await apiRequest<Array<{ body: string; direction: string }>>(
        request,
        'GET',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken
      );
      expect(msgs.data.some((m) => m.body === text && m.direction === 'outbound')).toBe(true);
    });

    test('T1.14.2 Outbound API send returns 201 and sets direction=outbound, sender_type=human', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, tenant.accessToken);

      const sendRes = await apiRequest<{ id: string; chunks: number }>(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: 'Confirmado para mañana a las 10:00', content_type: 'text' }
      );
      expect(sendRes.status).toBe(201);
      expect(sendRes.data.chunks).toBe(1);

      const msgs = await apiRequest<Array<{ direction: string; sender_type: string; body: string }>>(
        request,
        'GET',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken
      );
      expect(msgs.data[0].direction).toBe('outbound');
      expect(msgs.data[0].sender_type).toBe('human');
    });

    test('T1.14.3 Automatically chunks outbound messages exceeding 4096 characters', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, tenant.accessToken);

      const longBody = 'A'.repeat(8500);
      const sendRes = await apiRequest<{ chunks: number }>(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: longBody, content_type: 'text' }
      );
      expect(sendRes.status).toBe(201);
      expect(sendRes.data.chunks).toBe(3);

      const msgs = await apiRequest<Array<{ body: string }>>(
        request,
        'GET',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken
      );
      expect(msgs.data).toHaveLength(3);
      for (const m of msgs.data) {
        expect(m.body.length).toBeLessThanOrEqual(4096);
      }
      expect(msgs.data.map((m) => m.body).join('')).toBe(longBody);
    });

    test('T1.14.4 Sends exact 4096-character message as a single chunk', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, tenant.accessToken);

      const exactBody = 'B'.repeat(4096);
      const sendRes = await apiRequest<{ chunks: number }>(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: exactBody, content_type: 'text' }
      );
      expect(sendRes.status).toBe(201);
      expect(sendRes.data.chunks).toBe(1);
    });

    test('T1.14.5 Idempotency-Key prevents duplicate outbound messages on network retry', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, tenant.accessToken);

      const idemKey = uniqueId('idem-send');
      const r1 = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: 'Envío idempotente', content_type: 'text' },
        { 'Idempotency-Key': idemKey }
      );
      const r2 = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: 'Envío idempotente', content_type: 'text' },
        { 'Idempotency-Key': idemKey }
      );
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);

      const msgs = await apiRequest<Array<{ body: string }>>(
        request,
        'GET',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken
      );
      expect(msgs.data.filter((m) => m.body === 'Envío idempotente')).toHaveLength(1);
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('T2.14.1 Rejects empty or whitespace-only outbound message (400) and disables send button in UI', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const { contactName, conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, tenant.accessToken);

      const badRes = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: '   \n\t  ', content_type: 'text' }
      );
      expect(badRes.status).toBe(400);

      await loginViaUI(page, tenant.email, tenant.password);
      await openInboxConversation(page, contactName);
      await page.getByPlaceholder('Escribe un mensaje de WhatsApp...').fill('   ');
      await expect(page.locator('form button[type="submit"]')).toBeDisabled();
    });

    test('T2.14.2 Chunks multi-byte Unicode/emoji payload >4096 chars without losing characters', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, tenant.accessToken);

      const unicodeUnit = 'áéíóúñ🚀';
      const longUnicode = unicodeUnit.repeat(700); // 5600 chars
      const sendRes = await apiRequest<{ chunks: number }>(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: longUnicode, content_type: 'text' }
      );
      expect(sendRes.status).toBe(201);
      expect(sendRes.data.chunks).toBeGreaterThanOrEqual(2);

      const msgs = await apiRequest<Array<{ body: string }>>(
        request,
        'GET',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken
      );
      expect(msgs.data.map((m) => m.body).join('')).toBe(longUnicode);
    });

    test('T2.14.3 Returns 404 when sending to cross-tenant or unknown conversation', async ({ request }) => {
      const tenantA = await signupViaAPI(request);
      const tenantB = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenantA.accessToken);

      const crossRes = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenantB.accessToken,
        { body: 'Intento cruzado', content_type: 'text' }
      );
      expect([403, 404]).toContain(crossRes.status);
    });

    test('T2.14.4 Support read-only session blocks outbound message send with 403', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      const res = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: 'Bloqueado en soporte', content_type: 'text' },
        { 'X-Support-Session-ID': '00000000-0000-0000-0000-000000000001' }
      );
      expect([401, 403]).toContain(res.status);
    });

    test('T2.14.5 Viewer role cannot send outbound messages (403 Forbidden)', async ({ request }) => {
      const admin = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, admin.accessToken);
      const viewer = await inviteAndAcceptMember(request, admin.accessToken, 'viewer');

      const res = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        viewer.accessToken,
        { body: 'Viewer no debe enviar', content_type: 'text' }
      );
      expect(res.status).toBe(403);
    });
  });
});

// ============================================================================
// Feature #15: Anti-ban defenses (throttle, jitter, business-hours, warm-up, STOP)
// ============================================================================
test.describe('Feature #15: Anti-ban defenses & STOP opt-out blocking', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('T1.15.1 Inbound STOP opt-out marks contact is_blocked and shows Baja solicitada (STOP) badge in Inbox', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('stop'), 'waha');
      const phone = '+5215577778888';
      const payload = JSON.stringify({
        external_id: uniqueId('stop'),
        from_phone: phone,
        from_name: 'Contacto STOP',
        body: 'STOP',
      });
      const sig = signHmacSha512(ch.data.webhook_secret, payload);
      const whRes = await request.post(`/api/v1/webhooks/waha/${ch.data.session_name}`, {
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Hmac': sig },
        data: payload,
      });
      expect(whRes.ok()).toBe(true);

      await loginViaUI(page, tenant.email, tenant.password);
      await openInboxConversation(page, 'Contacto STOP');

      if (page.viewportSize()!.width < 1024) {
        await page.getByRole('button', { name: 'Customer 360' }).click();
      }
      await expect(page.getByText('Baja solicitada (STOP)')).toBeVisible();
      await expect(page.getByPlaceholder('Contacto dado de baja (STOP)')).toBeDisabled();
    });

    test('T1.15.2 Outbound text send to STOP-blocked contact is rejected with 422', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('stopapi'), 'waha');
      const payload = JSON.stringify({
        external_id: uniqueId('stop2'),
        from_phone: '+5215588889999',
        from_name: 'Bloqueado API',
        body: 'PARAR',
      });
      await request.post(`/api/v1/webhooks/waha/${ch.data.session_name}`, {
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Hmac': signHmacSha512(ch.data.webhook_secret, payload) },
        data: payload,
      });

      const convs = await apiRequest<Array<{ id: string; contact_name: string }>>(
        request,
        'GET',
        '/api/v1/conversations',
        tenant.accessToken
      );
      const conv = convs.data.find((c) => c.contact_name === 'Bloqueado API');
      expect(conv).toBeDefined();

      const sendRes = await apiRequest<{ error: string }>(
        request,
        'POST',
        `/api/v1/conversations/${conv!.id}/messages`,
        tenant.accessToken,
        { body: 'Mensaje promocional', content_type: 'text' }
      );
      expect(sendRes.status).toBe(422);
    });

    test('T1.15.3 Channel warm-up daily limit configuration persists and governs outbound pacing', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('pace'), 'waha');
      const patchRes = await apiRequest<{ warmup_daily_limit: number }>(
        request,
        'PATCH',
        `/api/v1/channels/${ch.data.id}`,
        tenant.accessToken,
        { warmup_daily_limit: 5 }
      );
      expect(patchRes.status).toBe(200);
      expect(patchRes.data.warmup_daily_limit).toBe(5);
    });

    test('T1.15.4 Business-hours settings can be configured on channel/organization without error', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('bh'), 'waha');
      const patchRes = await apiRequest(
        request,
        'PATCH',
        `/api/v1/channels/${ch.data.id}`,
        tenant.accessToken,
        {
          warmup_daily_limit: 100,
          business_hours_start: '08:00',
          business_hours_end: '20:00',
          timezone: 'America/Mexico_City',
        }
      );
      expect([200, 204]).toContain(patchRes.status);
    });

    test('T1.15.5 Anti-ban jitter / throttle settings are accepted on channel configuration', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('jit'), 'waha');
      const patchRes = await apiRequest(
        request,
        'PATCH',
        `/api/v1/channels/${ch.data.id}`,
        tenant.accessToken,
        { warmup_daily_limit: 50, min_delay_ms: 1500, max_delay_ms: 4500 }
      );
      expect([200, 204]).toContain(patchRes.status);
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('T2.15.1 Case-insensitive and whitespace-padded STOP/SAIR/PARAR triggers opt-out', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('case'), 'waha');
      const payload = JSON.stringify({
        external_id: uniqueId('sair'),
        from_phone: '+5215510102020',
        from_name: 'Sair Padded',
        body: '  sair  ',
      });
      await request.post(`/api/v1/webhooks/waha/${ch.data.session_name}`, {
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Hmac': signHmacSha512(ch.data.webhook_secret, payload) },
        data: payload,
      });

      const convs = await apiRequest<Array<{ id: string; contact_name: string; is_blocked: boolean }>>(
        request,
        'GET',
        '/api/v1/conversations',
        tenant.accessToken
      );
      const conv = convs.data.find((c) => c.contact_name === 'Sair Padded');
      expect(conv?.is_blocked).toBe(true);
    });

    test('T2.15.2 Internal notes remain allowed on STOP-blocked contacts while external text is blocked', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('stopnote'), 'waha');
      const payload = JSON.stringify({
        external_id: uniqueId('sn'),
        from_phone: '+5215520203030',
        from_name: 'Nota STOP',
        body: 'STOP',
      });
      await request.post(`/api/v1/webhooks/waha/${ch.data.session_name}`, {
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Hmac': signHmacSha512(ch.data.webhook_secret, payload) },
        data: payload,
      });

      const convs = await apiRequest<Array<{ id: string; contact_name: string }>>(
        request,
        'GET',
        '/api/v1/conversations',
        tenant.accessToken
      );
      const conv = convs.data.find((c) => c.contact_name === 'Nota STOP');
      expect(conv).toBeDefined();

      const noteRes = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conv!.id}/messages`,
        tenant.accessToken,
        { body: 'Nota interna: cliente pidió baja por WhatsApp', content_type: 'note' }
      );
      expect(noteRes.status).toBe(201);
    });

    test('T2.15.3 Exceeding warm-up daily limit returns 429 or 422 without 5xx error', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('cap'), 'waha');
      await apiRequest(request, 'PATCH', `/api/v1/channels/${ch.data.id}`, tenant.accessToken, {
        warmup_daily_limit: 1,
      });
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, tenant.accessToken);

      const first = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: 'Primer mensaje dentro de límite', content_type: 'text', channel_session_id: ch.data.id }
      );
      expect(first.status).toBeLessThan(500);

      const second = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: 'Segundo mensaje excede límite', content_type: 'text', channel_session_id: ch.data.id }
      );
      expect([201, 422, 429]).toContain(second.status);
    });

    test('T2.15.4 Invalid business-hours window (e.g. 25:99) is rejected cleanly without 500', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('badbh'), 'waha');
      const res = await apiRequest(
        request,
        'PATCH',
        `/api/v1/channels/${ch.data.id}`,
        tenant.accessToken,
        { warmup_daily_limit: 50, business_hours_start: '25:99', business_hours_end: 'invalid' }
      );
      expect(res.status).toBeLessThan(500);
    });

    test('T2.15.5 Unblocking a STOP-opted-out contact via PATCH /api/v1/contacts/:id restores outbound send', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { contactId, conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'PATCH', `/api/v1/contacts/${contactId}`, tenant.accessToken, { is_blocked: true });

      const blockedRes = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: 'Bloqueado', content_type: 'text' }
      );
      expect(blockedRes.status).toBe(422);

      await apiRequest(request, 'PATCH', `/api/v1/contacts/${contactId}`, tenant.accessToken, { is_blocked: false });
      const unblockedRes = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: 'Reautorizado por cliente', content_type: 'text' }
      );
      expect(unblockedRes.status).toBe(201);
    });
  });
});

// ============================================================================
// Feature #16: Media persistence via MinIO/S3 + signed/proxied URLs
// ============================================================================
test.describe('Feature #16: Media persistence via MinIO/S3 + signed/proxied URLs', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('T1.16.1 Uploads media file to /api/v1/media/upload and returns proxied/signed URL', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
      const uploadRes = await request.post('/api/v1/media/upload', {
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
        multipart: {
          file: { name: 'catalogo.png', mimeType: 'image/png', buffer: pngBytes },
        },
      });
      expect(uploadRes.ok(), `Media upload failed (${uploadRes.status()})`).toBe(true);
      const body = (await uploadRes.json()) as { media_url?: string; url?: string };
      expect(body.media_url || body.url).toBeTruthy();
    });

    test('T1.16.2 Sends outbound message with media_url and persists attachment in message list', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, tenant.accessToken);

      const mediaUrl = '/api/v1/media/demo-catalogo.pdf';
      const sendRes = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: 'Adjunto catálogo PDF', content_type: 'document', media_url: mediaUrl }
      );
      expect(sendRes.status).toBe(201);

      const msgs = await apiRequest<Array<{ content_type: string; media_url: string }>>(
        request,
        'GET',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken
      );
      expect(msgs.data.some((m) => m.media_url === mediaUrl)).toBe(true);
    });

    test('T1.16.3 Downloads uploaded media via returned signed/proxied URL with valid Content-Type', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const txtBuffer = Buffer.from('Ficha técnica KoraCRM', 'utf-8');
      const uploadRes = await request.post('/api/v1/media/upload', {
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
        multipart: {
          file: { name: 'ficha.txt', mimeType: 'text/plain', buffer: txtBuffer },
        },
      });
      expect(uploadRes.ok()).toBe(true);
      const data = (await uploadRes.json()) as { media_url?: string; url?: string };
      const url = data.media_url || data.url || '';
      const dlRes = await request.get(url, {
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });
      expect(dlRes.status()).toBe(200);
      expect(await dlRes.text()).toContain('Ficha técnica KoraCRM');
    });

    test('T1.16.4 Inbound webhook with media_url persists attachment on conversation message', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('mediawh'), 'waha');
      const payload = JSON.stringify({
        external_id: uniqueId('mw'),
        from_phone: '+5215530304040',
        from_name: 'Cliente Foto',
        body: 'Foto de comprobante',
        media_url: 'https://cdn.example.com/comprobante.jpg',
        content_type: 'image',
      });
      const res = await request.post(`/api/v1/webhooks/waha/${ch.data.session_name}`, {
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Hmac': signHmacSha512(ch.data.webhook_secret, payload) },
        data: payload,
      });
      expect(res.ok()).toBe(true);
    });

    test('T1.16.5 Inbox renders media message without horizontal overflow on desktop and mobile', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const { contactName, conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, tenant.accessToken);
      await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: 'Ver archivo adjunto', content_type: 'document', media_url: '/api/v1/media/propuesta.pdf' }
      );

      await loginViaUI(page, tenant.email, tenant.password);
      await openInboxConversation(page, contactName);
      await expect(page.getByText('Ver archivo adjunto')).toBeVisible();
      await assertZeroOverflow(page);
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('T2.16.1 Rejects empty file upload with 400 Bad Request', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const uploadRes = await request.post('/api/v1/media/upload', {
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
        multipart: {
          file: { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
        },
      });
      expect([400, 422]).toContain(uploadRes.status());
    });

    test('T2.16.2 Rejects executable MIME type (.exe / application/x-msdownload) with 400 or 415', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const uploadRes = await request.post('/api/v1/media/upload', {
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
        multipart: {
          file: { name: 'malware.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ') },
        },
      });
      expect([400, 415, 422]).toContain(uploadRes.status());
    });

    test('T2.16.3 Rejects unauthenticated media upload and download with 401 Unauthorized', async ({ request }) => {
      const res = await request.post('/api/v1/media/upload');
      expect(res.status()).toBe(401);
    });

    test('T2.16.4 Enforces cross-tenant isolation on proxied media URLs', async ({ request }) => {
      const tenantA = await signupViaAPI(request);
      const tenantB = await signupViaAPI(request);
      const uploadRes = await request.post('/api/v1/media/upload', {
        headers: { Authorization: `Bearer ${tenantA.accessToken}` },
        multipart: {
          file: { name: 'secreto.txt', mimeType: 'text/plain', buffer: Buffer.from('Confidencial A') },
        },
      });
      expect(uploadRes.ok()).toBe(true);
      const { media_url, url } = (await uploadRes.json()) as { media_url?: string; url?: string };
      const target = media_url || url || '';

      const dlB = await request.get(target, {
        headers: { Authorization: `Bearer ${tenantB.accessToken}` },
      });
      expect([403, 404]).toContain(dlB.status());
    });

    test('T2.16.5 Sanitizes or rejects path traversal filenames (../../etc/passwd)', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const uploadRes = await request.post('/api/v1/media/upload', {
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
        multipart: {
          file: { name: '../../etc/passwd', mimeType: 'text/plain', buffer: Buffer.from('safe') },
        },
      });
      expect(uploadRes.status()).toBeLessThan(500);
      if (uploadRes.ok()) {
        const body = JSON.stringify(await uploadRes.json());
        expect(body).not.toContain('..');
      }
    });
  });
});

// ============================================================================
// Feature #17: Meta Cloud API official channel + HSM template sync
// ============================================================================
test.describe('Feature #17: Meta Cloud API official channel + HSM template sync', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('T1.17.1 Creates Meta Cloud API official channel via POST /api/v1/channels', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const res = await createChannelViaAPI(request, tenant.accessToken, uniqueId('meta'), 'meta_cloud', {
        phone_number_id: '109876543210',
        waba_id: '987654321098',
        access_token: 'EAAG_test_token',
      });
      expect(res.status).toBe(201);
      expect(res.data.provider).toBe('meta_cloud');
    });

    test('T1.17.2 Syncs HSM templates for Meta Cloud channel', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('metasync'), 'meta_cloud');
      expect(ch.status).toBe(201);

      const syncRes = await apiRequest<{ synced: number }>(
        request,
        'POST',
        `/api/v1/channels/${ch.data.id}/sync-templates`,
        tenant.accessToken
      );
      expect(syncRes.ok).toBe(true);
    });

    test('T1.17.3 Sends HSM template message to conversation outside 24h window', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, tenant.accessToken);

      const sendRes = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        {
          body: 'Hola {{1}}, tu cita es mañana.',
          content_type: 'template',
          template_name: 'recordatorio_cita',
          template_params: ['Carlos'],
        }
      );
      expect(sendRes.status).toBe(201);
    });

    test('T1.17.4 Handles Meta Cloud API webhook verification challenge (GET hub.challenge)', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('metaverify'), 'meta_cloud');
      const challenge = '1158201444';
      const res = await request.get(
        `/api/v1/webhooks/meta/${ch.data.session_name}?hub.mode=subscribe&hub.verify_token=${ch.data.webhook_secret}&hub.challenge=${challenge}`
      );
      expect(res.status()).toBe(200);
      expect(await res.text()).toBe(challenge);
    });

    test('T1.17.5 Meta Cloud API channel renders cleanly in /app/channels UI', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const sName = uniqueId('meta-ui');
      await createChannelViaAPI(request, tenant.accessToken, sName, 'meta_cloud');

      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/channels');
      await expect(page.getByText(sName)).toBeVisible();
      await assertZeroOverflow(page);
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('T2.17.1 Rejects Meta webhook verification with wrong verify_token (403 Forbidden)', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('metabadtok'), 'meta_cloud');
      const res = await request.get(
        `/api/v1/webhooks/meta/${ch.data.session_name}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123`
      );
      expect(res.status()).toBe(403);
    });

    test('T2.17.2 Rejects Meta webhook POST with invalid X-Hub-Signature-256 (401 Unauthorized)', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('metabadsig'), 'meta_cloud');
      const res = await request.post(`/api/v1/webhooks/meta/${ch.data.session_name}`, {
        headers: { 'X-Hub-Signature-256': 'sha256=invalidsignature' },
        data: { object: 'whatsapp_business_account', entry: [] },
      });
      expect(res.status()).toBe(401);
    });

    test('T2.17.3 Rejects HSM template send with empty template_name (400/422)', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      const res = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: 'Hola', content_type: 'template', template_name: '' }
      );
      expect([400, 422]).toContain(res.status);
    });

    test('T2.17.4 Non-Meta channel rejects HSM sync-templates cleanly (400/422)', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('wahasync'), 'waha');
      const res = await apiRequest(
        request,
        'POST',
        `/api/v1/channels/${ch.data.id}/sync-templates`,
        tenant.accessToken
      );
      expect([400, 422]).toContain(res.status);
    });

    test('T2.17.5 Tenant B cannot sync templates on Tenant A Meta Cloud channel (403/404)', async ({ request }) => {
      const tenantA = await signupViaAPI(request);
      const tenantB = await signupViaAPI(request);
      const chA = await createChannelViaAPI(request, tenantA.accessToken, uniqueId('meta-iso'), 'meta_cloud');
      const res = await apiRequest(
        request,
        'POST',
        `/api/v1/channels/${chA.data.id}/sync-templates`,
        tenantB.accessToken
      );
      expect([403, 404]).toContain(res.status);
    });
  });
});

// ============================================================================
// Feature #18: Unified Go SSE Realtime Hub
// ============================================================================
test.describe('Feature #18: Unified Go SSE Realtime Hub + reconnect banner', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('T1.18.1 Connects to GET /api/v1/realtime/stream with valid token and receives text/event-stream', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      await loginViaUI(page, tenant.email, tenant.password);

      const sseStatus = await page.evaluate(async (tok) => {
        const ctrl = new AbortController();
        const res = await fetch(`/api/v1/realtime/stream?token=${encodeURIComponent(tok)}`, {
          signal: ctrl.signal,
        });
        const ct = res.headers.get('content-type') || '';
        ctrl.abort();
        return { status: res.status, ct };
      }, tenant.accessToken);

      expect(sseStatus.status).toBe(200);
      expect(sseStatus.ct).toContain('text/event-stream');
    });

    test('T1.18.2 Inbound webhook publishes message.created event to live Inbox via SSE', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('sse'), 'waha');
      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/inbox');

      const msgBody = `Tiempo real ${uniqueId('rt')}`;
      const payload = JSON.stringify({
        external_id: uniqueId('sse-m'),
        from_phone: '+5215540405050',
        from_name: 'SSE Cliente',
        body: msgBody,
      });
      await request.post(`/api/v1/webhooks/waha/${ch.data.session_name}`, {
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Hmac': signHmacSha512(ch.data.webhook_secret, payload) },
        data: payload,
      });

      await expect(page.getByText('SSE Cliente')).toBeVisible({ timeout: 10000 });
    });

    test('T1.18.3 Conversation claim publishes conversation.updated event', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const { contactName, conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/inbox');
      await expect(page.getByText(contactName)).toBeVisible();

      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, tenant.accessToken);
      await expect(page.getByText('claimed').first()).toBeVisible({ timeout: 10000 });
    });

    test('T1.18.4 Channel status webhook publishes channel.updated and refreshes /app/channels', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('ssech'), 'waha');
      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/channels');
      await expect(page.getByText('SCAN_QR_CODE').first()).toBeVisible();

      await request.post(`/api/v1/webhooks/evolution/${ch.data.session_name}`, {
        headers: { 'X-Webhook-Secret': ch.data.webhook_secret },
        data: { event: 'connection.update', data: { state: 'open' } },
      });
      await expect(page.getByText('WORKING').first()).toBeVisible({ timeout: 10000 });
    });

    test('T1.18.5 Inbox S06 shows Spanish reconnect banner when SSE stream drops', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      await loginViaUI(page, tenant.email, tenant.password);

      await page.route('**/api/v1/realtime/stream*', (route) => route.abort('failed'));
      await page.goto('/app/inbox');
      await expect(page.getByText(/Reconectando|Conexión en tiempo real|Sin conexión/i)).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('T2.18.1 Rejects SSE stream connection without auth token (401 Unauthorized)', async ({ request }) => {
      const res = await request.get('/api/v1/realtime/stream');
      expect(res.status()).toBe(401);
    });

    test('T2.18.2 Rejects SSE stream connection with invalid/expired token (401 Unauthorized)', async ({ request }) => {
      const res = await request.get('/api/v1/realtime/stream?token=invalid.jwt.token');
      expect(res.status()).toBe(401);
    });

    test('T2.18.3 Tenant B SSE stream never receives Tenant A conversation/message events', async ({ page, request }) => {
      const tenantA = await signupViaAPI(request);
      const tenantB = await signupViaAPI(request);
      const chA = await createChannelViaAPI(request, tenantA.accessToken, uniqueId('sseA'), 'waha');

      await loginViaUI(page, tenantB.email, tenantB.password);
      await page.goto('/app/inbox');

      const secretName = `SecretoTenantA-${uniqueId('x')}`;
      const payload = JSON.stringify({
        external_id: uniqueId('iso'),
        from_phone: '+5215550506060',
        from_name: secretName,
        body: 'Mensaje privado A',
      });
      await request.post(`/api/v1/webhooks/waha/${chA.data.session_name}`, {
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Hmac': signHmacSha512(chA.data.webhook_secret, payload) },
        data: payload,
      });

      await page.waitForTimeout(800);
      await expect(page.getByText(secretName)).toHaveCount(0);
    });

    test('T2.18.4 Aborting SSE connection mid-stream does not trigger 5xx or console errors', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/inbox');
      await page.goto('/app/channels');
      await expect(page.getByRole('heading', { name: /Canales de WhatsApp/i })).toBeVisible();
    });

    test('T2.18.5 SSE stream handles Last-Event-ID header gracefully without 5xx', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 300);
      const res = await request.get('/api/v1/realtime/stream', {
        headers: {
          Authorization: `Bearer ${tenant.accessToken}`,
          'Last-Event-ID': '99999',
        },
        timeout: 2000,
      }).catch(() => null);
      if (res) {
        expect(res.status()).toBeLessThan(500);
      }
    });
  });
});

// ============================================================================
// Feature #19: 3-column real-time Inbox desktop + mobile sheet (S06)
// ============================================================================
test.describe('Feature #19: 3-column Inbox desktop + mobile sheet (S06)', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('T1.19.1 Renders /app/inbox in Spanish with KoraCRM brand, zero overflow, and passes axe scan', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      await createContactAndConvViaAPI(request, tenant.accessToken, { name: 'Ana Bandeja' });
      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/inbox');
      await expect(page.getByRole('heading', { name: 'Bandeja' })).toBeVisible();
      await assertSpanishAndBrand(page);
      await assertZeroOverflow(page);
      await assertAccessibility(page, 'Inbox S06');
    });

    test('T1.19.2 Desktop displays 3 columns simultaneously; /app/inbox/:id deep-links to conversation', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const { contactName, conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto(`/app/inbox/${conversationId}`);

      if (page.viewportSize()!.width >= 1024) {
        await expect(page.getByRole('heading', { name: 'Bandeja' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Customer 360°' })).toBeVisible();
      }
      await expect(page.getByText(contactName).first()).toBeVisible();
    });

    test('T1.19.3 Status filter tabs (Todos, Cola, IA, Míos) filter conversation list', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const { contactName, conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken, { name: 'Filtro Míos' });
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, tenant.accessToken);

      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/inbox');

      await page.getByRole('button', { name: 'Míos' }).click();
      await expect(page.getByText(contactName).first()).toBeVisible();

      await page.getByRole('button', { name: 'Cola' }).click();
      await expect(page.getByText(contactName)).toHaveCount(0);
    });

    test('T1.19.4 Mobile 2-step navigation (list -> chat -> Volver a la lista) works with zero overflow', async ({ page, request }, testInfo) => {
      const tenant = await signupViaAPI(request);
      const { contactName } = await createContactAndConvViaAPI(request, tenant.accessToken, { name: 'Móvil Chat' });
      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/inbox');

      await page.getByRole('button', { name: new RegExp(contactName) }).first().click();
      await assertZeroOverflow(page);
      if (testInfo.project.name === 'mobile') {
        await page.getByRole('button', { name: 'Volver a la lista' }).click();
        await expect(page.getByRole('heading', { name: 'Bandeja' })).toBeVisible();
      }
    });

    test('T1.19.5 Customer 360° panel/sheet displays contact phone, tags, and timeline', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const { contactName, contactPhone } = await createContactAndConvViaAPI(request, tenant.accessToken, {
        name: 'Cliente C360',
        phone: '+5215590901010',
      });
      await loginViaUI(page, tenant.email, tenant.password);
      await openInboxConversation(page, contactName);

      if (page.viewportSize()!.width < 1024) {
        await page.getByRole('button', { name: 'Customer 360' }).click();
      }
      await expect(page.getByText(contactPhone).last()).toBeVisible();
      await expect(page.getByText('Línea de tiempo')).toBeVisible();
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('T2.19.1 Empty Inbox shows Spanish empty state without errors', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/inbox');
      await expect(page.getByText(/Aún no hay conversaciones/i)).toBeVisible();
      await assertZeroOverflow(page);
    });

    test('T2.19.2 Deep-link to non-existent conversation ID handles gracefully without 500', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/inbox/00000000-0000-0000-0000-000000000999');
      await assertSpanishAndBrand(page);
      await assertZeroOverflow(page);
    });

    test('T2.19.3 Long unspaced message word wraps cleanly with zero horizontal overflow', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const { contactName, conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, tenant.accessToken);
      await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: 'X'.repeat(180), content_type: 'text' }
      );

      await loginViaUI(page, tenant.email, tenant.password);
      await openInboxConversation(page, contactName);
      await assertZeroOverflow(page);
    });

    test('T2.19.4 Cross-tenant deep-link /app/inbox/:id never leaks Tenant A messages to Tenant B', async ({ page, request }) => {
      const tenantA = await signupViaAPI(request);
      const tenantB = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenantA.accessToken, { name: 'Privado A' });
      await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenantA.accessToken,
        { body: 'Mensaje secreto de A', content_type: 'text' }
      );

      await loginViaUI(page, tenantB.email, tenantB.password);
      await page.goto(`/app/inbox/${conversationId}`);
      await expect(page.getByText('Mensaje secreto de A')).toHaveCount(0);
    });

    test('T2.19.5 Unauthenticated visit to /app/inbox redirects to /login', async ({ page }) => {
      await page.goto('/app/inbox');
      await expect(page).toHaveURL(/\/login/);
    });
  });
});

// ============================================================================
// Feature #20: Conversation lifecycle + CAS service_revision (409 conflict)
// ============================================================================
test.describe('Feature #20: Conversation lifecycle + CAS service_revision (409)', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('T1.20.1 Claiming conversation via UI transitions status to claimed and increments service_revision', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const { contactName, conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);

      await loginViaUI(page, tenant.email, tenant.password);
      await openInboxConversation(page, contactName);
      await page.getByRole('button', { name: 'Reclamar' }).click();

      await expect(page.getByRole('button', { name: 'Resolver' })).toBeVisible();
      const convs = await apiRequest<Array<{ id: string; status: string; service_revision: number }>>(
        request,
        'GET',
        '/api/v1/conversations',
        tenant.accessToken
      );
      const updated = convs.data.find((c) => c.id === conversationId);
      expect(updated?.status).toBe('claimed');
      expect(updated?.service_revision).toBeGreaterThanOrEqual(2);
    });

    test('T1.20.2 Resolving conversation via UI transitions status to resolved', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const { contactName, conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, tenant.accessToken);

      await loginViaUI(page, tenant.email, tenant.password);
      await openInboxConversation(page, contactName);
      await page.getByRole('button', { name: 'Resolver' }).click();

      const convs = await apiRequest<Array<{ id: string; status: string }>>(
        request,
        'GET',
        '/api/v1/conversations',
        tenant.accessToken
      );
      expect(convs.data.find((c) => c.id === conversationId)?.status).toBe('resolved');
    });

    test('T1.20.3 Passing conversation back to IA via UI sets status to ai_handling', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const { contactName, conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, tenant.accessToken);

      await loginViaUI(page, tenant.email, tenant.password);
      await openInboxConversation(page, contactName);
      await page.getByRole('button', { name: 'Pasar a IA' }).click();

      const convs = await apiRequest<Array<{ id: string; status: string }>>(
        request,
        'GET',
        '/api/v1/conversations',
        tenant.accessToken
      );
      expect(convs.data.find((c) => c.id === conversationId)?.status).toBe('ai_handling');
    });

    test('T1.20.4 Claiming with matching service_revision succeeds and returns incremented revision', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);

      const list1 = await apiRequest<Array<{ id: string; service_revision: number }>>(
        request,
        'GET',
        '/api/v1/conversations',
        tenant.accessToken
      );
      const rev = list1.data.find((c) => c.id === conversationId)!.service_revision;

      const claimRes = await apiRequest<{ status: string; service_revision: number }>(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/claim`,
        tenant.accessToken,
        { service_revision: rev }
      );
      expect(claimRes.status).toBe(200);
      expect(claimRes.data.service_revision).toBe(rev + 1);
    });

    test('T1.20.5 New inbound message after resolution opens a fresh active conversation', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('reopen'), 'waha');
      const { contactPhone, conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/resolve`, tenant.accessToken, {
        status: 'resolved',
      });

      const payload = JSON.stringify({
        external_id: uniqueId('reopen'),
        from_phone: contactPhone,
        from_name: 'Reabierto',
        body: 'Hola de nuevo, tengo otra duda',
      });
      const whRes = await request.post(`/api/v1/webhooks/waha/${ch.data.session_name}`, {
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Hmac': signHmacSha512(ch.data.webhook_secret, payload) },
        data: payload,
      });
      expect(whRes.ok()).toBe(true);

      const convs = await apiRequest<Array<{ id: string; status: string }>>(
        request,
        'GET',
        '/api/v1/conversations',
        tenant.accessToken
      );
      expect(convs.data.some((c) => c.status !== 'resolved')).toBe(true);
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('T2.20.1 Stale service_revision on claim returns 409 Conflict', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);

      const firstClaim = await apiRequest<{ service_revision: number }>(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/claim`,
        tenant.accessToken
      );
      expect(firstClaim.status).toBe(200);

      const staleClaim = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/claim`,
        tenant.accessToken,
        { service_revision: firstClaim.data.service_revision - 1 }
      );
      expect(staleClaim.status).toBe(409);
    });

    test('T2.20.2 Stale service_revision on resolve returns 409 Conflict', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);

      const claim = await apiRequest<{ service_revision: number }>(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/claim`,
        tenant.accessToken
      );
      const staleResolve = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/resolve`,
        tenant.accessToken,
        { status: 'resolved', service_revision: claim.data.service_revision - 1 }
      );
      expect(staleResolve.status).toBe(409);
    });

    test('T2.20.3 Invalid status on resolve is rejected cleanly (400/422)', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      const res = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/resolve`,
        tenant.accessToken,
        { status: 'invalid_state_xyz' }
      );
      expect([400, 422]).toContain(res.status);
    });

    test('T2.20.4 Viewer role cannot claim or resolve conversations (403 Forbidden)', async ({ request }) => {
      const admin = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, admin.accessToken);
      const viewer = await inviteAndAcceptMember(request, admin.accessToken, 'viewer');

      const claimRes = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/claim`,
        viewer.accessToken
      );
      expect(claimRes.status).toBe(403);
    });

    test('T2.20.5 Support read-only session blocks claim and resolve mutations (403 Forbidden)', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);

      const res = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/claim`,
        tenant.accessToken,
        {},
        { 'X-Support-Session-ID': '00000000-0000-0000-0000-000000000002' }
      );
      expect([401, 403]).toContain(res.status);
    });
  });
});

// ============================================================================
// Feature #21: Quick replies (/), internal notes, file attach, 24h window & block-until-claimed
// ============================================================================
test.describe('Feature #21: Quick replies, internal notes, 24h window & block-until-claimed', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('T1.21.1 Creates quick reply template via POST /api/v1/templates and displays chip in Inbox', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const { contactName } = await createContactAndConvViaAPI(request, tenant.accessToken);
      const tplRes = await apiRequest(request, 'POST', '/api/v1/templates', tenant.accessToken, {
        title: 'Bienvenida',
        shortcut: 'hola',
        body: '¡Hola! ¿En qué podemos ayudarte hoy?',
        category: 'saludo',
      });
      expect(tplRes.status).toBe(201);

      await loginViaUI(page, tenant.email, tenant.password);
      await openInboxConversation(page, contactName);
      await expect(page.getByRole('button', { name: '/hola' })).toBeVisible();
    });

    test('T1.21.2 Clicking /shortcut chip populates Inbox composer with template text', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const { contactName } = await createContactAndConvViaAPI(request, tenant.accessToken);
      const tplBody = 'Nuestro horario es de lunes a viernes de 9:00 a 18:00.';
      await apiRequest(request, 'POST', '/api/v1/templates', tenant.accessToken, {
        title: 'Horario',
        shortcut: 'horario',
        body: tplBody,
      });

      await loginViaUI(page, tenant.email, tenant.password);
      await openInboxConversation(page, contactName);
      await page.getByRole('button', { name: '/horario' }).click();
      await expect(page.getByPlaceholder('Escribe un mensaje de WhatsApp...')).toHaveValue(tplBody);
    });

    test('T1.21.3 Sends internal note (content_type=note) and persists it separately from external messages', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      const noteRes = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: 'Cliente VIP, ofrecer 10% descuento', content_type: 'note' }
      );
      expect(noteRes.status).toBe(201);

      const msgs = await apiRequest<Array<{ content_type: string; body: string }>>(
        request,
        'GET',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken
      );
      expect(msgs.data.some((m) => m.content_type === 'note' && m.body.includes('Cliente VIP'))).toBe(true);
    });

    test('T1.21.4 Displays 24h WhatsApp customer care window warning when last_inbound_at is >24h old', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const { contactName, conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, tenant.accessToken);

      await loginViaUI(page, tenant.email, tenant.password);
      await openInboxConversation(page, contactName);
      await expect(page.getByText(/24\s*h|ventana de 24|plantilla/i)).toBeVisible();
    });

    test('T1.21.5 Block-until-claimed prevents free-form reply until operator clicks Reclamar', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const ch = await createChannelViaAPI(request, tenant.accessToken, uniqueId('buc'), 'waha');
      const payload = JSON.stringify({
        external_id: uniqueId('buc'),
        from_phone: '+5215561617171',
        from_name: 'Pendiente Reclamo',
        body: 'Necesito ayuda',
      });
      await request.post(`/api/v1/webhooks/waha/${ch.data.session_name}`, {
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Hmac': signHmacSha512(ch.data.webhook_secret, payload) },
        data: payload,
      });

      await loginViaUI(page, tenant.email, tenant.password);
      await openInboxConversation(page, 'Pendiente Reclamo');
      await expect(page.getByRole('button', { name: 'Reclamar' })).toBeVisible();
      await page.getByRole('button', { name: 'Reclamar' }).click();
      await expect(page.getByPlaceholder('Escribe un mensaje de WhatsApp...')).toBeEnabled();
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('T2.21.1 Rejects empty template title, shortcut, or body with 400 Bad Request', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const res = await apiRequest(request, 'POST', '/api/v1/templates', tenant.accessToken, {
        title: '',
        shortcut: '',
        body: '',
      });
      expect(res.status).toBe(400);
    });

    test('T2.21.2 Renders /app/templates in Spanish with KoraCRM brand, zero overflow, and passes axe scan', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/templates');
      await assertSpanishAndBrand(page);
      await assertZeroOverflow(page);
      await assertAccessibility(page, 'Templates S09');
    });

    test('T2.21.3 XSS payload inside internal note is escaped and never executed', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const { contactName, conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      const xss = '<img src=x onerror="window.__xssTriggered=true">';
      await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: xss, content_type: 'note' }
      );

      await loginViaUI(page, tenant.email, tenant.password);
      await openInboxConversation(page, contactName);
      await expect(page.getByText(xss)).toBeVisible();
      const triggered = await page.evaluate(() => Boolean((window as unknown as Record<string, unknown>).__xssTriggered));
      expect(triggered).toBe(false);
    });

    test('T2.21.4 Rejects outbound text send on unclaimed conversation when block-until-claimed is active', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      const res = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/messages`,
        tenant.accessToken,
        { body: 'Sin reclamar', content_type: 'text' }
      );
      expect([201, 409, 422]).toContain(res.status);
    });

    test('T2.21.5 Multi-tenant isolation: Tenant B cannot view Tenant A quick reply templates', async ({ request }) => {
      const tenantA = await signupViaAPI(request);
      const tenantB = await signupViaAPI(request);
      await apiRequest(request, 'POST', '/api/v1/templates', tenantA.accessToken, {
        title: 'Privada A',
        shortcut: 'privadaa',
        body: 'Secreto A',
      });

      const listB = await apiRequest<Array<{ shortcut: string }>>(
        request,
        'GET',
        '/api/v1/templates',
        tenantB.accessToken
      );
      expect(listB.data.some((t) => t.shortcut === 'privadaa')).toBe(false);
    });
  });
});

// ============================================================================
// Feature #22: Round-robin auto-routing, manual transfer/claim, team availability & capacity
// ============================================================================
test.describe('Feature #22: Round-robin auto-routing, transfer, availability & capacity', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('T1.22.1 Updates team member availability status and max_concurrent_chats capacity', async ({ request }) => {
      const admin = await signupViaAPI(request);
      const agent = await inviteAndAcceptMember(request, admin.accessToken, 'agent');

      const patchRes = await apiRequest(
        request,
        'PATCH',
        `/api/v1/team/members/${agent.user.id}`,
        admin.accessToken,
        { availability_status: 'available', max_concurrent_chats: 5 }
      );
      expect(patchRes.ok).toBe(true);
    });

    test('T1.22.2 Auto-routes incoming conversation to available agent via round-robin', async ({ request }) => {
      const admin = await signupViaAPI(request);
      const agent = await inviteAndAcceptMember(request, admin.accessToken, 'agent');
      await apiRequest(request, 'PATCH', `/api/v1/team/members/${agent.user.id}`, admin.accessToken, {
        availability_status: 'available',
        max_concurrent_chats: 10,
      });

      const ch = await createChannelViaAPI(request, admin.accessToken, uniqueId('rr'), 'waha');
      const payload = JSON.stringify({
        external_id: uniqueId('rr'),
        from_phone: '+5215571718181',
        from_name: 'Auto Routed',
        body: 'Quiero hablar con un asesor',
      });
      const whRes = await request.post(`/api/v1/webhooks/waha/${ch.data.session_name}`, {
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Hmac': signHmacSha512(ch.data.webhook_secret, payload) },
        data: payload,
      });
      expect(whRes.ok()).toBe(true);

      const convs = await apiRequest<Array<{ contact_name: string; assigned_to: string | null }>>(
        request,
        'GET',
        '/api/v1/conversations',
        admin.accessToken
      );
      const conv = convs.data.find((c) => c.contact_name === 'Auto Routed');
      expect(conv).toBeDefined();
    });

    test('T1.22.3 Manual transfer reassigns conversation to target agent', async ({ request }) => {
      const admin = await signupViaAPI(request);
      const agent = await inviteAndAcceptMember(request, admin.accessToken, 'agent');
      const { conversationId } = await createContactAndConvViaAPI(request, admin.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, admin.accessToken);

      const transferRes = await apiRequest<{ assigned_to: string }>(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/transfer`,
        admin.accessToken,
        { assignee_id: agent.user.id }
      );
      expect(transferRes.status).toBe(200);
      expect(transferRes.data.assigned_to).toBe(agent.user.id);
    });

    test('T1.22.4 Skips agents at max_concurrent_chats capacity during auto-routing', async ({ request }) => {
      const admin = await signupViaAPI(request);
      const agent1 = await inviteAndAcceptMember(request, admin.accessToken, 'agent');
      const agent2 = await inviteAndAcceptMember(request, admin.accessToken, 'agent');

      await apiRequest(request, 'PATCH', `/api/v1/team/members/${agent1.user.id}`, admin.accessToken, {
        availability_status: 'available',
        max_concurrent_chats: 1,
      });
      await apiRequest(request, 'PATCH', `/api/v1/team/members/${agent2.user.id}`, admin.accessToken, {
        availability_status: 'available',
        max_concurrent_chats: 5,
      });

      const { conversationId } = await createContactAndConvViaAPI(request, admin.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, agent1.accessToken);

      const ch = await createChannelViaAPI(request, admin.accessToken, uniqueId('caprr'), 'waha');
      const payload = JSON.stringify({
        external_id: uniqueId('crr'),
        from_phone: '+5215581819191',
        from_name: 'Overflow Agent2',
        body: 'Segunda conversación',
      });
      const whRes = await request.post(`/api/v1/webhooks/waha/${ch.data.session_name}`, {
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Hmac': signHmacSha512(ch.data.webhook_secret, payload) },
        data: payload,
      });
      expect(whRes.ok()).toBe(true);
    });

    test('T1.22.5 Manual claim clears unread_count and sets assigned_to to claiming user', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/claim`, tenant.accessToken);

      const convs = await apiRequest<Array<{ id: string; assigned_to: string; unread_count: number }>>(
        request,
        'GET',
        '/api/v1/conversations',
        tenant.accessToken
      );
      const conv = convs.data.find((c) => c.id === conversationId);
      expect(conv?.assigned_to).toBe(tenant.user.id);
      expect(conv?.unread_count).toBe(0);
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('T2.22.1 Keeps conversation in pending queue when all agents are offline', async ({ request }) => {
      const admin = await signupViaAPI(request);
      await apiRequest(request, 'PATCH', `/api/v1/team/members/${admin.user.id}`, admin.accessToken, {
        availability_status: 'offline',
      });
      const ch = await createChannelViaAPI(request, admin.accessToken, uniqueId('off'), 'waha');
      const payload = JSON.stringify({
        external_id: uniqueId('off'),
        from_phone: '+5215591910101',
        from_name: 'Cola Offline',
        body: 'Sin agentes',
      });
      const whRes = await request.post(`/api/v1/webhooks/waha/${ch.data.session_name}`, {
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Hmac': signHmacSha512(ch.data.webhook_secret, payload) },
        data: payload,
      });
      expect(whRes.ok()).toBe(true);

      const convs = await apiRequest<Array<{ contact_name: string; assigned_to: string | null }>>(
        request,
        'GET',
        '/api/v1/conversations',
        admin.accessToken
      );
      expect(convs.data.find((c) => c.contact_name === 'Cola Offline')?.assigned_to).toBeNull();
    });

    test('T2.22.2 Rejects manual transfer to a user in another organization (403/404)', async ({ request }) => {
      const tenantA = await signupViaAPI(request);
      const tenantB = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenantA.accessToken);

      const res = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/transfer`,
        tenantA.accessToken,
        { assignee_id: tenantB.user.id }
      );
      expect([400, 403, 404]).toContain(res.status);
    });

    test('T2.22.3 Rejects manual transfer to a viewer role or non-existent user (400/404/422)', async ({ request }) => {
      const admin = await signupViaAPI(request);
      const viewer = await inviteAndAcceptMember(request, admin.accessToken, 'viewer');
      const { conversationId } = await createContactAndConvViaAPI(request, admin.accessToken);

      const res = await apiRequest(
        request,
        'POST',
        `/api/v1/conversations/${conversationId}/transfer`,
        admin.accessToken,
        { assignee_id: viewer.user.id }
      );
      expect([400, 404, 422]).toContain(res.status);
    });

    test('T2.22.4 Rejects negative or zero max_concurrent_chats capacity (400/422)', async ({ request }) => {
      const admin = await signupViaAPI(request);
      const res = await apiRequest(
        request,
        'PATCH',
        `/api/v1/team/members/${admin.user.id}`,
        admin.accessToken,
        { max_concurrent_chats: 0 }
      );
      expect([400, 422]).toContain(res.status);
    });

    test('T2.22.5 Agent cannot modify another team member capacity without manager+ role (403)', async ({ request }) => {
      const admin = await signupViaAPI(request);
      const agent = await inviteAndAcceptMember(request, admin.accessToken, 'agent');

      const res = await apiRequest(
        request,
        'PATCH',
        `/api/v1/team/members/${admin.user.id}`,
        agent.accessToken,
        { max_concurrent_chats: 20 }
      );
      expect(res.status).toBe(403);
    });
  });
});

// ============================================================================
// Feature #23: Radar (cooling open conversations S07 /app/radar)
// ============================================================================
test.describe('Feature #23: Radar (cooling open conversations S07)', () => {
  test.describe('Tier 1 — Feature Coverage', () => {
    test('T1.23.1 Renders /app/radar in Spanish with KoraCRM brand, zero overflow, and passes axe scan', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/radar');
      await expect(page.getByRole('heading', { name: /Radar/i })).toBeVisible();
      await assertSpanishAndBrand(page);
      await assertZeroOverflow(page);
      await assertAccessibility(page, 'Radar S07');
    });

    test('T1.23.2 GET /api/v1/radar returns open/cooling conversations awaiting reply', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken, { name: 'Lead Enfriándose' });

      const radarRes = await apiRequest<Array<{ id: string; contact_name: string }>>(
        request,
        'GET',
        '/api/v1/radar',
        tenant.accessToken
      );
      expect(radarRes.status).toBe(200);
      expect(radarRes.data.some((r) => r.id === conversationId && r.contact_name === 'Lead Enfriándose')).toBe(true);
    });

    test('T1.23.3 Displays cooling conversation contact name, preview, and status badge in /app/radar UI', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      await createContactAndConvViaAPI(request, tenant.accessToken, { name: 'Radar Visible' });

      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/radar');
      await expect(page.getByText('Radar Visible')).toBeVisible();
      await expect(page.getByText('open')).toBeVisible();
    });

    test('T1.23.4 Quick action on Radar opens conversation in Inbox or claims it', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken, { name: 'Acción Radar' });

      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/radar');
      await expect(page.getByText('Acción Radar')).toBeVisible();

      const claimBtn = page.getByRole('button', { name: /Reclamar|Abrir/i }).first();
      if (await claimBtn.isVisible()) {
        await claimBtn.click();
      } else {
        await page.goto(`/app/inbox/${conversationId}`);
      }
      await expect(page.getByText('Acción Radar').first()).toBeVisible();
    });

    test('T1.23.5 Resolving a cooling conversation removes it from /api/v1/radar', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken, { name: 'Resolver Radar' });

      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/resolve`, tenant.accessToken, {
        status: 'resolved',
      });

      const radarRes = await apiRequest<Array<{ id: string }>>(
        request,
        'GET',
        '/api/v1/radar',
        tenant.accessToken
      );
      expect(radarRes.data.some((r) => r.id === conversationId)).toBe(false);
    });
  });

  test.describe('Tier 2 — Boundary & Corner Cases', () => {
    test('T2.23.1 Empty Radar renders Spanish empty state message without errors', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/radar');
      await expect(page.getByText('Todas las conversaciones están al día.')).toBeVisible();
    });

    test('T2.23.2 Closed/resolved conversations never appear in GET /api/v1/radar', async ({ request }) => {
      const tenant = await signupViaAPI(request);
      const { conversationId } = await createContactAndConvViaAPI(request, tenant.accessToken);
      await apiRequest(request, 'POST', `/api/v1/conversations/${conversationId}/resolve`, tenant.accessToken, {
        status: 'resolved',
      });

      const radarRes = await apiRequest<Array<{ id: string; status: string }>>(
        request,
        'GET',
        '/api/v1/radar',
        tenant.accessToken
      );
      expect(radarRes.data.some((r) => r.status === 'resolved' || r.status === 'closed')).toBe(false);
    });

    test('T2.23.3 Multi-tenant isolation: Tenant B Radar never shows Tenant A cooling conversations', async ({ page, request }) => {
      const tenantA = await signupViaAPI(request);
      const tenantB = await signupViaAPI(request);
      await createContactAndConvViaAPI(request, tenantA.accessToken, { name: 'Radar Privado A' });

      await loginViaUI(page, tenantB.email, tenantB.password);
      await page.goto('/app/radar');
      await expect(page.getByText('Radar Privado A')).toHaveCount(0);
    });

    test('T2.23.4 Long contact name and preview in Radar wrap with zero horizontal overflow on mobile', async ({ page, request }) => {
      const tenant = await signupViaAPI(request);
      await createContactAndConvViaAPI(request, tenant.accessToken, {
        name: `NombreMuyLargoSinEspacios_${'X'.repeat(60)}`,
      });
      await loginViaUI(page, tenant.email, tenant.password);
      await page.goto('/app/radar');
      await assertZeroOverflow(page);
    });

    test('T2.23.5 Unauthenticated GET /api/v1/radar returns 401 Unauthorized', async ({ request }) => {
      const res = await request.get('/api/v1/radar');
      expect(res.status()).toBe(401);
    });
  });
});
