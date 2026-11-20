import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  Plus,
  ArrowRight,
  Settings2,
  Trash2,
  CheckSquare,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  ExternalLink,
} from 'lucide-react';
import { ApiError, apiFetch, subscribeSSE } from '../lib/api';
import { useAuth } from '../App';
import { Badge, Button, Card, Input, Sheet } from '../components/ui/primitives';

interface Stage {
  id: string;
  name: string;
  position: number;
  color: string;
  is_won: boolean;
  is_lost: boolean;
  requires_human: boolean;
}

interface FieldSchemaItem {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'boolean';
  options?: string[];
}

interface Pipeline {
  id: string;
  name: string;
  pipeline_type: 'sales' | 'support' | 'custom';
  vocabulary: { deal?: string; deals?: string; stage?: string };
  fields_schema: FieldSchemaItem[];
  is_default: boolean;
  stages: Stage[];
}

interface Lead {
  id: string;
  contact_id: string;
  contact_name: string;
  contact_phone: string;
  pipeline_id: string;
  stage_id: string;
  title: string;
  position_in_stage: number;
  value_cents: number;
  currency: string;
  status: 'open' | 'won' | 'lost';
  owner_user_id: string | null;
  tags: string[];
  version: number;
}

const ROLE_ORDER: Record<string, number> = {
  viewer: 0,
  agent: 1,
  manager: 2,
  admin: 3,
};

function computeFractionalPosition(colLeads: Lead[], targetIndex?: number): number {
  if (colLeads.length === 0) return 1000;
  if (targetIndex === undefined || targetIndex >= colLeads.length) {
    return colLeads[colLeads.length - 1].position_in_stage + 1000;
  }
  if (targetIndex <= 0) {
    return colLeads[0].position_in_stage / 2;
  }
  const prev = colLeads[targetIndex - 1].position_in_stage;
  const next = colLeads[targetIndex].position_in_stage;
  return (prev + next) / 2;
}

