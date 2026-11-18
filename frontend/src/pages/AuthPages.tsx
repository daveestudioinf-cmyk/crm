import React, { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { apiFetch, setToken } from '../lib/api';
import { Button, Card, Input } from '../components/ui/primitives';

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
    <div className="min-h-dvh flex items-center justify-center p-4 bg-[var(--surface)]">
      <Card className="w-full max-w-md p-6 space-y-5">
        <div className="flex items-center gap-2.5">
          <img src="/icon.svg" alt="KoraCRM" className="w-8 h-8 rounded-lg" />
          <div>
            <h1 className="text-xl font-bold">Iniciar sesión en KoraCRM</h1>
            <p className="text-xs text-[var(--text-muted)]">Accede a tu espacio de ventas por WhatsApp</p>
          </div>
        </div>
        {error && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-[var(--danger)]">{error}</div>}
        <form onSubmit={handleSubmit} className="space-y-4">
          {!mfaToken ? (
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium">Correo electrónico</label>
                <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@empresa.com" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Contraseña</label>
                <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
              </div>
            </>
          ) : (
            <div className="space-y-1">
              <label className="text-xs font-medium">Código de autenticación (TOTP)</label>
              <Input required value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} placeholder="123456" />
            </div>
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Ingresando...' : mfaToken ? 'Verificar MFA' : 'Iniciar sesión'}
          </Button>
        </form>
        <div className="text-center text-xs text-[var(--text-muted)]">
          ¿Nuevo en KoraCRM? <Link to="/signup" className="text-[var(--accent)] font-medium">Crear una organización</Link>
        </div>
      </Card>
    </div>
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
      nav({ to: '/app/inbox' });
    } catch (err: any) {
      setError(err.message || 'Error al crear cuenta');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center p-4 bg-[var(--surface)]">
      <Card className="w-full max-w-md p-6 space-y-5">
        <div className="flex items-center gap-2.5">
          <img src="/icon.svg" alt="KoraCRM" className="w-8 h-8 rounded-lg" />
          <div>
            <h1 className="text-xl font-bold">Crea tu Espacio CRM</h1>
            <p className="text-xs text-[var(--text-muted)]">Incluye embudos de Ventas/Soporte y Agente de IA</p>
          </div>
        </div>
        {error && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-[var(--danger)]">{error}</div>}
        <form onSubmit={handleSubmit} className="space-y-3.5">
          <div className="space-y-1">
            <label className="text-xs font-medium">Nombre de la organización</label>
            <Input required value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Comercial Acme" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Tu nombre</label>
            <Input required value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Ana Silva" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Correo electrónico</label>
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ana@acme.com" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Contraseña (mín. 6 caracteres)</label>
            <Input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Creando espacio...' : 'Crear Espacio de Trabajo'}
          </Button>
        </form>
        <div className="text-center text-xs text-[var(--text-muted)]">
          ¿Ya tienes una cuenta? <Link to="/login" className="text-[var(--accent)] font-medium">Iniciar sesión</Link>
        </div>
      </Card>
    </div>
  );
}
