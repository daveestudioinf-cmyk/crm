import React, { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, CheckCircle2, KeyRound, ShieldCheck } from 'lucide-react';
import { apiFetch, setToken } from '../lib/api';
import { Button, Card, Input } from '../components/ui/primitives';

const MFA_TOKEN_SESSION_KEY = 'koracrm_mfa_token';

function AuthCardShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh flex items-center justify-center p-4 bg-[var(--surface)] text-[var(--text)]">
      <Card className="w-full max-w-md p-6 space-y-5">
        <div className="flex items-center gap-2.5">
          <img src="/icon.svg" alt="KoraCRM" className="w-8 h-8 rounded-lg shrink-0" />
          <div className="min-w-0">
            <h1 className="text-xl font-bold truncate">{title}</h1>
            <p className="text-xs text-[var(--text-muted)]">{subtitle}</p>
          </div>
        </div>
        {children}
      </Card>
    </div>
  );
}

export function LoginPage({ onAuth }: { onAuth: () => Promise<void> }) {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mfaToken) {
        const res = await apiFetch('/auth/mfa/verify', {
          method: 'POST',
          body: JSON.stringify({ mfa_token: mfaToken, code: mfaCode }),
        });
        sessionStorage.removeItem(MFA_TOKEN_SESSION_KEY);
        setToken(res.access_token);
        await onAuth();
        nav({ to: '/app/inbox' });
        return;
      }
      const res = await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      if (res.mfa_required) {
        sessionStorage.setItem(MFA_TOKEN_SESSION_KEY, res.mfa_token);
        setMfaToken(res.mfa_token);
        setLoading(false);
        return;
      }
      setToken(res.access_token);
      await onAuth();
      nav({ to: '/app/inbox' });
    } catch (err: any) {
      setError(err.message || 'Error al iniciar sesión');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCardShell
      title="Iniciar sesión en KoraCRM"
      subtitle="Accede a tu espacio de ventas por WhatsApp"
    >
      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-[var(--danger)]">
          {error}
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        {!mfaToken ? (
          <>
            <div className="space-y-1">
              <label className="text-xs font-medium">Correo electrónico</label>
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="tu@empresa.com"
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium">Contraseña</label>
                <Link
                  to="/login/forgot"
                  className="text-xs text-[var(--accent)] hover:underline"
                >
                  ¿Olvidaste tu contraseña?
                </Link>
              </div>
              <Input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
          </>
        ) : (
          <div className="space-y-2">
            <div className="space-y-1">
              <label className="text-xs font-medium">Código de autenticación (TOTP)</label>
              <Input
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                placeholder="123456"
              />
            </div>
            <div className="flex items-center justify-between text-xs">
              <Link to="/login/recovery" className="text-[var(--accent)] hover:underline">
                Usar código de recuperación
              </Link>
              <button
                type="button"
                onClick={() => {
                  setMfaToken('');
                  setMfaCode('');
                  sessionStorage.removeItem(MFA_TOKEN_SESSION_KEY);
                }}
                className="text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer"
              >
                Cambiar cuenta
              </button>
            </div>
          </div>
        )}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? 'Ingresando...' : mfaToken ? 'Verificar MFA' : 'Iniciar sesión'}
        </Button>
      </form>
      <div className="space-y-2 text-center text-xs text-[var(--text-muted)]">
        <div>
          ¿Nuevo en KoraCRM?{' '}
          <Link to="/signup" className="text-[var(--accent)] font-medium hover:underline">
            Crear una organización
          </Link>
        </div>
        <div>
          <Link to="/login/recovery" className="text-[var(--text-muted)] hover:text-[var(--text)] underline-offset-2 hover:underline">
            ¿Problemas con tu 2FA? Usar código de recuperación
          </Link>
        </div>
      </div>
    </AuthCardShell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [devResetToken, setDevResetToken] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ message?: string; reset_token?: string; token?: string }>('/auth/forgot', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      setSent(true);
      if (res?.reset_token || res?.token) {
        setDevResetToken(res.reset_token || res.token || '');
      }
    } catch (err: any) {
      setError(err.message || 'No se pudo procesar la solicitud.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCardShell
      title="Recuperar contraseña"
      subtitle="Te enviaremos un enlace para restablecer tu acceso"
    >
      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-[var(--danger)]">
          {error}
        </div>
      )}
      {sent ? (
        <div className="space-y-4">
          <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 space-y-1.5">
            <div className="flex items-center gap-1.5 font-semibold">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>Revisa tu correo</span>
            </div>
            <p>
              Si existe una cuenta asociada a <strong>{email}</strong>, recibirás instrucciones para restablecer tu contraseña.
            </p>
          </div>
          {devResetToken && (
            <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--border)] text-xs space-y-2">
              <div className="font-medium text-[var(--text-muted)]">Enlace directo de restablecimiento:</div>
              <Link
                to="/login/reset"
                search={{ token: devResetToken } as any}
                className="text-[var(--accent)] font-medium underline break-all"
              >
                Restablecer contraseña ahora
              </Link>
            </div>
          )}
          <Link to="/login" className="block">
            <Button variant="secondary" className="w-full">
              <ArrowLeft className="w-4 h-4" /> Volver a iniciar sesión
            </Button>
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-medium">Correo electrónico</label>
            <Input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@empresa.com"
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Enviando...' : 'Enviar enlace de recuperación'}
          </Button>
          <div className="text-center text-xs">
            <Link to="/login" className="text-[var(--accent)] font-medium hover:underline">
              Volver a iniciar sesión
            </Link>
          </div>
        </form>
      )}
    </AuthCardShell>
  );
}

