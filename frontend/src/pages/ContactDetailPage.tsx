import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  Download,
  ExternalLink,
  MessageSquare,
  Phone,
  Plus,
  ShieldAlert,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { Badge, Button, Card, Input, Sheet } from '../components/ui/primitives';

function formatCPF(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
  if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

function isValidCPF(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return true; // optional
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(digits[i], 10) * (10 - i);
  let check1 = (sum * 10) % 11;
  if (check1 === 10) check1 = 0;
  if (check1 !== parseInt(digits[9], 10)) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(digits[i], 10) * (11 - i);
  let check2 = (sum * 10) % 11;
  if (check2 === 10) check2 = 0;
  return check2 === parseInt(digits[10], 10);
}

export function ContactDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams({ strict: false }) as { id: string };

  const [contact, setContact] = useState<any | null>(null);
  const [leads, setLeads] = useState<any[]>([]);
  const [conversations, setConversations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Edit form
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [cpf, setCpf] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');
  const [saving, setSaving] = useState(false);

  // Multi-phone
  const [phoneInput, setPhoneInput] = useState('');
  const [phoneLabel, setPhoneLabel] = useState('móvil');
  const [phonePrimary, setPhonePrimary] = useState(false);
  const [phoneBusy, setPhoneBusy] = useState(false);

  // LGPD Anonymize / Export dialog
  const [lgpdMode, setLgpdMode] = useState<'redact' | 'export' | null>(null);
  const [lgpdReason, setLgpdReason] = useState('');
  const [lgpdBusy, setLgpdBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const [c, allLeads, allConvs] = await Promise.all([
        apiFetch<any>(`/contacts/${id}`),
        apiFetch<any[]>('/leads').catch(() => []),
        apiFetch<any[]>('/conversations').catch(() => []),
      ]);
      setContact(c);
      setName(c.name || '');
      setEmail(c.email || '');
      setCpf(c.cpf ? formatCPF(c.cpf) : '');
      setTags(Array.isArray(c.tags) ? c.tags : []);
      setLeads(
        Array.isArray(c.leads)
          ? c.leads
          : (allLeads || []).filter((l: any) => l.contact_id === id)
      );
      setConversations(
        Array.isArray(c.conversations)
          ? c.conversations
          : (allConvs || []).filter((cv: any) => cv.contact_id === id)
      );
    } catch (err: any) {
      setError(err.message || 'No se pudo cargar el contacto.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!id) return;
    if (cpf.trim() && !isValidCPF(cpf)) {
      setError('El CPF ingresado no es válido (debe tener 11 dígitos válidos).');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await apiFetch(`/contacts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          cpf: cpf.replace(/\D/g, ''),
          tags,
        }),
      });
      setNotice('Contacto actualizado correctamente.');
      await load();
    } catch (err: any) {
      setError(err.message || 'No se pudo actualizar el contacto.');
    } finally {
      setSaving(false);
    }
  }

  function handleAddTag() {
    const clean = newTag.trim();
    if (!clean) return;
    if (!tags.includes(clean)) {
      setTags((prev) => [...prev, clean]);
    }
    setNewTag('');
  }

  async function handleAddPhone(e: React.FormEvent) {
    e.preventDefault();
    if (!id || !phoneInput.trim()) return;
    setPhoneBusy(true);
    setError('');
    setNotice('');
    try {
      await apiFetch(`/contacts/${id}/phones`, {
        method: 'POST',
        body: JSON.stringify({
          phone_e164: phoneInput.trim(),
          label: phoneLabel.trim() || 'móvil',
          is_primary: phonePrimary,
        }),
      });
      setPhoneInput('');
      setPhonePrimary(false);
      setNotice('Teléfono agregado.');
      await load();
    } catch (err: any) {
      setError(err.message || 'No se pudo agregar el teléfono.');
    } finally {
      setPhoneBusy(false);
    }
  }

  async function handleDeletePhone(phoneId: string) {
    if (!id) return;
    setPhoneBusy(true);
    setError('');
    try {
      await apiFetch(`/contacts/${id}/phones/${phoneId}`, { method: 'DELETE' });
      setNotice('Teléfono eliminado.');
      await load();
    } catch (err: any) {
      setError(err.message || 'No se pudo eliminar el teléfono.');
    } finally {
      setPhoneBusy(false);
    }
  }

  async function handleStartChat() {
    if (!id) return;
    try {
      const conv = await apiFetch<{ id: string }>('/conversations', {
        method: 'POST',
        body: JSON.stringify({ contact_id: id }),
      });
      if (conv?.id) {
        void navigate({ to: '/app/inbox/$id', params: { id: conv.id } });
      }
    } catch (err: any) {
      setError(err.message || 'No se pudo abrir la conversación.');
    }
  }

  async function handleLgpdSubmit() {
    if (!id || !lgpdMode) return;
    setLgpdBusy(true);
    setError('');
    setNotice('');
    try {
      await apiFetch('/lgpd/requests', {
        method: 'POST',
        body: JSON.stringify({
          contact_id: id,
          request_type: lgpdMode,
          reason: lgpdReason.trim() || undefined,
        }),
      });
      setLgpdMode(null);
      setLgpdReason('');
      setNotice(
        lgpdMode === 'redact'
          ? 'Solicitud LGPD de anonimización registrada. Puedes ejecutarla desde LGPD y Auditoría.'
          : 'Solicitud LGPD de exportación registrada. Puedes descargarla desde LGPD y Auditoría.'
      );
    } catch (err: any) {
      setError(err.message || 'No se pudo crear la solicitud LGPD.');
    } finally {
      setLgpdBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="p-4 md:p-6 max-w-5xl space-y-4">
        <div className="h-8 w-48 rounded-lg bg-[var(--surface)] animate-pulse" />
        <Card className="p-6 h-48 animate-pulse bg-[var(--surface)]" />
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="p-4 md:p-6 max-w-3xl space-y-3">
        <Link
          to="/app/contacts"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--accent)] hover:underline"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Volver a Contactos
        </Link>
        <Card className="p-6 text-center space-y-2">
          <div className="text-sm font-semibold">Contacto no encontrado</div>
          <div className="text-xs text-[var(--text-muted)]">{error}</div>
        </Card>
      </div>
    );
  }

  const phones: any[] = contact.phones || contact.contact_phones || [];

  return (
    <div className="p-4 md:p-6 max-w-6xl space-y-5 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/app/contacts"
            aria-label="Volver a Contactos"
            className="p-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] hover:bg-[var(--surface)] shrink-0"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold truncate">{contact.name}</h1>
              {contact.is_anonymized && <Badge tone="warning">Anonimizado</Badge>}
              {contact.is_blocked && <Badge tone="danger">STOP</Badge>}
            </div>
            <div className="text-xs text-[var(--text-muted)] truncate">
              {contact.phone_number || contact.email || 'Customer 360°'}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void handleStartChat()}>
            <MessageSquare className="w-3.5 h-3.5" /> Abrir chat
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setLgpdMode('export')}>
            <Download className="w-3.5 h-3.5" /> Exportar LGPD
          </Button>
          <Button size="sm" variant="danger" onClick={() => setLgpdMode('redact')}>
            <ShieldAlert className="w-3.5 h-3.5" /> Anonimizar
          </Button>
        </div>
      </div>

      {notice && (
        <div className="px-3 py-2 rounded-xl text-xs bg-teal-50 border border-teal-200 text-teal-900">
          {notice}
        </div>
      )}
      {error && (
        <div className="px-3 py-2 rounded-xl text-xs bg-red-50 border border-red-200 text-[var(--danger)]">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Columna izquierda: Edición y Teléfonos */}
        <div className="lg:col-span-2 space-y-5 min-w-0">
          <Card className="p-4 md:p-5 space-y-4">
            <h2 className="text-sm font-semibold">Datos del contacto</h2>
            <form onSubmit={handleSave} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="c-name" className="text-xs font-medium">
                    Nombre
                  </label>
                  <Input
                    id="c-name"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="c-email" className="text-xs font-medium">
                    Correo electrónico
                  </label>
                  <Input
                    id="c-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="correo@ejemplo.com"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="c-cpf" className="text-xs font-medium">
                    CPF / Documento
                  </label>
                  <Input
                    id="c-cpf"
                    value={cpf}
                    onChange={(e) => setCpf(formatCPF(e.target.value))}
                    placeholder="000.000.000-00"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="c-tag" className="text-xs font-medium">
                    Etiquetas
                  </label>
                  <div className="flex gap-2">
                    <Input
                      id="c-tag"
                      value={newTag}
                      onChange={(e) => setNewTag(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddTag();
                        }
                      }}
                      placeholder="Nueva etiqueta..."
                    />
                    <Button type="button" variant="secondary" onClick={handleAddTag}>
                      <Tag className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </div>

              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-teal-50 text-teal-800 border border-teal-200"
                    >
                      {t}
                      <button
                        type="button"
                        onClick={() => setTags((prev) => prev.filter((item) => item !== t))}
                        aria-label={`Quitar etiqueta ${t}`}
                        className="hover:text-[var(--danger)] cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className="flex justify-end">
                <Button type="submit" disabled={saving}>
                  {saving ? 'Guardando...' : 'Guardar cambios'}
                </Button>
              </div>
            </form>
          </Card>

          {/* Multi-phone manager */}
          <Card className="p-4 md:p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Phone className="w-4 h-4 text-[var(--accent)]" />
                <span>Teléfonos asociados ({phones.length})</span>
              </h2>
            </div>

            {phones.length === 0 ? (
              <div className="text-xs text-[var(--text-muted)]">
                No hay teléfonos adicionales registrados.
              </div>
            ) : (
              <div className="space-y-2">
                {phones.map((p: any) => (
                  <div
                    key={p.id || p.phone_e164}
                    className="p-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] flex items-center justify-between gap-2"
                  >
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="font-mono text-xs font-medium">{p.phone_e164}</span>
                      {p.label && <Badge tone="neutral">{p.label}</Badge>}
                      {p.is_primary && <Badge tone="accent">Principal</Badge>}
                    </div>
                    {p.id && (
                      <button
                        type="button"
                        disabled={phoneBusy}
                        onClick={() => void handleDeletePhone(p.id)}
                        aria-label={`Eliminar teléfono ${p.phone_e164}`}
                        className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-red-50 cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={handleAddPhone} className="flex flex-wrap items-center gap-2 pt-1">
              <Input
                required
                className="flex-1 min-w-[160px]"
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                placeholder="+5215512345678"
              />
              <Input
                className="w-28"
                value={phoneLabel}
                onChange={(e) => setPhoneLabel(e.target.value)}
                placeholder="Etiqueta"
              />
              <label className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={phonePrimary}
                  onChange={(e) => setPhonePrimary(e.target.checked)}
                  className="accent-[var(--accent)]"
                />
                Principal
              </label>
              <Button type="submit" size="sm" disabled={phoneBusy}>
                <Plus className="w-3.5 h-3.5" /> Agregar
              </Button>
            </form>
          </Card>

          {/* Conversaciones y Leads vinculados */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="p-4 space-y-3">
              <h2 className="text-sm font-semibold">Conversaciones ({conversations.length})</h2>
              {conversations.length === 0 ? (
                <div className="text-xs text-[var(--text-muted)]">Sin conversaciones aún.</div>
              ) : (
                <div className="space-y-2">
                  {conversations.map((cv) => (
                    <Link
                      key={cv.id}
                      to="/app/inbox/$id"
                      params={{ id: cv.id }}
                      className="block p-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)] transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Badge tone="accent">{cv.status}</Badge>
                        <ExternalLink className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                      </div>
                      <div className="text-xs text-[var(--text-muted)] truncate mt-1">
                        {cv.last_message_preview || 'Abrir conversación'}
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-4 space-y-3">
              <h2 className="text-sm font-semibold">Oportunidades / Leads ({leads.length})</h2>
              {leads.length === 0 ? (
                <div className="text-xs text-[var(--text-muted)]">Sin leads asociados.</div>
              ) : (
                <div className="space-y-2">
                  {leads.map((l) => (
                    <div
                      key={l.id}
                      className="p-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold truncate">{l.title}</span>
                        <Badge tone={l.status === 'won' ? 'success' : 'neutral'}>
                          {l.status}
                        </Badge>
                      </div>
                      {typeof l.value_cents === 'number' && (
                        <div className="text-[11px] text-[var(--text-muted)]">
                          {(l.value_cents / 100).toLocaleString('es')} {l.currency || 'USD'}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>

        {/* Columna derecha: Línea de tiempo */}
        <Card className="p-4 space-y-3 h-fit">
          <h2 className="text-sm font-semibold">Línea de tiempo</h2>
          {(contact.timeline || []).length === 0 ? (
            <div className="text-xs text-[var(--text-muted)]">Sin actividad registrada.</div>
          ) : (
            <div className="space-y-2.5">
              {(contact.timeline || []).map((act: any) => (
                <div
                  key={act.id}
                  className="p-2.5 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-xs space-y-1"
                >
                  <div className="font-medium text-[var(--text)]">{act.summary}</div>
                  <div className="text-[10px] text-[var(--text-muted)]">
                    {new Date(act.performed_at).toLocaleString('es')}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* AnonymizeDialog / LGPD */}
      <Sheet
        open={Boolean(lgpdMode)}
        onClose={() => setLgpdMode(null)}
        title={
          lgpdMode === 'redact'
            ? 'Solicitar anonimización LGPD'
            : 'Solicitar exportación LGPD'
        }
      >
        <div className="space-y-4">
          <p className="text-xs text-[var(--text-muted)]">
            {lgpdMode === 'redact'
              ? `Se creará una solicitud de anonimización en cascada para ${contact.name}. Al ejecutarse, sus datos personales serán eliminados de forma irreversible.`
              : `Se creará una solicitud de exportación de datos personales en formato JSON para ${contact.name}.`}
          </p>
          <div className="space-y-1">
            <label htmlFor="lgpd-reason" className="text-xs font-medium">
              Motivo (opcional)
            </label>
            <Input
              id="lgpd-reason"
              value={lgpdReason}
              onChange={(e) => setLgpdReason(e.target.value)}
              placeholder="Solicitud del titular vía WhatsApp"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setLgpdMode(null)}>
              Cancelar
            </Button>
            <Button
              variant={lgpdMode === 'redact' ? 'danger' : 'primary'}
              disabled={lgpdBusy}
              onClick={() => void handleLgpdSubmit()}
            >
              {lgpdBusy
                ? 'Enviando...'
                : lgpdMode === 'redact'
                  ? 'Confirmar anonimización'
                  : 'Solicitar exportación'}
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
