import React, { useEffect, useState } from 'react';
import { Activity, Filter, Search } from 'lucide-react';
import { type ActivityItem, apiFetch } from '../lib/api';
import { Badge, Button, Card, Input } from '../components/ui/primitives';
import { AnalyticsSubNav } from './MetricsPage';

const ACTIVITY_TYPES = [
  { value: '', label: 'Todos los tipos' },
  { value: 'note', label: 'Nota' },
  { value: 'call', label: 'Llamada' },
  { value: 'email', label: 'Correo' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'stage_change', label: 'Cambio de etapa' },
  { value: 'task', label: 'Tarea' },
  { value: 'meeting', label: 'Reunión' },
];

export function ActivitiesPage() {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activityType, setActivityType] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');

  async function load(overrides?: { type?: string; from?: string; to?: string }) {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      const t = overrides?.type ?? activityType;
      const f = overrides?.from ?? from;
      const toVal = overrides?.to ?? to;
      if (t) params.set('type', t);
      if (f) params.set('from', f);
      if (toVal) params.set('to', toVal);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const res = await apiFetch<ActivityItem[]>(`/activities${qs}`);
      setItems(Array.isArray(res) ? res : []);
    } catch (err: any) {
      setError(err?.message || 'No se pudieron cargar las actividades.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function handleFilter(e: React.FormEvent) {
    e.preventDefault();
    void load();
  }

  function resetFilters() {
    setActivityType('');
    setQ('');
    setFrom('');
    setTo('');
    void load({ type: '', from: '', to: '' });
  }

  const needle = q.trim().toLowerCase();
  const visibleItems = needle
    ? items.filter(
        (item) =>
          (item.summary || '').toLowerCase().includes(needle) ||
          (item.actor_name || '').toLowerCase().includes(needle) ||
          (item.lead_title || '').toLowerCase().includes(needle) ||
          (item.contact_name || '').toLowerCase().includes(needle)
      )
    : items;

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl min-w-0">
      <div>
        <h1 className="text-xl font-bold">Reporte de Actividades</h1>
        <p className="text-xs text-[var(--text-muted)]">
          Historial consolidado de interacciones comerciales, notas, cambios de etapa y seguimiento
        </p>
      </div>

      <AnalyticsSubNav active="activities" />

      <Card className="p-4 space-y-3 min-w-0">
        <div className="text-xs font-semibold flex items-center gap-1.5 text-[var(--text-muted)]">
          <Filter className="w-3.5 h-3.5" /> Filtros de búsqueda
        </div>
        <form onSubmit={handleFilter} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
          <Input
            placeholder="Buscar resumen, asesor, contacto..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            value={activityType}
            onChange={(e) => setActivityType(e.target.value)}
            className="h-10 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
          >
            {ACTIVITY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <Input type="date" aria-label="Desde" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input type="date" aria-label="Hasta" value={to} onChange={(e) => setTo(e.target.value)} />
          <div className="flex gap-2">
            <Button type="submit" className="flex-1">
              <Search className="w-3.5 h-3.5" /> Filtrar
            </Button>
            <Button type="button" variant="secondary" onClick={resetFilters}>
              Limpiar
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
          <Activity className="w-4 h-4 text-[var(--accent)]" /> Actividades ({visibleItems.length})
        </div>

        {loading ? (
          <div className="text-xs text-[var(--text-muted)] py-4">Cargando actividades...</div>
        ) : visibleItems.length === 0 ? (
          <div className="text-xs text-[var(--text-muted)] py-4">
            No se encontraron actividades con los filtros aplicados.
          </div>
        ) : (
          <div className="space-y-2.5">
            {visibleItems.map((item) => (
              <div
                key={item.id}
                className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-xs space-y-1.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <Badge tone="accent">{item.type}</Badge>
                    {item.lead_title && <span className="font-semibold truncate">{item.lead_title}</span>}
                    {item.contact_name && (
                      <span className="text-[var(--text-muted)] truncate">• {item.contact_name}</span>
                    )}
                  </div>
                  <span className="text-[11px] text-[var(--text-muted)] shrink-0">
                    {new Date(item.performed_at).toLocaleString('es')}
                  </span>
                </div>
                <p className="text-[var(--text)] break-words">{item.summary}</p>
                {item.actor_name && (
                  <div className="text-[11px] text-[var(--text-muted)]">Asesor: {item.actor_name}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