export function ResetPasswordPage() {
  const params = new URLSearchParams(window.location.search);
  const initialToken = params.get('token') || '';
  const [token, setResetToken] = useState(initialToken);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (password !== confirm) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    setLoading(true);
    try {
      await apiFetch('/auth/reset', {
        method: 'POST',
        body: JSON.stringify({ token: token.trim(), password, new_password: password }),
      });
      setDone(true);
    } catch (err: any) {
      setError(err.message || 'No se pudo restablecer la contraseña.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCardShell
      title="Restablecer contraseña"
      subtitle="Ingresa una nueva contraseña para tu cuenta"
    >
      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-[var(--danger)]">
          {error}
        </div>
      )}
      {done ? (
        <div className="space-y-4">
          <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>Contraseña actualizada correctamente. Ya puedes iniciar sesión.</span>
          </div>
          <Link to="/login" className="block">
            <Button className="w-full">Ir a iniciar sesión</Button>
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {!initialToken && (
            <div className="space-y-1">
              <label className="text-xs font-medium">Token de recuperación</label>
              <Input
                required
                value={token}
                onChange={(e) => setResetToken(e.target.value)}
                placeholder="Pega el token recibido"
              />
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs font-medium">Nueva contraseña (mín. 8 caracteres)</label>
            <Input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Confirmar nueva contraseña</label>
            <Input
              type="password"
              required
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Guardando...' : 'Guardar nueva contraseña'}
          </Button>
        </form>
      )}
    </AuthCardShell>
  );
}

export function MfaLoginPage({ onAuth }: { onAuth: () => Promise<void> }) {
  const nav = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const initialToken = params.get('token') || sessionStorage.getItem(MFA_TOKEN_SESSION_KEY) || '';
  const [mfaToken, setMfaToken] = useState(initialToken);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch('/auth/mfa/verify', {
        method: 'POST',
        body: JSON.stringify({ mfa_token: mfaToken.trim(), code: code.trim() }),
      });
      sessionStorage.removeItem(MFA_TOKEN_SESSION_KEY);
      setToken(res.access_token);
      await onAuth();
      nav({ to: '/app/inbox' });
    } catch (err: any) {
      setError(err.message || 'Código MFA inválido');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCardShell
      title="Verificación en dos pasos"
      subtitle="Ingresa el código de tu aplicación autenticadora"
    >
      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-[var(--danger)]">
          {error}
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        {!initialToken && (
          <div className="space-y-1">
            <label className="text-xs font-medium">Token MFA</label>
            <Input
              required
              value={mfaToken}
              onChange={(e) => setMfaToken(e.target.value)}
              placeholder="Token temporal de sesión"
            />
          </div>
        )}
        <div className="space-y-1">
          <label className="text-xs font-medium flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-[var(--accent)]" /> Código TOTP (6 dígitos)
          </label>
          <Input
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
          />
        </div>
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? 'Verificando...' : 'Verificar y entrar'}
        </Button>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
        <Link to="/login/recovery" className="text-[var(--accent)] hover:underline">
          Usar código de recuperación
        </Link>
        <Link to="/login" className="hover:text-[var(--text)]">
          Volver al inicio de sesión
        </Link>
      </div>
    </AuthCardShell>
  );
}

