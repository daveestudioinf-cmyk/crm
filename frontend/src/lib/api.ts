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

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
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
    case 'invalid email or password':
      return 'Correo o contraseña incorrectos.';
    case 'invalid totp code':
    case 'invalid_mfa_code':
      return 'Código de verificación inválido.';
    case 'invalid_recovery_code':
    case 'invalid or used recovery code':
      return 'Código de recuperación inválido o ya utilizado.';
    case 'invalid_token':
    case 'invalid token':
      return 'El enlace o token no es válido.';
    case 'token_expired':
    case 'invite_expired':
    case 'invite expired':
      return 'La invitación o enlace ha expirado.';
    case 'already_accepted':
    case 'invite_already_accepted':
    case 'invite already accepted':
      return 'Esta invitación ya fue aceptada.';
    case 'email already registered':
      return 'Este correo electrónico ya está registrado.';
    case 'cannot demote the last admin':
      return 'No puedes degradar al último administrador de la organización.';
    case 'cannot remove the last admin':
      return 'No puedes eliminar al último administrador de la organización.';
    case 'insufficient role':
      return 'No tienes permisos suficientes para realizar esta acción.';
    case 'idempotency_conflict_in_progress':
      return 'Solicitud en progreso. Por favor espera un momento e intenta de nuevo.';
    case 'revision_conflict':
    case 'service_revision_conflict':
    case 'conversation_revision_conflict':
      return 'La conversación fue modificada por otro agente. Actualizando...';
    case 'shortcut already exists':
      return 'Ya existe una plantilla con ese atajo.';
    case 'contact opted out (STOP)':
      return 'El contacto solicitó darse de baja (STOP).';
    case 'version_conflict':
    case 'lead modified concurrently':
      return 'Este registro fue modificado por otro usuario. Actualizando datos...';
    case 'bulk_limit_exceeded':
    case 'bulk move limited to 50 leads':
      return 'La acción masiva está limitada a un máximo de 50 registros a la vez.';
    case 'cannot delete stage with existing leads':
      return 'No puedes eliminar una etapa que aún tiene leads asignados.';
    case 'cannot_link_self':
      return 'No puedes vincular un lead consigo mismo.';
    case 'link_already_exists':
      return 'Este vínculo ya existe.';
    default:
      return code || fallback;
  }
}

export interface ApiFetchOptions extends RequestInit {
  idempotencyKey?: string;
}

const SKIP_REFRESH_PATHS = [
  '/auth/login',
  '/auth/signup',
  '/auth/forgot',
  '/auth/reset',
  '/auth/mfa/verify',
  '/team/accept-invite',
];

function shouldSkipRefresh(path: string): boolean {
  if (SKIP_REFRESH_PATHS.includes(path)) return true;
  if (path.startsWith('/team/invites/')) return true;
  return false;
}

