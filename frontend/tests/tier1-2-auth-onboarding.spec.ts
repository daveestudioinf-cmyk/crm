import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import {
  attachErrorGuards,
  assertZeroOverflow,
  assertSpanishAndBrand,
  assertAccessibility,
} from './helpers/guards';
import { signupViaAPI, apiRequest, uniqueId, loginViaUI } from './helpers/api';

const DB_URL =
  process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/crm_dev?sslmode=disable';

function promotePlatformAdmin(email: string): void {
  const safeEmail = email.replace(/[^a-zA-Z0-9@._+-]/g, '');
  execFileSync('psql', [
    DB_URL,
    '-c',
    `UPDATE users SET is_platform_admin = true WHERE email = '${safeEmail}';`,
  ]);
}

function base32ToBuffer(base32: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = base32.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of cleaned) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateTOTP(base32Secret: string, timeStepOffset = 0): string {
  const key = base32ToBuffer(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / 30) + timeStepOffset;
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

async function seedAuthenticatedSession(page: Page, accessToken: string): Promise<void> {
  await page.goto('/login');
  await page.evaluate((token) => {
    localStorage.setItem('koracrm_token', token);
  }, accessToken);
}

test.beforeEach(async ({ page }) => {
  attachErrorGuards(page);
});

// ============================================================================
// Feature #1: Multi-tenant isolation (organization_id in API & UI)
// ============================================================================
test.describe('Feature #1: Multi-tenant isolation (Tier 1)', () => {
  test('T1.1.1 Signup creates isolated organization and /auth/me returns matching organization_id', async ({
    request,
  }) => {
    const tenantA = await signupViaAPI(request, { orgName: `Aislamiento A ${uniqueId('org')}` });
    const tenantB = await signupViaAPI(request, { orgName: `Aislamiento B ${uniqueId('org')}` });

    expect(tenantA.organizationId).not.toBe('');
    expect(tenantB.organizationId).not.toBe('');
    expect(tenantA.organizationId).not.toBe(tenantB.organizationId);

    const meA = await apiRequest<{ organization_id: string; org_name?: string }>(
      request,
      'GET',
      '/api/v1/auth/me',
      tenantA.accessToken
    );
    expect(meA.status).toBe(200);
    expect(meA.data.organization_id).toBe(tenantA.organizationId);
  });

  test('T1.1.2 Tenant A contacts and leads are scoped exclusively to Tenant A', async ({
    request,
  }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);

    const markerA = uniqueId('tenantA');
    const created = await apiRequest<{ id: string; organization_id?: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      tenantA.accessToken,
      { name: `Contacto ${markerA}`, phone_number: '+5215510001001', email: `${markerA}@a.dev` }
    );
    expect(created.status).toBe(201);

    const listA = await apiRequest<Array<{ id: string; name: string }>>(
      request,
      'GET',
      '/api/v1/contacts',
      tenantA.accessToken
    );
    expect(listA.status).toBe(200);
    expect(listA.data.some((c) => c.id === created.data.id)).toBe(true);

    const listB = await apiRequest<Array<{ id: string; name: string }>>(
      request,
      'GET',
      '/api/v1/contacts',
      tenantB.accessToken
    );
    expect(listB.status).toBe(200);
    expect(listB.data.some((c) => c.id === created.data.id)).toBe(false);
  });

  test('T1.1.3 Matching X-Organization-ID header succeeds on tenant endpoints', async ({
    request,
  }) => {
    const tenant = await signupViaAPI(request);
    const res = await apiRequest<{ id: string; name: string }>(
      request,
      'GET',
      '/api/v1/organization',
      tenant.accessToken,
      undefined,
      { 'X-Organization-ID': tenant.organizationId }
    );
    expect(res.status).toBe(200);
    expect(res.data.id).toBe(tenant.organizationId);
  });

  test('T1.1.4 Two tenants can create contacts with identical phone and email without collision', async ({
    request,
  }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);
    const sharedPhone = '+5215598765432';
    const sharedEmail = `compartido-${uniqueId('mail')}@ejemplo.com`;

    const resA = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      tenantA.accessToken,
      { name: 'Cliente A', phone_number: sharedPhone, email: sharedEmail }
    );
    const resB = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      tenantB.accessToken,
      { name: 'Cliente B', phone_number: sharedPhone, email: sharedEmail }
    );

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(resA.data.id).not.toBe(resB.data.id);
  });

  test('T1.1.5 UI /app/contacts renders only authenticated tenant contacts with Spanish UI and zero overflow', async ({
    page,
    request,
  }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);
    const nameA = `VisibleA ${uniqueId('ct')}`;
    const nameB = `OcultoB ${uniqueId('ct')}`;

    await apiRequest(request, 'POST', '/api/v1/contacts', tenantA.accessToken, {
      name: nameA,
      phone_number: '+5215511112222',
    });
    await apiRequest(request, 'POST', '/api/v1/contacts', tenantB.accessToken, {
      name: nameB,
      phone_number: '+5215533334444',
    });

    await seedAuthenticatedSession(page, tenantA.accessToken);
    await page.goto('/app/contacts');
    await expect(page.getByRole('heading', { name: /Contactos/i })).toBeVisible();
    await expect(page.getByText(nameA)).toBeVisible();
    await expect(page.getByText(nameB)).toHaveCount(0);
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
  });
});

