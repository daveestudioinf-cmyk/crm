import React, { useEffect, useState } from 'react';
import { Calendar, Check, Clock, Plus, RefreshCw, Trash2, UserPlus, X } from 'lucide-react';
import { apiFetch, subscribeSSE } from '../lib/api';
import { Badge, Button, Card, Input, Sheet } from '../components/ui/primitives';

interface Appointment {
  id: string;
  contact_id?: string;
  contact_name?: string;
  title: string;
  description: string;
  location: string;
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
  notes: string;
}

interface WaitlistEntry {
  id: string;
  contact_name: string;
  contact_phone: string;
  phone_e164: string;
  service_name: string;
  preferred_period: string;
  status: string;
  notes: string;
}

interface ContactOption {
  id: string;
  name: string;
  phone_number?: string;
}

const APPT_STATUS_META: Record<string, { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }> = {
  scheduled: { label: 'Programada', tone: 'accent' },
  confirmed: { label: 'Confirmada', tone: 'success' },
  completed: { label: 'Completada', tone: 'neutral' },
  cancelled: { label: 'Cancelada', tone: 'danger' },
  no_show: { label: 'No asistió', tone: 'warning' },
};

function defaultDateTimeLocal(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function AgendaPage() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [viewMode, setViewMode] = useState<'day' | 'week'>('week');

  const [apptOpen, setApptOpen] = useState(false);
  const [savingAppt, setSavingAppt] = useState(false);
  const [title, setTitle] = useState('');
  const [startsAtLocal, setStartsAtLocal] = useState(defaultDateTimeLocal);
  const [durationMinutes, setDurationMinutes] = useState('30');
  const [contactId, setContactId] = useState('');
  const [notes, setNotes] = useState('');

  const [wlName, setWlName] = useState('');
  const [wlPhone, setWlPhone] = useState('');
  const [wlNotes, setWlNotes] = useState('');
  const [savingWl, setSavingWl] = useState(false);

  async function loadAll() {
    try {
      setError('');
      const [apptRes, wlRes, ctRes] = await Promise.all([
        apiFetch('/appointments').catch(() => ({ items: [] })),
        apiFetch('/waitlist').catch(() => ({ items: [] })),
        apiFetch('/contacts').catch(() => ({ items: [] })),
      ]);
      setAppointments(apptRes.items || apptRes.appointments || []);
      setWaitlist(wlRes.items || wlRes.waitlist || []);
      setContacts(Array.isArray(ctRes) ? ctRes : ctRes?.items ?? ctRes?.contacts ?? []);
    } catch (err: any) {
      setError(err?.message || 'Error al cargar la agenda');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
    const unsub = subscribeSSE((eventType) => {
      if (eventType === 'appointment.updated') {
        loadAll();
      }
    });
    return () => unsub();
  }, []);

  async function handleCreateAppointment(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setError('El título de la cita es obligatorio.');
      return;
    }
    setSavingAppt(true);
    setError('');
    try {
      const isoStart = new Date(startsAtLocal || defaultDateTimeLocal()).toISOString();
      await apiFetch('/appointments', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          starts_at: isoStart,
          duration_minutes: Math.max(5, Number(durationMinutes) || 30),
          contact_id: contactId || undefined,
          notes: notes.trim(),
        }),
      });
      setTitle('');
      setStartsAtLocal(defaultDateTimeLocal());
      setDurationMinutes('30');
      setContactId('');
      setNotes('');
      setApptOpen(false);
      await loadAll();
    } catch (err: any) {
      if (err?.status === 409) {
        setError('Ya existe una cita programada en ese horario.');
      } else {
        setError(err?.message || 'No se pudo agendar la cita');
      }
    } finally {
      setSavingAppt(false);
    }
  }

  async function updateAppointmentStatus(id: string, status: string) {
    try {
      setError('');
      await apiFetch(`/appointments/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      await loadAll();
    } catch (err: any) {
      setError(err?.message || 'No se pudo actualizar la cita');
    }
  }

  async function handleAddWaitlist(e: React.FormEvent) {
    e.preventDefault();
    if (!wlName.trim()) {
      setError('El nombre del contacto es obligatorio para la lista de espera.');
      return;
    }
    setSavingWl(true);
    setError('');
    try {
      await apiFetch('/waitlist', {
        method: 'POST',
        body: JSON.stringify({
          contact_name: wlName.trim(),
          phone_e164: wlPhone.trim(),
          notes: wlNotes.trim(),
        }),
      });
      setWlName('');
      setWlPhone('');
      setWlNotes('');
      await loadAll();
    } catch (err: any) {
      setError(err?.message || 'No se pudo agregar a la lista de espera');
    } finally {
      setSavingWl(false);
    }
  }

  async function handlePromoteWaitlist(id: string) {
    try {
      setError('');
      await apiFetch(`/waitlist/${id}/promote`, { method: 'POST', body: JSON.stringify({}) });
      await loadAll();
    } catch (err: any) {
      if (err?.status === 409) {
        setError('El próximo horario disponible ya está ocupado.');
      } else {
        setError(err?.message || 'No se pudo agendar desde la lista de espera');
      }
    }
  }

  async function handleDeleteWaitlist(id: string) {
    try {
      setError('');
      await apiFetch(`/waitlist/${id}`, { method: 'DELETE' });
      await loadAll();
    } catch (err: any) {
      setError(err?.message || 'No se pudo eliminar de la lista de espera');
    }
  }

  const now = new Date();
  const visibleAppointments = appointments.filter((a) => {
    if (viewMode === 'week') return true;
    const d = new Date(a.starts_at);
    return (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    );
  });

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-[var(--text)]">Agenda y Lista de Espera</h1>
          <p className="text-xs text-[var(--text-muted)]">
            Programa citas sin traslapes y promueve contactos desde la lista de espera.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('day')}
              className={`px-3 py-1 text-xs rounded-[8px] cursor-pointer ${
                viewMode === 'day' ? 'bg-[var(--bg)] font-semibold text-[var(--text)] shadow-xs' : 'text-[var(--text-muted)]'
              }`}
            >
              Hoy
            </button>
            <button
              type="button"
              onClick={() => setViewMode('week')}
              className={`px-3 py-1 text-xs rounded-[8px] cursor-pointer ${
                viewMode === 'week' ? 'bg-[var(--bg)] font-semibold text-[var(--text)] shadow-xs' : 'text-[var(--text-muted)]'
              }`}
            >
              Todas
            </button>
          </div>
          <Button variant="secondary" size="sm" onClick={loadAll} aria-label="Actualizar agenda">
            <RefreshCw className="w-4 h-4" />
            Actualizar
          </Button>
          <Button size="sm" onClick={() => setApptOpen(true)}>
            <Plus className="w-4 h-4" />
            Nueva Cita
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 min-w-0">
        <div className="lg:col-span-2 space-y-3 min-w-0">
          <h2 className="text-sm font-semibold text-[var(--text)] flex items-center gap-2">
            <Calendar className="w-4 h-4 text-[var(--accent)]" />
            Sesiones programadas ({visibleAppointments.length})
          </h2>

          {loading ? (
            <Card className="p-6 text-sm text-[var(--text-muted)]">Cargando citas...</Card>
          ) : visibleAppointments.length === 0 ? (
            <Card className="p-6 text-center space-y-2">
              <p className="text-sm font-medium text-[var(--text)]">Sin citas en este rango</p>
              <p className="text-xs text-[var(--text-muted)]">Haz clic en «Nueva Cita» para agendar.</p>
            </Card>
          ) : (
            <div className="space-y-3">
              {visibleAppointments.map((a) => {
                const meta = APPT_STATUS_META[a.status] || { label: a.status, tone: 'neutral' as const };
                const startDate = new Date(a.starts_at);
                return (
                  <Card key={a.id} className="p-4 space-y-2.5 min-w-0">
                    <div className="flex items-start justify-between gap-2 min-w-0">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-[var(--text)] truncate">{a.title}</h3>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)] mt-0.5">
                          <span className="inline-flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5" />
                            {startDate.toLocaleString('es-MX', {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })}
                          </span>
                          <span>· {a.duration_minutes} min</span>
                          {a.contact_name && <span>· {a.contact_name}</span>}
                        </div>
                      </div>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </div>

                    {a.notes && <p className="text-xs text-[var(--text-muted)]">{a.notes}</p>}

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {a.status === 'scheduled' && (
                        <Button size="sm" variant="secondary" onClick={() => updateAppointmentStatus(a.id, 'confirmed')}>
                          <Check className="w-3.5 h-3.5" />
                          Confirmar
                        </Button>
                      )}
                      {(a.status === 'scheduled' || a.status === 'confirmed') && (
                        <Button size="sm" variant="secondary" onClick={() => updateAppointmentStatus(a.id, 'completed')}>
                          Completar
                        </Button>
                      )}
                      {a.status !== 'cancelled' && a.status !== 'completed' && (
                        <Button size="sm" variant="ghost" onClick={() => updateAppointmentStatus(a.id, 'cancelled')}>
                          <X className="w-3.5 h-3.5" />
                          Cancelar
                        </Button>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-4 min-w-0">
          <h2 className="text-sm font-semibold text-[var(--text)] flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-[var(--accent)]" />
            Lista de espera ({waitlist.filter((w) => w.status === 'waiting').length})
          </h2>

          <Card className="p-4 space-y-3">
            <form onSubmit={handleAddWaitlist} className="space-y-2.5">
              <div className="space-y-1">
                <label htmlFor="wl-name" className="block text-xs font-medium text-[var(--text)]">
                  Nombre en espera
                </label>
                <Input
                  id="wl-name"
                  value={wlName}
                  onChange={(e) => setWlName(e.target.value)}
                  placeholder="Ej. Ana López"
                  required
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="wl-phone" className="block text-xs font-medium text-[var(--text)]">
                  Teléfono (E.164)
                </label>
                <Input
                  id="wl-phone"
                  value={wlPhone}
                  onChange={(e) => setWlPhone(e.target.value)}
                  placeholder="+5215512345678"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="wl-notes" className="block text-xs font-medium text-[var(--text)]">
                  Notas de preferencia
                </label>
                <Input
                  id="wl-notes"
                  value={wlNotes}
                  onChange={(e) => setWlNotes(e.target.value)}
                  placeholder="Horario preferido..."
                />
              </div>
              <Button type="submit" size="sm" className="w-full" disabled={savingWl}>
                {savingWl ? 'Agregando...' : 'Agregar a espera'}
              </Button>
            </form>
          </Card>

          <div className="space-y-2.5">
            {waitlist.map((w) => (
              <Card key={w.id} className="p-3 space-y-2 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-[var(--text)] truncate">{w.contact_name}</div>
                    {w.contact_phone && <div className="text-xs text-[var(--text-muted)]">{w.contact_phone}</div>}
                    {w.notes && <div className="text-xs text-[var(--text-muted)] mt-0.5">{w.notes}</div>}
                  </div>
                  <Badge tone={w.status === 'scheduled' ? 'success' : 'neutral'}>
                    {w.status === 'scheduled' ? 'Agendada' : 'En espera'}
                  </Badge>
                </div>
                <div className="flex items-center gap-2">
                  {w.status === 'waiting' && (
                    <Button size="sm" variant="secondary" onClick={() => handlePromoteWaitlist(w.id)}>
                      Agendar
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => handleDeleteWaitlist(w.id)} aria-label="Eliminar de lista de espera">
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </div>

      <Sheet open={apptOpen} onClose={() => setApptOpen(false)} title="Nueva Cita">
        <form onSubmit={handleCreateAppointment} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="appt-title" className="block text-xs font-medium text-[var(--text)]">
              Título
            </label>
            <Input
              id="appt-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ej. Demostración de producto"
              required
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="appt-starts" className="block text-xs font-medium text-[var(--text)]">
                Fecha y hora
              </label>
              <Input
                id="appt-starts"
                type="datetime-local"
                value={startsAtLocal}
                onChange={(e) => setStartsAtLocal(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="appt-duration" className="block text-xs font-medium text-[var(--text)]">
                Duración (minutos)
              </label>
              <Input
                id="appt-duration"
                type="number"
                min={5}
                step={5}
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="appt-contact" className="block text-xs font-medium text-[var(--text)]">
              Contacto (opcional)
            </label>
            <select
              id="appt-contact"
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              className="flex h-10 w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            >
              <option value="">Sin contacto vinculado</option>
              {contacts.map((ct) => (
                <option key={ct.id} value={ct.id}>
                  {ct.name} {ct.phone_number ? `(${ct.phone_number})` : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="appt-notes" className="block text-xs font-medium text-[var(--text)]">
              Notas
            </label>
            <textarea
              id="appt-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Detalles de la cita..."
              className="w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setApptOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={savingAppt}>
              {savingAppt ? 'Guardando...' : 'Guardar Cita'}
            </Button>
          </div>
        </form>
      </Sheet>
    </div>
  );
}
