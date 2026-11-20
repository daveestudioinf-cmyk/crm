import { useState } from 'react';
import { Bell, Check, CheckCircle2, Inbox, ShieldQuestion, X } from 'lucide-react';
import { type AgentCase, type AgentInboxItem, apiFetch } from '../../lib/api';
import { Badge, Button, Card, Input } from '../ui/primitives';

function severityLabel(severity: string): string {
  switch (severity) {
    case 'low':
      return 'Baja';
    case 'medium':
      return 'Media';
    case 'high':
      return 'Alta';
    case 'critical':
      return 'Crítica';
    default:
      return severity;
  }
}

function categoryLabel(category: string): string {
  switch (category) {
    case 'handoff':
      return 'Derivación a humano';
    case 'budget':
      return 'Presupuesto IA';
    case 'sentiment':
      return 'Sentimiento negativo';
    case 'case':
      return 'Caso pendiente';
    default:
      return category || 'Alerta IA';
  }
}

export function CaseList({
  cases,
  onRefresh,
  onNotice,
}: {
  cases: AgentCase[];
  onRefresh: () => void;
  onNotice: (type: 'ok' | 'err', text: string) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'awaiting_human' | 'approved' | 'rejected'>('awaiting_human');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const visible = filter === 'all' ? cases : cases.filter((c) => c.status === filter);

  async function decide(c: AgentCase, decision: 'approve' | 'reject') {
    setBusyId(c.id);
    try {
      await apiFetch(`/ai/cases/${c.id}/${decision}`, {
        method: 'POST',
        body: JSON.stringify({ decision_notes: notes[c.id]?.trim() || '' }),
      });
      onNotice(
        'ok',
        decision === 'approve' ? `Caso "${c.title}" aprobado.` : `Caso "${c.title}" rechazado.`
      );
      onRefresh();
    } catch (err: any) {
      onNotice('err', err?.message || 'No se pudo registrar la decisión.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className="p-4 space-y-4 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold text-sm flex items-center gap-2">
          <ShieldQuestion className="w-4 h-4 text-[var(--accent)]" />
          Casos de Decisión del Agente ({visible.length})
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ['awaiting_human', 'Pendientes'],
              ['approved', 'Aprobados'],
              ['rejected', 'Rechazados'],
              ['all', 'Todos'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium cursor-pointer ${
                filter === key
                  ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                  : 'bg-[var(--surface)] text-[var(--text-muted)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="text-xs text-[var(--text-muted)] py-4">
          No hay casos en esta vista.
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((c) => (
            <div
              key={c.id}
              className="p-3.5 rounded-xl bg-[var(--surface)] border border-[var(--border)] space-y-2.5 text-xs"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 space-y-0.5">
                  <div className="font-semibold text-sm">{c.title}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Badge
                    tone={
                      c.status === 'approved'
                        ? 'success'
                        : c.status === 'rejected'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    {c.status === 'awaiting_human'
                      ? 'Pendiente'
                      : c.status === 'approved'
                        ? 'Aprobado'
                        : 'Rechazado'}
                  </Badge>
                </div>
              </div>

              <p className="text-[var(--text)]">{c.summary}</p>

              {c.status === 'awaiting_human' ? (
                <div className="flex flex-col sm:flex-row gap-2 pt-1">
                  <Input
                    className="flex-1 h-8 text-xs"
                    placeholder="Nota de decisión (opcional)"
                    value={notes[c.id] || ''}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [c.id]: e.target.value }))}
                  />
                  <div className="flex gap-2 shrink-0">
                    <Button
                      type="button"
                      size="sm"
                      disabled={busyId === c.id}
                      onClick={() => decide(c, 'approve')}
                    >
                      <Check className="w-3.5 h-3.5" /> Aprobar
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      disabled={busyId === c.id}
                      onClick={() => decide(c, 'reject')}
                    >
                      <X className="w-3.5 h-3.5" /> Rechazar
                    </Button>
                  </div>
                </div>
              ) : (
                c.decision_notes && (
                  <div className="text-[11px] text-[var(--text-muted)]">
                    Nota: {c.decision_notes}
                  </div>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function AgentInboxPanel({
  items,
  onRefresh,
  onNotice,
}: {
  items: AgentInboxItem[];
  onRefresh: () => void;
  onNotice: (type: 'ok' | 'err', text: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const unreadCount = items.filter((i) => !i.is_read).length;

  async function markRead(item: AgentInboxItem) {
    setBusyId(item.id);
    try {
      await apiFetch(`/ai/inbox/${item.id}/read`, { method: 'POST' });
      onNotice('ok', 'Alerta marcada como leída.');
      onRefresh();
    } catch (err: any) {
      onNotice('err', err?.message || 'No se pudo marcar la alerta.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className="p-4 space-y-3 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold text-sm flex items-center gap-2">
          <Inbox className="w-4 h-4 text-[var(--accent)]" />
          Central de Alertas IA ({items.length})
        </div>
        {unreadCount > 0 && <Badge tone="warning">{unreadCount} sin leer</Badge>}
      </div>

      {items.length === 0 ? (
        <div className="text-xs text-[var(--text-muted)] py-4">
          No hay alertas pendientes en la central.
        </div>
      ) : (
        <div className="space-y-2.5">
          {items.map((item) => (
            <div
              key={item.id}
              className={`p-3 rounded-xl border text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                item.is_read
                  ? 'bg-[var(--surface)] border-[var(--border)] opacity-80'
                  : 'bg-[var(--bg)] border-[var(--accent)]'
              }`}
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Bell className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                  <span className="font-semibold">{categoryLabel(item.category)}</span>
                  <Badge
                    tone={
                      item.severity === 'critical' || item.severity === 'high'
                        ? 'danger'
                        : item.severity === 'medium'
                          ? 'warning'
                          : 'accent'
                    }
                  >
                    {severityLabel(item.severity)}
                  </Badge>
                  {!item.is_read && <Badge tone="warning">Nueva</Badge>}
                </div>
                <p className="text-[var(--text-muted)]">{item.message}</p>
                <div className="text-[11px] text-[var(--text-muted)]">
                  {new Date(item.created_at).toLocaleString('es')}
                </div>
              </div>

              {!item.is_read ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busyId === item.id}
                  onClick={() => markRead(item)}
                  className="shrink-0"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {busyId === item.id ? 'Marcando...' : 'Marcar leída'}
                </Button>
              ) : (
                <span className="text-[11px] text-[var(--text-muted)] shrink-0">Leída</span>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