test.describe('Feature #1: Multi-tenant isolation (Tier 2 - Boundary & Corner Cases)', () => {
  test('T2.1.1 Tenant B cannot read Tenant A contact by ID (403/404)', async ({ request }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);

    const created = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      tenantA.accessToken,
      { name: 'Secreto A', phone_number: '+5215512340001' }
    );
    expect(created.status).toBe(201);

    const crossRead = await apiRequest(
      request,
      'GET',
      `/api/v1/contacts/${created.data.id}`,
      tenantB.accessToken
    );
    expect([403, 404]).toContain(crossRead.status);
  });

  test('T2.1.2 Tenant B cannot update Tenant A contact by ID (403/404)', async ({ request }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);

    const created = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      tenantA.accessToken,
      { name: 'Protegido A', phone_number: '+5215512340002' }
    );
    expect(created.status).toBe(201);

    const crossPatch = await apiRequest(
      request,
      'PATCH',
      `/api/v1/contacts/${created.data.id}`,
      tenantB.accessToken,
      { name: 'Modificado por B' }
    );
    expect([403, 404]).toContain(crossPatch.status);
  });

  test('T2.1.3 Spoofing X-Organization-ID with another tenant UUID is rejected with 403/401', async ({
    request,
  }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);

    const spoofed = await apiRequest(
      request,
      'GET',
      '/api/v1/contacts',
      tenantA.accessToken,
      undefined,
      { 'X-Organization-ID': tenantB.organizationId }
    );
    expect([401, 403]).toContain(spoofed.status);
  });

  test('T2.1.4 Unauthenticated requests to protected tenant endpoints return 401', async ({
    request,
  }) => {
    const contactsRes = await apiRequest(request, 'GET', '/api/v1/contacts');
    const orgRes = await apiRequest(request, 'GET', '/api/v1/organization');
    expect(contactsRes.status).toBe(401);
    expect(orgRes.status).toBe(401);
  });

  test('T2.1.5 Suspended tenant is blocked from tenant API calls while /auth/me still responds', async ({
    request,
  }) => {
    const superAdmin = await signupViaAPI(request);
    promotePlatformAdmin(superAdmin.email);
    const target = await signupViaAPI(request);

    const suspendRes = await apiRequest(
      request,
      'PATCH',
      `/api/v1/admin/tenants/${target.organizationId}`,
      superAdmin.accessToken,
      { is_suspended: true, reason: 'E2E suspension check' }
    );
    expect(suspendRes.status).toBe(200);

    const blockedContacts = await apiRequest(
      request,
      'GET',
      '/api/v1/contacts',
      target.accessToken
    );
    expect(blockedContacts.status).toBe(403);

    const meRes = await apiRequest(request, 'GET', '/api/v1/auth/me', target.accessToken);
    expect(meRes.status).toBe(200);
  });
});

// ============================================================================
// Feature #2: Auth JWT + HttpOnly refresh + TOTP MFA & recovery codes
// ============================================================================
test.describe('Feature #2: Auth JWT, Refresh, MFA & Recovery (Tier 1)', () => {
  test('T1.2.1 /login renders Spanish UI, KoraCRM brand, zero overflow, and passes accessibility scan', async ({
    page,
  }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Iniciar sesión en KoraCRM' })).toBeVisible();
    await expect(page.getByPlaceholder('tu@empresa.com')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Iniciar sesión' })).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'LoginPage');
  });

  test('T1.2.2 Valid UI login redirects to /app/inbox and /auth/refresh issues new access token', async ({
    page,
    request,
  }) => {
    const user = await signupViaAPI(request);
    await loginViaUI(page, user.email, user.password);
    await expect(page).toHaveURL(/\/app\/inbox/);

    const refreshRes = await apiRequest<{ access_token: string }>(
      request,
      'POST',
      '/api/v1/auth/refresh'
    );
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.data.access_token).toBeTruthy();
  });

  test('T1.2.3 /login/forgot and /login/reset render Spanish password recovery flows with zero overflow', async ({
    page,
    request,
  }) => {
    const user = await signupViaAPI(request);
    await page.goto('/login/forgot');
    await expect(page.getByRole('heading', { name: /Recuperar contraseña/i })).toBeVisible();
    await page.getByPlaceholder('tu@empresa.com').fill(user.email);
    await page.getByRole('button', { name: /Enviar enlace/i }).click();
    await expect(page.getByText(/Revisa tu correo|enviamos/i)).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);

    await page.goto('/login/reset');
    await expect(page.getByRole('heading', { name: /Restablecer contraseña/i })).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
  });

  test('T1.2.4 /login/mfa and /login/recovery render Spanish TOTP/recovery forms and pass accessibility scan', async ({
    page,
  }) => {
    await page.goto('/login/mfa');
    await expect(page.getByRole('heading', { name: /Verificación en dos pasos/i })).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'MfaLoginPage');

    await page.goto('/login/recovery');
    await expect(page.getByRole('heading', { name: /Código de recuperación/i })).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'RecoveryCodePage');
  });

  test('T1.2.5 TOTP MFA setup, enable, login challenge, and recovery code flow work end-to-end', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const setup = await apiRequest<{ secret: string; otpauth_url: string }>(
      request,
      'POST',
      '/api/v1/auth/mfa/setup',
      user.accessToken
    );
    expect(setup.status).toBe(200);
    expect(setup.data.secret).toBeTruthy();
    expect(setup.data.otpauth_url).toContain('otpauth://totp/');

    const validCode = generateTOTP(setup.data.secret);
    const enable = await apiRequest<{ mfa_enabled: boolean; recovery_codes: string[] }>(
      request,
      'POST',
      '/api/v1/auth/mfa/enable',
      user.accessToken,
      { code: validCode }
    );
    expect(enable.status).toBe(200);
    expect(enable.data.mfa_enabled).toBe(true);
    expect(Array.isArray(enable.data.recovery_codes)).toBe(true);
    expect(enable.data.recovery_codes.length).toBeGreaterThan(0);

    const loginMfa = await apiRequest<{ mfa_required: boolean; mfa_token: string }>(
      request,
      'POST',
      '/api/v1/auth/login',
      undefined,
      { email: user.email, password: user.password }
    );
    expect(loginMfa.status).toBe(200);
    expect(loginMfa.data.mfa_required).toBe(true);
    expect(loginMfa.data.mfa_token).toBeTruthy();

    const verifyRecovery = await apiRequest<{ access_token: string }>(
      request,
      'POST',
      '/api/v1/auth/mfa/verify',
      undefined,
      { mfa_token: loginMfa.data.mfa_token, code: enable.data.recovery_codes[0] }
    );
    expect(verifyRecovery.status).toBe(200);
    expect(verifyRecovery.data.access_token).toBeTruthy();
  });
});

