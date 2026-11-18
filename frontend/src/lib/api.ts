const TOKEN_KEY = 'koracrm_access_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
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
      if (!retry.ok) throw new Error((await retry.json().catch(() => ({}))).error || retry.statusText);
      return retry.json();
    }
    setToken(null);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}
