import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  Trash2,
  Save,
  Link2,
  Paperclip,
  MessageSquarePlus,
  ExternalLink,
  AlertTriangle,
} from 'lucide-react';
import { ApiError, apiFetch } from '../lib/api';
import { useAuth } from '../App';
import { Badge, Button, Card, Input, Sheet } from '../components/ui/primitives';

interface FieldSchemaItem {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'boolean';
  options?: string[];
}

interface LeadDetail {
  id: string;
  contact_id: string;
  pipeline_id: string;
  stage_id: string;
  title: string;
  value_cents: number;
  currency: string;
  status: 'open' | 'won' | 'lost';
  loss_reason: string;
  custom_fields: Record<string, any>;
  tags: string[];
  version: number;
  contact: { id: string; name: string; phone_number: string; email: string };
  pipeline: {
    id: string;
    name: string;
    pipeline_type: string;
    vocabulary: { deal?: string; deals?: string };
    fields_schema: FieldSchemaItem[];
  };
  stages: Array<{ id: string; name: string; is_won: boolean; is_lost: boolean }>;
  activities: Array<{ id: string; type: string; summary: string; performed_at: string }>;
  links: Array<{
    id: string;
    link_type: string;
    linked_lead_id: string;
    linked_lead_title: string;
    linked_lead_status: string;
  }>;
  attachments: Array<{
    id: string;
    file_name: string;
    file_url: string;
    mime_type: string;
    size_bytes: number;
    created_at: string;
  }>;
}

const ROLE_ORDER: Record<string, number> = {
  viewer: 0,
  agent: 1,
  manager: 2,
  admin: 3,
};

const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  note: 'Nota',
  call: 'Llamada',
  meeting: 'Reunión',
  stage_change: 'Cambio de etapa',
  stage_changed: 'Cambio de etapa',
  status_changed: 'Cambio de estado',
  lead_created: 'Registro creado',
};

const LINK_TYPE_LABELS: Record<string, string> = {
  related: 'Relacionado',
  ticket: 'Ticket',
  blocks: 'Bloquea a',
  blocked_by: 'Bloqueado por',
  duplicate: 'Duplicado',
};

