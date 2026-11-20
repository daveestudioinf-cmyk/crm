import React, { useState } from 'react';
import { Edit3, GitBranch, Power, Repeat, Trash2 } from 'lucide-react';
import { type AIAgent, type AIRouter, type FollowupFlow, apiFetch } from '../../lib/api';
import { Badge, Button, Card, Input } from '../ui/primitives';

export function FollowupsPanel({
  followups,
  onRefresh,
  onNotice,
}: {
  followups: FollowupFlow[];
  onRefresh: () => void;
  onNotice: (type: 'ok' | 'err', text: string) => void;
}) {
  const [editingId, setEditingId] = useState<string>('');
  const [name, setName] = useState('');
  const [triggerType, setTriggerType] = useState('inactivity');
  const [delayMinutes, setDelayMinutes] = useState('60');
  const [maxAttempts, setMaxAttempts] = useState('3');
  const [promptTemplate, setPromptTemplate] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);

  function resetForm() {
    setEditingId('');
    setName('');
    setTriggerType('inactivity');
    setDelayMinutes('60');
    setMaxAttempts('3');
    setPromptTemplate('');
    setIsActive(true);
  }

  function startEdit(f: FollowupFlow) {
    setEditingId(f.id);
    setName(f.name);
    setTriggerType(f.trigger_type || 'inactivity');
    setDelayMinutes(String(f.delay_minutes ?? 60));
    setMaxAttempts(String(f.max_attempts ?? 3));
    setPromptTemplate(f.prompt_template || '');
    setIsActive(f.is_active);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        trigger_type: triggerType,
        delay_minutes: Math.max(1, parseInt(delayMinutes, 10) || 60),
        max_attempts: Math.max(1, parseInt(maxAttempts, 10) || 3),
        prompt_template: promptTemplate.trim(),
        is_active: isActive,
      };
      if (editingId) {
        await apiFetch(`/ai/followups/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        onNotice('ok', 'Flujo de seguimiento actualizado.');
      } else {
        await apiFetch('/ai/followups', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        onNotice('ok', 'Flujo de seguimiento creado.');
      }
      resetForm();
      onRefresh();
    } catch (err: any) {
      onNotice('err', err?.message || 'No se pudo guardar el flujo de seguimiento.');
    } finally {
      setSaving(false);
    }
  }

  async function toggle(f: FollowupFlow) {
    try {
      await apiFetch(`/ai/followups/${f.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !f.is_active }),
      });
      onNotice('ok', `Seguimiento "${f.name}" ${!f.is_active ? 'activado' : 'pausado'}.`);
      onRefresh();
    } catch (err: any) {
      onNotice('err', err?.message || 'No se pudo cambiar el estado.');
    }
  }

  async function remove(id: string) {
    try {
      await apiFetch(`/ai/followups/${id}`, { method: 'DELETE' });
      if (editingId === id) resetForm();
      onNotice('ok', 'Flujo de seguimiento eliminado.');
      onRefresh();
    } catch (err: any) {
      onNotice('err', err?.message || 'No se pudo eliminar el flujo.');
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card className="p-4 space-y-3 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="font-semibold text-sm flex items-center gap-2">
            <Repeat className="w-4 h-4 text-[var(--accent)]" />
            {editingId ? 'Editar Flujo de Seguimiento' : 'Nuevo Flujo de Seguimiento'}
          </div>
          {editingId && (
            <Button type="button" size="sm" variant="ghost" onClick={resetForm}>
              Cancelar
            </Button>
          )}
        </div>
        <form onSubmit={save} className="space-y-2.5">
          <div>
            <label className="text-xs font-medium block mb-1">Nombre del flujo</label>
            <Input
              required
              placeholder="Ej. Recordatorio tras 1 hora sin respuesta"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div>
              <label className="text-xs font-medium block mb-1">Tipo de disparador</label>
              <select
                value={triggerType}
                onChange={(e) => setTriggerType(e.target.value)}
                className="w-full h-10 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
              >
                <option value="inactivity">Inactividad</option>
                <option value="no_reply">Sin respuesta</option>
                <option value="lead_created">Lead creado</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">Espera (min)</label>
              <Input
                type="number"
                min="1"
                required
                value={delayMinutes}
                onChange={(e) => setDelayMinutes(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">Máx. intentos</label>
              <Input
                type="number"
                min="1"
                max="10"
                required
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium block mb-1">Prompt / Plantilla del mensaje</label>
            <textarea
              required
              rows={3}
              placeholder="Hola {{nombre}}, ¿pudiste revisar la propuesta que te enviamos?"
              value={promptTemplate}
              onChange={(e) => setPromptTemplate(e.target.value)}
              className="w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] p-3 text-sm"
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Flujo activo
          </label>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? 'Guardando...' : editingId ? 'Actualizar flujo' : 'Crear flujo'}
          </Button>
        </form>
      </Card>

      <Card className="p-4 space-y-3 min-w-0">
        <div className="font-semibold text-sm">Flujos Configurados ({followups.length})</div>
        {followups.length === 0 ? (
          <div className="text-xs text-[var(--text-muted)]">No hay flujos de seguimiento configurados.</div>
        ) : (
          <div className="space-y-2.5">
            {followups.map((f) => (
              <div
                key={f.id}
                className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-xs space-y-1.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold truncate">{f.name}</span>
                  <Badge tone={f.is_active ? 'success' : 'neutral'}>
                    {f.is_active ? 'Activo' : 'Pausado'}
                  </Badge>
                </div>
                <div className="text-[11px] text-[var(--text-muted)]">
                  {f.trigger_type} • Espera: {f.delay_minutes} min
                  {f.max_attempts ? ` • Máx. ${f.max_attempts} intentos` : ''}
                </div>
                <p className="text-[var(--text)] line-clamp-2">{f.prompt_template}</p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button type="button" size="sm" variant="secondary" onClick={() => startEdit(f)}>
                    <Edit3 className="w-3 h-3" /> Editar
                  </Button>
                  <Button type="button" size="sm" variant="secondary" onClick={() => toggle(f)}>
                    <Power className="w-3 h-3" /> {f.is_active ? 'Pausar' : 'Activar'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    aria-label={`Eliminar ${f.name}`}
                    onClick={() => remove(f.id)}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export function RoutersPanel({
  routers,
  agents,
  onRefresh,
  onNotice,
}: {
  routers: AIRouter[];
  agents: AIAgent[];
  onRefresh: () => void;
  onNotice: (type: 'ok' | 'err', text: string) => void;
}) {
  const [editingId, setEditingId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [keywordsText, setKeywordsText] = useState('');
  const [targetAgentId, setTargetAgentId] = useState('');
  const [priority, setPriority] = useState('10');
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);

  function resetForm() {
    setEditingId('');
    setName('');
    setDescription('');
    setKeywordsText('');
    setTargetAgentId(agents[0]?.id || '');
    setPriority('10');
    setIsActive(true);
  }

  function startEdit(r: AIRouter) {
    setEditingId(r.id);
    setName(r.name);
    setDescription(r.description || '');
    setKeywordsText((r.intent_keywords || []).join(', '));
    setTargetAgentId(r.target_agent_id);
    setPriority(String(r.priority ?? 10));
    setIsActive(r.is_active);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const intent_keywords = keywordsText
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
      const payload = {
        name: name.trim(),
        description: description.trim(),
        intent_keywords,
        target_agent_id: targetAgentId || agents[0]?.id,
        priority: parseInt(priority, 10) || 10,
        is_active: isActive,
      };
      if (editingId) {
        await apiFetch(`/ai/routers/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        onNotice('ok', 'Regla de enrutamiento actualizada.');
      } else {
        await apiFetch('/ai/routers', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        onNotice('ok', 'Regla de enrutamiento creada.');
      }
      resetForm();
      onRefresh();
    } catch (err: any) {
      onNotice('err', err?.message || 'No se pudo guardar el router de intención.');
    } finally {
      setSaving(false);
    }
  }

  async function toggle(r: AIRouter) {
    try {
      await apiFetch(`/ai/routers/${r.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !r.is_active }),
      });
      onNotice('ok', `Router "${r.name}" ${!r.is_active ? 'activado' : 'pausado'}.`);
      onRefresh();
    } catch (err: any) {
      onNotice('err', err?.message || 'No se pudo actualizar el router.');
    }
  }

  async function remove(id: string) {
    try {
      await apiFetch(`/ai/routers/${id}`, { method: 'DELETE' });
      if (editingId === id) resetForm();
      onNotice('ok', 'Router de intención eliminado.');
      onRefresh();
    } catch (err: any) {
      onNotice('err', err?.message || 'No se pudo eliminar el router.');
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card className="p-4 space-y-3 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="font-semibold text-sm flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-[var(--accent)]" />
            {editingId ? 'Editar Regla de Enrutamiento' : 'Nueva Regla de Enrutamiento por Intención'}
          </div>
          {editingId && (
            <Button type="button" size="sm" variant="ghost" onClick={resetForm}>
              Cancelar
            </Button>
          )}
        </div>
        <form onSubmit={save} className="space-y-2.5">
          <div>
            <label className="text-xs font-medium block mb-1">Nombre de la regla</label>
            <Input
              required
              placeholder="Ej. Derivar soporte técnico a agente especialista"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium block mb-1">Descripción (opcional)</label>
            <Input
              placeholder="Ej. Consultas sobre fallas, garantías o facturación"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium block mb-1">Palabras clave de intención (separadas por coma)</label>
            <Input
              required
              placeholder="no funciona, error, factura, reembolso"
              value={keywordsText}
              onChange={(e) => setKeywordsText(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <label className="text-xs font-medium block mb-1">Agente destino</label>
              <select
                required
                value={targetAgentId || agents[0]?.id || ''}
                onChange={(e) => setTargetAgentId(e.target.value)}
                className="w-full h-10 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
              >
                {agents.length === 0 && <option value="">Crea un agente primero</option>}
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">Prioridad</label>
              <Input
                type="number"
                min="1"
                max="100"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Regla activa
          </label>
          <Button type="submit" size="sm" disabled={saving || agents.length === 0}>
            {saving ? 'Guardando...' : editingId ? 'Actualizar router' : 'Crear router'}
          </Button>
        </form>
      </Card>

      <Card className="p-4 space-y-3 min-w-0">
        <div className="font-semibold text-sm">Routers Activos ({routers.length})</div>
        {routers.length === 0 ? (
          <div className="text-xs text-[var(--text-muted)]">No hay reglas de enrutamiento configuradas.</div>
        ) : (
          <div className="space-y-2.5">
            {routers.map((r) => {
              const agentName =
                r.target_agent_name || agents.find((a) => a.id === r.target_agent_id)?.name || 'Agente';
              return (
                <div
                  key={r.id}
                  className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-xs space-y-1.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold truncate">{r.name}</span>
                    <div className="flex items-center gap-1.5">
                      <Badge tone="accent">P{r.priority}</Badge>
                      <Badge tone={r.is_active ? 'success' : 'neutral'}>
                        {r.is_active ? 'Activo' : 'Pausado'}
                      </Badge>
                    </div>
                  </div>
                  {r.description && <div className="text-[11px] text-[var(--text-muted)]">{r.description}</div>}
                  <div className="text-[11px] text-[var(--text-muted)]">
                    Palabras clave:{' '}
                    <code className="font-mono">{(r.intent_keywords || []).join(', ') || '—'}</code> →{' '}
                    <strong>{agentName}</strong>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button type="button" size="sm" variant="secondary" onClick={() => startEdit(r)}>
                      <Edit3 className="w-3 h-3" /> Editar
                    </Button>
                    <Button type="button" size="sm" variant="secondary" onClick={() => toggle(r)}>
                      <Power className="w-3 h-3" /> {r.is_active ? 'Pausar' : 'Activar'}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label={`Eliminar ${r.name}`}
                      onClick={() => remove(r.id)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