async function parseResponseBody<T>(res: Response): Promise<T> {
  if (res.status === 204) {
    return undefined as T;
  }
  const text = await res.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

export async function apiFetch<T = any>(path: string, init: ApiFetchOptions = {}): Promise<T> {
  const { idempotencyKey, ...fetchInit } = init;
  const token = getToken();
  const headers = new Headers(fetchInit.headers || {});
  if (!headers.has('Content-Type') && fetchInit.body && typeof fetchInit.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  if (idempotencyKey && !headers.has('Idempotency-Key')) {
    headers.set('Idempotency-Key', idempotencyKey);
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
    ...fetchInit,
    headers,
    credentials: 'include',
  });
  if (res.status === 401 && !shouldSkipRefresh(path)) {
    const ref = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' });
    if (ref.ok) {
      const data = await ref.json();
      setToken(data.access_token);
      headers.set('Authorization', `Bearer ${data.access_token}`);
      const retry = await fetch(`/api/v1${path}`, { ...fetchInit, headers, credentials: 'include' });
      if (!retry.ok) {
        const err = await retry.json().catch(() => ({ error: retry.statusText }));
        if (retry.status === 403 && err.error === 'support_session_invalid') {
          setSupportSession(null);
        }
        throw new ApiError(formatApiError(err.error, retry.statusText), retry.status, err.error || '');
      }
      return parseResponseBody<T>(retry);
    }
    setToken(null);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    if (res.status === 403 && err.error === 'support_session_invalid') {
      setSupportSession(null);
    }
    throw new ApiError(formatApiError(err.error, res.statusText), res.status, err.error || '');
  }
  return parseResponseBody<T>(res);
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

export interface AIAgent {
  id: string;
  name: string;
  system_prompt: string;
  provider: string;
  model: string;
  temperature: number;
  max_tokens: number;
  handoff_enabled: boolean;
  is_active: boolean;
  version: number;
  updated_at?: string;
}

export interface AIProviderCredential {
  id: string;
  provider: string;
  label: string;
  base_url: string;
  default_model: string;
  api_key_mask: string;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface AIBudget {
  monthly_limit_cents: number;
  monthly_cap_cents: number;
  spent_cents: number;
  warn_at_percent: number;
  hard_stop: boolean;
  alert_80_sent: boolean;
  calls?: number;
  pct: number;
}

export interface AIAgentRun {
  id: string;
  agent_id?: string | null;
  conversation_id?: string | null;
  status: 'completed' | 'handoff' | 'blocked_budget' | 'failed';
  provider: string;
  model: string;
  input_preview: string;
  output_preview: string;
  handoff_reason?: string;
  error_message?: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_cents: number;
  latency_ms: number;
  created_at: string;
}

export interface OrgMemoryEntry {
  id: string;
  category: string;
  content: string;
  is_active: boolean;
  created_at: string;
}

export interface ChannelSession {
  id: string;
  session_name: string;
  provider: string;
  engine: string;
  phone_number: string;
  status: 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'STOPPED' | 'FAILED';
  warmup_daily_limit: number;
  created_at: string;
}

export type SSEStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface SubscribeSSEOptions {
  onStatusChange?: (status: SSEStatus) => void;
}

export function subscribeSSE(
  onEvent: (eventType: string, data: any) => void,
  options?: SubscribeSSEOptions
): () => void {
  let closed = false;
  let attempt = 0;
  let timer: number | undefined;
  let controller: AbortController | null = null;

  const setStatus = (s: SSEStatus) => {
    if (!closed) options?.onStatusChange?.(s);
  };

  const scheduleReconnect = () => {
    if (closed) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setStatus('offline');
      return;
    }
    setStatus('reconnecting');
    const baseDelay = Math.min(30000, 1000 * Math.pow(2, attempt));
    const jitter = Math.floor(Math.random() * 400);
    attempt += 1;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!closed) void connect();
    }, baseDelay + jitter);
  };

  async function connect() {
    if (closed) return;
    const token = getToken();
    if (!token) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setStatus('offline');
      return;
    }

    controller?.abort();
    controller = new AbortController();
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');

    const headers = new Headers();
    headers.set('Authorization', `Bearer ${token}`);
    const support = getSupportSession();
    if (support?.id) {
      headers.set('X-Support-Session-ID', support.id);
    }

    try {
      const res = await fetch('/api/v1/realtime/stream', {
        headers,
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        scheduleReconnect();
        return;
      }
      attempt = 0;
      setStatus('connected');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = 'message';

      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (line === '') {
            currentEvent = 'message';
            continue;
          }
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const payloadStr = line.slice(5).trim();
            try {
              onEvent(currentEvent, JSON.parse(payloadStr));
            } catch {
              onEvent(currentEvent, payloadStr);
            }
          }
        }
      }
      if (!closed) {
        scheduleReconnect();
      }
    } catch {
      if (!closed) {
        scheduleReconnect();
      }
    }
  }

  const handleOnline = () => {
    if (closed) return;
    window.clearTimeout(timer);
    attempt = 0;
    void connect();
  };

  const handleOffline = () => {
    if (closed) return;
    window.clearTimeout(timer);
    controller?.abort();
    setStatus('offline');
  };

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  void connect();

  return () => {
    closed = true;
    window.clearTimeout(timer);
    controller?.abort();
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
}
