import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckSquare,
  Plus,
  Trash2,
  Pencil,
  CalendarClock,
  Repeat,
  ListChecks,
  Play,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { Badge, Button, Card, Input, Sheet } from '../components/ui/primitives';

interface TaskItem {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'done' | 'cancelled';
  due_at: string | null;
  recurrence: string;
  lead_id: string | null;
  contact_id: string | null;
  created_at: string;
}

interface TaskPlanItem {
  title: string;
  description: string;
  offset_days: number;
  recurrence: string;
}

interface TaskPlan {
  id: string;
  name: string;
  description: string;
  items: TaskPlanItem[];
}

type FilterTab = 'all' | 'pending' | 'in_progress' | 'overdue' | 'done';

function toLocalDateTimeInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isOverdue(t: TaskItem): boolean {
  if (!t.due_at) return false;
  if (t.status !== 'pending' && t.status !== 'in_progress') return false;
  return new Date(t.due_at).getTime() < Date.now();
}

function statusLabel(st: string): string {
  switch (st) {
    case 'pending':
      return 'Pendiente';
    case 'in_progress':
      return 'En progreso';
    case 'done':
      return 'Completada';
    case 'cancelled':
      return 'Cancelada';
    default:
      return st;
  }
}

function recurrenceLabel(rec: string): string {
  switch (rec) {
    case 'daily':
      return 'Diaria';
    case 'weekly':
      return 'Semanal';
    case 'monthly':
      return 'Mensual';
    default:
      return rec;
  }
}

