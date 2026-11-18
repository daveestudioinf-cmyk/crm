const TOKEN_KEY = 'koracrm_access_token';
const SUPPORT_SESSION_KEY = 'koracrm_support_session';
export const SUPPORT_SESSION_EVENT = 'koracrm:support-session-changed';

export interface User {
  id: string;
  email: string;
  full_name: string;
  organization_id: string;
  org_name: string;
  role: string;
  mfa_enabled?: boolean;
  is_platform_admin?: boolean;
}

export interface SupportSession {
  id: string;
  target_organization_id: string;
  organization_name: string;
  mode: 'support_readonly' | 'full';
  reason: string;
  expires_at: string;
  created_at?: string;
}

export interface AdminTenant {
  id: string;
  name: string;
  slug: string;
  is_suspended: boolean;
  created_at: string;
  updated_at: string;
  users_count: number;
  contacts_count: number;
  conversations_count: number;
  active_support_sessions: number;
}

export interface AdminTenantsResponse {
  items: AdminTenant[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminMetrics {
  total_tenants: number;
  active_tenants: number;
  suspended_tenants: number;
  total_users: number;
  total_contacts: number;
  total_conversations: number;
  total_messages: number;
  active_support_sessions: number;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getSupportSession(): SupportSession | null {
  try {
    const raw = sessionStorage.getItem(SUPPORT_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SupportSession;
    if (!parsed?.id || !parsed?.expires_at) return null;
    if (new Date(parsed.expires_at).getTime() <= Date.now()) {
      sessionStorage.removeItem(SUPPORT_SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function setSupportSession(session: SupportSession | null) {
  if (session) {
    sessionStorage.setItem(SUPPORT_SESSION_KEY, JSON.stringify(session));
  } else {
    sessionStorage.removeItem(SUPPORT_SESSION_KEY);
  }
  window.dispatchEvent(new CustomEvent(SUPPORT_SESSION_EVENT, { detail: session }));
}

function formatApiError(code: string, fallback: string): string {
  switch (code) {
    case 'support_session_invalid':
      return 'La sesión de soporte expiró o fue cerrada.';
    case 'support_readonly':
      return 'Modo soporte de solo lectura: no se permiten cambios.';
    case 'support_session_jwt_only':
    case 'platform_admin_jwt_only':
      return 'Esta operación requiere sesión de usuario autenticada.';
    case 'tenant_suspended':
      return 'Esta organización está suspendida.';
    case 'platform_admin_required':
      return 'Se requieren permisos de Super-Admin.';
    case 'organization not found':
      return 'Organización no encontrada.';
    case 'support session not found':
      return 'Sesión de soporte no encontrada.';
    case 'audit log failure':
      return 'Error al registrar auditoría.';
    case 'db error':
      return 'Error de base de datos.';
    default:
      return code || fallback;
  }
}

export async function apiFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers || {});
  if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!path.startsWith('/admin')) {
    const sess = getSupportSession();
    if (sess?.id) {
      headers.set('X-Support-Session-ID', sess.id);
    }
  }

  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/signup') {
    const ref = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' });
    if (ref.ok) {
      const data = await ref.json();
      setToken(data.access_token);
      headers.set('Authorization', `Bearer ${data.access_token}`);
      const retry = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'include' });
      if (!retry.ok) {
        const err = await retry.json().catch(() => ({ error: retry.statusText }));
        if (retry.status === 403 && err.error === 'support_session_invalid') {
          setSupportSession(null);
        }
        throw new Error(formatApiError(err.error, retry.statusText));
      }
      return retry.json();
    }
    setToken(null);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    if (res.status === 403 && err.error === 'support_session_invalid') {
      setSupportSession(null);
    }
    throw new Error(formatApiError(err.error, res.statusText));
  }
  return res.json();
}

export function fetchAdminMetrics(): Promise<AdminMetrics> {
  return apiFetch<AdminMetrics>('/admin/metrics');
}

export function fetchAdminTenants(params: {
  limit?: number;
  offset?: number;
  q?: string;
  is_suspended?: string;
} = {}): Promise<AdminTenantsResponse> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  if (params.q) qs.set('q', params.q);
  if (params.is_suspended === 'true' || params.is_suspended === 'false') {
    qs.set('is_suspended', params.is_suspended);
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiFetch<AdminTenantsResponse>(`/admin/tenants${suffix}`);
}

export function updateAdminTenantStatus(
  id: string,
  is_suspended: boolean,
  reason = ''
): Promise<{ id: string; name: string; is_suspended: boolean }> {
  return apiFetch(`/admin/tenants/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ is_suspended, reason }),
  });
}

export function startAdminSupportSession(payload: {
  target_organization_id: string;
  reason: string;
  mode?: 'support_readonly' | 'full';
  ttl_minutes?: number;
}): Promise<SupportSession> {
  return apiFetch<SupportSession>('/admin/support-sessions', {
    method: 'POST',
    body: JSON.stringify({
      target_organization_id: payload.target_organization_id,
      reason: payload.reason,
      mode: payload.mode ?? 'support_readonly',
      ttl_minutes: payload.ttl_minutes ?? 60,
    }),
  });
}

export function endAdminSupportSession(id: string): Promise<{ status: string; id: string }> {
  return apiFetch(`/admin/support-sessions/${id}/end`, {
    method: 'POST',
  });
}
