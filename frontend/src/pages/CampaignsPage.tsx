import React, { useEffect, useState } from 'react';
import { Megaphone, Pause, Play, Plus, RefreshCw, Users, XCircle } from 'lucide-react';
import { apiFetch, subscribeSSE } from '../lib/api';
import { Badge, Button, Card, Input, Sheet } from '../components/ui/primitives';

interface Campaign {
  id: string;
  channel_session_id?: string;
  name: string;
  message_template: string;
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled';
  throttle_per_minute: number;
  daily_cap: number;
  respect_business_hours: boolean;
  total_count: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  created_at: string;
}

interface CampaignRecipient {
  id: string;
  contact_name: string;
  phone_number: string;
  status: string;
  error_message?: string;
}

interface ChannelSession {
  id: string;
  session_name: string;
  status: string;
  warmup_daily_limit: number;
}

interface ContactOption {
  id: string;
  name: string;
  phone_number?: string;
  is_blocked?: boolean;
}

const STATUS_META: Record<string, { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }> = {
  draft: { label: 'Borrador', tone: 'neutral' },
  scheduled: { label: 'Programada', tone: 'accent' },
  running: { label: 'En ejecución', tone: 'success' },
  paused: { label: 'Pausada', tone: 'warning' },
  completed: { label: 'Completada', tone: 'success' },
  cancelled: { label: 'Cancelada', tone: 'danger' },
};

const RECIPIENT_STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente',
  queued: 'En cola',
  sent: 'Enviado',
  failed: 'Fallido',
  skipped: 'Omitido',
};