export function TasksPage() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [plans, setPlans] = useState<TaskPlan[]>([]);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Task editor state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskItem | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TaskItem['status']>('pending');
  const [dueAt, setDueAt] = useState('');
  const [recurrencePreset, setRecurrencePreset] = useState('none');
  const [customRecurrence, setCustomRecurrence] = useState('');
  const [saving, setSaving] = useState(false);

  // Task plan editor state
  const [planSheetOpen, setPlanSheetOpen] = useState(false);
  const [planName, setPlanName] = useState('');
  const [planDesc, setPlanDesc] = useState('');
  const [planItems, setPlanItems] = useState<TaskPlanItem[]>([
    { title: '', description: '', offset_days: 1, recurrence: '' },
  ]);

  const loadAll = useCallback(async () => {
    try {
      const [tList, pList] = await Promise.all([
        apiFetch<TaskItem[]>('/tasks'),
        apiFetch<TaskPlan[]>('/task-plans'),
      ]);
      setTasks(tList || []);
      setPlans(pList || []);
      setError('');
    } catch (err: any) {
      setError(err?.message || 'Error al cargar tareas.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([apiFetch<TaskItem[]>('/tasks'), apiFetch<TaskPlan[]>('/task-plans')])
      .then(([tList, pList]) => {
        if (!active) return;
        setTasks(tList || []);
        setPlans(pList || []);
        setError('');
      })
      .catch((err: any) => {
        if (!active) return;
        setError(err?.message || 'Error al cargar tareas.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (filter === 'all') return true;
      if (filter === 'overdue') return isOverdue(t);
      return t.status === filter;
    });
  }, [tasks, filter]);

  function openCreateTask() {
    setEditingTask(null);
    setTitle('');
    setDescription('');
    setStatus('pending');
    setDueAt('');
    setRecurrencePreset('none');
    setCustomRecurrence('');
    setEditorOpen(true);
  }

  function openEditTask(t: TaskItem) {
    setEditingTask(t);
    setTitle(t.title);
    setDescription(t.description || '');
    setStatus(t.status);
    setDueAt(toLocalDateTimeInput(t.due_at));
    if (!t.recurrence) {
      setRecurrencePreset('none');
      setCustomRecurrence('');
    } else if (['daily', 'weekly', 'monthly'].includes(t.recurrence)) {
      setRecurrencePreset(t.recurrence);
      setCustomRecurrence('');
    } else {
      setRecurrencePreset('custom');
      setCustomRecurrence(t.recurrence);
    }
    setEditorOpen(true);
  }

  async function handleSaveTask(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const recValue =
        recurrencePreset === 'none'
          ? ''
          : recurrencePreset === 'custom'
            ? customRecurrence.trim()
            : recurrencePreset;
      const dueISO = dueAt ? new Date(dueAt).toISOString() : '';

      const payload = {
        title: title.trim(),
        description: description.trim(),
        status,
        due_at: dueISO,
        recurrence: recValue,
      };
      if (editingTask) {
        await apiFetch(`/tasks/${editingTask.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        setNotice('Tarea actualizada.');
      } else {
        await apiFetch('/tasks', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setNotice('Tarea creada.');
      }
      setEditorOpen(false);
      await loadAll();
    } catch (err: any) {
      setError(err?.message || 'No se pudo guardar la tarea.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleDone(t: TaskItem) {
    setError('');
    try {
      await apiFetch(`/tasks/${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: t.status === 'done' ? 'pending' : 'done' }),
      });
      await loadAll();
    } catch (err: any) {
      setError(err?.message || 'No se pudo actualizar la tarea.');
    }
  }

  async function handleDeleteTask(id: string) {
    setError('');
    setNotice('');
    try {
      await apiFetch(`/tasks/${id}`, { method: 'DELETE' });
      setNotice('Tarea eliminada.');
      await loadAll();
    } catch (err: any) {
      setError(err?.message || 'No se pudo eliminar la tarea.');
    }
  }

  async function handleCreatePlan(e: React.FormEvent) {
    e.preventDefault();
    if (!planName.trim()) return;
    const validItems = planItems.filter((it) => it.title.trim() !== '');
    if (validItems.length === 0) return;
    setError('');
    setNotice('');
    try {
      await apiFetch('/task-plans', {
        method: 'POST',
        body: JSON.stringify({
          name: planName.trim(),
          description: planDesc.trim(),
          items: validItems.map((it) => ({
            ...it,
            title: it.title.trim(),
          })),
        }),
      });
      setPlanName('');
      setPlanDesc('');
      setPlanItems([{ title: '', description: '', offset_days: 1, recurrence: '' }]);
      setPlanSheetOpen(false);
      setNotice('Plan de tareas creado.');
      await loadAll();
    } catch (err: any) {
      setError(err?.message || 'No se pudo crear el plan.');
    }
  }

  async function handleApplyPlan(planId: string) {
    setError('');
    setNotice('');
    try {
      const res = await apiFetch<{ created: number }>(`/task-plans/${planId}/apply`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setNotice(`Plan aplicado: ${res.created} tareas creadas.`);
      await loadAll();
    } catch (err: any) {
      setError(err?.message || 'No se pudo aplicar el plan.');
    }
  }

  async function handleDeletePlan(planId: string) {
    setError('');
    setNotice('');
    try {
      await apiFetch(`/task-plans/${planId}`, { method: 'DELETE' });
      setNotice('Plan de tareas eliminado.');
      await loadAll();
    } catch (err: any) {
      setError(err?.message || 'No se pudo eliminar el plan.');
    }
  }

  const tabs: Array<{ key: FilterTab; label: string }> = [
    { key: 'all', label: 'Todas' },
    { key: 'pending', label: 'Pendientes' },
    { key: 'in_progress', label: 'En progreso' },
    { key: 'overdue', label: 'Vencidas' },
    { key: 'done', label: 'Completadas' },
  ];

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-5xl mx-auto min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-[var(--text)]">Tareas y Planes</h1>
          <p className="text-xs text-[var(--text-muted)]">
            Organiza seguimientos con fecha límite, recurrencia y plantillas reutilizables
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => setPlanSheetOpen(true)}>
            <ListChecks className="w-4 h-4" /> Nuevo Plan
          </Button>
          <Button size="sm" onClick={openCreateTask}>
            <Plus className="w-4 h-4" /> Nueva Tarea
          </Button>
        </div>
      </div>

      {notice && (
        <div className="px-3.5 py-2 rounded-xl border border-emerald-200 bg-emerald-50 text-xs text-emerald-800">
          {notice}
        </div>
      )}
      {error && (
        <div className="px-3.5 py-2 rounded-xl border border-red-200 bg-red-50 text-xs text-red-800">
          {error}
        </div>
      )}

      {/* Filtros */}
      <div className="flex flex-wrap gap-1.5">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setFilter(tab.key)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer transition-colors ${
              filter === tab.key
                ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                : 'bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] hover:border-[var(--accent)]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Lista de Tareas */}
      {loading ? (
        <Card className="p-8 text-center text-sm text-[var(--text-muted)]">
          Cargando tareas...
        </Card>
      ) : filteredTasks.length === 0 ? (
        <Card className="p-8 text-center space-y-2">
          <CheckSquare className="w-8 h-8 text-[var(--text-muted)] mx-auto" />
          <div className="text-sm font-medium text-[var(--text)]">No hay tareas en esta vista</div>
          <p className="text-xs text-[var(--text-muted)]">
            Crea una nueva tarea o aplica un plan de tareas reutilizable.
          </p>
        </Card>
      ) : (
        <div className="space-y-2.5">
          {filteredTasks.map((t) => {
            const overdue = isOverdue(t);
            return (
              <Card key={t.id} className="p-3.5 flex flex-wrap items-center justify-between gap-3 min-w-0">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleDone(t)}
                      className={`text-sm font-semibold text-left cursor-pointer ${
                        t.status === 'done' ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text)]'
                      }`}
                    >
                      {t.title}
                    </button>
                    <Badge
                      tone={
                        t.status === 'done'
                          ? 'success'
                          : overdue
                            ? 'danger'
                            : t.status === 'in_progress'
                              ? 'accent'
                              : 'neutral'
                      }
                    >
                      {overdue ? 'Vencida' : statusLabel(t.status)}
                    </Badge>
                    {t.recurrence && (
                      <Badge tone="warning">
                        <Repeat className="w-3 h-3" /> {recurrenceLabel(t.recurrence)}
                      </Badge>
                    )}
                  </div>
                  {t.description && (
                    <p className="text-xs text-[var(--text-muted)] line-clamp-2">{t.description}</p>
                  )}
                  {t.due_at && (
                    <div className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                      <CalendarClock className="w-3.5 h-3.5" />
                      <span>Vence: {new Date(t.due_at).toLocaleString('es')}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button size="sm" variant="secondary" onClick={() => toggleDone(t)}>
                    {t.status === 'done' ? 'Reabrir' : 'Completar'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => openEditTask(t)}
                    aria-label={`Editar ${t.title}`}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleDeleteTask(t.id)}
                    aria-label={`Eliminar ${t.title}`}
                    className="text-[var(--danger)]"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Planes de Tareas Reutilizables */}
      <section className="space-y-3 pt-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text)]">Planes Reutilizables</h2>
            <p className="text-xs text-[var(--text-muted)]">
              Secuencias predefinidas que generan tareas con fechas relativas al instante
            </p>
          </div>
        </div>

        {plans.length === 0 ? (
          <Card className="p-5 text-xs text-[var(--text-muted)]">
            Aún no hay planes de tareas creados. Usa &quot;Nuevo Plan&quot; para crear una plantilla.
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {plans.map((p) => (
              <Card key={p.id} className="p-4 space-y-3 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-sm truncate">{p.name}</div>
                    {p.description && (
                      <div className="text-xs text-[var(--text-muted)] line-clamp-2">{p.description}</div>
                    )}
                  </div>
                  <Badge tone="accent">{p.items?.length || 0} pasos</Badge>
                </div>
                <ul className="space-y-1 text-xs text-[var(--text-muted)]">
                  {(p.items || []).slice(0, 4).map((it, idx) => (
                    <li key={idx} className="truncate">
                      • {it.title} (+{it.offset_days}d{it.recurrence ? `, ${recurrenceLabel(it.recurrence)}` : ''})
                    </li>
                  ))}
                </ul>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <Button size="sm" onClick={() => handleApplyPlan(p.id)}>
                    <Play className="w-3.5 h-3.5" /> Aplicar plan
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleDeletePlan(p.id)}
                    className="text-[var(--danger)]"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Sheet Crear/Editar Tarea */}
      <Sheet
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editingTask ? 'Editar tarea' : 'Nueva tarea'}
      >
        <form onSubmit={handleSaveTask} className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium">Título *</label>
            <Input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Llamar para confirmar propuesta..."
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium">Descripción</label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Detalles adicionales..."
              className="w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 py-2 text-sm"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium">Estado</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as TaskItem['status'])}
                className="h-10 w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
              >
                <option value="pending">Pendiente</option>
                <option value="in_progress">En progreso</option>
                <option value="done">Completada</option>
                <option value="cancelled">Cancelada</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Fecha límite</label>
              <Input
                type="datetime-local"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium">Recurrencia</label>
            <select
              value={recurrencePreset}
              onChange={(e) => setRecurrencePreset(e.target.value)}
              className="h-10 w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
            >
              <option value="none">Sin recurrencia</option>
              <option value="daily">Diaria</option>
              <option value="weekly">Semanal</option>
              <option value="monthly">Mensual</option>
              <option value="custom">Personalizada</option>
            </select>
          </div>

          {recurrencePreset === 'custom' && (
            <div className="space-y-1">
              <label className="text-xs font-medium">Regla personalizada</label>
              <Input
                value={customRecurrence}
                onChange={(e) => setCustomRecurrence(e.target.value)}
                placeholder="Ej. cada 3 días"
              />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setEditorOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Guardando...' : editingTask ? 'Guardar cambios' : 'Crear tarea'}
            </Button>
          </div>
        </form>
      </Sheet>

      {/* Sheet Nuevo Plan de Tareas */}
      <Sheet
        open={planSheetOpen}
        onClose={() => setPlanSheetOpen(false)}
        title="Nuevo Plan de Tareas"
      >
        <form onSubmit={handleCreatePlan} className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium">Nombre del plan *</label>
            <Input
              required
              value={planName}
              onChange={(e) => setPlanName(e.target.value)}
              placeholder="Ej. Seguimiento Post-Demo"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Descripción</label>
            <Input
              value={planDesc}
              onChange={(e) => setPlanDesc(e.target.value)}
              placeholder="Secuencia estándar de 3 pasos"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium">Tareas del plan</label>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() =>
                  setPlanItems((prev) => [
                    ...prev,
                    { title: '', description: '', offset_days: 3, recurrence: '' },
                  ])
                }
              >
                <Plus className="w-3.5 h-3.5" /> Agregar paso
              </Button>
            </div>
            {planItems.map((it, idx) => (
              <div key={idx} className="p-2.5 rounded-xl border border-[var(--border)] space-y-2">
                <Input
                  required
                  placeholder={`Paso ${idx + 1}: Título de la tarea`}
                  value={it.title}
                  onChange={(e) =>
                    setPlanItems((prev) =>
                      prev.map((x, i) => (i === idx ? { ...x, title: e.target.value } : x))
                    )
                  }
                />
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    type="number"
                    min="0"
                    placeholder="Días (+)"
                    value={String(it.offset_days)}
                    onChange={(e) =>
                      setPlanItems((prev) =>
                        prev.map((x, i) =>
                          i === idx ? { ...x, offset_days: parseInt(e.target.value || '0', 10) || 0 } : x
                        )
                      )
                    }
                  />
                  <select
                    value={it.recurrence}
                    onChange={(e) =>
                      setPlanItems((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, recurrence: e.target.value } : x))
                      )
                    }
                    className="h-10 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-2 text-xs"
                  >
                    <option value="">Sin recurrencia</option>
                    <option value="daily">Diaria</option>
                    <option value="weekly">Semanal</option>
                    <option value="monthly">Mensual</option>
                  </select>
                </div>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setPlanSheetOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit">Guardar Plan</Button>
          </div>
        </form>
      </Sheet>
    </div>
  );
}
