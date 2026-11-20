import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Copy,
  Edit3,
  FlaskConical,
  Play,
  Plus,
  Power,
  RefreshCw,
  Trash2,
  Webhook,
  Workflow,
  XCircle,
} from 'lucide-react';
import {
  type AutomationAction,
  type AutomationCondition,
  type AutomationRule,
  type AutomationRuleRun,
  type WebhookSource,
  apiFetch,
  subscribeSSE,
} from '../lib/api';
import { Badge, Button, Card, Input, Sheet } from '../components/ui/primitives';

const TRIGGER_EVENTS = [
  { value: 'lead.created', label: 'Lead creado' },
  { value: 'lead.stage_changed', label: 'Cambio de etapa en embudo' },
  { value: 'message.inbound', label: 'Mensaje entrante recibido' },
  { value: 'conversation.closed', label: 'Conversación cerrada' },
  { value: 'webhook.inbound', label: 'Webhook entrante recibido' },
];

const CONDITION_OPERATORS: Array<{ value: AutomationCondition['op']; label: string }> = [
  { value: 'eq', label: 'Es igual a' },
  { value: 'neq', label: 'Es distinto de' },
  { value: 'contains', label: 'Contiene' },
  { value: 'gt', label: 'Mayor que' },
  { value: 'lt', label: 'Menor que' },
  { value: 'in', label: 'En lista (coma)' },
  { value: 'exists', label: 'Existe / No vacío' },
];

const ACTION_TYPES: Array<{
  value: AutomationAction['type'];
  label: string;
  field: keyof Omit<AutomationAction, 'type'>;
  placeholder: string;
}> = [
  { value: 'create_task', label: 'Crear tarea automática', field: 'title', placeholder: 'Título de la tarea' },
  { value: 'move_stage', label: 'Mover lead de etapa', field: 'stage_id', placeholder: 'ID de etapa destino' },
  { value: 'assign_agent', label: 'Asignar a asesor / agente', field: 'user_id', placeholder: 'ID de usuario o agente' },
  { value: 'send_whatsapp', label: 'Enviar mensaje WhatsApp', field: 'message', placeholder: 'Texto del mensaje' },
  { value: 'add_tag', label: 'Agregar etiqueta', field: 'tag', placeholder: 'Nombre de etiqueta (ej. VIP)' },
  { value: 'webhook_post', label: 'Notificar webhook externo', field: 'url', placeholder: 'https://tu-sistema.com/hook' },
];

function getActionMeta(type: AutomationAction['type']) {
  return ACTION_TYPES.find((t) => t.value === type) || ACTION_TYPES[0];
}

function getActionFieldValue(a: AutomationAction): string {
  const meta = getActionMeta(a.type);
  if (a.type === 'assign_agent') return a.user_id || a.agent_id || '';
  return (a[meta.field] as string) || '';
}

function buildTypedAction(type: AutomationAction['type'], val: string): AutomationAction {
  const meta = getActionMeta(type);
  return { type, [meta.field]: val };
}

function normalizeConditions(raw: AutomationRule['conditions']): AutomationCondition[] {
  if (Array.isArray(raw)) {
    return raw.map((c: any) => ({
      field: c?.field || '',
      op: (c?.op || c?.operator || 'eq') as AutomationCondition['op'],
      value: String(c?.value ?? ''),
    }));
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([field, val]) => ({
      field,
      op: 'eq',
      value: String(val ?? ''),
    }));
  }
  return [];
}

function normalizeActions(raw: AutomationRule['actions']): AutomationAction[] {
  if (Array.isArray(raw)) {
    return raw.map((a: any) => {
      const type = (a?.type || 'add_tag') as AutomationAction['type'];
      const meta = getActionMeta(type);
      const val = a?.[meta.field] || a?.agent_id || a?.value || a?.target || '';
      return buildTypedAction(type, String(val));
    });
  }
  return [];
}