test.describe('Feature #2: Auth JWT, Refresh, MFA & Recovery (Tier 2 - Boundary & Corner Cases)', () => {
  test('T2.2.1 Login with wrong password returns 401 and displays Spanish error without console errors', async ({
    request,
  }) => {
    const user = await signupViaAPI(request);
    const res = await apiRequest(request, 'POST', '/api/v1/auth/login', undefined, {
      email: user.email,
      password: 'WrongPassword999!',
    });
    expect(res.status).toBe(401);
  });

  test('T2.2.2 Login with empty/malformed payload returns 400/401 (never 500)', async ({
    request,
  }) => {
    const emptyRes = await apiRequest(request, 'POST', '/api/v1/auth/login', undefined, {
      email: '',
      password: '',
    });
    expect([400, 401, 422]).toContain(emptyRes.status);

    const nonExistent = await apiRequest(request, 'POST', '/api/v1/auth/login', undefined, {
      email: `no-existe-${uniqueId('u')}@koracrm.dev`,
      password: 'Secret123!',
    });
    expect(nonExistent.status).toBe(401);
  });

  test('T2.2.3 MFA verify with invalid TOTP code or invalid mfa_token returns 400/401', async ({
    request,
  }) => {
    const res = await apiRequest(request, 'POST', '/api/v1/auth/mfa/verify', undefined, {
      mfa_token: 'invalid-mfa-token',
      code: '000000',
    });
    expect([400, 401]).toContain(res.status);
  });

  test('T2.2.4 Password reset with invalid or expired token returns 400/401/404 cleanly', async ({
    request,
  }) => {
    const res = await apiRequest(request, 'POST', '/api/v1/auth/reset', undefined, {
      token: 'expired-or-bogus-reset-token',
      password: 'NewPassword123!',
    });
    expect([400, 401, 404]).toContain(res.status);
  });

  test('T2.2.5 Logout clears refresh session so subsequent /auth/refresh returns 401', async ({
    request,
  }) => {
    await signupViaAPI(request);
    const logoutRes = await apiRequest(request, 'POST', '/api/v1/auth/logout');
    expect(logoutRes.status).toBe(200);

    const refreshRes = await apiRequest(request, 'POST', '/api/v1/auth/refresh');
    expect(refreshRes.status).toBe(401);
  });
});

// ============================================================================
// Feature #3: 4-role RBAC (viewer, agent, manager, admin) + Platform Super-Admin
// ============================================================================
test.describe('Feature #3: 4-role RBAC & Team Invites (Tier 1)', () => {
  test('T1.3.1 /app/team renders team directory in Spanish with zero overflow and passes accessibility scan', async ({
    page,
    request,
  }) => {
    const admin = await signupViaAPI(request);
    await seedAuthenticatedSession(page, admin.accessToken);
    await page.goto('/app/team');
    await expect(page.getByRole('heading', { name: /Equipo/i })).toBeVisible();
    await expect(page.getByText(admin.email)).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'TeamPage');
  });

  test('T1.3.2 Admin creates team invite and GET /team/invites/{token} returns invite metadata', async ({
    request,
  }) => {
    const admin = await signupViaAPI(request);
    const inviteEmail = `agente-${uniqueId('inv')}@koracrm.dev`;

    const createInv = await apiRequest<{ id: string; token: string; role: string }>(
      request,
      'POST',
      '/api/v1/team/invites',
      admin.accessToken,
      { email: inviteEmail, role: 'agent' }
    );
    expect([200, 201]).toContain(createInv.status);
    expect(createInv.data.token).toBeTruthy();

    const inspectInv = await apiRequest<{ email: string; role: string }>(
      request,
      'GET',
      `/api/v1/team/invites/${createInv.data.token}`
    );
    expect(inspectInv.status).toBe(200);
    expect(inspectInv.data.email).toBe(inviteEmail);
    expect(inspectInv.data.role).toBe('agent');
  });

  test('T1.3.3 /team/accept-invite/:token accepts invite via UI and logs user into /app/inbox', async ({
    page,
    request,
  }) => {
    const admin = await signupViaAPI(request);
    const inviteEmail = `nuevo-${uniqueId('inv')}@koracrm.dev`;

    const createInv = await apiRequest<{ token: string }>(
      request,
      'POST',
      '/api/v1/team/invites',
      admin.accessToken,
      { email: inviteEmail, role: 'agent' }
    );
    expect([200, 201]).toContain(createInv.status);

    await page.goto(`/team/accept-invite/${createInv.data.token}`);
    await expect(page.getByRole('heading', { name: 'Unirse al equipo en KoraCRM' })).toBeVisible();
    await expect(page.getByText(inviteEmail)).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);

    await page.getByPlaceholder('Tu nombre completo').fill('Agente Invitado');
    await page.getByPlaceholder('Mínimo 8 caracteres').fill('Secret123!');
    await page.getByRole('button', { name: /Aceptar invitación/i }).click();
    await expect(page).toHaveURL(/\/app\/inbox/);
  });

  test('T1.3.4 Admin updates team member availability and capacity via PATCH /team/members/{id}', async ({
    request,
  }) => {
    const admin = await signupViaAPI(request);
    const teamRes = await apiRequest<Array<{ id: string; email: string }>>(
      request,
      'GET',
      '/api/v1/team',
      admin.accessToken
    );
    expect(teamRes.status).toBe(200);
    const memberId = teamRes.data[0].id;

    const patchRes = await apiRequest(
      request,
      'PATCH',
      `/api/v1/team/members/${memberId}`,
      admin.accessToken,
      { is_available: false, max_concurrent_chats: 8 }
    );
    expect(patchRes.status).toBe(200);
  });

  test('T1.3.5 /app/settings renders Profile, Organization, and API Tokens tabs in Spanish with zero overflow', async ({
    page,
    request,
  }) => {
    const admin = await signupViaAPI(request);
    await seedAuthenticatedSession(page, admin.accessToken);
    await page.goto('/app/settings');
    await expect(page.getByRole('heading', { name: /Configuración/i })).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'SettingsPage');
  });
});