export function LeadDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEdit = (ROLE_ORDER[user?.role || 'viewer'] ?? 0) >= 1;

  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [allLeads, setAllLeads] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ tone: 'error' | 'warning' | 'success'; text: string } | null>(null);

  // Editable fields
  const [title, setTitle] = useState('');
  const [valueAmount, setValueAmount] = useState('0');
  const [stageId, setStageId] = useState('');
  const [status, setStatus] = useState<'open' | 'won' | 'lost'>('open');
  const [lossReason, setLossReason] = useState('');
  const [customFields, setCustomFields] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);

  // Delete modal
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  // Activity note
  const [noteText, setNoteText] = useState('');
  const [noteType, setNoteType] = useState('note');

  // Link form
  const [targetLeadId, setTargetLeadId] = useState('');
  const [linkType, setLinkType] = useState('related');

  // Attachment form
  const [attName, setAttName] = useState('');
  const [attUrl, setAttUrl] = useState('');

  const hydrateForm = (data: LeadDetail) => {
    setTitle(data.title);
    setValueAmount(((data.value_cents || 0) / 100).toFixed(2));
    setStageId(data.stage_id);
    setStatus(data.status);
    setLossReason(data.loss_reason || '');
    setCustomFields(data.custom_fields || {});
  };

  const loadDetail = useCallback(async () => {
    if (!id) return;
    try {
      const [detail, leadsList] = await Promise.all([
        apiFetch<LeadDetail>(`/leads/${id}`),
        apiFetch<any[]>('/leads'),
      ]);
      setLead(detail);
      setAllLeads((leadsList || []).filter((l) => l.id !== id));
      hydrateForm(detail);
    } catch (err: any) {
      setBanner({ tone: 'error', text: err?.message || 'No se pudo cargar el registro.' });
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    let active = true;
    if (!id) return;
    Promise.all([apiFetch<LeadDetail>(`/leads/${id}`), apiFetch<any[]>('/leads')])
      .then(([detail, leadsList]) => {
        if (!active) return;
        setLead(detail);
        setAllLeads((leadsList || []).filter((l) => l.id !== id));
        hydrateForm(detail);
      })
      .catch((err: any) => {
        if (!active) return;
        setBanner({ tone: 'error', text: err?.message || 'No se pudo cargar el registro.' });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id]);

  async function handleSaveLead(e: React.FormEvent) {
    e.preventDefault();
    if (!lead || !title.trim()) return;
    setSaving(true);
    setBanner(null);
    try {
      await apiFetch(`/leads/${lead.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: title.trim(),
          value_cents: Math.round(Number(valueAmount || 0) * 100),
          stage_id: stageId,
          status,
          loss_reason: status === 'lost' ? lossReason.trim() : '',
          custom_fields: customFields,
          version: lead.version,
        }),
      });
      setBanner({ tone: 'success', text: 'Cambios guardados correctamente.' });
      await loadDetail();
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 409) {
        setBanner({
          tone: 'warning',
          text: 'Conflicto de versión (409): este registro fue actualizado por otro usuario. Recargando...',
        });
        await loadDetail();
      } else {
        setBanner({ tone: 'error', text: err?.message || 'Error al guardar.' });
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteLead() {
    if (!lead) return;
    try {
      await apiFetch(`/leads/${lead.id}`, { method: 'DELETE' });
      navigate({ to: '/app/pipelines/$id', params: { id: lead.pipeline_id } });
    } catch (err: any) {
      setBanner({ tone: 'error', text: err?.message || 'No se pudo eliminar.' });
      setConfirmDeleteOpen(false);
    }
  }

  async function handleAddActivity(e: React.FormEvent) {
    e.preventDefault();
    if (!lead || !noteText.trim()) return;
    try {
      await apiFetch(`/leads/${lead.id}/activities`, {
        method: 'POST',
        body: JSON.stringify({ type: noteType, summary: noteText.trim() }),
      });
      setNoteText('');
      await loadDetail();
    } catch (err: any) {
      setBanner({ tone: 'error', text: err?.message || 'No se pudo agregar la actividad.' });
    }
  }

  async function handleAddLink(e: React.FormEvent) {
    e.preventDefault();
    if (!lead || !targetLeadId) return;
    try {
      await apiFetch(`/leads/${lead.id}/links`, {
        method: 'POST',
        body: JSON.stringify({ target_lead_id: targetLeadId, link_type: linkType }),
      });
      setTargetLeadId('');
      await loadDetail();
    } catch (err: any) {
      setBanner({ tone: 'error', text: err?.message || 'No se pudo vincular el registro.' });
    }
  }

  async function handleDeleteLink(linkId: string) {
    if (!lead) return;
    try {
      await apiFetch(`/leads/${lead.id}/links/${linkId}`, { method: 'DELETE' });
      await loadDetail();
    } catch (err: any) {
      setBanner({ tone: 'error', text: err?.message || 'No se pudo eliminar el vínculo.' });
    }
  }

  async function handleAddAttachment(e: React.FormEvent) {
    e.preventDefault();
    if (!lead || !attName.trim() || !attUrl.trim()) return;
    try {
      await apiFetch(`/leads/${lead.id}/attachments`, {
        method: 'POST',
        body: JSON.stringify({ file_name: attName.trim(), file_url: attUrl.trim() }),
      });
      setAttName('');
      setAttUrl('');
      await loadDetail();
    } catch (err: any) {
      setBanner({ tone: 'error', text: err?.message || 'No se pudo agregar el adjunto.' });
    }
  }

  async function handleDeleteAttachment(attId: string) {
    if (!lead) return;
    try {
      await apiFetch(`/leads/${lead.id}/attachments/${attId}`, { method: 'DELETE' });
      await loadDetail();
    } catch (err: any) {
      setBanner({ tone: 'error', text: err?.message || 'No se pudo eliminar el adjunto.' });
    }
  }

  const schema = useMemo(() => lead?.pipeline?.fields_schema || [], [lead]);

  if (loading) {
    return (
      <div className="p-6 text-sm text-[var(--text-muted)]">Cargando detalle del registro...</div>
    );
  }

  if (!lead) {
    return (
      <div className="p-6 space-y-3">
        <div className="text-sm text-[var(--danger)]">Registro no encontrado.</div>
        <Link to="/app/kanban" className="text-xs text-[var(--accent)] underline">
          Volver al embudo
        </Link>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-6xl mx-auto min-w-0">
      {/* LeadHeader */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/app/pipelines/$id"
            params={{ id: lead.pipeline_id }}
            className="p-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:border-[var(--accent)] shrink-0"
            aria-label="Volver al embudo"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-[var(--text)] truncate">{lead.title}</h1>
              <Badge tone={lead.status === 'won' ? 'success' : lead.status === 'lost' ? 'danger' : 'accent'}>
                {lead.status === 'won' ? 'Ganado' : lead.status === 'lost' ? 'Perdido' : 'Abierto'}
              </Badge>
            </div>
            <div className="text-xs text-[var(--text-muted)] flex flex-wrap items-center gap-2">
              <span>{lead.pipeline?.name}</span>
              <span>·</span>
              <Link
                to="/app/contacts/$id"
                params={{ id: lead.contact_id }}
                className="text-[var(--accent)] hover:underline"
              >
                {lead.contact?.name}
              </Link>
              <span>· v{lead.version}</span>
            </div>
          </div>
        </div>

        {canEdit && (
          <Button size="sm" variant="danger" onClick={() => setConfirmDeleteOpen(true)}>
            <Trash2 className="w-4 h-4" /> Eliminar
          </Button>
        )}
      </div>

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
          <button type="button" onClick={() => setBanner(null)} className="underline cursor-pointer">
            Cerrar
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Columna principal: Detalle, Campos Personalizados y Timeline */}
        <div className="lg:col-span-2 space-y-5 min-w-0">
          <Card className="p-4">
            <form onSubmit={handleSaveLead} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium">Título</label>
                  <Input
                    required
                    disabled={!canEdit}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Valor ({lead.currency})</label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    disabled={!canEdit}
                    value={valueAmount}
                    onChange={(e) => setValueAmount(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium">Etapa</label>
                  <select
                    disabled={!canEdit}
                    value={stageId}
                    onChange={(e) => setStageId(e.target.value)}
                    className="h-10 w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
                  >
                    {lead.stages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Estado</label>
                  <select
                    disabled={!canEdit}
                    value={status}
                    onChange={(e) => setStatus(e.target.value as 'open' | 'won' | 'lost')}
                    className="h-10 w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
                  >
                    <option value="open">Abierto</option>
                    <option value="won">Ganado</option>
                    <option value="lost">Perdido</option>
                  </select>
                </div>
              </div>

              {status === 'lost' && (
                <div className="space-y-1">
                  <label className="text-xs font-medium">Motivo de pérdida</label>
                  <Input
                    disabled={!canEdit}
                    value={lossReason}
                    onChange={(e) => setLossReason(e.target.value)}
                    placeholder="Precio, competencia, sin respuesta..."
                  />
                </div>
              )}

              {/* CustomFieldsEditor dinámico */}
              {schema.length > 0 && (
                <div className="border-t border-[var(--border)] pt-3 space-y-3">
                  <div className="text-xs font-semibold text-[var(--text)]">
                    Campos personalizados
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {schema.map((field) => {
                      const val = customFields[field.key] ?? '';
                      if (field.type === 'boolean') {
                        return (
                          <label key={field.key} className="flex items-center gap-2 text-xs pt-5 cursor-pointer">
                            <input
                              type="checkbox"
                              disabled={!canEdit}
                              checked={Boolean(val)}
                              onChange={(e) =>
                                setCustomFields((prev) => ({ ...prev, [field.key]: e.target.checked }))
                              }
                            />
                            {field.label}
                          </label>
                        );
                      }
                      if (field.type === 'select') {
                        return (
                          <div key={field.key} className="space-y-1">
                            <label className="text-xs font-medium">{field.label}</label>
                            <select
                              disabled={!canEdit}
                              value={String(val)}
                              onChange={(e) =>
                                setCustomFields((prev) => ({ ...prev, [field.key]: e.target.value }))
                              }
                              className="h-10 w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
                            >
                              <option value="">Seleccionar...</option>
                              {(field.options || []).map((opt) => (
                                <option key={opt} value={opt}>
                                  {opt}
                                </option>
                              ))}
                            </select>
                          </div>
                        );
                      }
                      return (
                        <div key={field.key} className="space-y-1">
                          <label className="text-xs font-medium">{field.label}</label>
                          <Input
                            type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                            disabled={!canEdit}
                            value={String(val)}
                            onChange={(e) =>
                              setCustomFields((prev) => ({ ...prev, [field.key]: e.target.value }))
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {canEdit && (
                <div className="flex justify-end">
                  <Button type="submit" disabled={saving}>
                    <Save className="w-4 h-4" /> {saving ? 'Guardando...' : 'Guardar cambios'}
                  </Button>
                </div>
              )}
            </form>
          </Card>

          {/* TimelineView */}
          <Card className="p-4 space-y-4">
            <div className="text-sm font-semibold text-[var(--text)]">Línea de tiempo y notas</div>
            {canEdit && (
              <form onSubmit={handleAddActivity} className="flex flex-wrap gap-2">
                <select
                  value={noteType}
                  onChange={(e) => setNoteType(e.target.value)}
                  aria-label="Tipo de actividad"
                  className="h-10 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-xs"
                >
                  <option value="note">Nota</option>
                  <option value="call">Llamada</option>
                  <option value="meeting">Reunión</option>
                </select>
                <Input
                  required
                  className="flex-1 min-w-[180px]"
                  placeholder="Registrar nota o actividad..."
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                />
                <Button type="submit" size="sm">
                  <MessageSquarePlus className="w-4 h-4" /> Registrar
                </Button>
              </form>
            )}

            <div className="space-y-2.5">
              {(lead.activities || []).length === 0 ? (
                <div className="text-xs text-[var(--text-muted)]">Sin actividades registradas.</div>
              ) : (
                lead.activities.map((act) => (
                  <div
                    key={act.id}
                    className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex flex-wrap items-start justify-between gap-2"
                  >
                    <div className="space-y-0.5 min-w-0">
                      <Badge tone="neutral" className="text-[10px]">
                        {ACTIVITY_TYPE_LABELS[act.type] || act.type}
                      </Badge>
                      <div className="text-xs font-medium text-[var(--text)]">{act.summary}</div>
                    </div>
                    <span className="text-[11px] text-[var(--text-muted)]">
                      {new Date(act.performed_at).toLocaleString('es')}
                    </span>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>

        {/* Columna lateral: Vínculos (crm_lead_links) y Adjuntos */}
        <div className="space-y-5 min-w-0">
          <Card className="p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
              <Link2 className="w-4 h-4 text-[var(--accent)]" /> Registros vinculados
            </div>

            {canEdit && (
              <form onSubmit={handleAddLink} className="space-y-2">
                <select
                  required
                  value={targetLeadId}
                  onChange={(e) => setTargetLeadId(e.target.value)}
                  className="h-9 w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-2.5 text-xs"
                >
                  <option value="">Seleccionar lead o ticket...</option>
                  {allLeads.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.title} ({l.contact_name})
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <select
                    value={linkType}
                    onChange={(e) => setLinkType(e.target.value)}
                    className="h-9 flex-1 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-2.5 text-xs"
                  >
                    <option value="related">Relacionado</option>
                    <option value="ticket">Ticket de soporte</option>
                    <option value="blocks">Bloquea a</option>
                    <option value="blocked_by">Bloqueado por</option>
                    <option value="duplicate">Duplicado</option>
                  </select>
                  <Button type="submit" size="sm">
                    Vincular
                  </Button>
                </div>
              </form>
            )}

            <div className="space-y-2">
              {(lead.links || []).length === 0 ? (
                <div className="text-xs text-[var(--text-muted)]">No hay registros vinculados.</div>
              ) : (
                lead.links.map((lk) => (
                  <div
                    key={lk.id}
                    className="p-2.5 rounded-xl border border-[var(--border)] flex items-center justify-between gap-2 text-xs"
                  >
                    <div className="min-w-0">
                      <Badge tone="accent" className="text-[10px] mb-1">
                        {LINK_TYPE_LABELS[lk.link_type] || lk.link_type}
                      </Badge>
                      <Link
                        to="/app/leads/$id"
                        params={{ id: lk.linked_lead_id }}
                        className="font-medium text-[var(--text)] hover:text-[var(--accent)] truncate block"
                      >
                        {lk.linked_lead_title}
                      </Link>
                    </div>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => handleDeleteLink(lk.id)}
                        className="text-[var(--danger)] p-1 cursor-pointer shrink-0"
                        aria-label="Eliminar vínculo"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </Card>

          <Card className="p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
              <Paperclip className="w-4 h-4 text-[var(--accent)]" /> Archivos adjuntos
            </div>

            {canEdit && (
              <form onSubmit={handleAddAttachment} className="space-y-2">
                <Input
                  required
                  className="h-9 text-xs"
                  placeholder="Nombre del archivo (ej. propuesta.pdf)"
                  value={attName}
                  onChange={(e) => setAttName(e.target.value)}
                />
                <div className="flex gap-2">
                  <Input
                    required
                    type="url"
                    className="h-9 text-xs flex-1"
                    placeholder="https://..."
                    value={attUrl}
                    onChange={(e) => setAttUrl(e.target.value)}
                  />
                  <Button type="submit" size="sm">
                    Adjuntar
                  </Button>
                </div>
              </form>
            )}

            <div className="space-y-2">
              {(lead.attachments || []).length === 0 ? (
                <div className="text-xs text-[var(--text-muted)]">Sin archivos adjuntos.</div>
              ) : (
                lead.attachments.map((att) => (
                  <div
                    key={att.id}
                    className="p-2.5 rounded-xl border border-[var(--border)] flex items-center justify-between gap-2 text-xs"
                  >
                    <a
                      href={att.file_url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1.5 font-medium text-[var(--accent)] hover:underline truncate"
                    >
                      <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{att.file_name}</span>
                    </a>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => handleDeleteAttachment(att.id)}
                        className="text-[var(--danger)] p-1 cursor-pointer shrink-0"
                        aria-label={`Eliminar ${att.file_name}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* Confirmación de eliminación */}
      <Sheet
        open={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        title="Eliminar registro"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-muted)]">
            ¿Seguro que deseas eliminar <strong>{lead.title}</strong>? Se perderán sus actividades y vínculos.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmDeleteOpen(false)}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={handleDeleteLead}>
              Confirmar eliminación
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
