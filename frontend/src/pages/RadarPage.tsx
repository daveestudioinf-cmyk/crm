import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Clock, ExternalLink, Flame, RefreshCw, Search, UserCheck } from 'lucide-react';
import { ApiError, apiFetch } from '../lib/api';
import { Badge, Button, Card, Input } from '../components/ui/primitives';

type UrgencyLevel = 'critico' | 'alto' | 'medio';

function computeWaitMinutes(item: any): number {
  const ref = item.last_inbound_at || item.last_message_at || item.updated_at || item.created_at;
  if (!ref) return 0;
  const diffMs = Date.now() - new Date(ref).getTime();
  return Math.max(0, Math.floor(diffMs / 60000));
}

function getUrgency(waitMins: number): { level: UrgencyLevel; label: string; tone: 'danger' | 'warning' | 'accent' } {
  if (waitMins >= 240) return { level: 'critico', label: 'Crítico', tone: 'danger' };
  if (waitMins >= 60) return { level: 'alto', label: 'Alto', tone: 'warning' };
  return { level: 'medio', label: 'Medio', tone: 'accent' };
}

function formatWaitTime(waitMins: number): string {
  if (waitMins < 1) return 'Hace un momento';
  if (waitMins < 60) return `Hace ${waitMins} min`;
  const hours = Math.floor(waitMins / 60);
  const mins = waitMins % 60;
  if (hours < 24) return mins > 0 ? `Hace ${hours} h ${mins} min` : `Hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `Hace ${days} d`;
}

const STATUS_LABELS: Record<string, string> = {
  open: 'Abierta',
  pending: 'En cola',
  claimed: 'Reclamada',
  ai_handling: 'IA',
};

export function RadarPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [urgencyFilter, setUrgencyFilter] = useState<'' | UrgencyLevel>('');
  const [statusFilter, setStatusFilter] = useState('');
  const [claimingId, setClaimingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<any[]>('/radar');
      setItems(data || []);
    } catch (err: any) {
      setError(err.message || 'No se pudo cargar el Radar.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const enriched = useMemo(() => {
    return items.map((item) => {
      const waitMins = computeWaitMinutes(item);
      const urgency = getUrgency(waitMins);
      return { ...item, waitMins, urgency };
    });
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enriched.filter((item) => {
      if (urgencyFilter && item.urgency.level !== urgencyFilter) return false;
      if (statusFilter && item.status !== statusFilter) return false;
      if (!q) return true;
      return (
        (item.contact_name || '').toLowerCase().includes(q) ||
        (item.contact_phone || '').toLowerCase().includes(q) ||
        (item.last_message_preview || '').toLowerCase().includes(q)
      );
    });
  }, [enriched, urgencyFilter, statusFilter, search]);

  async function handleQuickClaim(item: any) {
    setClaimingId(item.id);
    setError('');
    setNotice('');
    try {
      await apiFetch(`/conversations/${item.id}/claim`, {
        method: 'POST',
        body: JSON.stringify({
          expected_revision: item.service_revision ?? 0,
        }),
      });
      setNotice(`Conversación de ${item.contact_name} reclamada.`);
      await load();
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 409) {
        setNotice('La conversación fue reclamada o actualizada por otro agente. Lista actualizada.');
        await load();
      } else {
        setError(err.message || 'No se pudo reclamar la conversación.');
      }
    } finally {
      setClaimingId(null);
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Flame className="w-5 h-5 text-[var(--warning)] shrink-0" />
            <span>Radar de Conversaciones</span>
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            Prioriza conversaciones enfriándose según su tiempo de espera.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={load} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Actualizar
        </Button>
      </div>

      <div className="flex flex-col md:flex-row md:items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-3 text-[var(--text-muted)]" />
          <Input
            className="pl-9"
            placeholder="Buscar contacto, teléfono o mensaje..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {[
            { k: '' as const, l: 'Todas' },
            { k: 'critico' as const, l: 'Crítico' },
            { k: 'alto' as const, l: 'Alto' },
            { k: 'medio' as const, l: 'Medio' },
          ].map((u) => (
            <button
              key={u.k || 'all'}
              type="button"
              onClick={() => setUrgencyFilter(u.k)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer transition-colors ${
                urgencyFilter === u.k
                  ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                  : 'bg-[var(--surface)] text-[var(--text-muted)] border border-[var(--border)] hover:text-[var(--text)]'
              }`}
            >
              {u.l}
            </button>
          ))}

          <select
            aria-label="Filtrar por estado"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-8 rounded-full border border-[var(--border)] bg-[var(--bg)] px-3 text-xs text-[var(--text)]"
          >
            <option value="">Todos los estados</option>
            <option value="open">Abierta</option>
            <option value="pending">En cola</option>
            <option value="claimed">Reclamada</option>
          </select>
        </div>
      </div>

      {notice && (
        <div className="px-3 py-2 rounded-xl text-xs bg-teal-50 border border-teal-200 text-teal-900">
          {notice}
        </div>
      )}

      {error && (
        <Card className="p-4 border-red-200 bg-red-50 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-[var(--danger)]">{error}</span>
          <Button size="sm" variant="secondary" onClick={load}>
            Reintentar
          </Button>
        </Card>
      )}

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="p-4 h-20 animate-pulse bg-[var(--surface)]" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="p-8 text-center text-xs text-[var(--text-muted)]">
          {items.length === 0
            ? 'Todas las conversaciones están al día.'
            : 'No hay conversaciones que coincidan con los filtros seleccionados.'}
        </Card>
      ) : (
        <div className="space-y-2.5">
          {filtered.map((item) => (
            <Card
              key={item.id}
              className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 min-w-0"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-sm text-[var(--text)] truncate">
                    {item.contact_name}
                  </span>
                  <Badge tone={item.urgency.tone}>{item.urgency.label}</Badge>
                  <Badge tone="neutral">{STATUS_LABELS[item.status] || item.status}</Badge>
                </div>
                <div className="text-xs text-[var(--text-muted)] truncate">
                  {item.last_message_preview || 'Esperando respuesta'}
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--text-muted)]">
                  {item.contact_phone && <span>{item.contact_phone}</span>}
                  <span className="inline-flex items-center gap-1">
                    <Clock className="w-3 h-3" /> {formatWaitTime(item.waitMins)}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {item.status !== 'claimed' && (
                  <Button
                    size="sm"
                    disabled={claimingId === item.id}
                    onClick={() => handleQuickClaim(item)}
                  >
                    <UserCheck className="w-3.5 h-3.5" />
                    {claimingId === item.id ? 'Reclamando...' : 'Reclamar'}
                  </Button>
                )}
                <Link
                  to="/app/inbox/$id"
                  params={{ id: item.id }}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-medium bg-[var(--surface)] text-[var(--text)] border border-[var(--border)] hover:bg-slate-100 transition-colors"
                >
                  <span>Abrir chat</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