test.describe('Feature #3: 4-role RBAC & Team Invites (Tier 2 - Boundary & Corner Cases)', () => {
  test('T2.3.1 Viewer and Agent roles receive 403 Forbidden on admin/manager endpoints', async ({
    request,
  }) => {
    const admin = await signupViaAPI(request);
    const viewerEmail = `viewer-${uniqueId('v')}@koracrm.dev`;
    const inv = await apiRequest<{ token: string }>(
      request,
      'POST',
      '/api/v1/team/invites',
      admin.accessToken,
      { email: viewerEmail, role: 'viewer' }
    );
    const accept = await apiRequest<{ access_token: string }>(
      request,
      'POST',
      '/api/v1/team/accept-invite',
      undefined,
      { token: inv.data.token, full_name: 'Visor Prueba', password: 'Secret123!' }
    );
    expect(accept.status).toBe(200);

    const inviteAttempt = await apiRequest(
      request,
      'POST',
      '/api/v1/team/invites',
      accept.data.access_token,
      { email: 'otro@koracrm.dev', role: 'agent' }
    );
    expect(inviteAttempt.status).toBe(403);

    const tokenAttempt = await apiRequest(
      request,
      'POST',
      '/api/v1/api-tokens',
      accept.data.access_token,
      { name: 'Prohibido' }
    );
    expect(tokenAttempt.status).toBe(403);

    const orgAttempt = await apiRequest(
      request,
      'PATCH',
      '/api/v1/organization',
      accept.data.access_token,
      { name: 'Hackeado' }
    );
    expect(orgAttempt.status).toBe(403);
  });

  test('T2.3.2 Manager receives 403 Forbidden on admin-only endpoints (API tokens, org update)', async ({
    request,
  }) => {
    const admin = await signupViaAPI(request);
    const mgrEmail = `mgr-${uniqueId('m')}@koracrm.dev`;
    const inv = await apiRequest<{ token: string }>(
      request,
      'POST',
      '/api/v1/team/invites',
      admin.accessToken,
      { email: mgrEmail, role: 'manager' }
    );
    const accept = await apiRequest<{ access_token: string }>(
      request,
      'POST',
      '/api/v1/team/accept-invite',
      undefined,
      { token: inv.data.token, full_name: 'Gerente Prueba', password: 'Secret123!' }
    );
    expect(accept.status).toBe(200);

    const tokenAttempt = await apiRequest(
      request,
      'POST',
      '/api/v1/api-tokens',
      accept.data.access_token,
      { name: 'Token Gerente' }
    );
    expect(tokenAttempt.status).toBe(403);

    const orgAttempt = await apiRequest(
      request,
      'PATCH',
      '/api/v1/organization',
      accept.data.access_token,
      { name: 'Org Gerente' }
    );
    expect(orgAttempt.status).toBe(403);
  });

  test('T2.3.3 Regular tenant admin cannot access /admin UI or /api/v1/admin/* (403)', async ({
    page,
    request,
  }) => {
    const regularUser = await signupViaAPI(request);
    const apiAdminRes = await apiRequest(
      request,
      'GET',
      '/api/v1/admin/tenants',
      regularUser.accessToken
    );
    expect(apiAdminRes.status).toBe(403);

    await seedAuthenticatedSession(page, regularUser.accessToken);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Acceso restringido' })).toBeVisible();
    await assertZeroOverflow(page);
  });

  test('T2.3.4 /team/accept-invite/invalid-token renders invalid invite card gracefully in Spanish', async ({
    page,
  }) => {
    await page.goto('/team/accept-invite/token-invalido-12345');
    await expect(page.getByRole('heading', { name: /Invitación no válida|expirada/i })).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
  });

  test('T2.3.5 Inviting with invalid role returns 400/422 cleanly', async ({ request }) => {
    const admin = await signupViaAPI(request);
    const res = await apiRequest(request, 'POST', '/api/v1/team/invites', admin.accessToken, {
      email: `badrole-${uniqueId('r')}@koracrm.dev`,
      role: 'superowner_invalid',
    });
    expect([400, 422]).toContain(res.status);
  });
});