export function TestLeadButton({
  source,
  onTested,
}: {
  source: WebhookSource;
  onTested: (msg: string, ok: boolean) => void;
}) {
  const [testing, setTesting] = useState(false);

  async function handleTest() {
    setTesting(true);
    try {
      const res = await apiFetch<{ status?: string; contact_id?: string; lead_id?: string }>(
        `/webhooks/sources/${source.id}/test`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: `Lead Prueba (${source.name})`,
            phone: '+5215500009999',
            email: 'prueba@koracrm.local',
          }),
        }
      );
      onTested(
        `Prueba enviada a "${source.name}"${res?.lead_id ? ` (Lead ${res.lead_id.slice(0, 8)})` : ''}.`,
        true
      );
    } catch (err: any) {
      onTested(err?.message || 'No se pudo ejecutar la prueba del webhook.', false);
    } finally {
      setTesting(false);
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      disabled={testing || !source.is_active}
      onClick={handleTest}
    >
      <FlaskConical className="w-3.5 h-3.5" />
      {testing ? 'Probando...' : 'Probar lead'}
    </Button>
  );
}

export function RuleBuilder({
  editingRule,
  onSaved,
  onCancelEdit,
  onError,
}: {
  editingRule: AutomationRule | null;
  onSaved: (msg: string) => void;
  onCancelEdit: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState('');
  const [triggerEvent, setTriggerEvent] = useState('lead.created');
  const [isActive, setIsActive] = useState(true);
  const [conditions, setConditions] = useState<AutomationCondition[]>([
    { field: 'source', op: 'eq', value: 'webhook' },
  ]);
  const [actions, setActions] = useState<AutomationAction[]>([
    { type: 'add_tag', tag: 'Inbound' },
  ]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editingRule) {
      setName(editingRule.name);
      setTriggerEvent(editingRule.trigger_event || 'lead.created');
      setIsActive(editingRule.is_active);
      const conds = normalizeConditions(editingRule.conditions);
      setConditions(conds.length ? conds : []);
      const acts = normalizeActions(editingRule.actions);
      setActions(acts.length ? acts : [{ type: 'add_tag', tag: '' }]);
    } else {
      setName('');
      setTriggerEvent('lead.created');
      setIsActive(true);
      setConditions([{ field: 'source', op: 'eq', value: 'webhook' }]);
      setActions([{ type: 'add_tag', tag: 'Inbound' }]);
    }
  }, [editingRule]);

  function addCondition() {
    setConditions((prev) => [...prev, { field: '', op: 'eq', value: '' }]);
  }

  function updateCondition(idx: number, patch: Partial<AutomationCondition>) {
    setConditions((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }

  function removeCondition(idx: number) {
    setConditions((prev) => prev.filter((_, i) => i !== idx));
  }

  function addAction() {
    setActions((prev) => [...prev, { type: 'create_task', title: '' }]);
  }

  function updateAction(idx: number, next: AutomationAction) {
    setActions((prev) => prev.map((a, i) => (i === idx ? next : a)));
  }

  function removeAction(idx: number) {
    setActions((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const cleanConditions = conditions.filter((c) => c.field.trim() !== '');
      const cleanActions = actions.filter((a) => a.type);
      const payload = {
        name: name.trim(),
        trigger_event: triggerEvent,
        conditions: cleanConditions,
        actions: cleanActions,
        is_active: isActive,
      };
      if (editingRule) {
        await apiFetch(`/automation-rules/${editingRule.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        onSaved('Regla de automatización actualizada.');
      } else {
        await apiFetch('/automation-rules', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setName('');
        onSaved('Regla de automatización creada.');
      }
    } catch (err: any) {
      onError(err?.message || 'No se pudo guardar la regla.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-4 space-y-4 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold text-sm">
          <Workflow className="w-4 h-4 text-[var(--accent)]" />
          {editingRule ? 'Editar regla WHEN / IF / THEN' : 'Nueva regla WHEN / IF / THEN'}
        </div>
        {editingRule && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancelEdit}>
            Cancelar edición
          </Button>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium block mb-1">Nombre de la regla</label>
            <Input
              required
              placeholder="Ej. Etiquetar y asignar leads de formulario"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium block mb-1">CUÁNDO (WHEN) — Evento disparador</label>
            <select
              value={triggerEvent}
              onChange={(e) => setTriggerEvent(e.target.value)}
              className="w-full h-10 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
            >
              {TRIGGER_EVENTS.map((ev) => (
                <option key={ev.value} value={ev.value}>
                  {ev.label} ({ev.value})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* IF Conditions */}
        <div className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)] space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold">SI (IF) — Condiciones ({conditions.length})</span>
            <Button type="button" size="sm" variant="secondary" onClick={addCondition}>
              <Plus className="w-3.5 h-3.5" /> Condición
            </Button>
          </div>
          {conditions.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)]">
              Sin condiciones: se ejecutará para todos los eventos de este tipo.
            </p>
          ) : (
            <div className="space-y-2">
              {conditions.map((c, idx) => (
                <div key={idx} className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-center">
                  <Input
                    placeholder="Campo (ej. source, value)"
                    value={c.field}
                    onChange={(e) => updateCondition(idx, { field: e.target.value })}
                  />
                  <select
                    value={c.op}
                    onChange={(e) =>
                      updateCondition(idx, { op: e.target.value as AutomationCondition['op'] })
                    }
                    className="h-10 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-2.5 text-sm"
                  >
                    {CONDITION_OPERATORS.map((op) => (
                      <option key={op.value} value={op.value}>
                        {op.label}
                      </option>
                    ))}
                  </select>
                  <Input
                    placeholder="Valor esperado"
                    value={c.value}
                    disabled={c.op === 'exists'}
                    onChange={(e) => updateCondition(idx, { value: e.target.value })}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    aria-label="Quitar condición"
                    onClick={() => removeCondition(idx)}
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Quitar
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* THEN Actions */}
        <div className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)] space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold">ENTONCES (THEN) — Acciones ({actions.length})</span>
            <Button type="button" size="sm" variant="secondary" onClick={addAction}>
              <Plus className="w-3.5 h-3.5" /> Acción
            </Button>
          </div>
          <div className="space-y-2">
            {actions.map((a, idx) => {
              const meta = getActionMeta(a.type);
              const val = getActionFieldValue(a);
              return (
                <div key={idx} className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-center">
                  <select
                    value={a.type}
                    onChange={(e) =>
                      updateAction(
                        idx,
                        buildTypedAction(e.target.value as AutomationAction['type'], val)
                      )
                    }
                    className="h-10 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-2.5 text-sm"
                  >
                    {ACTION_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <Input
                    placeholder={meta.placeholder}
                    value={val}
                    onChange={(e) => updateAction(idx, buildTypedAction(a.type, e.target.value))}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={actions.length <= 1}
                    aria-label="Quitar acción"
                    onClick={() => removeAction(idx)}
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Quitar
                  </Button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            Regla activa inmediatamente
          </label>
          <Button type="submit" disabled={saving}>
            {saving ? 'Guardando...' : editingRule ? 'Actualizar regla' : 'Guardar regla'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function ExecutionTimeline({
  runs,
  onRetry,
  retryingId,
}: {
  runs: AutomationRuleRun[];
  onRetry: (runId: string) => void;
  retryingId: string | null;
}) {
  function statusTone(status: string): 'success' | 'danger' | 'warning' | 'neutral' {
    if (status === 'executed' || status === 'completed' || status === 'done') return 'success';
    if (status === 'failed') return 'danger';
    if (status === 'running' || status === 'pending') return 'warning';
    return 'neutral';
  }

  function statusLabel(status: string): string {
    switch (status) {
      case 'executed':
        return 'Ejecutada';
      case 'completed':
      case 'done':
        return 'Completada';
      case 'failed':
        return 'Fallida';
      case 'running':
        return 'Ejecutando';
      case 'pending':
        return 'Pendiente';
      case 'skipped':
        return 'Omitida';
      default:
        return status;
    }
  }

  return (
    <Card className="p-4 space-y-3 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-sm flex items-center gap-2">
          <Clock className="w-4 h-4 text-[var(--accent)]" />
          Historial de Ejecuciones ({runs.length})
        </div>
      </div>

      {runs.length === 0 ? (
        <div className="text-xs text-[var(--text-muted)] py-2">
          Aún no hay ejecuciones de automatización registradas.
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => {
            const actionsCount = Array.isArray(run.actions_executed)
              ? run.actions_executed.length
              : typeof run.actions_executed === 'number'
                ? run.actions_executed
                : 0;
            return (
              <div
                key={run.id}
                className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {run.status === 'failed' ? (
                      <XCircle className="w-3.5 h-3.5 text-[var(--danger)] shrink-0" />
                    ) : (
                      <CheckCircle2 className="w-3.5 h-3.5 text-[var(--success)] shrink-0" />
                    )}
                    <span className="font-semibold truncate">
                      {run.rule_name || `Regla ${run.rule_id.slice(0, 8)}`}
                    </span>
                    <Badge tone={statusTone(run.status)}>{statusLabel(run.status)}</Badge>
                    {run.trigger_event && (
                      <span className="font-mono text-[11px] text-[var(--text-muted)]">
                        {run.trigger_event}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-[var(--text-muted)]">
                    {new Date(run.created_at).toLocaleString('es')}
                    {run.duration_ms !== undefined ? ` • ${run.duration_ms} ms` : ''}
                    {run.actions_executed !== undefined ? ` • ${actionsCount} acciones` : ''}
                  </div>
                {run.error_message && (
                  <div className="text-[11px] text-[var(--danger)] break-words">
                    Error: {run.error_message}
                  </div>
                )}
              </div>

              {run.status === 'failed' && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={retryingId === run.id}
                  onClick={() => onRetry(run.id)}
                  className="shrink-0"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {retryingId === run.id ? 'Reintentando...' : 'Reintentar'}
                </Button>
              )}
            </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function WebhooksPage() {
  const [sources, setSources] = useState<WebhookSource[]>([]);
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [runs, setRuns] = useState<AutomationRuleRun[]>([]);
  const [name, setName] = useState('');
  const [editingRule, setEditingRule] = useState<AutomationRule | null>(null);
  const [confirmDeleteSource, setConfirmDeleteSource] = useState<WebhookSource | null>(null);
  const [confirmDeleteRule, setConfirmDeleteRule] = useState<AutomationRule | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  async function load() {
    try {
      const [srcRes, ruleRes, runRes] = await Promise.all([
        apiFetch<WebhookSource[]>('/webhooks/sources').catch(() => []),
        apiFetch<AutomationRule[]>('/automation-rules').catch(() =>
          apiFetch<AutomationRule[]>('/automations').catch(() => [])
        ),
        apiFetch<AutomationRuleRun[]>('/automations/runs').catch(() => []),
      ]);
      setSources(srcRes || []);
      setRules(ruleRes || []);
      setRuns(runRes || []);
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || 'Error al cargar automatizaciones.' });
    }
  }

  useEffect(() => {
    void load();
    const unsub = subscribeSSE((evType) => {
      if (evType === 'automation.executed') {
        void load();
      }
    });
    return unsub;
  }, []);

  async function addSource(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    try {
      await apiFetch('/webhooks/sources', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      setName('');
      setNotice({ type: 'ok', text: 'Fuente webhook creada.' });
      await load();
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || 'No se pudo crear la fuente webhook.' });
    }
  }

  async function toggleSource(s: WebhookSource) {
    setNotice(null);
    try {
      await apiFetch(`/webhooks/sources/${s.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !s.is_active }),
      });
      setNotice({
        type: 'ok',
        text: `Webhook "${s.name}" ${!s.is_active ? 'activado' : 'pausado'}.`,
      });
      await load();
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || 'No se pudo actualizar la fuente.' });
    }
  }

  async function deleteSource(s: WebhookSource) {
    setNotice(null);
    try {
      await apiFetch(`/webhooks/sources/${s.id}`, { method: 'DELETE' });
      setConfirmDeleteSource(null);
      setNotice({ type: 'ok', text: `Webhook "${s.name}" eliminado.` });
      await load();
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || 'No se pudo eliminar la fuente.' });
    }
  }

  async function toggleRule(r: AutomationRule) {
    setNotice(null);
    try {
      await apiFetch(`/automation-rules/${r.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !r.is_active }),
      });
      setNotice({
        type: 'ok',
        text: `Regla "${r.name}" ${!r.is_active ? 'activada' : 'desactivada'}.`,
      });
      await load();
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || 'No se pudo cambiar el estado de la regla.' });
    }
  }

  async function deleteRule(r: AutomationRule) {
    setNotice(null);
    try {
      await apiFetch(`/automation-rules/${r.id}`, { method: 'DELETE' });
      if (editingRule?.id === r.id) setEditingRule(null);
      setConfirmDeleteRule(null);
      setNotice({ type: 'ok', text: `Regla "${r.name}" eliminada.` });
      await load();
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || 'No se pudo eliminar la regla.' });
    }
  }

  async function retryRun(runId: string) {
    setRetryingId(runId);
    setNotice(null);
    try {
      await apiFetch(`/automation-runs/${runId}/retry`, { method: 'POST' });
      setNotice({ type: 'ok', text: 'Reintento de ejecución encolado.' });
      await load();
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || 'No se pudo reintentar la ejecución.' });
    } finally {
      setRetryingId(null);
    }
  }

  function copyWebhookUrl(token: string) {
    const url = `${window.location.origin}/api/v1/webhooks/in/${token}`;
    navigator.clipboard?.writeText(url).catch(() => {});
    setNotice({ type: 'ok', text: 'URL del webhook copiada al portapapeles.' });
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl min-w-0">
      <div>
        <h1 className="text-xl font-bold">Webhooks y Automatizaciones WHEN / IF / THEN</h1>
        <p className="text-xs text-[var(--text-muted)]">
          Captura leads desde formularios externos, automatiza flujos con reglas y audita ejecuciones
        </p>
      </div>

      {notice && (
        <div
          role="status"
          className={`px-3 py-2 rounded-xl text-xs border ${
            notice.type === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          {notice.text}
        </div>
      )}

      {/* Fuentes Webhook */}
      <Card className="p-4 space-y-4 min-w-0">
        <div className="flex items-center gap-2 font-semibold text-sm">
          <Webhook className="w-4 h-4 text-[var(--accent)]" /> Fuentes Webhook Entrantes ({sources.length})
        </div>
        <form onSubmit={addSource} className="flex flex-wrap gap-2 max-w-xl">
          <Input
            required
            className="flex-1 min-w-[180px]"
            placeholder="Nombre de fuente (ej. Formulario Web / Meta Lead Ads)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit">Crear fuente</Button>
        </form>

        {sources.length === 0 ? (
          <div className="text-xs text-[var(--text-muted)]">No hay fuentes webhook configuradas.</div>
        ) : (
          <div className="space-y-2.5">
            {sources.map((s) => (
              <div
                key={s.id}
                className="p-3.5 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex flex-col md:flex-row md:items-center justify-between gap-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-sm truncate">{s.name}</span>
                    <Badge tone={s.is_active ? 'success' : 'neutral'}>
                      {s.is_active ? 'Activo' : 'Pausado'}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 min-w-0">
                    <code className="text-xs text-[var(--text-muted)] break-all">
                      POST /api/v1/webhooks/in/{s.token}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyWebhookUrl(s.token)}
                      aria-label="Copiar URL"
                      className="p-1 rounded-md hover:bg-slate-200/70 text-[var(--text-muted)] cursor-pointer shrink-0"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <TestLeadButton
                    source={s}
                    onTested={(text, ok) => setNotice({ type: ok ? 'ok' : 'err', text })}
                  />
                  <Button type="button" size="sm" variant="secondary" onClick={() => toggleSource(s)}>
                    <Power className="w-3.5 h-3.5" />
                    {s.is_active ? 'Pausar' : 'Activar'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    aria-label={`Eliminar ${s.name}`}
                    onClick={() => setConfirmDeleteSource(s)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Constructor de Reglas WHEN/IF/THEN */}
      <RuleBuilder
        editingRule={editingRule}
        onSaved={(msg) => {
          setEditingRule(null);
          setNotice({ type: 'ok', text: msg });
          void load();
        }}
        onCancelEdit={() => setEditingRule(null)}
        onError={(msg) => setNotice({ type: 'err', text: msg })}
      />

      {/* Lista de Reglas */}
      <Card className="p-4 space-y-3 min-w-0">
        <div className="font-semibold text-sm flex items-center gap-2">
          <Play className="w-4 h-4 text-[var(--accent)]" /> Reglas Configuradas ({rules.length})
        </div>
        {rules.length === 0 ? (
          <div className="text-xs text-[var(--text-muted)]">Aún no hay reglas configuradas.</div>
        ) : (
          <div className="space-y-2.5">
            {rules.map((r) => {
              const conds = normalizeConditions(r.conditions);
              const acts = normalizeActions(r.actions);
              return (
                <div
                  key={r.id}
                  className="p-3.5 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-sm truncate">{r.name}</span>
                      <Badge tone={r.is_active ? 'success' : 'neutral'}>
                        {r.is_active ? 'Activa' : 'Inactiva'}
                      </Badge>
                    </div>
                    <div className="text-xs text-[var(--text-muted)] flex flex-wrap gap-2">
                      <span>
                        <strong>WHEN:</strong> <code className="font-mono">{r.trigger_event}</code>
                      </span>
                      <span>•</span>
                      <span>
                        <strong>IF:</strong> {conds.length} condiciones
                      </span>
                      <span>•</span>
                      <span>
                        <strong>THEN:</strong> {acts.length} acciones
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <Button type="button" size="sm" variant="secondary" onClick={() => setEditingRule(r)}>
                      <Edit3 className="w-3.5 h-3.5" /> Editar
                    </Button>
                    <Button type="button" size="sm" variant="secondary" onClick={() => toggleRule(r)}>
                      <Power className="w-3.5 h-3.5" /> {r.is_active ? 'Pausar' : 'Activar'}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label={`Eliminar regla ${r.name}`}
                      onClick={() => setConfirmDeleteRule(r)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Historial de Ejecuciones */}
      <ExecutionTimeline runs={runs} onRetry={retryRun} retryingId={retryingId} />

      <Sheet
        open={Boolean(confirmDeleteSource)}
        onClose={() => setConfirmDeleteSource(null)}
        title="Eliminar fuente webhook"
      >
        <div className="space-y-4">
          <p className="text-xs text-[var(--text-muted)]">
            ¿Seguro que deseas eliminar la fuente <strong>{confirmDeleteSource?.name}</strong>? Los formularios que usen este token dejarán de enviar leads.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmDeleteSource(null)}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={() => confirmDeleteSource && deleteSource(confirmDeleteSource)}>
              Eliminar fuente
            </Button>
          </div>
        </div>
      </Sheet>

      <Sheet
        open={Boolean(confirmDeleteRule)}
        onClose={() => setConfirmDeleteRule(null)}
        title="Eliminar regla de automatización"
      >
        <div className="space-y-4">
          <p className="text-xs text-[var(--text-muted)]">
            ¿Seguro que deseas eliminar la regla <strong>{confirmDeleteRule?.name}</strong>?
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmDeleteRule(null)}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={() => confirmDeleteRule && deleteRule(confirmDeleteRule)}>
              Eliminar regla
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
