import { expect, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';

export function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface SignupOptions {
  orgName?: string;
  email?: string;
  password?: string;
  fullName?: string;
}

export interface SignupResult {
  accessToken: string;
  organizationId: string;
  orgName: string;
  email: string;
  password: string;
  fullName: string;
  user: {
    id: string;
    email: string;
    full_name: string;
    organization_id: string;
    org_name?: string;
    role: string;
  };
  raw: Record<string, unknown>;
}

export async function signupViaAPI(
  request: APIRequestContext,
  opts: SignupOptions = {}
): Promise<SignupResult> {
  const id = uniqueId('e2e');
  const orgName = opts.orgName ?? `Org ${id}`;
  const email = opts.email ?? `${id}@koracrm.dev`;
  const password = opts.password ?? 'Secret123!';
  const fullName = opts.fullName ?? `Usuario ${id}`;

  const res = await request.post('/api/v1/auth/signup', {
    data: {
      org_name: orgName,
      email,
      password,
      full_name: fullName,
    },
  });

  const text = await res.text();
  expect(res.ok(), `POST /api/v1/auth/signup failed (${res.status()}): ${text}`).toBe(true);

  const raw = JSON.parse(text) as Record<string, unknown>;
  const accessToken = String(raw.access_token ?? raw.token ?? '');
  const user = (raw.user ?? {}) as SignupResult['user'];
  const organizationId = String(user.organization_id ?? raw.organization_id ?? '');

  expect(accessToken, 'Missing access_token from signup response').not.toBe('');

  return {
    accessToken,
    organizationId,
    orgName,
    email,
    password,
    fullName,
    user,
    raw,
  };
}

export interface ApiRequestResult<T = unknown> {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  data: T;
  response: APIResponse;
}

export async function apiRequest<T = unknown>(
  request: APIRequestContext,
  method: string,
  path: string,
  token?: string,
  data?: unknown,
  headers: Record<string, string> = {}
): Promise<ApiRequestResult<T>> {
  const reqHeaders: Record<string, string> = {
    ...headers,
  };
  if (token) {
    reqHeaders['Authorization'] = `Bearer ${token}`;
  }
  if (data !== undefined && !reqHeaders['Content-Type']) {
    reqHeaders['Content-Type'] = 'application/json';
  }

  const response = await request.fetch(path, {
    method,
    headers: reqHeaders,
    data,
  });

  const text = await response.text();
  let parsed: unknown = text;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  } else {
    parsed = null;
  }

  return {
    status: response.status(),
    ok: response.ok(),
    headers: response.headers(),
    data: parsed as T,
    response,
  };
}

export async function loginViaUI(
  page: Page,
  email: string,
  password: string
): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('tu@empresa.com').fill(email);
  await page.getByPlaceholder('••••••••').fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page).toHaveURL(/\/app\//);
}