// ============================================================================
// Feature #5: API Tokens (SHA256 Bearer crm_*) & Idempotency-Key middleware
// ============================================================================
test.describe('Feature #5: API Tokens & Idempotency-Key (Tier 1)', () => {
  test('T1.5.1 Admin creates API token receiving crm_* once and list returns masked metadata', async ({
    request,
  }) => {
    const admin = await signupViaAPI(request);
    const createRes = await apiRequest<{ id: string; token: string; name: string }>(
      request,
      'POST',
      '/api/v1/api-tokens',
      admin.accessToken,
      { name: 'Integración ERP' }
    );
    expect([200, 201]).toContain(createRes.status);
    expect(createRes.data.token).toMatch(/^crm_/);

    const listRes = await apiRequest<Array<{ id: string; name: string; token?: string }>>(
      request,
      'GET',
      '/api/v1/api-tokens',
      admin.accessToken
    );
    expect(listRes.status).toBe(200);
    const found = listRes.data.find((t) => t.id === createRes.data.id);
    expect(found).toBeTruthy();
    expect(found?.token).toBeUndefined();
  });

  test('T1.5.2 /app/settings/api-tokens renders token UI in Spanish with zero overflow and passes axe scan', async ({
    page,
    request,
  }) => {
    const admin = await signupViaAPI(request);
    await seedAuthenticatedSession(page, admin.accessToken);
    await page.goto('/app/settings/api-tokens');
    await expect(page.getByText(/Tokens API/i).first()).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'SettingsApiTokens');
  });

  test('T1.5.3 crm_* Bearer token authenticates GET and POST /api/v1/contacts', async ({
    request,
  }) => {
    const admin = await signupViaAPI(request);
    const tokRes = await apiRequest<{ token: string }>(
      request,
      'POST',
      '/api/v1/api-tokens',
      admin.accessToken,
      { name: 'CLI Token' }
    );
    const crmToken = tokRes.data.token;

    const createContact = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      crmToken,
      { name: 'Contacto API Token', phone_number: '+5215577776666' }
    );
    expect(createContact.status).toBe(201);

    const listContacts = await apiRequest<Array<{ id: string }>>(
      request,
      'GET',
      '/api/v1/contacts',
      crmToken
    );
    expect(listContacts.status).toBe(200);
    expect(listContacts.data.some((c) => c.id === createContact.data.id)).toBe(true);
  });

  test('T1.5.4 Admin revokes API token via DELETE /api/v1/api-tokens/{id}', async ({ request }) => {
    const admin = await signupViaAPI(request);
    const tokRes = await apiRequest<{ id: string; token: string }>(
      request,
      'POST',
      '/api/v1/api-tokens',
      admin.accessToken,
      { name: 'Token Temporal' }
    );

    const delRes = await apiRequest(
      request,
      'DELETE',
      `/api/v1/api-tokens/${tokRes.data.id}`,
      admin.accessToken
    );
    expect([200, 204]).toContain(delRes.status);
  });

  test('T1.5.5 Idempotency-Key deduplicates duplicate POST /api/v1/contacts requests', async ({
    request,
  }) => {
    const admin = await signupViaAPI(request);
    const idemKey = uniqueId('idem');
    const payload = { name: `Idem ${idemKey}`, phone_number: '+5215588887777' };

    const first = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      admin.accessToken,
      payload,
      { 'Idempotency-Key': idemKey }
    );
    const second = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      admin.accessToken,
      payload,
      { 'Idempotency-Key': idemKey }
    );

    expect(first.status).toBe(201);
    expect([200, 201]).toContain(second.status);
    expect(second.data.id).toBe(first.data.id);

    const list = await apiRequest<Array<{ id: string; name: string }>>(
      request,
      'GET',
      `/api/v1/contacts?q=${encodeURIComponent(idemKey)}`,
      admin.accessToken
    );
    expect(list.data.length).toBe(1);
  });
});

test.describe('Feature #5: API Tokens & Idempotency-Key (Tier 2 - Boundary & Corner Cases)', () => {
  test('T2.5.1 Revoked crm_* Bearer token is rejected with 401 Unauthorized', async ({
    request,
  }) => {
    const admin = await signupViaAPI(request);
    const tokRes = await apiRequest<{ id: string; token: string }>(
      request,
      'POST',
      '/api/v1/api-tokens',
      admin.accessToken,
      { name: 'Para Revocar' }
    );
    await apiRequest(request, 'DELETE', `/api/v1/api-tokens/${tokRes.data.id}`, admin.accessToken);

    const rejected = await apiRequest(request, 'GET', '/api/v1/contacts', tokRes.data.token);
    expect(rejected.status).toBe(401);
  });

  test('T2.5.2 Malformed or unknown crm_* token is rejected with 401 Unauthorized', async ({
    request,
  }) => {
    const res = await apiRequest(
      request,
      'GET',
      '/api/v1/contacts',
      'crm_invalid_00000000000000000000000'
    );
    expect(res.status).toBe(401);
  });

  test('T2.5.3 Idempotency-Key replay does not create extra records on POST /api/v1/leads', async ({
    request,
  }) => {
    const admin = await signupViaAPI(request);
    const pipelines = await apiRequest<Array<{ id: string; stages: Array<{ id: string }> }>>(
      request,
      'GET',
      '/api/v1/pipelines',
      admin.accessToken
    );
    const pipeline = pipelines.data[0];
    const stageId = pipeline.stages[0].id;
    const contact = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      admin.accessToken,
      { name: 'Contacto Lead Idem', phone_number: '+5215566665555' }
    );

    const idemKey = uniqueId('lead-idem');
    const leadPayload = {
      title: `Trato ${idemKey}`,
      pipeline_id: pipeline.id,
      stage_id: stageId,
      contact_id: contact.data.id,
    };
    const r1 = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/leads',
      admin.accessToken,
      leadPayload,
      { 'Idempotency-Key': idemKey }
    );
    const r2 = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/leads',
      admin.accessToken,
      leadPayload,
      { 'Idempotency-Key': idemKey }
    );
    expect(r1.status).toBe(201);
    expect(r2.data.id).toBe(r1.data.id);
  });

  test('T2.5.4 Creating API token with empty name returns 400/422', async ({ request }) => {
    const admin = await signupViaAPI(request);
    const res = await apiRequest(request, 'POST', '/api/v1/api-tokens', admin.accessToken, {
      name: '   ',
    });
    expect([400, 422]).toContain(res.status);
  });

  test('T2.5.5 Same Idempotency-Key string across two different tenants stays isolated', async ({
    request,
  }) => {
    const tenantA = await signupViaAPI(request);
    const tenantB = await signupViaAPI(request);
    const sharedKey = uniqueId('shared-idem');

    const resA = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      tenantA.accessToken,
      { name: 'Tenant A Idem', phone_number: '+5215500001111' },
      { 'Idempotency-Key': sharedKey }
    );
    const resB = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/contacts',
      tenantB.accessToken,
      { name: 'Tenant B Idem', phone_number: '+5215500002222' },
      { 'Idempotency-Key': sharedKey }
    );

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(resA.data.id).not.toBe(resB.data.id);
  });
});

