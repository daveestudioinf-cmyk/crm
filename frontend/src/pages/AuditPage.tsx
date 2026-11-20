import React, { useEffect, useState } from 'react';
import { Filter, Headset, Search, ShieldCheck } from 'lucide-react';
import { type AuditLogEntry, apiFetch } from '../lib/api';
import { Badge, Button, Card, Input } from '../components/ui/primitives';
import { AnalyticsSubNav } from './MetricsPage';

export function AuditPage() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (actor.trim()) params.set('actor', actor.trim());
      if (action.trim()) params.set('action', action.trim());
      if (resourceType.trim()) params.set('resource_type', resourceType.trim());
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (q.trim()) params.set('q', q.trim());
      const qs = params.toString() ? `?${params.toString()}` : '';
      const res = await apiFetch<AuditLogEntry[]>(`/audit${qs}`);
      setEntries(Array.isArray(res) ? res : []);
    } catch (err: any) {
      setError(err?.message || 'No se pudo cargar el registro de auditoría.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void load();
  }

  function resetFilters() {
    setActor('');
    setAction('');
    setResourceType('');
    setFrom('');
    setTo('');
    setQ('');
    setTimeout(() => void load(), 0);
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-6xl min-w-0">
      <div>
        <h1 className="text-xl font-bold">Auditoría Inmutable (Retención 5 años)</h1>
        <p className="text-xs text-[var(--text-muted)]">
          Registro cronológico de mutaciones, sesiones de soporte y cumplimiento normativo
        </p>
      </div>

      <AnalyticsSubNav active="audit" />

      <Card className="p-4 space-y-3 min-w-0">
        <div className="text-xs font-semibold flex items-center gap-1.5 text-[var(--text-muted)]">
          <Filter className="w-3.5 h-3.5" /> Filtros avanzados
        </div>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          <Input placeholder="Búsqueda libre (q)" value={q} onChange={(e) => setQ(e.target.value)} />
          <Input placeholder="Actor (ID o correo)" value={actor} onChange={(e) => setActor(e.target.value)} />
          <Input placeholder="Acción (ej. lead.update)" value={action} onChange={(e) => setAction(e.target.value)} />
          <Input
            placeholder="Recurso (ej. contact, lead, lgpd_request)"
            value={resourceType}
            onChange={(e) => setResourceType(e.target.value)}
          />
          <Input type="date" aria-label="Fecha desde" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input type="date" aria-label="Fecha hasta" value={to} onChange={(e) => setTo(e.target.value)} />
          <div className="sm:col-span-2 lg:col-span-3 flex flex-wrap gap-2">
            <Button type="submit" size="sm">
              <Search className="w-3.5 h-3.5" /> Aplicar filtros
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={resetFilters}>
              Limpiar filtros
            </Button>
          </div>
        </form>
      </Card>

      {error && (
        <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-[var(--danger)]">
          {error}
        </div>
      )}

      <Card className="p-4 space-y-3 min-w-0">
        <div className="font-semibold text-sm flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-[var(--accent)]" /> Eventos Auditados ({entries.length})
        </div>

        {loading ? (
          <div className="text-xs text-[var(--text-muted)] py-4">Cargando registros de auditoría...</div>
        ) : entries.length === 0 ? (
          <div className="text-xs text-[var(--text-muted)] py-4">
            No hay registros de auditoría para los filtros seleccionados.
          </div>
        ) : (
          <>
            {/* Tabla escritorio */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-xs text-left border-collapse">
                <thead>
                  <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                    <th className="py-2 pr-3 font-medium">Fecha</th>
                    <th className="py-2 px-3 font-medium">Acción</th>
                    <th className="py-2 px-3 font-medium">Recurso</th>
                    <th className="py-2 px-3 font-medium">Actor</th>
                    <th className="py-2 pl-3 font-medium">IP / Metadatos</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id} className="border-b border-[var(--border)] last:border-0 align-top">
                      <td className="py-2.5 pr-3 whitespace-nowrap text-[var(--text-muted)]">
                        {new Date(e.created_at).toLocaleString('es')}
                      </td>
                      <td className="py-2.5 px-3 font-mono font-semibold">{e.action}</td>
                      <td className="py-2.5 px-3">
                        <Badge tone="neutral">{e.resource_type}</Badge>
                        {e.resource_id && (
                          <div className="text-[11px] font-mono text-[var(--text-muted)] mt-0.5">
                            {e.resource_id.slice(0, 12)}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="font-medium">
                          {e.actor_name || e.actor_email || (e.actor_user_id ? e.actor_user_id.slice(0, 8) : 'Sistema')}
                        </div>
                        {e.support_session_id && (
                          <Badge tone="warning" className="mt-1">
                            <Headset className="w-3 h-3" /> Soporte
                          </Badge>
                        )}
                      </td>
                      <td className="py-2.5 pl-3 text-[11px] text-[var(--text-muted)] max-w-xs break-all">
                        {e.ip_address && <div>IP: {e.ip_address}</div>}
                        {e.metadata && Object.keys(e.metadata).length > 0 && (
                          <code className="block truncate">{JSON.stringify(e.metadata)}</code>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Tarjetas móvil */}
            <div className="md:hidden space-y-2.5">
              {entries.map((e) => (
                <div
                  key={e.id}
                  className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-xs space-y-1.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono font-semibold">{e.action}</span>
                    <Badge tone="neutral">{e.resource_type}</Badge>
                  </div>
                  <div className="text-[11px] text-[var(--text-muted)]">
                    {new Date(e.created_at).toLocaleString('es')}
                  </div>
                  <div className="text-[11px]">
                    Actor:{' '}
                    <strong>
                      {e.actor_name || e.actor_email || (e.actor_user_id ? e.actor_user_id.slice(0, 8) : 'Sistema')}
                    </strong>
                    {e.support_session_id && (
                      <Badge tone="warning" className="ml-2">Soporte</Badge>
                    )}
                  </div>
                  {e.ip_address && (
                    <div className="text-[11px] text-[var(--text-muted)]">IP: {e.ip_address}</div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
