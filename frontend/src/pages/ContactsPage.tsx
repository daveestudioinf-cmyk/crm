import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowLeftRight,
  CheckSquare,
  Download,
  GitMerge,
  MessageSquare,
  Plus,
  Search,
  Square,
  Tag,
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
  if (!digits) return true;
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

export function ContactsPage() {
  const nav = useNavigate();
  const [contacts, setContacts] = useState<any[]>([]);
  const [mergeQueue, setMergeQueue] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [swappedIds, setSwappedIds] = useState<Record<string, boolean>>({});
  const [mergeBusyId, setMergeBusyId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkTagInput, setBulkTagInput] = useState('');
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState('');
  const [createError, setCreateError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState({ name: '', phone_number: '', email: '', cpf: '' });

  const load = useCallback(async () => {
    setError('');
    try {
      const [cts, mq] = await Promise.all([
        apiFetch<any[]>(`/contacts${q ? `?q=${encodeURIComponent(q)}` : ''}`),
        apiFetch<any[]>('/contacts/merge-queue'),
      ]);
      setContacts(cts || []);
      setMergeQueue(mq || []);
    } catch (err: any) {
      setError(err.message || 'No se pudieron cargar los contactos.');
    }
  }, [q]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError('');
    if (form.cpf.trim() && !isValidCPF(form.cpf)) {
      setCreateError('El CPF ingresado no es válido (debe tener 11 dígitos válidos).');
      return;
    }
    try {
      await apiFetch('/contacts', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          cpf: form.cpf.replace(/\D/g, ''),
        }),
      });
      setForm({ name: '', phone_number: '', email: '', cpf: '' });
      setNewOpen(false);
      await load();
    } catch (err: any) {
      setCreateError(err.message || 'No se pudo crear el contacto.');
    }
  }

  async function startChat(contactId: string) {
    try {
      const conv = await apiFetch<{ id: string }>('/conversations', {
        method: 'POST',
        body: JSON.stringify({ contact_id: contactId }),
      });
      if (conv?.id) {
        void nav({ to: '/app/inbox/$id', params: { id: conv.id } });
      } else {
        void nav({ to: '/app/inbox' });
      }
    } catch (err: any) {
      setError(err.message || 'No se pudo iniciar la conversación.');
    }
  }

  async function handleMerge(mergeId: string, primaryId: string, dupId: string) {
    setMergeBusyId(mergeId);
    setError('');
    try {
      await apiFetch('/contacts/merge', {
        method: 'POST',
        body: JSON.stringify({ primary_id: primaryId, duplicate_id: dupId }),
      });
      setNotice('Contactos fusionados correctamente.');
      await load();
    } catch (err: any) {
      setError(err.message || 'No se pudieron fusionar los contactos.');
    } finally {
      setMergeBusyId(null);
    }
  }

  async function handleDismissMerge(mergeId: string) {
    setMergeBusyId(mergeId);
    setError('');
    try {
      await apiFetch(`/contacts/merge-queue/${mergeId}/dismiss`, {
        method: 'POST',
      });
      setNotice('Sugerencia de fusión descartada.');
      await load();
    } catch (err: any) {
      setError(err.message || 'No se pudo descartar la sugerencia.');
    } finally {
      setMergeBusyId(null);
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  }

  function toggleSelectAll() {
    if (selectedIds.length === contacts.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(contacts.map((c) => c.id));
    }
  }

  async function handleBulkAddTag(e: React.FormEvent) {
    e.preventDefault();
    const tag = bulkTagInput.trim();
    if (!tag || selectedIds.length === 0) return;
    setBulkBusy(true);
    setError('');
    try {
      const selectedContacts = contacts.filter((c) => selectedIds.includes(c.id));
      await Promise.all(
        selectedContacts.map((c) => {
          const existingTags: string[] = Array.isArray(c.tags) ? c.tags : [];
          const nextTags = existingTags.includes(tag) ? existingTags : [...existingTags, tag];
          return apiFetch(`/contacts/${c.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ tags: nextTags }),
          });
        })
      );
      setBulkTagInput('');
      setBulkTagOpen(false);
      setNotice(`Etiqueta "${tag}" agregada a ${selectedContacts.length} contactos.`);
      setSelectedIds([]);
      await load();
    } catch (err: any) {
      setError(err.message || 'Error al etiquetar contactos.');
    } finally {
      setBulkBusy(false);
    }
  }

  function handleBulkExport() {
    const selectedContacts = contacts.filter((c) => selectedIds.includes(c.id));
    const blob = new Blob([JSON.stringify(selectedContacts, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `koracrm-contactos-${selectedContacts.length}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const allSelected = contacts.length > 0 && selectedIds.length === contacts.length;

  return (
    <div className="p-4 md:p-6 space-y-4 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Contactos (Customer 360°)</h1>
        <div className="flex flex-wrap gap-2">
          {mergeQueue.length > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setMergeOpen(true)}>
              <GitMerge className="w-4 h-4" /> Cola de Fusión ({mergeQueue.length})
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => {
              setCreateError('');
              setNewOpen(true);
            }}
          >
            <Plus className="w-4 h-4" /> Nuevo Contacto
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-3 text-[var(--text-muted)]" />
          <Input
            className="pl-9"
            placeholder="Buscar nombre, teléfono o correo..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {contacts.length > 0 && (
          <button
            type="button"
            onClick={toggleSelectAll}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer"
          >
            {allSelected ? (
              <CheckSquare className="w-4 h-4 text-[var(--accent)]" />
            ) : (
              <Square className="w-4 h-4" />
            )}
            <span>{allSelected ? 'Deseleccionar todos' : 'Seleccionar todos'}</span>
          </button>
        )}
      </div>

      {notice && (
        <div className="px-3 py-2 rounded-xl text-xs bg-teal-50 border border-teal-200 text-teal-900 flex items-center justify-between gap-2">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice('')} className="cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {error && (
        <div className="px-3 py-2 rounded-xl text-xs bg-red-50 border border-red-200 text-[var(--danger)]">
          {error}
        </div>
      )}

      {/* Barra de acciones masivas */}
      {selectedIds.length > 0 && (
        <Card
          role="region"
          aria-label="Acciones masivas de contactos"
          className="p-3 bg-teal-50 border-teal-200 flex flex-wrap items-center justify-between gap-2"
        >
          <span className="text-xs font-semibold text-teal-900">
            {selectedIds.length}{' '}
            {selectedIds.length === 1 ? 'contacto seleccionado' : 'contactos seleccionados'}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setBulkTagOpen(true)}>
              <Tag className="w-3.5 h-3.5" /> Etiquetar
            </Button>
            <Button size="sm" variant="secondary" onClick={handleBulkExport}>
              <Download className="w-3.5 h-3.5" /> Exportar JSON
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds([])}>
              Limpiar
            </Button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {contacts.map((c) => {
          const checked = selectedIds.includes(c.id);
          return (
            <Card
              key={c.id}
              className={`p-4 flex items-center justify-between gap-2 min-w-0 ${
                checked ? 'border-[var(--accent)] bg-teal-50/30' : ''
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleSelect(c.id)}
                aria-label={`Seleccionar ${c.name}`}
                className="w-4 h-4 accent-[var(--accent)] shrink-0 cursor-pointer"
              />
              <Link
                to="/app/contacts/$id"
                params={{ id: c.id }}
                className="text-left min-w-0 flex-1 hover:underline"
              >
                <div className="font-semibold text-sm truncate text-[var(--text)]">{c.name}</div>
                <div className="text-xs text-[var(--text-muted)] truncate">
                  {c.phone_number || c.email || 'Sin datos de contacto'}
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {c.is_anonymized && <Badge tone="warning">Anonimizado</Badge>}
                  {(c.tags || []).slice(0, 2).map((tag: string) => (
                    <Badge key={tag} tone="accent">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </Link>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void startChat(c.id)}
                title="Abrir chat en Bandeja"
                className="shrink-0"
              >
                <MessageSquare className="w-3.5 h-3.5" />
              </Button>
            </Card>
          );
        })}
      </div>

      {/* Nuevo Contacto */}
      <Sheet
        open={newOpen}
        onClose={() => {
          setNewOpen(false);
          setCreateError('');
        }}
        title="Nuevo Contacto"
      >
        <form onSubmit={handleCreate} className="space-y-3">
          {createError && (
            <div className="px-3 py-2 rounded-xl text-xs bg-red-50 border border-red-200 text-[var(--danger)]">
              {createError}
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs font-medium">Nombre</label>
            <Input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="María Oliveira"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Teléfono (E.164)</label>
            <Input
              value={form.phone_number}
              onChange={(e) => setForm({ ...form, phone_number: e.target.value })}
              placeholder="+5215512345678"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Correo electrónico</label>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="maria@ejemplo.com"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">CPF / Documento</label>
            <Input
              value={form.cpf}
              onChange={(e) => setForm({ ...form, cpf: formatCPF(e.target.value) })}
              placeholder="000.000.000-00"
            />
          </div>
          <Button type="submit" className="w-full">
            Guardar Contacto
          </Button>
        </form>
      </Sheet>

      {/* Etiqueta masiva */}
      <Sheet open={bulkTagOpen} onClose={() => setBulkTagOpen(false)} title="Etiquetar contactos">
        <form onSubmit={handleBulkAddTag} className="space-y-3">
          <p className="text-xs text-[var(--text-muted)]">
            Se agregará esta etiqueta a los {selectedIds.length} contactos seleccionados.
          </p>
          <Input
            required
            value={bulkTagInput}
            onChange={(e) => setBulkTagInput(e.target.value)}
            placeholder="Ej. vip, seguimiento"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setBulkTagOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={bulkBusy}>
              {bulkBusy ? 'Aplicando...' : 'Aplicar etiqueta'}
            </Button>
          </div>
        </form>
      </Sheet>

      {/* MergeDialog mejorado */}
      <Sheet open={mergeOpen} onClose={() => setMergeOpen(false)} title="Cola de Duplicados">
        <div className="space-y-3">
          {mergeQueue.length === 0 ? (
            <div className="text-xs text-[var(--text-muted)] py-4 text-center">
              No hay duplicados pendientes por revisar.
            </div>
          ) : (
            mergeQueue.map((m) => {
              const swapped = Boolean(swappedIds[m.id]);
              const primary = swapped
                ? {
                    id: m.duplicate_contact_id,
                    name: m.duplicate_name,
                    phone: m.duplicate_phone,
                    email: m.duplicate_email,
                  }
                : {
                    id: m.primary_contact_id,
                    name: m.primary_name,
                    phone: m.primary_phone,
                    email: m.primary_email,
                  };
              const duplicate = swapped
                ? {
                    id: m.primary_contact_id,
                    name: m.primary_name,
                    phone: m.primary_phone,
                    email: m.primary_email,
                  }
                : {
                    id: m.duplicate_contact_id,
                    name: m.duplicate_name,
                    phone: m.duplicate_phone,
                    email: m.duplicate_email,
                  };

              return (
                <Card key={m.id} className="p-3.5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Badge tone="warning">{m.reason || 'posible duplicado'}</Badge>
                    <button
                      type="button"
                      onClick={() =>
                        setSwappedIds((prev) => ({ ...prev, [m.id]: !prev[m.id] }))
                      }
                      className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:underline cursor-pointer"
                    >
                      <ArrowLeftRight className="w-3.5 h-3.5" /> Intercambiar principal
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="p-2.5 rounded-xl border border-[var(--accent)] bg-teal-50/40 space-y-0.5 min-w-0">
                      <div className="text-[10px] font-semibold uppercase text-[var(--accent)]">
                        Principal (se conserva)
                      </div>
                      <div className="text-xs font-semibold truncate">{primary.name}</div>
                      {primary.phone && (
                        <div className="text-[11px] text-[var(--text-muted)] truncate">
                          {primary.phone}
                        </div>
                      )}
                      {primary.email && (
                        <div className="text-[11px] text-[var(--text-muted)] truncate">
                          {primary.email}
                        </div>
                      )}
                    </div>

                    <div className="p-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] space-y-0.5 min-w-0">
                      <div className="text-[10px] font-semibold uppercase text-[var(--text-muted)]">
                        Duplicado (se absorbe)
                      </div>
                      <div className="text-xs font-semibold truncate">{duplicate.name}</div>
                      {duplicate.phone && (
                        <div className="text-[11px] text-[var(--text-muted)] truncate">
                          {duplicate.phone}
                        </div>
                      )}
                      {duplicate.email && (
                        <div className="text-[11px] text-[var(--text-muted)] truncate">
                          {duplicate.email}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={mergeBusyId === m.id}
                      onClick={() => void handleDismissMerge(m.id)}
                    >
                      Descartar
                    </Button>
                    <Button
                      size="sm"
                      disabled={mergeBusyId === m.id}
                      onClick={() => void handleMerge(m.id, primary.id, duplicate.id)}
                    >
                      {mergeBusyId === m.id ? 'Procesando...' : 'Fusionar'}
                    </Button>
                  </div>
                </Card>
              );
            })
          )}
        </div>
      </Sheet>
    </div>
  );
}
