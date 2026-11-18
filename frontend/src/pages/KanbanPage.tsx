import React, { useEffect, useState } from 'react';
import { Plus, ArrowRight } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { Badge, Button, Card, Input, Sheet } from '../components/ui/primitives';

export function KanbanPage() {
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [activePipe, setActivePipe] = useState<any | null>(null);
  const [leads, setLeads] = useState<any[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [mobileStageId, setMobileStageId] = useState<string>('');
  const [newOpen, setNewOpen] = useState(false);
  const [moveLead, setMoveLead] = useState<any | null>(null);
  const [title, setTitle] = useState('');
  const [contactId, setContactId] = useState('');
  const [valueCents, setValueCents] = useState('0');

  async function loadData(pipeId?: string) {
    const [pipes, cts] = await Promise.all([apiFetch('/pipelines'), apiFetch('/contacts')]);
    setPipelines(pipes);
    setContacts(cts);
    const chosen = pipes.find((p: any) => p.id === (pipeId || activePipe?.id)) || pipes[0];
    if (chosen) {
      setActivePipe(chosen);
      if (!mobileStageId && chosen.stages?.length > 0) setMobileStageId(chosen.stages[0].id);
      const lds = await apiFetch(`/leads?pipeline_id=${chosen.id}`);
      setLeads(lds);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function handleCreateLead(e: React.FormEvent) {
    e.preventDefault();
    if (!activePipe || !contactId || !title) return;
    await apiFetch('/leads', {
      method: 'POST',
      body: JSON.stringify({
        pipeline_id: activePipe.id,
        stage_id: activePipe.stages[0]?.id,
        contact_id: contactId,
        title,
        value_cents: Math.round(Number(valueCents || 0) * 100),
      }),
    });
    setTitle('');
    setNewOpen(false);
    loadData(activePipe.id);
  }

  async function handleMoveStage(lead: any, targetStageId: string) {
    setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, stage_id: targetStageId } : l)));
    setMoveLead(null);
    await apiFetch(`/leads/${lead.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ stage_id: targetStageId, version: lead.version }),
    });
    loadData(activePipe?.id);
  }

  const stages = activePipe?.stages || [];

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-xl font-bold">Embudo</h1>
          <div className="flex gap-1.5">
            {pipelines.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setActivePipe(p);
                  setMobileStageId(p.stages?.[0]?.id || '');
                  loadData(p.id);
                }}
                className={`px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer ${
                  activePipe?.id === p.id ? 'bg-[var(--accent)] text-[var(--on-accent)]' : 'bg-[var(--surface)] border border-[var(--border)]'
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
        <Button size="sm" onClick={() => setNewOpen(true)}>
          <Plus className="w-4 h-4" /> Nuevo {activePipe?.vocabulary?.deal || 'Lead'}
        </Button>
      </div>

      {/* Pestañas de etapas en móvil (cero scroll horizontal) */}
      <div className="md:hidden space-y-3">
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {stages.map((s: any) => (
            <button
              key={s.id}
              onClick={() => setMobileStageId(s.id)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer ${
                mobileStageId === s.id ? 'bg-[var(--accent)] text-[var(--on-accent)]' : 'bg-[var(--surface)] border border-[var(--border)]'
              }`}
            >
              {s.name} ({leads.filter((l) => l.stage_id === s.id).length})
            </button>
          ))}
        </div>
        <div className="space-y-2.5">
          {leads
            .filter((l) => l.stage_id === mobileStageId)
            .map((l) => (
              <Card key={l.id} className="p-3.5 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-sm truncate">{l.title}</div>
                  <div className="text-xs text-[var(--text-muted)] truncate">{l.contact_name}</div>
                  <div className="text-xs font-medium text-[var(--accent)] mt-1">${(l.value_cents / 100).toFixed(2)}</div>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setMoveLead(l)}>
                  Mover <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              </Card>
            ))}
        </div>
      </div>

      {/* Columnas Kanban escritorio */}
      <div className="hidden md:flex gap-4 overflow-x-auto pb-4">
        {stages.map((s: any) => {
          const colLeads = leads.filter((l) => l.stage_id === s.id);
          return (
            <div
              key={s.id}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                const leadId = e.dataTransfer.getData('text/plain');
                const found = leads.find((x) => x.id === leadId);
                if (found && found.stage_id !== s.id) handleMoveStage(found, s.id);
              }}
              className="w-72 shrink-0 rounded-2xl bg-[var(--surface)] border border-[var(--border)] p-3 flex flex-col gap-2.5 min-h-[420px]"
            >
              <div className="flex items-center justify-between px-1">
                <span className="font-semibold text-sm">{s.name}</span>
                <Badge>{colLeads.length}</Badge>
              </div>
              {colLeads.map((l) => (
                <Card
                  key={l.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', l.id)}
                  className="p-3 cursor-grab active:cursor-grabbing space-y-1.5"
                >
                  <div className="font-semibold text-sm">{l.title}</div>
                  <div className="text-xs text-[var(--text-muted)]">{l.contact_name}</div>
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-xs font-medium text-[var(--accent)]">${(l.value_cents / 100).toFixed(2)}</span>
                    <button onClick={() => setMoveLead(l)} className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer">
                      Mover
                    </button>
                  </div>
                </Card>
              ))}
            </div>
          );
        })}
      </div>

      <Sheet open={newOpen} onClose={() => setNewOpen(false)} title={`Nuevo ${activePipe?.vocabulary?.deal || 'Lead'}`}>
        <form onSubmit={handleCreateLead} className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium">Título</label>
            <Input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Plan Empresarial" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Contacto</label>
            <select
              required
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              className="h-10 w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
            >
              <option value="">Selecciona un contacto...</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Valor ($)</label>
            <Input type="number" step="0.01" value={valueCents} onChange={(e) => setValueCents(e.target.value)} />
          </div>
          <Button type="submit" className="w-full">Crear</Button>
        </form>
      </Sheet>

      <Sheet open={!!moveLead} onClose={() => setMoveLead(null)} title={`Mover "${moveLead?.title}"`}>
        <div className="space-y-2">
          {stages.map((s: any) => (
            <button
              key={s.id}
              onClick={() => handleMoveStage(moveLead, s.id)}
              className="w-full text-left p-3 rounded-xl border border-[var(--border)] hover:border-[var(--accent)] text-sm font-medium cursor-pointer"
            >
              {s.name}
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}