export function KanbanPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { id?: string };
  const routePipelineId = params?.id;

  const roleRank = ROLE_ORDER[user?.role || 'viewer'] ?? 0;
  const canEditLeads = roleRank >= 1;
  const canManagePipelines = roleRank >= 2;

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [activePipe, setActivePipe] = useState<Pipeline | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [team, setTeam] = useState<any[]>([]);
  const [mobileStageId, setMobileStageId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ tone: 'warning' | 'error' | 'success'; text: string } | null>(null);
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)').matches : true
  );

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    setIsDesktop(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Create lead modal
  const [newOpen, setNewOpen] = useState(false);
  const [moveLead, setMoveLead] = useState<Lead | null>(null);
  const [title, setTitle] = useState('');
  const [contactId, setContactId] = useState('');
  const [valueAmount, setValueAmount] = useState('0');
  const [tagsInput, setTagsInput] = useState('');

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkStageId, setBulkStageId] = useState('');
  const [bulkOwnerId, setBulkOwnerId] = useState('');

  // Pipeline & Stage management modal
  const [pipeModalOpen, setPipeModalOpen] = useState(false);
  const [pipeMode, setPipeMode] = useState<'create' | 'edit'>('edit');
  const [pipeName, setPipeName] = useState('');
  const [pipeType, setPipeType] = useState<'sales' | 'support' | 'custom'>('sales');
  const [vocabDeal, setVocabDeal] = useState('Lead');
  const [vocabDeals, setVocabDeals] = useState('Leads');
  const [pipeIsDefault, setPipeIsDefault] = useState(false);
  const [fieldsSchema, setFieldsSchema] = useState<FieldSchemaItem[]>([]);
  const [newStageName, setNewStageName] = useState('');
  const [newStageReqHuman, setNewStageReqHuman] = useState(false);
  const [newStageWon, setNewStageWon] = useState(false);
  const [newStageLost, setNewStageLost] = useState(false);

  const loadBoard = useCallback(
    async (preferredPipeId?: string) => {
      try {
        const [pipes, cts, members] = await Promise.all([
          apiFetch<Pipeline[]>('/pipelines'),
          apiFetch<any[]>('/contacts'),
          apiFetch<any[]>('/team').catch(() => []),
        ]);
        setPipelines(pipes || []);
        setContacts(cts || []);
        setTeam(members || []);

        const targetId = preferredPipeId || routePipelineId;
        const chosen =
          (pipes || []).find((p) => p.id === targetId) ||
          (pipes || []).find((p) => p.is_default) ||
          (pipes || [])[0] ||
          null;
        setActivePipe(chosen);
        if (chosen) {
          const lds = await apiFetch<Lead[]>(`/leads?pipeline_id=${chosen.id}`);
          setLeads(lds || []);
          setMobileStageId((prev) =>
            chosen.stages?.some((s) => s.id === prev)
              ? prev
              : chosen.stages?.find((s) => (lds || []).some((l) => l.stage_id === s.id))?.id ||
                chosen.stages?.[0]?.id ||
                ''
          );
        } else {
          setLeads([]);
        }
      } catch (err: any) {
        setBanner({ tone: 'error', text: err?.message || 'Error al cargar el embudo.' });
      } finally {
        setLoading(false);
      }
    },
    [routePipelineId]
  );

  useEffect(() => {
    let active = true;
    (async () => {
      if (!active) return;
      await loadBoard(routePipelineId);
    })();
    const unsub = subscribeSSE((evType) => {
      if (evType === 'lead.updated' || evType === 'lead.created' || evType === 'lead.deleted') {
        loadBoard(routePipelineId);
      }
    });
    return () => {
      active = false;
      unsub();
    };
  }, [loadBoard, routePipelineId]);

  const stages = useMemo(() => activePipe?.stages || [], [activePipe]);

  function selectPipeline(p: Pipeline) {
    setSelectedIds([]);
    setActivePipe(p);
    setMobileStageId(p.stages?.[0]?.id || '');
    navigate({ to: '/app/pipelines/$id', params: { id: p.id } });
  }

  async function handleCreateLead(e: React.FormEvent) {
    e.preventDefault();
    if (!activePipe || !contactId || !title.trim()) return;
    setBanner(null);
    try {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      await apiFetch('/leads', {
        method: 'POST',
        body: JSON.stringify({
          pipeline_id: activePipe.id,
          stage_id: activePipe.stages[0]?.id,
          contact_id: contactId,
          title: title.trim(),
          value_cents: Math.round(Number(valueAmount || 0) * 100),
          tags,
        }),
      });
      setTitle('');
      setValueAmount('0');
      setTagsInput('');
      setNewOpen(false);
      await loadBoard(activePipe.id);
    } catch (err: any) {
      setBanner({ tone: 'error', text: err?.message || 'No se pudo crear el registro.' });
    }
  }

  async function handleMoveStage(lead: Lead, targetStageId: string, targetIndex?: number) {
    const colLeads = leads
      .filter((l) => l.stage_id === targetStageId && l.id !== lead.id)
      .sort((a, b) => a.position_in_stage - b.position_in_stage);
    const nextPos = computeFractionalPosition(colLeads, targetIndex);

    setLeads((prev) =>
      prev.map((l) =>
        l.id === lead.id ? { ...l, stage_id: targetStageId, position_in_stage: nextPos } : l
      )
    );
    setMoveLead(null);
    setBanner(null);

    try {
      await apiFetch(`/leads/${lead.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          stage_id: targetStageId,
          position_in_stage: nextPos,
          version: lead.version,
        }),
      });
      await loadBoard(activePipe?.id);
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 409) {
        setBanner({
          tone: 'warning',
          text: 'Conflicto de versión (409): otro agente modificó este lead. Se actualizó el tablero.',
        });
      } else {
        setBanner({ tone: 'error', text: err?.message || 'No se pudo mover el lead.' });
      }
      await loadBoard(activePipe?.id);
    }
  }

  function toggleSelectLead(id: string) {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 50) {
        setBanner({
          tone: 'warning',
          text: 'Solo puedes seleccionar hasta 50 registros para acciones masivas.',
        });
        return prev;
      }
      return [...prev, id];
    });
  }

  async function handleBulkAction(action: 'move_stage' | 'assign' | 'delete') {
    if (selectedIds.length === 0) return;
    if (selectedIds.length > 50) {
      setBanner({ tone: 'warning', text: 'Máximo 50 registros por acción masiva.' });
      return;
    }
    if (action === 'move_stage' && !bulkStageId) return;
    if (action === 'assign' && !bulkOwnerId) return;

    setBanner(null);
    try {
      await apiFetch('/leads/bulk', {
        method: 'POST',
        body: JSON.stringify({
          lead_ids: selectedIds,
          action,
          stage_id: action === 'move_stage' ? bulkStageId : undefined,
          owner_user_id: action === 'assign' ? bulkOwnerId : undefined,
        }),
      });
      setSelectedIds([]);
      setBulkStageId('');
      setBulkOwnerId('');
      setBanner({ tone: 'success', text: 'Acción masiva completada.' });
      await loadBoard(activePipe?.id);
    } catch (err: any) {
      setBanner({ tone: 'error', text: err?.message || 'Error en acción masiva.' });
    }
  }

  function openPipelineModal(mode: 'create' | 'edit') {
    setPipeMode(mode);
    if (mode === 'edit' && activePipe) {
      setPipeName(activePipe.name);
      setPipeType(activePipe.pipeline_type);
      setVocabDeal(activePipe.vocabulary?.deal || 'Lead');
      setVocabDeals(activePipe.vocabulary?.deals || 'Leads');
      setPipeIsDefault(activePipe.is_default);
      setFieldsSchema(activePipe.fields_schema || []);
    } else {
      setPipeName('');
      setPipeType('sales');
      setVocabDeal('Lead');
      setVocabDeals('Leads');
      setPipeIsDefault(false);
      setFieldsSchema([]);
    }
    setPipeModalOpen(true);
  }

  async function handleSavePipeline(e: React.FormEvent) {
    e.preventDefault();
    if (!pipeName.trim()) return;
    setBanner(null);
    try {
      const payload = {
        name: pipeName.trim(),
        pipeline_type: pipeType,
        vocabulary: { deal: vocabDeal.trim() || 'Lead', deals: vocabDeals.trim() || 'Leads', stage: 'Etapa' },
        fields_schema: fieldsSchema.filter((f) => f.key.trim() && f.label.trim()),
        is_default: pipeIsDefault,
      };
      if (pipeMode === 'create') {
        const created = await apiFetch<Pipeline>('/pipelines', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setPipeModalOpen(false);
        setBanner({ tone: 'success', text: 'Embudo creado.' });
        await loadBoard(created.id);
        navigate({ to: '/app/pipelines/$id', params: { id: created.id } });
      } else if (activePipe) {
        await apiFetch(`/pipelines/${activePipe.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        setPipeModalOpen(false);
        setBanner({ tone: 'success', text: 'Embudo actualizado.' });
        await loadBoard(activePipe.id);
      }
    } catch (err: any) {
      setBanner({ tone: 'error', text: err?.message || 'No se pudo guardar el embudo.' });
    }
  }

  async function handleCreateStage() {
    if (!activePipe || !newStageName.trim()) return;
    setBanner(null);
    try {
      await apiFetch(`/pipelines/${activePipe.id}/stages`, {
        method: 'POST',
        body: JSON.stringify({
          name: newStageName.trim(),
          requires_human: newStageReqHuman,
          is_won: newStageWon,
          is_lost: newStageLost,
        }),
      });
      setNewStageName('');
      setNewStageReqHuman(false);
      setNewStageWon(false);
      setNewStageLost(false);
      await loadBoard(activePipe.id);
    } catch (err: any) {
      setBanner({ tone: 'error', text: err?.message || 'No se pudo crear la etapa.' });
    }
  }

  async function handleReorderStage(stageIdx: number, dir: -1 | 1) {
    const targetIdx = stageIdx + dir;
    if (targetIdx < 0 || targetIdx >= stages.length) return;
    const current = stages[stageIdx];
    const swapWith = stages[targetIdx];
    try {
      await Promise.all([
        apiFetch(`/stages/${current.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ position: swapWith.position }),
        }),
        apiFetch(`/stages/${swapWith.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ position: current.position }),
        }),
      ]);
      await loadBoard(activePipe?.id);
    } catch (err: any) {
      setBanner({ tone: 'error', text: err?.message || 'No se pudo reordenar la etapa.' });
    }
  }

  async function handleDeleteStage(stageId: string) {
    setBanner(null);
    try {
      await apiFetch(`/stages/${stageId}`, { method: 'DELETE' });
      await loadBoard(activePipe?.id);
    } catch (err: any) {
      setBanner({ tone: 'error', text: err?.message || 'No se pudo eliminar la etapa.' });
    }
  }

  const dealSingular = activePipe?.vocabulary?.deal || 'Lead';

  return (
    <div className="p-4 md:p-6 space-y-4 min-w-0">
      {/* Cabecera y selector de pipelines */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <h1 className="text-xl font-bold text-[var(--text)]">Embudo</h1>
          <div className="flex gap-1.5 flex-wrap">
            {pipelines.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => selectPipeline(p)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer transition-colors ${
                  activePipe?.id === p.id
                    ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                    : 'bg-[var(--surface)] border border-[var(--border)] text-[var(--text)]'
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManagePipelines && activePipe && (
            <Button size="sm" variant="secondary" onClick={() => openPipelineModal('edit')}>
              <Settings2 className="w-4 h-4" /> Configurar
            </Button>
          )}
          {canManagePipelines && (
            <Button size="sm" variant="secondary" onClick={() => openPipelineModal('create')}>
              <Plus className="w-4 h-4" /> Embudo
            </Button>
          )}
          {canEditLeads && (
            <Button size="sm" onClick={() => setNewOpen(true)} disabled={!activePipe}>
              <Plus className="w-4 h-4" /> Nuevo {dealSingular}
            </Button>
          )}
        </div>
      </div>

      {/* Banner de estado / conflictos 409 */}
      {banner && (
        <div
          role="alert"
          className={`px-3.5 py-2.5 rounded-xl border text-xs flex items-center justify-between gap-2 ${
            banner.tone === 'warning'
              ? 'bg-amber-50 border-amber-200 text-amber-900'
              : banner.tone === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          <span className="flex items-center gap-2">
            {banner.tone === 'warning' && <AlertTriangle className="w-4 h-4 shrink-0" />}
            {banner.text}
          </span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="text-xs underline cursor-pointer shrink-0"
          >
            Cerrar
          </button>
        </div>
      )}

      {/* Barra de acciones masivas */}
      {canEditLeads && selectedIds.length > 0 && (
        <Card className="p-3 bg-teal-50/70 border-teal-200 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text)]">
            <CheckSquare className="w-4 h-4 text-[var(--accent)]" />
            <span>{selectedIds.length} seleccionados (máx. 50)</span>
            <button
              type="button"
              onClick={() => setSelectedIds([])}
              className="text-xs underline text-[var(--text-muted)] cursor-pointer"
            >
              Limpiar
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={bulkStageId}
              onChange={(e) => setBulkStageId(e.target.value)}
              aria-label="Mover seleccionados a etapa"
              className="h-8 rounded-lg border border-[var(--border-input)] bg-[var(--bg)] px-2 text-xs"
            >
              <option value="">Mover a etapa...</option>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <Button size="sm" variant="secondary" disabled={!bulkStageId} onClick={() => handleBulkAction('move_stage')}>
              Mover
            </Button>

            {team.length > 0 && (
              <>
                <select
                  value={bulkOwnerId}
                  onChange={(e) => setBulkOwnerId(e.target.value)}
                  aria-label="Asignar seleccionados a"
                  className="h-8 rounded-lg border border-[var(--border-input)] bg-[var(--bg)] px-2 text-xs"
                >
                  <option value="">Asignar a...</option>
                  {team.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.full_name || m.email}
                    </option>
                  ))}
                </select>
                <Button size="sm" variant="secondary" disabled={!bulkOwnerId} onClick={() => handleBulkAction('assign')}>
                  Asignar
                </Button>
              </>
            )}

            <Button size="sm" variant="danger" onClick={() => handleBulkAction('delete')}>
              <Trash2 className="w-3.5 h-3.5" /> Eliminar
            </Button>
          </div>
        </Card>
      )}

      {loading ? (
        <Card className="p-8 text-center text-sm text-[var(--text-muted)]">Cargando embudo...</Card>
      ) : !activePipe ? (
        <Card className="p-8 text-center text-sm text-[var(--text-muted)]">
          No hay embudos configurados aún.
        </Card>
      ) : (
        <>
          {!isDesktop && (
          <div className="md:hidden space-y-3 min-w-0">
            <div role="tablist" aria-label="Etapas del embudo" className="flex gap-1.5 overflow-x-auto pb-1">
              {stages.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={mobileStageId === s.id}
                  onClick={() => setMobileStageId(s.id)}
                  className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer ${
                    mobileStageId === s.id
                      ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                      : 'bg-[var(--surface)] border border-[var(--border)]'
                  }`}
                >
                  {s.name} ({leads.filter((l) => l.stage_id === s.id).length})
                </button>
              ))}
            </div>
            <div className="space-y-2.5">
              {leads
                .filter((l) => l.stage_id === mobileStageId)
                .sort((a, b) => a.position_in_stage - b.position_in_stage)
                .map((l) => (
                  <Card key={l.id} className="p-3.5 flex items-center justify-between gap-2 min-w-0">
                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      {canEditLeads && (
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(l.id)}
                          onChange={() => toggleSelectLead(l.id)}
                          aria-label={`Seleccionar ${l.title}`}
                          className="mt-1 shrink-0"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <Link
                          to="/app/leads/$id"
                          params={{ id: l.id }}
                          className="font-semibold text-sm text-[var(--text)] hover:text-[var(--accent)] truncate block"
                        >
                          {l.title}
                        </Link>
                        <div className="text-xs text-[var(--text-muted)] truncate">{l.contact_name}</div>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1">
                          <span className="text-xs font-medium text-[var(--accent)]">
                            {l.currency} {(l.value_cents / 100).toFixed(2)}
                          </span>
                          <Badge tone={l.status === 'won' ? 'success' : l.status === 'lost' ? 'danger' : 'neutral'}>
                            {l.status === 'won' ? 'Ganado' : l.status === 'lost' ? 'Perdido' : 'Abierto'}
                          </Badge>
                        </div>
                      </div>
                    </div>
                    {canEditLeads && (
                      <Button size="sm" variant="secondary" onClick={() => setMoveLead(l)} className="shrink-0">
                        Mover <ArrowRight className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </Card>
                ))}
            </div>
          </div>
          )}

          {isDesktop && (
          <div tabIndex={0} role="region" aria-label="Tablero de etapas" className="hidden md:flex gap-4 overflow-x-auto pb-4">
            {stages.map((s) => {
              const colLeads = leads
                .filter((l) => l.stage_id === s.id)
                .sort((a, b) => a.position_in_stage - b.position_in_stage);
              return (
                <div
                  key={s.id}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (!canEditLeads) return;
                    const leadId = e.dataTransfer.getData('text/plain');
                    const found = leads.find((x) => x.id === leadId);
                    if (found) handleMoveStage(found, s.id);
                  }}
                  className="w-72 shrink-0 rounded-2xl bg-[var(--surface)] border border-[var(--border)] p-3 flex flex-col gap-2.5 min-h-[440px]"
                >
                  <div className="flex items-center justify-between px-1 gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-semibold text-sm truncate">{s.name}</span>
                      {s.requires_human && <Badge tone="warning">Humano</Badge>}
                    </div>
                    <Badge>{colLeads.length}</Badge>
                  </div>
                  {colLeads.map((l, idx) => (
                    <Card
                      key={l.id}
                      draggable={canEditLeads}
                      onDragStart={(e) => e.dataTransfer.setData('text/plain', l.id)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!canEditLeads) return;
                        const leadId = e.dataTransfer.getData('text/plain');
                        const found = leads.find((x) => x.id === leadId);
                        if (found && found.id !== l.id) {
                          handleMoveStage(found, s.id, idx);
                        }
                      }}
                      className="p-3 cursor-grab active:cursor-grabbing space-y-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2 min-w-0">
                          {canEditLeads && (
                            <input
                              type="checkbox"
                              checked={selectedIds.includes(l.id)}
                              onChange={() => toggleSelectLead(l.id)}
                              aria-label={`Seleccionar ${l.title}`}
                              className="mt-0.5 shrink-0"
                            />
                          )}
                          <Link
                            to="/app/leads/$id"
                            params={{ id: l.id }}
                            className="font-semibold text-sm text-[var(--text)] hover:text-[var(--accent)] leading-snug break-words"
                          >
                            {l.title}
                          </Link>
                        </div>
                        <Link
                          to="/app/leads/$id"
                          params={{ id: l.id }}
                          aria-label={`Ver detalle de ${l.title}`}
                          className="text-[var(--text-muted)] hover:text-[var(--accent)] shrink-0"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </Link>
                      </div>
                      <div className="text-xs text-[var(--text-muted)] truncate">{l.contact_name}</div>
                      {l.tags?.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {l.tags.slice(0, 3).map((tag) => (
                            <Badge key={tag} tone="accent" className="text-[10px] px-2 py-0">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center justify-between pt-1">
                        <span className="text-xs font-medium text-[var(--accent)]">
                          {l.currency} {(l.value_cents / 100).toFixed(2)}
                        </span>
                        <div className="flex items-center gap-2">
                          <Badge
                            tone={l.status === 'won' ? 'success' : l.status === 'lost' ? 'danger' : 'neutral'}
                            className="text-[10px] px-2 py-0"
                          >
                            {l.status === 'won' ? 'Ganado' : l.status === 'lost' ? 'Perdido' : 'Abierto'}
                          </Badge>
                          {canEditLeads && (
                            <button
                              type="button"
                              onClick={() => setMoveLead(l)}
                              className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer"
                            >
                              Mover
                            </button>
                          )}
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              );
            })}
          </div>
          )}
        </>
      )}

      {/* Modal Nuevo Lead */}
      <Sheet open={newOpen} onClose={() => setNewOpen(false)} title={`Nuevo ${dealSingular}`}>
        <form onSubmit={handleCreateLead} className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium">Título *</label>
            <Input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Plan Empresarial"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Contacto *</label>
            <select
              required
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              className="h-10 w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
            >
              <option value="">Selecciona un contacto...</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Valor ($)</label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={valueAmount}
              onChange={(e) => setValueAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Etiquetas (separadas por coma)</label>
            <Input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="vip, whatsapp"
            />
          </div>
          <Button type="submit" className="w-full">
            Crear {dealSingular}
          </Button>
        </form>
      </Sheet>

      {/* Modal Mover Etapa */}
      <Sheet open={!!moveLead} onClose={() => setMoveLead(null)} title={`Mover "${moveLead?.title}"`}>
        <div className="space-y-2">
          {stages.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => moveLead && handleMoveStage(moveLead, s.id)}
              className="w-full text-left p-3 rounded-xl border border-[var(--border)] hover:border-[var(--accent)] text-sm font-medium cursor-pointer flex items-center justify-between"
            >
              <span>{s.name}</span>
              {s.id === moveLead?.stage_id && <Badge tone="accent">Actual</Badge>}
            </button>
          ))}
        </div>
      </Sheet>

      {/* Modal Configuración de Embudo y Etapas */}
      <Sheet
        open={pipeModalOpen}
        onClose={() => setPipeModalOpen(false)}
        title={pipeMode === 'create' ? 'Nuevo Embudo' : `Configurar "${activePipe?.name}"`}
      >
        <div className="space-y-5">
          <form onSubmit={handleSavePipeline} className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium">Nombre del embudo *</label>
              <Input
                required
                value={pipeName}
                onChange={(e) => setPipeName(e.target.value)}
                placeholder="Ventas B2B"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium">Tipo</label>
                <select
                  value={pipeType}
                  onChange={(e) => setPipeType(e.target.value as 'sales' | 'support' | 'custom')}
                  className="h-10 w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
                >
                  <option value="sales">Ventas</option>
                  <option value="support">Soporte (Tickets)</option>
                  <option value="custom">Personalizado</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Vocabulario (singular / plural)</label>
                <div className="grid grid-cols-2 gap-1.5">
                  <Input
                    value={vocabDeal}
                    onChange={(e) => setVocabDeal(e.target.value)}
                    placeholder="Lead"
                  />
                  <Input
                    value={vocabDeals}
                    onChange={(e) => setVocabDeals(e.target.value)}
                    placeholder="Leads"
                  />
                </div>
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={pipeIsDefault}
                onChange={(e) => setPipeIsDefault(e.target.checked)}
              />
              Embudo predeterminado de la organización
            </label>

            {/* Campos personalizados del embudo */}
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold">Campos personalizados</label>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setFieldsSchema((prev) => [
                      ...prev,
                      { key: `campo_${prev.length + 1}`, label: 'Nuevo campo', type: 'text' },
                    ])
                  }
                >
                  <Plus className="w-3.5 h-3.5" /> Campo
                </Button>
              </div>
              {fieldsSchema.map((f, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-1.5 items-center">
                  <Input
                    className="col-span-4 h-8 text-xs"
                    placeholder="clave"
                    value={f.key}
                    onChange={(e) =>
                      setFieldsSchema((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, key: e.target.value } : x))
                      )
                    }
                  />
                  <Input
                    className="col-span-4 h-8 text-xs"
                    placeholder="Etiqueta"
                    value={f.label}
                    onChange={(e) =>
                      setFieldsSchema((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, label: e.target.value } : x))
                      )
                    }
                  />
                  <select
                    value={f.type}
                    onChange={(e) =>
                      setFieldsSchema((prev) =>
                        prev.map((x, i) =>
                          i === idx ? { ...x, type: e.target.value as FieldSchemaItem['type'] } : x
                        )
                      )
                    }
                    className="col-span-3 h-8 rounded-lg border border-[var(--border-input)] bg-[var(--bg)] px-1.5 text-xs"
                  >
                    <option value="text">Texto</option>
                    <option value="number">Número</option>
                    <option value="date">Fecha</option>
                    <option value="select">Lista</option>
                    <option value="boolean">Sí/No</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => setFieldsSchema((prev) => prev.filter((_, i) => i !== idx))}
                    className="col-span-1 text-[var(--danger)] flex justify-center cursor-pointer"
                    aria-label="Quitar campo"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <Button type="submit" className="w-full">
              {pipeMode === 'create' ? 'Crear Embudo' : 'Guardar Cambios'}
            </Button>
          </form>

          {/* Gestión de etapas (solo en modo edición) */}
          {pipeMode === 'edit' && activePipe && (
            <div className="border-t border-[var(--border)] pt-4 space-y-3">
              <div className="text-xs font-semibold">Etapas del embudo</div>
              <div className="space-y-1.5">
                {stages.map((st, idx) => (
                  <div
                    key={st.id}
                    className="flex items-center justify-between gap-2 p-2 rounded-xl border border-[var(--border)] text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium truncate">{st.name}</span>
                      {st.is_won && <Badge tone="success">Ganado</Badge>}
                      {st.is_lost && <Badge tone="danger">Perdido</Badge>}
                      {st.requires_human && <Badge tone="warning">Humano</Badge>}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => handleReorderStage(idx, -1)}
                        className="p-1 text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-30 cursor-pointer"
                        aria-label={`Subir ${st.name}`}
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={idx === stages.length - 1}
                        onClick={() => handleReorderStage(idx, 1)}
                        className="p-1 text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-30 cursor-pointer"
                        aria-label={`Bajar ${st.name}`}
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteStage(st.id)}
                        className="p-1 text-[var(--danger)] cursor-pointer"
                        aria-label={`Eliminar ${st.name}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="p-2.5 rounded-xl bg-[var(--surface)] border border-[var(--border)] space-y-2">
                <div className="flex gap-2">
                  <Input
                    className="h-8 text-xs"
                    placeholder="Nueva etapa..."
                    value={newStageName}
                    onChange={(e) => setNewStageName(e.target.value)}
                  />
                  <Button type="button" size="sm" onClick={handleCreateStage}>
                    Agregar
                  </Button>
                </div>
                <div className="flex flex-wrap gap-3 text-[11px]">
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newStageReqHuman}
                      onChange={(e) => setNewStageReqHuman(e.target.checked)}
                    />
                    Requiere humano
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newStageWon}
                      onChange={(e) => setNewStageWon(e.target.checked)}
                    />
                    Es Ganado
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newStageLost}
                      onChange={(e) => setNewStageLost(e.target.checked)}
                    />
                    Es Perdido
                  </label>
                </div>
              </div>
            </div>
          )}
        </div>
      </Sheet>
    </div>
  );
}