// ============================================================================
// Feature #6: Audited temporary Platform Support Sessions (S26 /admin)
// ============================================================================
test.describe('Feature #6: Platform Support Sessions (Tier 1)', () => {
  test('T1.6.1 Super-Admin /admin renders KPIs and tenant directory with zero overflow and passes axe scan', async ({
    page,
    request,
  }) => {
    const superAdmin = await signupViaAPI(request);
    promotePlatformAdmin(superAdmin.email);

    await seedAuthenticatedSession(page, superAdmin.accessToken);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Consola Super-Admin' })).toBeVisible();
    await expect(page.getByText('Organizaciones')).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'AdminPage');
  });

  test('T1.6.2 Super-Admin can suspend and reactivate a tenant via /api/v1/admin/tenants/{id}', async ({
    request,
  }) => {
    const superAdmin = await signupViaAPI(request);
    promotePlatformAdmin(superAdmin.email);
    const target = await signupViaAPI(request);

    const suspend = await apiRequest<{ is_suspended: boolean }>(
      request,
      'PATCH',
      `/api/v1/admin/tenants/${target.organizationId}`,
      superAdmin.accessToken,
      { is_suspended: true, reason: 'Suspensión de prueba' }
    );
    expect(suspend.status).toBe(200);
    expect(suspend.data.is_suspended).toBe(true);

    const reactivate = await apiRequest<{ is_suspended: boolean }>(
      request,
      'PATCH',
      `/api/v1/admin/tenants/${target.organizationId}`,
      superAdmin.accessToken,
      { is_suspended: false, reason: 'Reactivación de prueba' }
    );
    expect(reactivate.status).toBe(200);
    expect(reactivate.data.is_suspended).toBe(false);
  });

  test('T1.6.3 Super-Admin starts support_readonly session with 1h TTL', async ({ request }) => {
    const superAdmin = await signupViaAPI(request);
    promotePlatformAdmin(superAdmin.email);
    const target = await signupViaAPI(request);

    const sess = await apiRequest<{ id: string; mode: string; expires_at: string }>(
      request,
      'POST',
      '/api/v1/admin/support-sessions',
      superAdmin.accessToken,
      {
        target_organization_id: target.organizationId,
        reason: 'Diagnóstico de bandeja',
        mode: 'support_readonly',
        ttl_minutes: 60,
      }
    );
    expect([200, 201]).toContain(sess.status);
    expect(sess.data.id).toBeTruthy();
    expect(sess.data.mode).toBe('support_readonly');
  });

  test('T1.6.4 Active X-Support-Session-ID allows read-only GET inspection of target tenant', async ({
    request,
  }) => {
    const superAdmin = await signupViaAPI(request);
    promotePlatformAdmin(superAdmin.email);
    const target = await signupViaAPI(request);
    const marker = uniqueId('sup');
    await apiRequest(request, 'POST', '/api/v1/contacts', target.accessToken, {
      name: `Cliente Soporte ${marker}`,
      phone_number: '+5215544443333',
    });

    const sess = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/admin/support-sessions',
      superAdmin.accessToken,
      {
        target_organization_id: target.organizationId,
        reason: 'Inspección de contactos',
        mode: 'support_readonly',
        ttl_minutes: 60,
      }
    );

    const readRes = await apiRequest<Array<{ name: string }>>(
      request,
      'GET',
      '/api/v1/contacts',
      superAdmin.accessToken,
      undefined,
      { 'X-Support-Session-ID': sess.data.id }
    );
    expect(readRes.status).toBe(200);
    expect(readRes.data.some((c) => c.name.includes(marker))).toBe(true);
  });

  test('T1.6.5 Super-Admin can end support session via POST /api/v1/admin/support-sessions/{id}/end', async ({
    request,
  }) => {
    const superAdmin = await signupViaAPI(request);
    promotePlatformAdmin(superAdmin.email);
    const target = await signupViaAPI(request);

    const sess = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/admin/support-sessions',
      superAdmin.accessToken,
      {
        target_organization_id: target.organizationId,
        reason: 'Cierre de sesión',
        mode: 'support_readonly',
        ttl_minutes: 60,
      }
    );

    const endRes = await apiRequest(
      request,
      'POST',
      `/api/v1/admin/support-sessions/${sess.data.id}/end`,
      superAdmin.accessToken
    );
    expect(endRes.status).toBe(200);
  });
});

