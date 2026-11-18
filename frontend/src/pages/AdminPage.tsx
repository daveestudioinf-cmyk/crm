import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Building2,
  Headset,
  Lock,
  Search,
  ShieldAlert,
  ShieldCheck,
  Users,
  MessageSquare,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import {
  type AdminMetrics,
  type AdminTenant,
  type User,
  fetchAdminMetrics,
  fetchAdminTenants,
  setSupportSession,
  startAdminSupportSession,
  updateAdminTenantStatus,
} from '../lib/api';
import { Badge, Button, Card, Input, Sheet } from '../components/ui/primitives';

export function AdminPage({ user }: { user: User | null }) {
  const navigate = useNavigate();
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [total, setTotal] = useState(0);
  const [limit] = useState(10);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'suspended'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyTenantId, setBusyTenantId] = useState<string | null>(null);

  const [supportTarget, setSupportTarget] = useState<AdminTenant | null>(null);
  const [supportReason, setSupportReason] = useState('');
  const [supportError, setSupportError] = useState('');
  const [startingSupport, setStartingSupport] = useState(false);

  async function loadData(currentOffset = offset) {
    setLoading(true);
    setError('');
    try {
      const isSuspParam =
        statusFilter === 'active' ? 'false' : statusFilter === 'suspended' ? 'true' : undefined;
      const [m, t] = await Promise.all([
        fetchAdminMetrics(),
        fetchAdminTenants({ limit, offset: currentOffset, q: q.trim(), is_suspended: isSuspParam }),
      ]);
      setMetrics(m);
      setTenants(t.items || []);
      setTotal(t.total || 0);
    } catch (err: any) {
      setError(err.message || 'Error al cargar la consola Super-Admin.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (user?.is_platform_admin) {
      loadData(offset);
    }
  }, [user?.is_platform_admin, offset, statusFilter]);

  if (!user?.is_platform_admin) {
    return (
      <div className="p-6 max-w-xl mx-auto">
        <Card className="p-6 text-center space-y-3">
          <ShieldAlert className="w-10 h-10 text-[var(--danger)] mx-auto" />
          <h1 className="text-lg font-bold">Acceso restringido</h1>
          <p className="text-sm text-[var(--text-muted)]">
            Esta consola está reservada para administradores de plataforma (Super-Admin).
          </p>
          <Link to="/app/inbox">
            <Button variant="secondary">Volver a Bandeja</Button>
          </Link>
        </Card>
      </div>
    );
  }

  async function handleToggleSuspend(tenant: AdminTenant) {
    setBusyTenantId(tenant.id);
    setError('');
    try {
      const nextSuspended = !tenant.is_suspended;
      await updateAdminTenantStatus(
        tenant.id,
        nextSuspended,
        nextSuspended ? 'Suspendido desde consola Super-Admin' : 'Reactivado desde consola Super-Admin'
      );
      await loadData(offset);
    } catch (err: any) {
      setError(err.message || 'No se pudo actualizar el estado de la organización.');
    } finally {
      setBusyTenantId(null);
    }
  }

  async function handleStartSupport(e: React.FormEvent) {
    e.preventDefault();
    if (!supportTarget) return;
    const reason = supportReason.trim();
    if (!reason) {
      setSupportError('El motivo de la sesión de soporte es obligatorio.');
      return;
    }
    setStartingSupport(true);
    setSupportError('');
    try {
      const sess = await startAdminSupportSession({
        target_organization_id: supportTarget.id,
        reason,
        mode: 'support_readonly',
        ttl_minutes: 60,
      });
      setSupportSession(sess);
      setSupportTarget(null);
      setSupportReason('');
      navigate({ to: '/app/inbox' });
    } catch (err: any) {
      setSupportError(err.message || 'No se pudo iniciar la sesión de soporte.');
    } finally {
      setStartingSupport(false);
    }
  }

  const showingFrom = total === 0 ? 0 : offset + 1;
  const showingTo = Math.min(offset + limit, total);

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-[var(--accent)]" />
            <h1 className="text-xl font-bold tracking-tight">Consola Super-Admin</h1>
          </div>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Gobernanza multi-tenant, suspensión inmediata y sesiones de soporte auditadas (TTL 1h).
          </p>
        </div>
        <Link to="/app/inbox">
          <Button variant="secondary" size="sm">
            Volver al CRM
          </Button>
        </Link>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}

      {/* KPIs Globales */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card className="p-4">
          <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span>Organizaciones</span>
            <Building2 className="w-4 h-4 text-[var(--accent)]" />
          </div>
          <div className="text-2xl font-bold mt-1">{metrics?.total_tenants ?? '—'}</div>
          <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
            {metrics ? `${metrics.active_tenants} activas · ${metrics.suspended_tenants} suspendidas` : 'Cargando...'}
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span>Usuarios totales</span>
            <Users className="w-4 h-4 text-[var(--accent)]" />
          </div>
          <div className="text-2xl font-bold mt-1">{metrics?.total_users ?? '—'}</div>
          <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
            {metrics ? `${metrics.total_contacts} contactos registrados` : 'Cargando...'}
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span>Conversaciones</span>
            <MessageSquare className="w-4 h-4 text-[var(--accent)]" />
          </div>
          <div className="text-2xl font-bold mt-1">{metrics?.total_conversations ?? '—'}</div>
          <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
            {metrics ? `${metrics.total_messages} mensajes procesados` : 'Cargando...'}
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span>Soporte activo</span>
            <Headset className="w-4 h-4 text-amber-600" />
          </div>
          <div className="text-2xl font-bold mt-1">{metrics?.active_support_sessions ?? '—'}</div>
          <div className="text-[11px] text-[var(--text-muted)] mt-0.5">Sesiones TTL 1h vigentes</div>
        </Card>
      </div>

      {/* Filtros y búsqueda */}
      <Card className="p-4 space-y-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setOffset(0);
            loadData(0);
          }}
          className="flex flex-col sm:flex-row gap-2.5"
        >
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-[var(--text-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar organización por nombre o slug..."
              className="pl-9"
            />
          </div>
          <select
            aria-label="Filtrar por estado"
            value={statusFilter}
            onChange={(e) => {
              setOffset(0);
              setStatusFilter(e.target.value as 'all' | 'active' | 'suspended');
            }}
            className="h-10 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
          >
            <option value="all">Todos los estados</option>
            <option value="active">Solo activos</option>
            <option value="suspended">Solo suspendidos</option>
          </select>
          <Button type="submit" variant="secondary">
            Buscar
          </Button>
        </form>

        {/* Vista escritorio: tabla */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--text-muted)]">
                <th className="py-2.5 pr-3 font-medium">Organización</th>
                <th className="py-2.5 px-3 font-medium">Estado</th>
                <th className="py-2.5 px-3 font-medium">Usuarios</th>
                <th className="py-2.5 px-3 font-medium">Contactos</th>
                <th className="py-2.5 px-3 font-medium">Conversaciones</th>
                <th className="py-2.5 pl-3 text-right font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading && tenants.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-[var(--text-muted)]">
                    Cargando organizaciones...
                  </td>
                </tr>
              ) : tenants.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-[var(--text-muted)]">
                    No se encontraron organizaciones.
                  </td>
                </tr>
              ) : (
                tenants.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50/60">
                    <td className="py-3 pr-3">
                      <div className="font-semibold text-[var(--text)]">{t.name}</div>
                      <div className="text-xs text-[var(--text-muted)]">{t.slug}</div>
                    </td>
                    <td className="py-3 px-3">
                      {t.is_suspended ? (
                        <Badge tone="danger">Suspendido</Badge>
                      ) : (
                        <Badge tone="success">Activo</Badge>
                      )}
                    </td>
                    <td className="py-3 px-3 tabular-nums">{t.users_count}</td>
                    <td className="py-3 px-3 tabular-nums">{t.contacts_count}</td>
                    <td className="py-3 px-3 tabular-nums">{t.conversations_count}</td>
                    <td className="py-3 pl-3">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setSupportTarget(t);
                            setSupportReason('');
                            setSupportError('');
                          }}
                        >
                          <Headset className="w-3.5 h-3.5" />
                          Soporte (1h)
                        </Button>
                        <Button
                          size="sm"
                          variant={t.is_suspended ? 'primary' : 'danger'}
                          disabled={busyTenantId === t.id}
                          onClick={() => handleToggleSuspend(t)}
                        >
                          {t.is_suspended ? 'Activar' : 'Suspender'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Vista móvil: tarjetas sin scroll horizontal */}
        <div className="md:hidden space-y-2.5">
          {loading && tenants.length === 0 ? (
            <div className="py-6 text-center text-sm text-[var(--text-muted)]">Cargando organizaciones...</div>
          ) : tenants.length === 0 ? (
            <div className="py-6 text-center text-sm text-[var(--text-muted)]">No se encontraron organizaciones.</div>
          ) : (
            tenants.map((t) => (
              <div
                key={t.id}
                className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3.5 space-y-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-sm truncate">{t.name}</div>
                    <div className="text-xs text-[var(--text-muted)] truncate">{t.slug}</div>
                  </div>
                  {t.is_suspended ? (
                    <Badge tone="danger">Suspendido</Badge>
                  ) : (
                    <Badge tone="success">Activo</Badge>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs text-[var(--text-muted)]">
                  <div>Usuarios: <strong className="text-[var(--text)]">{t.users_count}</strong></div>
                  <div>Contactos: <strong className="text-[var(--text)]">{t.contacts_count}</strong></div>
                  <div>Chats: <strong className="text-[var(--text)]">{t.conversations_count}</strong></div>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="flex-1"
                    onClick={() => {
                      setSupportTarget(t);
                      setSupportReason('');
                      setSupportError('');
                    }}
                  >
                    <Headset className="w-3.5 h-3.5" />
                    Soporte (1h)
                  </Button>
                  <Button
                    size="sm"
                    variant={t.is_suspended ? 'primary' : 'danger'}
                    className="flex-1"
                    disabled={busyTenantId === t.id}
                    onClick={() => handleToggleSuspend(t)}
                  >
                    {t.is_suspended ? 'Activar' : 'Suspender'}
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Paginación */}
        <div className="flex items-center justify-between pt-2 border-t border-[var(--border)] text-xs text-[var(--text-muted)]">
          <span>
            Mostrando {showingFrom}–{showingTo} de {total}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - limit))}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              Anterior
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={offset + limit >= total}
              onClick={() => setOffset(offset + limit)}
            >
              Siguiente
              <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </Card>

      {/* Modal de Sesión de Soporte */}
      <Sheet
        open={Boolean(supportTarget)}
        onClose={() => setSupportTarget(null)}
        title="Iniciar sesión de soporte"
      >
        {supportTarget && (
          <form onSubmit={handleStartSupport} className="space-y-4">
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-1">
              <div className="flex items-center gap-1.5 font-semibold">
                <Lock className="w-3.5 h-3.5" />
                Modo Solo Lectura (TTL 1 hora)
              </div>
              <p>
                Ingresarás a <strong>{supportTarget.name}</strong> ({supportTarget.slug}) con permisos de lectura para
                diagnóstico (incluso si está suspendido). Todas las mutaciones estarán bloqueadas y cada acción quedará
                registrada en el log de auditoría.
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="support-reason" className="block text-xs font-semibold text-[var(--text)]">
                Motivo de la sesión (obligatorio)
              </label>
              <textarea
                id="support-reason"
                rows={3}
                value={supportReason}
                onChange={(e) => setSupportReason(e.target.value)}
                placeholder="Ej. Diagnóstico de webhook WhatsApp y revisión de contactos"
                className="w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                required
              />
            </div>

            {supportError && (
              <div className="text-xs text-[var(--danger)]">{supportError}</div>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setSupportTarget(null)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={startingSupport}>
                {startingSupport ? 'Iniciando...' : 'Iniciar soporte (1h)'}
              </Button>
            </div>
          </form>
        )}
      </Sheet>
    </div>
  );
}
