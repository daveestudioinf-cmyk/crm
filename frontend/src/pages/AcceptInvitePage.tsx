import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { AlertTriangle, CheckCircle2, Clock, UserPlus } from 'lucide-react';
import { apiFetch, setToken } from '../lib/api';
import { useAuth } from '../App';
import { Badge, Button, Card, Input } from '../components/ui/primitives';

interface InviteDetails {
  valid: boolean;
  expired: boolean;
  accepted: boolean;
  email: string;
  role: string;
  organization_name?: string;
}

type InviteState = 'loading' | 'valid' | 'expired' | 'already_accepted' | 'invalid';

export function AcceptInvitePage() {
  const params = useParams({ strict: false }) as { token?: string };
  const token = params.token || '';
  const nav = useNavigate();
  const { refreshUser } = useAuth();

  const [state, setState] = useState<InviteState>('loading');
  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    async function validate() {
      if (!token) {
        setState('invalid');
        return;
      }
      try {
        const res = await apiFetch<InviteDetails>(`/team/invites/${encodeURIComponent(token)}`);
        if (!active) return;
        setInvite(res);
        if (res.accepted) {
          setState('already_accepted');
        } else if (res.expired) {
          setState('expired');
        } else if (res.valid) {
          setState('valid');
        } else {
          setState('invalid');
        }
      } catch (err: any) {
        if (!active) return;
        const msg = (err?.message || '').toLowerCase();
        if (msg.includes('expir')) {
          setState('expired');
        } else if (msg.includes('aceptad') || msg.includes('accepted')) {
          setState('already_accepted');
        } else {
          setState('invalid');
        }
      }
    }
    validate();
    return () => {
      active = false;
    };
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch<{ access_token: string }>('/team/accept-invite', {
        method: 'POST',
        body: JSON.stringify({
          token,
          full_name: fullName.trim(),
          password,
        }),
      });
      setToken(res.access_token);
      await refreshUser();
      nav({ to: '/app/inbox' });
    } catch (err: any) {
      setError(err.message || 'No se pudo aceptar la invitación.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center p-4 bg-[var(--surface)] text-[var(--text)]">
      <Card className="w-full max-w-md p-6 space-y-5">
        <div className="flex items-center gap-2.5">
          <img src="/icon.svg" alt="KoraCRM" className="w-8 h-8 rounded-lg shrink-0" />
          <div className="min-w-0">
            <h1 className="text-xl font-bold truncate">Unirse al equipo en KoraCRM</h1>
            <p className="text-xs text-[var(--text-muted)]">Aceptar invitación a organización</p>
          </div>
        </div>

        {state === 'loading' && (
          <div className="py-8 text-center text-sm text-[var(--text-muted)]">
            Validando invitación...
          </div>
        )}

        {state === 'expired' && (
          <div className="space-y-4 text-center py-2">
            <div className="mx-auto w-11 h-11 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center text-[var(--warning)]">
              <Clock className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <h2 className="font-semibold text-base">Invitación expirada</h2>
              <p className="text-xs text-[var(--text-muted)]">
                Este enlace de invitación ha caducado. Solicita a un administrador que te envíe una nueva invitación.
              </p>
            </div>
            <Link to="/login" className="block">
              <Button variant="secondary" className="w-full">Ir a iniciar sesión</Button>
            </Link>
          </div>
        )}

        {state === 'already_accepted' && (
          <div className="space-y-4 text-center py-2">
            <div className="mx-auto w-11 h-11 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center text-[var(--success)]">
              <CheckCircle2 className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <h2 className="font-semibold text-base">Invitación ya aceptada</h2>
              <p className="text-xs text-[var(--text-muted)]">
                Esta invitación ya fue utilizada anteriormente. Inicia sesión con tu correo y contraseña.
              </p>
            </div>
            <Link to="/login" className="block">
              <Button className="w-full">Iniciar sesión</Button>
            </Link>
          </div>
        )}

        {state === 'invalid' && (
          <div className="space-y-4 text-center py-2">
            <div className="mx-auto w-11 h-11 rounded-full bg-red-50 border border-red-200 flex items-center justify-center text-[var(--danger)]">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <h2 className="font-semibold text-base">Invitación no válida</h2>
              <p className="text-xs text-[var(--text-muted)]">
                El enlace no existe o fue revocado por un administrador.
              </p>
            </div>
            <Link to="/" className="block">
              <Button variant="secondary" className="w-full">Ir al inicio</Button>
            </Link>
          </div>
        )}

        {state === 'valid' && invite && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="p-3.5 rounded-xl bg-[var(--surface)] border border-[var(--border)] space-y-1.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-muted)]">Organización:</span>
                <span className="font-semibold truncate">{invite.organization_name || 'KoraCRM'}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-muted)]">Correo:</span>
                <span className="font-mono truncate">{invite.email}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-muted)]">Rol asignado:</span>
                <Badge tone="accent">{invite.role}</Badge>
              </div>
            </div>

            {error && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-[var(--danger)]">
                {error}
              </div>
            )}

            <div className="space-y-1">
              <label htmlFor="invite-full-name" className="text-xs font-medium">Tu nombre completo</label>
              <Input
                id="invite-full-name"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Tu nombre completo"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="invite-password" className="text-xs font-medium">Contraseña (mín. 8 caracteres)</label>
              <Input
                id="invite-password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Mínimo 8 caracteres"
              />
            </div>

            <Button type="submit" className="w-full" disabled={submitting}>
              <UserPlus className="w-4 h-4" />
              {submitting ? 'Creando acceso...' : 'Aceptar invitación y entrar'}
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