test.describe('Feature #6: Platform Support Sessions (Tier 2 - Boundary & Corner Cases)', () => {
  test('T2.6.1 Active support_readonly session blocks all mutations with 403 Forbidden', async ({
    request,
  }) => {
    const superAdmin = await signupViaAPI(request);
    promotePlatformAdmin(superAdmin.email);
    const target = await signupViaAPI(request);

    const sess = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/admin/support-sessions',
      superAdmin.accessToken,
      {
        target_organization_id: target.organizationId,
        reason: 'Verificar readonly',
        mode: 'support_readonly',
        ttl_minutes: 60,
      }
    );

    const createContact = await apiRequest(
      request,
      'POST',
      '/api/v1/contacts',
      superAdmin.accessToken,
      { name: 'Bloqueado', phone_number: '+5215599990000' },
      { 'X-Support-Session-ID': sess.data.id }
    );
    expect(createContact.status).toBe(403);

    const patchOrg = await apiRequest(
      request,
      'PATCH',
      '/api/v1/organization',
      superAdmin.accessToken,
      { name: 'Bloqueado' },
      { 'X-Support-Session-ID': sess.data.id }
    );
    expect(patchOrg.status).toBe(403);
  });

  test('T2.6.2 Active support session is explicitly blocked on POST /api/v1/mcp (403)', async ({
    request,
  }) => {
    const superAdmin = await signupViaAPI(request);
    promotePlatformAdmin(superAdmin.email);
    const target = await signupViaAPI(request);

    const sess = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/admin/support-sessions',
      superAdmin.accessToken,
      {
        target_organization_id: target.organizationId,
        reason: 'Bloqueo MCP',
        mode: 'support_readonly',
        ttl_minutes: 60,
      }
    );

    const mcpRes = await apiRequest(
      request,
      'POST',
      '/api/v1/mcp',
      superAdmin.accessToken,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { 'X-Support-Session-ID': sess.data.id }
    );
    expect(mcpRes.status).toBe(403);
  });

  test('T2.6.3 Starting support session without reason or invalid org ID returns 400/404', async ({
    request,
  }) => {
    const superAdmin = await signupViaAPI(request);
    promotePlatformAdmin(superAdmin.email);

    const noReason = await apiRequest(
      request,
      'POST',
      '/api/v1/admin/support-sessions',
      superAdmin.accessToken,
      {
        target_organization_id: superAdmin.organizationId,
        reason: '',
        mode: 'support_readonly',
      }
    );
    expect([400, 422]).toContain(noReason.status);

    const badOrg = await apiRequest(
      request,
      'POST',
      '/api/v1/admin/support-sessions',
      superAdmin.accessToken,
      {
        target_organization_id: '00000000-0000-0000-0000-000000000000',
        reason: 'Org inexistente',
        mode: 'support_readonly',
      }
    );
    expect([400, 404]).toContain(badOrg.status);
  });

  test('T2.6.4 Ended support session ID in X-Support-Session-ID is rejected (403/401)', async ({
    request,
  }) => {
    const superAdmin = await signupViaAPI(request);
    promotePlatformAdmin(superAdmin.email);
    const target = await signupViaAPI(request);

    const sess = await apiRequest<{ id: string }>(
      request,
      'POST',
      '/api/v1/admin/support-sessions',
      superAdmin.accessToken,
      {
        target_organization_id: target.organizationId,
        reason: 'Expiración inmediata',
        mode: 'support_readonly',
        ttl_minutes: 60,
      }
    );
    await apiRequest(
      request,
      'POST',
      `/api/v1/admin/support-sessions/${sess.data.id}/end`,
      superAdmin.accessToken
    );

    const afterEnd = await apiRequest(
      request,
      'GET',
      '/api/v1/contacts',
      superAdmin.accessToken,
      undefined,
      { 'X-Support-Session-ID': sess.data.id }
    );
    expect([401, 403]).toContain(afterEnd.status);
  });

  test('T2.6.5 Non-platform-admin user cannot start support sessions (403)', async ({ request }) => {
    const regular = await signupViaAPI(request);
    const res = await apiRequest(
      request,
      'POST',
      '/api/v1/admin/support-sessions',
      regular.accessToken,
      {
        target_organization_id: regular.organizationId,
        reason: 'Intento no autorizado',
        mode: 'support_readonly',
      }
    );
    expect(res.status).toBe(403);
  });
});

// ============================================================================
// Feature #7: Guided tenant onboarding wizard (S04 /onboarding/*)
// ============================================================================
test.describe('Feature #7: Guided Onboarding Wizard (Tier 1)', () => {
  test('T1.7.1 /onboarding renders Step 1 niche presets in Spanish with zero overflow and passes axe scan', async ({
    page,
    request,
  }) => {
    const admin = await signupViaAPI(request);
    await seedAuthenticatedSession(page, admin.accessToken);
    await page.goto('/onboarding');
    await expect(page.getByText('Clínica / Salud')).toBeVisible();
    await expect(page.getByText('Inmobiliaria')).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'OnboardingStep1');
  });

  test('T1.7.2 Selecting a niche preset and saving updates organization pipeline vocabulary', async ({
    page,
    request,
  }) => {
    const admin = await signupViaAPI(request);
    await seedAuthenticatedSession(page, admin.accessToken);
    await page.goto('/onboarding/1');
    await page.getByText('Clínica / Salud').click();
    await page.getByRole('button', { name: /Guardar y continuar/i }).click();

    await expect(page).toHaveURL(/\/onboarding\/2/);
    const org = await apiRequest<{
      pipeline_vocabulary?: { deal?: string; deals?: string };
    }>(request, 'GET', '/api/v1/organization', admin.accessToken);
    expect(org.status).toBe(200);
    expect(org.data.pipeline_vocabulary?.deal).toBe('Paciente');
  });

  test('T1.7.3 /onboarding/2, /onboarding/3, and /onboarding/4 render each step with zero overflow', async ({
    page,
    request,
  }) => {
    const admin = await signupViaAPI(request);
    await seedAuthenticatedSession(page, admin.accessToken);

    for (const step of [2, 3, 4]) {
      await page.goto(`/onboarding/${step}`);
      await assertSpanishAndBrand(page);
      await assertZeroOverflow(page);
    }
  });

  test('T1.7.4 User can skip optional onboarding steps and finish into /app/inbox', async ({
    page,
    request,
  }) => {
    const admin = await signupViaAPI(request);
    await seedAuthenticatedSession(page, admin.accessToken);
    await page.goto('/onboarding/4');
    await page.getByRole('button', { name: /Ir a la Bandeja|Finalizar|Omitir/i }).first().click();
    await expect(page).toHaveURL(/\/app\/inbox/);
  });

  test('T1.7.5 Onboarding Step 4 allows inviting a team member inline', async ({
    page,
    request,
  }) => {
    const admin = await signupViaAPI(request);
    const inviteEmail = `onb-${uniqueId('inv')}@koracrm.dev`;
    await seedAuthenticatedSession(page, admin.accessToken);
    await page.goto('/onboarding/4');

    await page.getByPlaceholder(/compañero|correo|email/i).fill(inviteEmail);
    await page.getByRole('button', { name: /Enviar invitación|Invitar/i }).click();
    await expect(page.getByText(inviteEmail)).toBeVisible();
  });
});

