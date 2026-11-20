import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Trash2, UserPlus, Users } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAuth } from '../App';
import { Badge, Button, Card, Input, Sheet } from '../components/ui/primitives';

interface TeamMember {
  id: string;
  user_id?: string;
  full_name: string;
  email: string;
  role: 'viewer' | 'agent' | 'manager' | 'admin';
  is_available?: boolean;
  max_concurrent_chats?: number;
}

interface TeamInvite {
  id: string;
  email: string;
  role: 'viewer' | 'agent' | 'manager' | 'admin';
  token?: string;
  status?: string;
  expires_at?: string;
  accepted_at?: string | null;
  created_at?: string;
}

export function TeamPage() {
  const { user } = useAuth();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'viewer' | 'agent' | 'manager' | 'admin'>('agent');
  const [inviting, setInviting] = useState(false);
  const [copiedId, setCopiedId] = useState<string>('');
  const [createdInviteLink, setCreatedInviteLink] = useState<string>('');
  const [copiedCreatedLink, setCopiedCreatedLink] = useState(false);
  const [inviteTokensById, setInviteTokensById] = useState<Record<string, string>>({});

  const [capacityDrafts, setCapacityDrafts] = useState<Record<string, string>>({});

  const loadData = useCallback(async () => {
    setError('');
    try {
      const [teamRes, invRes] = await Promise.all([
        apiFetch<TeamMember[]>('/team'),
        apiFetch<TeamInvite[]>('/team/invites').catch(() => [] as TeamInvite[]),
      ]);
      const list = teamRes || [];
      setMembers(list);
      const drafts: Record<string, string> = {};
      for (const m of list) {
        drafts[m.id] = String(m.max_concurrent_chats ?? 5);
      }
      setCapacityDrafts(drafts);
      setInvites(invRes || []);
    } catch (err: any) {
      setError(err.message || 'No se pudo cargar el equipo.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function updateMember(memberId: string, patch: Record<string, any>) {
    setError('');
    setNotice('');
    try {
      await apiFetch(`/team/members/${memberId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setNotice('Miembro actualizado correctamente.');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'No se pudo actualizar el miembro.');
    }
  }

  async function removeMember(memberId: string) {
    setError('');
    setNotice('');
    try {
      await apiFetch(`/team/members/${memberId}`, { method: 'DELETE' });
      setNotice('Miembro eliminado del equipo.');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'No se pudo eliminar el miembro.');
    }
  }

  async function createInvite(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    setInviting(true);
    try {
      const res = await apiFetch<{ invite?: TeamInvite; token?: string }>('/team/invites', {
        method: 'POST',
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      if (res?.token) {
        const link = `${window.location.origin}/team/accept-invite/${res.token}`;
        setCreatedInviteLink(link);
        setCopiedCreatedLink(false);
        const inviteId = res.invite?.id;
        if (inviteId && res.token) {
          setInviteTokensById((prev) => ({ ...prev, [inviteId]: res.token! }));
        }
      }
      setInviteEmail('');
      setInviteRole('agent');
      setInviteOpen(false);
      setNotice('Invitación enviada correctamente.');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'No se pudo crear la invitación.');
    } finally {
      setInviting(false);
    }
  }

  async function revokeInvite(inviteId: string) {
    setError('');
    setNotice('');
    try {
      await apiFetch(`/team/invites/${inviteId}`, { method: 'DELETE' });
      setNotice('Invitación revocada.');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'No se pudo revocar la invitación.');
    }
  }

  function copyInviteLink(inv: TeamInvite) {
    const token = inviteTokensById[inv.id];
    if (!token) return;
    const url = `${window.location.origin}/team/accept-invite/${token}`;
    navigator.clipboard?.writeText(url);
    setCopiedId(inv.id);
    window.setTimeout(() => setCopiedId(''), 2000);
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-5xl min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Users className="w-5 h-5 text-[var(--accent)] shrink-0" />
            <span>Equipo y Permisos (RBAC)</span>
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            Administra roles, disponibilidad para auto-ruteo, capacidad de chats e invitaciones
          </p>
        </div>
        <Button onClick={() => setInviteOpen(true)}>
          <UserPlus className="w-4 h-4" /> Invitar miembro
        </Button>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-[var(--danger)]">
          {error}
        </div>
      )}
      {notice && (
        <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900">
          {notice}
        </div>
      )}
      {createdInviteLink && (
        <div className="p-3.5 rounded-xl bg-teal-50 border border-teal-200 text-xs space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-teal-900">
              Enlace de invitación de un solo uso (guárdalo ahora):
            </span>
            <button
              type="button"
              onClick={() => setCreatedInviteLink('')}
              className="text-teal-800 hover:underline cursor-pointer"
            >
              Cerrar
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="flex-1 min-w-0 font-mono break-all bg-[var(--bg)] p-2 rounded border border-[var(--border)]">
              {createdInviteLink}
            </code>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                navigator.clipboard?.writeText(createdInviteLink);
                setCopiedCreatedLink(true);
                window.setTimeout(() => setCopiedCreatedLink(false), 2000);
              }}
            >
              {copiedCreatedLink ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedCreatedLink ? 'Copiado' : 'Copiar enlace'}
            </Button>
          </div>
        </div>
      )}

      {/* Miembros activos */}
      <Card className="p-4 md:p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Miembros activos ({members.length})</h2>
        </div>

        {loading ? (
          <div className="text-xs text-[var(--text-muted)] py-4">Cargando miembros...</div>
        ) : members.length === 0 ? (
          <div className="text-xs text-[var(--text-muted)] py-4">No hay miembros registrados.</div>
        ) : (
          <div className="space-y-3">
            {members.map((m) => {
              const isSelf = user?.id === m.id || user?.id === m.user_id || user?.email === m.email;
              return (
                <div
                  key={m.id}
                  className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] flex flex-col md:flex-row md:items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-sm flex items-center gap-2 flex-wrap">
                      <span className="truncate">{m.full_name}</span>
                      {isSelf && <Badge tone="accent">Tú</Badge>}
                    </div>
                    <div className="text-xs text-[var(--text-muted)] truncate">{m.email}</div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    <select
                      aria-label={`Rol de ${m.full_name}`}
                      value={m.role}
                      disabled={isSelf}
                      onChange={(e) => updateMember(m.id, { role: e.target.value })}
                      className="h-9 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-2.5 text-xs"
                    >
                      <option value="viewer">Visor (viewer)</option>
                      <option value="agent">Agente (agent)</option>
                      <option value="manager">Gerente (manager)</option>
                      <option value="admin">Admin (admin)</option>
                    </select>

                    <button
                      type="button"
                      onClick={() => updateMember(m.id, { is_available: !(m.is_available ?? true) })}
                      className={`h-9 px-3 rounded-[10px] border text-xs font-medium cursor-pointer ${
                        (m.is_available ?? true)
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                          : 'bg-slate-100 border-[var(--border)] text-[var(--text-muted)]'
                      }`}
                    >
                      {(m.is_available ?? true) ? 'Disponible' : 'No disponible'}
                    </button>

                    <div className="flex items-center gap-1.5">
                      <label className="text-[11px] text-[var(--text-muted)]">Máx. chats:</label>
                      <Input
                        type="number"
                        min={1}
                        max={100}
                        className="w-16 h-9 text-xs"
                        value={capacityDrafts[m.id] ?? String(m.max_concurrent_chats ?? 5)}
                        onChange={(e) =>
                          setCapacityDrafts((prev) => ({ ...prev, [m.id]: e.target.value }))
                        }
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          updateMember(m.id, {
                            max_concurrent_chats: parseInt(capacityDrafts[m.id] || '5', 10) || 5,
                          })
                        }
                      >
                        Guardar
                      </Button>
                    </div>

                    {!isSelf && (
                      <Button
                        size="sm"
                        variant="danger"
                        aria-label={`Eliminar a ${m.full_name}`}
                        onClick={() => removeMember(m.id)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Invitaciones pendientes */}
      <Card className="p-4 md:p-5 space-y-3">
        <h2 className="text-sm font-semibold">Invitaciones pendientes ({invites.length})</h2>
        {invites.length === 0 ? (
          <div className="text-xs text-[var(--text-muted)] py-2">
            No hay invitaciones pendientes en este momento.
          </div>
        ) : (
          <div className="space-y-2.5">
            {invites.map((inv) => {
              const isAccepted = inv.accepted_at != null;
              const hasSessionToken = Boolean(inviteTokensById[inv.id]);
              return (
                <div
                  key={inv.id}
                  className="p-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] flex flex-wrap items-center justify-between gap-2"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="text-sm font-medium truncate">{inv.email}</div>
                    <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                      <Badge tone="accent">{inv.role}</Badge>
                      {isAccepted && <Badge tone="success">Aceptada</Badge>}
                      {inv.expires_at && !isAccepted && (
                        <span>Expira: {new Date(inv.expires_at).toLocaleDateString('es')}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {!isAccepted && hasSessionToken && (
                      <Button size="sm" variant="secondary" onClick={() => copyInviteLink(inv)}>
                        {copiedId === inv.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        {copiedId === inv.id ? 'Copiado' : 'Copiar enlace'}
                      </Button>
                    )}
                    {!isAccepted && (
                      <Button size="sm" variant="danger" onClick={() => revokeInvite(inv.id)}>
                        Revocar
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Modal / Sheet para invitar miembro */}
      <Sheet open={inviteOpen} onClose={() => setInviteOpen(false)} title="Invitar nuevo miembro">
        <form onSubmit={createInvite} className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-medium">Correo electrónico</label>
            <Input
              type="email"
              required
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="colaborador@empresa.com"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Rol en la organización</label>
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as any)}
              className="h-10 w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
            >
              <option value="agent">Agente — Atiende bandeja y leads</option>
              <option value="manager">Gerente — Configura canales, IA y equipo</option>
              <option value="viewer">Visor — Solo lectura</option>
              <option value="admin">Administrador — Control total</option>
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setInviteOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={inviting}>
              {inviting ? 'Enviando...' : 'Enviar invitación'}
            </Button>
          </div>
        </form>
      </Sheet>
    </div>
  );
}