export function RecoveryCodePage({ onAuth }: { onAuth: () => Promise<void> }) {
  const nav = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const initialToken = params.get('token') || sessionStorage.getItem(MFA_TOKEN_SESSION_KEY) || '';
  const [mfaToken, setMfaToken] = useState(initialToken);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch('/auth/mfa/verify', {
        method: 'POST',
        body: JSON.stringify({
          mfa_token: mfaToken.trim(),
          recovery_code: recoveryCode.trim(),
        }),
      });
      sessionStorage.removeItem(MFA_TOKEN_SESSION_KEY);
      setToken(res.access_token);
      await onAuth();
      nav({ to: '/app/inbox' });
    } catch (err: any) {
      setError(err.message || 'Código de recuperación inválido');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCardShell
      title="Código de recuperación MFA"
      subtitle="Ingresa uno de tus códigos de respaldo de un solo uso"
    >
      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-[var(--danger)]">
          {error}
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        {!initialToken && (
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
            Inicia sesión primero con tu correo y contraseña para obtener una sesión MFA pendiente, o ingresa el token MFA si lo tienes.
          </div>
        )}
        {!initialToken && (
          <div className="space-y-1">
            <label className="text-xs font-medium">Token MFA</label>
            <Input
              required
              value={mfaToken}
              onChange={(e) => setMfaToken(e.target.value)}
              placeholder="Token temporal de sesión"
            />
          </div>
        )}
        <div className="space-y-1">
          <label className="text-xs font-medium flex items-center gap-1.5">
            <KeyRound className="w-3.5 h-3.5 text-[var(--accent)]" /> Código de recuperación
          </label>
          <Input
            required
            className="font-mono"
            value={recoveryCode}
            onChange={(e) => setRecoveryCode(e.target.value)}
            placeholder="XXXX-XXXX"
          />
        </div>
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? 'Verificando...' : 'Acceder con código de recuperación'}
        </Button>
      </form>
      <div className="text-center text-xs">
        <Link to="/login" className="text-[var(--accent)] font-medium hover:underline">
          Volver a iniciar sesión
        </Link>
      </div>
    </AuthCardShell>
  );
}

export function SignupPage({ onAuth }: { onAuth: () => Promise<void> }) {
  const nav = useNavigate();
  const [orgName, setOrgName] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch('/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ org_name: orgName, full_name: fullName, email, password }),
      });
      setToken(res.access_token);
      await onAuth();
      nav({ to: '/onboarding' });
    } catch (err: any) {
      setError(err.message || 'Error al crear cuenta');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCardShell
      title="Crea tu Espacio CRM"
      subtitle="Incluye embudos de Ventas/Soporte y Agente de IA"
    >
      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-[var(--danger)]">
          {error}
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-3.5">
        <div className="space-y-1">
          <label className="text-xs font-medium">Nombre de la organización</label>
          <Input
            required
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="Comercial Acme"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium">Tu nombre</label>
          <Input
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Ana Silva"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium">Correo electrónico</label>
          <Input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ana@acme.com"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium">Contraseña (mín. 6 caracteres)</label>
          <Input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? 'Creando espacio...' : 'Crear Espacio de Trabajo'}
        </Button>
      </form>
      <div className="text-center text-xs text-[var(--text-muted)]">
        ¿Ya tienes una cuenta?{' '}
        <Link to="/login" className="text-[var(--accent)] font-medium hover:underline">
          Iniciar sesión
        </Link>
      </div>
    </AuthCardShell>
  );
}
