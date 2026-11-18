import React, { useEffect, useState } from 'react';
import { GitMerge, Plus, Search, MessageSquare } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { apiFetch } from '../lib/api';
import { Badge, Button, Card, Input, Sheet } from '../components/ui/primitives';

export function ContactsPage() {
  const nav = useNavigate();
  const [contacts, setContacts] = useState<any[]>([]);
  const [mergeQueue, setMergeQueue] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [selected, setSelected] = useState<any | null>(null);
  const [form, setForm] = useState({ name: '', phone_number: '', email: '', cpf: '' });

  async function load() {
    const [cts, mq] = await Promise.all([
      apiFetch(`/contacts${q ? `?q=${encodeURIComponent(q)}` : ''}`),
      apiFetch('/contacts/merge-queue'),
    ]);
    setContacts(cts);
    setMergeQueue(mq);
  }

  useEffect(() => {
    load();
  }, [q]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    await apiFetch('/contacts', { method: 'POST', body: JSON.stringify(form) });
    setForm({ name: '', phone_number: '', email: '', cpf: '' });
    setNewOpen(false);
    load();
  }

  async function openDetail(id: string) {
    const data = await apiFetch(`/contacts/${id}`);
    setSelected(data);
  }

  async function startChat(contactId: string) {
    await apiFetch('/conversations', { method: 'POST', body: JSON.stringify({ contact_id: contactId }) });
    nav({ to: '/app/inbox' });
  }

  async function handleMerge(primaryId: string, dupId: string) {
    await apiFetch('/contacts/merge', { method: 'POST', body: JSON.stringify({ primary_id: primaryId, duplicate_id: dupId }) });
    setMergeOpen(false);
    load();
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Contacts (Customer 360°)</h1>
        <div className="flex gap-2">
          {mergeQueue.length > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setMergeOpen(true)}>
              <GitMerge className="w-4 h-4" /> Merge Queue ({mergeQueue.length})
            </Button>
          )}
          <Button size="sm" onClick={() => setNewOpen(true)}>
            <Plus className="w-4 h-4" /> New Contact
          </Button>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="w-4 h-4 absolute left-3 top-3 text-[var(--text-muted)]" />
        <Input className="pl-9" placeholder="Search name, phone, or email..." value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {contacts.map((c) => (
          <Card key={c.id} className="p-4 flex items-center justify-between gap-2">
            <button onClick={() => openDetail(c.id)} className="text-left min-w-0 flex-1 cursor-pointer">
              <div className="font-semibold text-sm truncate">{c.name}</div>
              <div className="text-xs text-[var(--text-muted)] truncate">{c.phone_number || c.email || 'No contact info'}</div>
              {c.is_anonymized && <Badge tone="warning" className="mt-1">Anonymized</Badge>}
            </button>
            <Button size="sm" variant="secondary" onClick={() => startChat(c.id)} title="Open Inbox Chat">
              <MessageSquare className="w-3.5 h-3.5" />
            </Button>
          </Card>
        ))}
      </div>

      <Sheet open={newOpen} onClose={() => setNewOpen(false)} title="New Contact">
        <form onSubmit={handleCreate} className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium">Name</label>
            <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Maria Oliveira" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Phone (E.164)</label>
            <Input value={form.phone_number} onChange={(e) => setForm({ ...form, phone_number: e.target.value })} placeholder="+5511999998888" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Email</label>
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="maria@example.com" />
          </div>
          <Button type="submit" className="w-full">Save Contact</Button>
        </form>
      </Sheet>

      <Sheet open={!!selected} onClose={() => setSelected(null)} title={selected?.name || 'Customer 360°'}>
        {selected && (
          <div className="space-y-4">
            <div className="text-xs text-[var(--text-muted)] space-y-1">
              <div>Phone: {selected.phone_number || '—'}</div>
              <div>Email: {selected.email || '—'}</div>
              <div>CPF: {selected.cpf || '—'}</div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase text-[var(--text-muted)] mb-2">Activity Timeline</div>
              <div className="space-y-2">
                {(selected.timeline || []).map((t: any) => (
                  <div key={t.id} className="p-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border)] text-xs">
                    <div className="font-medium">{t.summary}</div>
                    <div className="text-[10px] text-[var(--text-muted)]">{new Date(t.performed_at).toLocaleString()}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Sheet>

      <Sheet open={mergeOpen} onClose={() => setMergeOpen(false)} title="Duplicate Merge Queue">
        <div className="space-y-3">
          {mergeQueue.map((m) => (
            <Card key={m.id} className="p-3 space-y-2">
              <div className="text-xs font-medium">
                {m.primary_name} ↔ {m.duplicate_name} ({m.reason})
              </div>
              <Button size="sm" onClick={() => handleMerge(m.primary_contact_id, m.duplicate_contact_id)}>
                Merge into {m.primary_name}
              </Button>
            </Card>
          ))}
        </div>
      </Sheet>
    </div>
  );
}