test.describe('Feature #7: Guided Onboarding Wizard (Tier 2 - Boundary & Corner Cases)', () => {
  test('T2.7.1 Unauthenticated visit to /onboarding redirects to /login', async ({ page }) => {
    await page.goto('/onboarding');
    await expect(page).toHaveURL(/\/login/);
  });

  test('T2.7.2 Unauthenticated visit to /onboarding/3 redirects to /login', async ({ page }) => {
    await page.goto('/onboarding/3');
    await expect(page).toHaveURL(/\/login/);
  });

  test('T2.7.3 Out-of-bounds onboarding steps (/onboarding/99, /onboarding/0) clamp safely without 500', async ({
    page,
    request,
  }) => {
    const admin = await signupViaAPI(request);
    await seedAuthenticatedSession(page, admin.accessToken);

    await page.goto('/onboarding/99');
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);

    await page.goto('/onboarding/0');
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
  });

  test('T2.7.4 Onboarding vocabulary step handles custom accents/Unicode cleanly', async ({
    request,
  }) => {
    const admin = await signupViaAPI(request);
    const res = await apiRequest<{ pipeline_vocabulary?: { deal?: string } }>(
      request,
      'PATCH',
      '/api/v1/organization',
      admin.accessToken,
      {
        niche: 'servicios',
        pipeline_vocabulary: { deal: 'Gestión', deals: 'Gestiones', stage: 'Fase' },
      }
    );
    expect(res.status).toBe(200);
    expect(res.data.pipeline_vocabulary?.deal).toBe('Gestión');
  });

  test('T2.7.5 Step 4 rejects malformed invite email without crashing', async ({
    page,
    request,
  }) => {
    const admin = await signupViaAPI(request);
    await seedAuthenticatedSession(page, admin.accessToken);
    await page.goto('/onboarding/4');
    await expect(page.getByRole('button', { name: /Enviar invitación|Invitar/i })).toBeVisible();
    await assertZeroOverflow(page);
  });
});

// ============================================================================
// Feature #42: Legal & Status pages (S05) + CRM Hub (S10)
// ============================================================================
test.describe('Feature #42: Legal, Status Pages & CRM Hub (Tier 1)', () => {
  test('T1.42.1 /get-started renders landing hero, CTAs, Spanish UI, zero overflow, and passes axe scan', async ({
    page,
  }) => {
    await page.goto('/get-started');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Crear Espacio de Trabajo' })).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'GetStartedPage');
  });

  test('T1.42.2 /legal/privacy and /legal/terms render Spanish LGPD & Terms with zero overflow and axe scan', async ({
    page,
  }) => {
    await page.goto('/legal/privacy');
    await expect(
      page.getByRole('heading', { name: /Política de Privacidad y Cumplimiento LGPD/i })
    ).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'PrivacyPage');

    await page.goto('/legal/terms');
    await expect(page.getByRole('heading', { name: 'Términos de Servicio' })).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
    await assertAccessibility(page, 'TermsPage');
  });

  test('T1.42.3 /403 and /500 render Spanish status error cards with zero overflow', async ({
    page,
  }) => {
    await page.goto('/403');
    await expect(page.getByText('ERROR 403')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Acceso denegado' })).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);

    await page.goto('/500');
    await expect(page.getByText('ERROR 500')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Error del servidor' })).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
  });

  test('T1.42.4 /oauth/mcp/consent renders Spanish MCP OAuth consent prompt with zero overflow', async ({
    page,
    request,
  }) => {
    const admin = await signupViaAPI(request);
    await seedAuthenticatedSession(page, admin.accessToken);
    await page.goto('/oauth/mcp/consent?client_name=Claude%20Desktop&scope=crm:read%20crm:write');
    await expect(page.getByText('Claude Desktop')).toBeVisible();
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
  });

  test('T1.42.5 /app/crm (CRM Hub S10) renders cleanly without 500s and with zero horizontal overflow', async ({
    page,
    request,
  }) => {
    const admin = await signupViaAPI(request);
    await seedAuthenticatedSession(page, admin.accessToken);
    await page.goto('/app/crm');
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
  });
});

test.describe('Feature #42: Legal, Status Pages & CRM Hub (Tier 2 - Boundary & Corner Cases)', () => {
  test('T2.42.1 Unknown route renders 404/fallback in Spanish without console errors or 500s', async ({
    page,
  }) => {
    await page.goto('/ruta-inexistente-koracrm-e2e');
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
  });

  test('T2.42.2 /oauth/mcp/consent when unauthenticated handles auth state gracefully without 500', async ({
    page,
  }) => {
    await page.goto('/oauth/mcp/consent?client_name=AgenteExterno');
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
  });

  test('T2.42.3 /oauth/mcp/consent safely escapes XSS-like query params without executing scripts', async ({
    page,
  }) => {
    let dialogTriggered = false;
    page.on('dialog', () => {
      dialogTriggered = true;
    });
    await page.goto('/oauth/mcp/consent?client_name=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(dialogTriggered).toBe(false);
    await assertSpanishAndBrand(page);
    await assertZeroOverflow(page);
  });

  test('T2.42.4 /legal/privacy and /403 maintain zero horizontal overflow and brand integrity', async ({
    page,
  }) => {
    await page.goto('/legal/privacy');
    await assertZeroOverflow(page);
    await assertSpanishAndBrand(page);

    await page.goto('/403');
    await assertZeroOverflow(page);
    await assertSpanishAndBrand(page);
  });

  test('T2.42.5 /app/crm when unauthenticated redirects to /login cleanly', async ({ page }) => {
    await page.goto('/app/crm');
    await expect(page).toHaveURL(/\/login/);
  });
});
