import React, { useEffect, useState } from 'react';
import { ArrowLeft, Bot, CheckCircle2, Info, Send, Sparkles, UserCheck } from 'lucide-react';
import { apiFetch, getToken } from '../lib/api';
import { Badge, Button, Input, Sheet } from '../components/ui/primitives';

export function InboxPage() {
  const [conversations, setConversations] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [contact360, setContact360] = useState<any | null>(null);
  const [body, setBody] = useState('');
  const [filter, setFilter] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);

  async function loadConversations() {
    const data = await apiFetch(`/conversations${filter ? `?status=${filter}` : ''}`);
    setConversations(data);
    if (!selected && data.length > 0 && window.innerWidth >= 768) {
      selectConversation(data[0]);
    }
  }

  async function selectConversation(conv: any) {
    setSelected(conv);
    const [msgs, c360] = await Promise.all([
      apiFetch(`/conversations/${conv.id}/messages`),
      apiFetch(`/contacts/${conv.contact_id}`),
    ]);
    setMessages(msgs);
    setContact360(c360);
  }

  useEffect(() => {
    loadConversations();
    apiFetch('/templates').then(setTemplates).catch(() => {});
  }, [filter]);

  useEffect(() => {
    const tok = getToken();
    if (!tok || !window.location.protocol.startsWith('http')) return;
    let es: EventSource | null = null;
    try {
      const url = new URL(`/api/v1/realtime/stream?token=${encodeURIComponent(tok)}`, window.location.origin).toString();
      es = new EventSource(url);
      es.addEventListener('message.created', (ev: any) => {
        const parsed = JSON.parse(ev.data);
        const p = parsed.payload;
        loadConversations();
        if (selected && p.conversation_id === selected.id) {
          setMessages((prev) => (prev.some((m) => m.id === p.id) ? prev : [...prev, p]));
        }
      });
      es.addEventListener('conversation.updated', () => loadConversations());
    } catch {
      // Fallback silencioso si el visor bloquea EventSource
    }
    return () => es?.close();
  }, [selected?.id]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !body.trim()) return;
    const text = body;
    setBody('');
    await apiFetch(`/conversations/${selected.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: text, content_type: 'text' }),
    });
    const msgs = await apiFetch(`/conversations/${selected.id}/messages`);
    setMessages(msgs);
    loadConversations();
  }

  async function handleClaim() {
    if (!selected) return;
    await apiFetch(`/conversations/${selected.id}/claim`, { method: 'POST' });
    setSelected({ ...selected, status: 'claimed' });
    loadConversations();
  }

  async function handleResolve(status: 'resolved' | 'ai_handling') {
    if (!selected) return;
    await apiFetch(`/conversations/${selected.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
    setSelected({ ...selected, status });
    loadConversations();
  }

  const statusTone = (s: string) => {
    if (s === 'claimed') return 'success';
    if (s === 'pending') return 'warning';
    if (s === 'ai_handling') return 'accent';
    return 'neutral';
  };

  const C360Content = contact360 ? (
    <div className="space-y-4">
      <div>
        <div className="text-sm font-semibold">{contact360.name}</div>
        <div className="text-xs text-[var(--text-muted)]">{contact360.phone_number || 'Sin teléfono'}</div>
        {contact360.email && <div className="text-xs text-[var(--text-muted)]">{contact360.email}</div>}
      </div>
      <div className="flex flex-wrap gap-1">
        {(contact360.tags || []).map((t: string) => (
          <Badge key={t} tone="accent">{t}</Badge>
        ))}
        {contact360.is_blocked && <Badge tone="danger">Baja solicitada (STOP)</Badge>}
      </div>
      <div>
        <div className="text-xs font-semibold uppercase text-[var(--text-muted)] mb-2">Línea de tiempo</div>
        <div className="space-y-2">
          {(contact360.timeline || []).slice(0, 6).map((act: any) => (
            <div key={act.id} className="text-xs p-2 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
              <div className="font-medium">{act.summary}</div>
              <div className="text-[10px] text-[var(--text-muted)]">{new Date(act.performed_at).toLocaleString()}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  ) : (
    <div className="text-xs text-[var(--text-muted)]">Selecciona una conversación para ver Customer 360°</div>
  );

  return (
    <div className="h-[calc(100dvh-3.5rem)] md:h-dvh flex overflow-hidden">
      {/* Columna 1: Lista de conversaciones */}
      <div className={`${selected ? 'hidden md:flex' : 'flex'} w-full md:w-80 flex-col border-r border-[var(--border)] bg-[var(--bg)]`}>
        <div className="p-3 border-b border-[var(--border)] space-y-2">
          <div className="flex items-center justify-between">
            <h1 className="font-bold text-base">Bandeja</h1>
            <span className="text-xs text-[var(--text-muted)]">{conversations.length} chats</span>
          </div>
          <div className="flex gap-1 overflow-x-auto pb-1">
            {[
              { k: '', l: 'Todos' },
              { k: 'pending', l: 'Cola' },
              { k: 'ai_handling', l: 'IA' },
              { k: 'claimed', l: 'Míos' },
            ].map((tab) => (
              <button
                key={tab.k}
                onClick={() => setFilter(tab.k)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium cursor-pointer ${
                  filter === tab.k ? 'bg-[var(--accent)] text-[var(--on-accent)]' : 'bg-[var(--surface)] text-[var(--text-muted)]'
                }`}
              >
                {tab.l}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-[var(--border)]">
          {conversations.length === 0 ? (
            <div className="p-6 text-center text-xs text-[var(--text-muted)]">
              Aún no hay conversaciones. Crea un contacto o conecta WhatsApp para iniciar.
            </div>
          ) : (
            conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => selectConversation(c)}
                className={`w-full text-left p-3 hover:bg-[var(--surface)] transition-colors cursor-pointer ${
                  selected?.id === c.id ? 'bg-[var(--surface)]' : ''
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-sm truncate">{c.contact_name}</span>
                  <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                </div>
                <div className="text-xs text-[var(--text-muted)] truncate mt-1">{c.last_message_preview || 'Sin mensajes aún'}</div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Columna 2: Hilo de chat */}
      <div className={`${selected ? 'flex' : 'hidden md:flex'} flex-1 flex-col bg-[var(--surface)] min-w-0`}>
        {selected ? (
          <>
            <div className="h-14 px-3 md:px-4 border-b border-[var(--border)] bg-[var(--bg)] flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  onClick={() => setSelected(null)}
                  className="md:hidden p-1.5 rounded-lg hover:bg-slate-100 cursor-pointer"
                  aria-label="Volver a la lista"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="min-w-0">
                  <div className="font-semibold text-sm truncate">{selected.contact_name}</div>
                  <div className="text-[11px] text-[var(--text-muted)] truncate">{selected.contact_phone}</div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {selected.status !== 'claimed' && (
                  <Button size="sm" onClick={handleClaim}>
                    <UserCheck className="w-3.5 h-3.5" /> Reclamar
                  </Button>
                )}
                {selected.status === 'claimed' && (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => handleResolve('ai_handling')}>
                      <Bot className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Pasar a IA</span>
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => handleResolve('resolved')}>
                      <CheckCircle2 className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Resolver</span>
                    </Button>
                  </>
                )}
                <button
                  onClick={() => setSheetOpen(true)}
                  className="lg:hidden p-2 rounded-lg border border-[var(--border)] cursor-pointer"
                  aria-label="Customer 360"
                >
                  <Info className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.map((m) => {
                const isOut = m.direction === 'outbound';
                return (
                  <div key={m.id} className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[82%] md:max-w-[70%] rounded-2xl px-3.5 py-2.5 text-sm shadow-xs ${
                        isOut
                          ? 'bg-[var(--accent)] text-[var(--on-accent)] rounded-br-sm'
                          : 'bg-[var(--bg)] border border-[var(--border)] text-[var(--text)] rounded-bl-sm'
                      }`}
                    >
                      {m.sender_type === 'ai' && (
                        <div className="flex items-center gap-1 text-[10px] opacity-80 mb-0.5">
                          <Sparkles className="w-3 h-3" /> Asistente IA
                        </div>
                      )}
                      <div className="whitespace-pre-wrap break-words">{m.body}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            {templates.length > 0 && (
              <div className="px-3 py-1.5 bg-[var(--bg)] border-t border-[var(--border)] flex gap-1.5 overflow-x-auto">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setBody(t.body)}
                    className="shrink-0 text-[11px] px-2.5 py-1 rounded-full bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--accent)] cursor-pointer"
                  >
                    /{t.shortcut}
                  </button>
                ))}
              </div>
            )}

            <form onSubmit={handleSend} className="p-3 bg-[var(--bg)] border-t border-[var(--border)] flex gap-2">
              <Input
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={selected.is_blocked ? 'Contacto dado de baja (STOP)' : 'Escribe un mensaje de WhatsApp...'}
                disabled={selected.is_blocked}
              />
              <Button type="submit" disabled={selected.is_blocked || !body.trim()}>
                <Send className="w-4 h-4" />
              </Button>
            </form>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)]">
            Selecciona una conversación para comenzar
          </div>
        )}
      </div>

      {/* Columna 3: Customer 360° escritorio */}
      <aside className="hidden lg:block w-80 border-l border-[var(--border)] bg-[var(--bg)] p-4 overflow-y-auto">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">Customer 360°</h2>
        {C360Content}
      </aside>

      {/* Sheet Customer 360° móvil */}
      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Customer 360°">
        {C360Content}
      </Sheet>
    </div>
  );
}
