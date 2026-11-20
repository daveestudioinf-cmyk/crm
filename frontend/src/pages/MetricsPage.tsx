import React, { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Activity,
  BarChart3,
  FileSearch,
  Target,
  TrendingUp,
  Users,
} from 'lucide-react';
import {
  type AttendantMetric,
  type FunnelStageMetric,
  apiFetch,
} from '../lib/api';
import { Badge, Button, Card, Input } from '../components/ui/primitives';

export function AnalyticsSubNav({ active }: { active: 'metrics' | 'activities' | 'audit' }) {
  const items = [
    { key: 'metrics', to: '/app/metrics', label: 'Métricas y Embudo', icon: BarChart3 },
    { key: 'activities', to: '/app/activities', label: 'Actividades', icon: Activity },
    { key: 'audit', to: '/app/audit', label: 'Auditoría 5 años', icon: FileSearch },
  ] as const;

  return (
    <div className="flex flex-wrap gap-2 border-b border-[var(--border)] pb-2">
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = active === item.key;
        return (
          <Link
            key={item.key}
            to={item.to}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              isActive
                ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                : 'bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}

export function FunnelChart({ stages }: { stages: FunnelStageMetric[] }) {
  const maxLeads = Math.max(1, ...stages.map((s) => s.leads_count || 0));

  return (
    <Card className="p-4 space-y-3 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold text-sm flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-[var(--accent)]" /> Embudo de Conversión por Etapa
        </div>
        <span className="text-xs text-[var(--text-muted)]">{stages.length} etapas</span>
      </div>

      {stages.length === 0 ? (
        <div className="text-xs text-[var(--text-muted)] py-4">
          Aún no hay datos de etapas del embudo para mostrar.
        </div>
      ) : (
        <div className="space-y-3">
          {stages.map((s) => {
            const pct = Math.max(4, Math.round(((s.leads_count || 0) / maxLeads) * 100));
            return (
              <div key={s.stage_id} className="space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="font-medium truncate">
                    {s.stage_name}
                    {s.pipeline_name && (
                      <span className="text-[var(--text-muted)] font-normal"> · {s.pipeline_name}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-semibold">{s.leads_count} leads</span>
                    <span className="text-[var(--text-muted)]">
                      ${((s.value_cents || 0) / 100).toLocaleString('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    {s.conversion_rate !== undefined && (
                      <Badge tone="accent">{Math.round(s.conversion_rate)}%</Badge>
                    )}
                  </div>
                </div>
                <div
                  className="w-full h-3 rounded-full overflow-hidden border"
                  style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
                >
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${pct}%`, backgroundColor: 'var(--accent)' }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function AttendantMetricsTable({ attendants }: { attendants: AttendantMetric[] }) {
  return (
    <Card className="p-4 space-y-3 min-w-0">
      <div className="font-semibold text-sm flex items-center gap-2">
        <Users className="w-4 h-4 text-[var(--accent)]" /> Rendimiento por Asesor ({attendants.length})
      </div>

      {attendants.length === 0 ? (
        <div className="text-xs text-[var(--text-muted)] py-3">
          No hay métricas de asesores registradas todavía.
        </div>
      ) : (
        <>
          {/* Tabla escritorio */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                  <th className="py-2 pr-3 font-medium">Asesor</th>
                  <th className="py-2 px-3 font-medium text-right">Chats asignados</th>
                  <th className="py-2 px-3 font-medium text-right">Chats resueltos</th>
                  <th className="py-2 px-3 font-medium text-right">Leads asignados</th>
                  <th className="py-2 pl-3 font-medium text-right">Tareas completadas</th>
                </tr>
              </thead>
              <tbody>
                {attendants.map((a) => (
                  <tr key={a.user_id} className="border-b border-[var(--border)] last:border-0">
                    <td className="py-2.5 pr-3">
                      <div className="font-medium">{a.full_name}</div>
                      {a.email && <div className="text-[11px] text-[var(--text-muted)]">{a.email}</div>}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono">{a.conversations_assigned}</td>
                    <td className="py-2.5 px-3 text-right font-mono">{a.conversations_resolved}</td>
                    <td className="py-2.5 px-3 text-right font-mono">{a.leads_owned}</td>
                    <td className="py-2.5 pl-3 text-right font-semibold font-mono">{a.tasks_done}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Tarjetas móvil */}
          <div className="md:hidden space-y-2.5">
            {attendants.map((a) => (
              <div
                key={a.user_id}
                className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-xs space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold truncate">{a.full_name}</span>
                  <Badge tone="success">{a.conversations_resolved} resueltos</Badge>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px] text-[var(--text-muted)]">
                  <div>Chats asignados: <strong className="text-[var(--text)]">{a.conversations_assigned}</strong></div>
                  <div>Chats resueltos: <strong className="text-[var(--text)]">{a.conversations_resolved}</strong></div>
                  <div>Leads: <strong className="text-[var(--text)]">{a.leads_owned}</strong></div>
                  <div>Tareas: <strong className="text-[var(--text)]">{a.tasks_done}</strong></div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

export function MetricsPage() {
  const [m, setM] = useState<any>(null);
  const [funnel, setFunnel] = useState<FunnelStageMetric[]>([]);
  const [attendants, setAttendants] = useState<AttendantMetric[]>([]);
  const [goalTarget, setGoalTarget] = useState<number>(() => {
    const saved = localStorage.getItem('koracrm_monthly_goal_leads');
    return saved ? Math.max(1, parseInt(saved, 10) || 20) : 20;
  });
  const [goalDraft, setGoalDraft] = useState(String(goalTarget));
  const [editingGoal, setEditingGoal] = useState(false);

  useEffect(() => {
    Promise.all([
      apiFetch<any>('/metrics').catch(() => null),
      apiFetch<FunnelStageMetric[]>('/metrics/funnel').catch(() => []),
      apiFetch<AttendantMetric[]>('/metrics/attendants').catch(() => []),
    ]).then(([metricsRes, funnelRes, attendantsRes]) => {
      setM(metricsRes);
      setFunnel(Array.isArray(funnelRes) ? funnelRes : []);
      setAttendants(Array.isArray(attendantsRes) ? attendantsRes : []);
    });
  }, []);

  const wonCount = m?.leads_won ?? 0;
  const goalPct = Math.min(100, Math.round((wonCount / Math.max(1, goalTarget)) * 100));

  function saveGoal(e: React.FormEvent) {
    e.preventDefault();
    const parsed = Math.max(1, parseInt(goalDraft, 10) || 20);
    setGoalTarget(parsed);
    localStorage.setItem('koracrm_monthly_goal_leads', String(parsed));
    setEditingGoal(false);
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl min-w-0">
      <div>
        <h1 className="text-xl font-bold">Analítica y Rendimiento</h1>
        <p className="text-xs text-[var(--text-muted)]">
          Embudo de conversión, metas comerciales, métricas por asesor y registros de actividad
        </p>
      </div>

      <AnalyticsSubNav active="metrics" />

      {m && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            ['Contactos', m.contacts_total],
            ['Leads Abiertos', m.leads_open],
            ['Ganados', m.leads_won],
            ['Chats Activos', m.conversations_open],
            ['Mensajes Hoy', m.messages_today],
          ].map(([k, v]) => (
            <Card key={String(k)} className="p-4 min-w-0">
              <div className="text-xs text-[var(--text-muted)] truncate">{k}</div>
              <div className="text-2xl font-bold mt-1">{v ?? 0}</div>
            </Card>
          ))}
        </div>
      )}

      {/* Meta de Ventas */}
      <Card className="p-4 space-y-3 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold text-sm flex items-center gap-2">
            <Target className="w-4 h-4 text-[var(--accent)]" /> Progreso de Meta Mensual (Leads Ganados)
          </div>
          <Button size="sm" variant="secondary" onClick={() => setEditingGoal((v) => !v)}>
            {editingGoal ? 'Cancelar' : 'Ajustar meta'}
          </Button>
        </div>

        {editingGoal && (
          <form onSubmit={saveGoal} className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              min="1"
              className="w-32"
              value={goalDraft}
              onChange={(e) => setGoalDraft(e.target.value)}
            />
            <Button type="submit" size="sm">Guardar meta</Button>
          </form>
        )}

        <div className="flex items-center justify-between text-xs">
          <span>
            <strong>{wonCount}</strong> de <strong>{goalTarget}</strong> leads ganados
          </span>
          <Badge tone={goalPct >= 100 ? 'success' : 'accent'}>{goalPct}%</Badge>
        </div>
        <div
          className="w-full h-3 rounded-full overflow-hidden border"
          style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${goalPct}%`, backgroundColor: 'var(--accent)' }}
          />
        </div>
      </Card>

      <FunnelChart stages={funnel} />

      <AttendantMetricsTable attendants={attendants} />
    </div>
  );
}