export function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [channels, setChannels] = useState<ChannelSession[]>([]);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [messageTemplate, setMessageTemplate] = useState('');
  const [channelSessionId, setChannelSessionId] = useState('');
  const [throttlePerMinute, setThrottlePerMinute] = useState('10');
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);

  const [recipientsOpen, setRecipientsOpen] = useState(false);
  const [recipientsTitle, setRecipientsTitle] = useState('');
  const [recipients, setRecipients] = useState<CampaignRecipient[]>([]);
  const [loadingRecipients, setLoadingRecipients] = useState(false);

  async function loadAll() {
    try {
      setError('');
      const [campRes, chanRes, contRes] = await Promise.all([
        apiFetch('/campaigns').catch(() => ({ items: [] })),
        apiFetch('/channels').catch(() => ({ items: [] })),
        apiFetch('/contacts').catch(() => ({ items: [] })),
      ]);
      setCampaigns(campRes.items || campRes.campaigns || []);
      setChannels(Array.isArray(chanRes) ? chanRes : chanRes?.items ?? chanRes?.channels ?? []);
      setContacts(Array.isArray(contRes) ? contRes : contRes?.items ?? contRes?.contacts ?? []);
    } catch (err: any) {
      setError(err?.message || 'Error al cargar campañas');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
    const unsub = subscribeSSE((eventType) => {
      if (eventType === 'campaign.updated') {
        loadAll();
      }
    });
    return () => unsub();
  }, []);

  function toggleContact(id: string) {
    setSelectedContactIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !messageTemplate.trim()) {
      setError('El nombre y la plantilla de mensaje son obligatorios.');
      return;
    }
    const throttle = Math.max(1, Number(throttlePerMinute) || 10);
    setSaving(true);
    setError('');
    try {
      await apiFetch('/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          message_template: messageTemplate.trim(),
          channel_session_id: channelSessionId || undefined,
          throttle_per_minute: throttle,
          contact_ids: selectedContactIds.length > 0 ? selectedContactIds : undefined,
        }),
      });
      setName('');
      setMessageTemplate('');
      setChannelSessionId('');
      setThrottlePerMinute('10');
      setSelectedContactIds([]);
      setCreateOpen(false);
      await loadAll();
    } catch (err: any) {
      setError(err?.message || 'No se pudo crear la campaña');
    } finally {
      setSaving(false);
    }
  }

  async function handleAction(id: string, action: 'start' | 'pause' | 'cancel') {
    try {
      setError('');
      await apiFetch(`/campaigns/${id}/${action}`, { method: 'POST', body: JSON.stringify({}) });
      await loadAll();
    } catch (err: any) {
      setError(err?.message || 'No se pudo actualizar la campaña');
    }
  }

  async function openRecipients(c: Campaign) {
    setRecipientsTitle(c.name);
    setRecipientsOpen(true);
    setLoadingRecipients(true);
    try {
      const res = await apiFetch(`/campaigns/${c.id}/recipients`);
      setRecipients(res.items || res.recipients || []);
    } catch {
      setRecipients([]);
    } finally {
      setLoadingRecipients(false);
    }
  }

  const charCount = Array.from(messageTemplate).length;

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-[var(--text)]">Campañas de WhatsApp</h1>
          <p className="text-xs text-[var(--text-muted)]">
            Envíos masivos con control anti-ban, límite de calentamiento y exclusión automática de bajas (STOP).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={loadAll} aria-label="Actualizar campañas">
            <RefreshCw className="w-4 h-4" />
            Actualizar
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4" />
            Nueva Campaña
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </div>
      )}

      {loading ? (
        <Card className="p-6 text-sm text-[var(--text-muted)]">Cargando campañas...</Card>
      ) : campaigns.length === 0 ? (
        <Card className="p-8 text-center space-y-3">
          <div className="w-10 h-10 rounded-full bg-teal-50 text-[var(--accent)] flex items-center justify-center mx-auto">
            <Megaphone className="w-5 h-5" />
          </div>
          <h2 className="text-base font-semibold text-[var(--text)]">Sin envíos programados aún</h2>
          <p className="text-xs text-[var(--text-muted)] max-w-md mx-auto">
            Crea tu primera campaña de WhatsApp con ritmo controlado y respeto de horarios laborales.
          </p>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4" />
            Empezar primera campaña
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 min-w-0">
          {campaigns.map((c) => {
            const meta = STATUS_META[c.status] || { label: c.status, tone: 'neutral' as const };
            return (
              <Card key={c.id} className="p-4 space-y-3 min-w-0">
                <div className="flex items-start justify-between gap-2 min-w-0">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-[var(--text)] truncate">{c.name}</h2>
                    <p className="text-xs text-[var(--text-muted)] line-clamp-2 mt-0.5">{c.message_template}</p>
                  </div>
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                </div>

                <div className="grid grid-cols-3 gap-2 text-xs bg-[var(--surface)] rounded-[10px] p-2.5 border border-[var(--border)]">
                  <div>
                    <span className="text-[var(--text-muted)] block">Ritmo</span>
                    <span className="font-semibold text-[var(--text)]">{c.throttle_per_minute} msgs/min</span>
                  </div>
                  <div>
                    <span className="text-[var(--text-muted)] block">Enviados</span>
                    <span className="font-semibold text-[var(--text)]">
                      {c.sent_count} / {c.total_count}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--text-muted)] block">Omitidos / Error</span>
                    <span className="font-semibold text-[var(--text)]">
                      {c.skipped_count} / {c.failed_count}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {(c.status === 'draft' || c.status === 'paused' || c.status === 'scheduled') && (
                    <Button size="sm" onClick={() => handleAction(c.id, 'start')}>
                      <Play className="w-3.5 h-3.5" />
                      {c.status === 'paused' ? 'Reanudar' : 'Iniciar'}
                    </Button>
                  )}
                  {c.status === 'running' && (
                    <Button size="sm" variant="secondary" onClick={() => handleAction(c.id, 'pause')}>
                      <Pause className="w-3.5 h-3.5" />
                      Pausar
                    </Button>
                  )}
                  {(c.status === 'running' || c.status === 'paused' || c.status === 'scheduled') && (
                    <Button size="sm" variant="ghost" onClick={() => handleAction(c.id, 'cancel')}>
                      <XCircle className="w-3.5 h-3.5" />
                      Cancelar
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" onClick={() => openRecipients(c)}>
                    <Users className="w-3.5 h-3.5" />
                    Destinatarios
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Sheet open={createOpen} onClose={() => setCreateOpen(false)} title="Nueva Campaña">
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="campaign-name" className="block text-xs font-medium text-[var(--text)]">
              Nombre
            </label>
            <Input
              id="campaign-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej. Seguimiento de clientes VIP"
              required
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="campaign-message" className="block text-xs font-medium text-[var(--text)]">
              Plantilla de mensaje
            </label>
            <textarea
              id="campaign-message"
              rows={4}
              value={messageTemplate}
              onChange={(e) => setMessageTemplate(e.target.value)}
              placeholder="Hola {{nombre}}, tenemos una novedad para ti..."
              className="w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              required
            />
            <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
              <span>Usa {'{{nombre}}'} para personalizar</span>
              <span className={charCount > 4096 ? 'text-[var(--warning)] font-medium' : ''}>
                {charCount} caracteres {charCount > 4096 ? '(se dividirá en bloques de 4096)' : ''}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="campaign-channel" className="block text-xs font-medium text-[var(--text)]">
                Canal WhatsApp
              </label>
              <select
                id="campaign-channel"
                value={channelSessionId}
                onChange={(e) => setChannelSessionId(e.target.value)}
                className="flex h-10 w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              >
                <option value="">Canal activo por defecto</option>
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.session_name} (Límite {ch.warmup_daily_limit}/día)
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="campaign-throttle" className="block text-xs font-medium text-[var(--text)]">
                Ritmo (envíos/min)
              </label>
              <Input
                id="campaign-throttle"
                type="number"
                min={1}
                max={60}
                value={throttlePerMinute}
                onChange={(e) => setThrottlePerMinute(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-[var(--text)]">
              Audiencia ({selectedContactIds.length > 0 ? `${selectedContactIds.length} seleccionados` : 'Todos los contactos elegibles'})
            </span>
            <div className="max-h-40 overflow-y-auto rounded-[10px] border border-[var(--border)] p-2 space-y-1 bg-[var(--surface)]">
              {contacts.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)] p-1">No hay contactos cargados.</p>
              ) : (
                contacts.map((ct) => {
                  const blocked = Boolean(ct.is_blocked);
                  return (
                    <label
                      key={ct.id}
                      className={`flex items-center justify-between gap-2 rounded px-2 py-1 text-xs ${
                        blocked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-[var(--bg)]'
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <input
                          type="checkbox"
                          disabled={blocked}
                          checked={selectedContactIds.includes(ct.id)}
                          onChange={() => toggleContact(ct.id)}
                        />
                        <span className="truncate text-[var(--text)]">{ct.name}</span>
                      </span>
                      {blocked ? (
                        <Badge tone="danger">STOP</Badge>
                      ) : (
                        <span className="text-[var(--text-muted)] shrink-0">{ct.phone_number || 'Sin teléfono'}</span>
                      )}
                    </label>
                  );
                })
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Guardando...' : 'Guardar Campaña'}
            </Button>
          </div>
        </form>
      </Sheet>

      <Sheet open={recipientsOpen} onClose={() => setRecipientsOpen(false)} title={`Destinatarios — ${recipientsTitle}`}>
        {loadingRecipients ? (
          <p className="text-xs text-[var(--text-muted)]">Cargando destinatarios...</p>
        ) : recipients.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">No hay destinatarios registrados aún.</p>
        ) : (
          <div className="space-y-2">
            {recipients.map((rec) => (
              <div
                key={rec.id}
                className="flex items-center justify-between gap-2 rounded-[10px] border border-[var(--border)] p-2.5 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-medium text-[var(--text)] truncate">{rec.contact_name || 'Contacto'}</div>
                  <div className="text-[var(--text-muted)]">{rec.phone_number}</div>
                  {rec.error_message && <div className="text-[var(--danger)]">{rec.error_message}</div>}
                </div>
                <Badge tone={rec.status === 'sent' ? 'success' : rec.status === 'failed' ? 'danger' : 'neutral'}>
                  {RECIPIENT_STATUS_LABELS[rec.status] ?? rec.status}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </Sheet>
    </div>
  );
}
