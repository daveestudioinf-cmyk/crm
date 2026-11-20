import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRightLeft,
  Bot,
  CheckCircle2,
  Clock,
  FileText,
  Info,
  Lock,
  Paperclip,
  RefreshCw,
  Send,
  Sparkles,
  StickyNote,
  UserCheck,
  WifiOff,
  X,
} from 'lucide-react';
import {
  ApiError,
  type SSEStatus,
  apiFetch,
  getSupportSession,
  getToken,
  subscribeSSE,
} from '../lib/api';
import { Badge, Button, Input, Sheet } from '../components/ui/primitives';

interface PendingAttachment {
  url: string;
  filename: string;
  contentType: string;
}

function is24hWindowClosed(conv: any): boolean {
  if (!conv?.channel_session_id) return false;
  if (!conv?.last_inbound_at) return true;
  const lastIn = new Date(conv.last_inbound_at).getTime();
  if (Number.isNaN(lastIn)) return true;
  return Date.now() - lastIn > 24 * 60 * 60 * 1000;
}

function isImageMedia(url: string, contentType?: string): boolean {
  if (contentType && contentType.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|avif)(\?.*)?$/i.test(url);
}

function ReconnectingBanner({
  status,
  onRetry,
}: {
  status: SSEStatus;
  onRetry: () => void;
}) {
  if (status !== 'reconnecting' && status !== 'offline') return null;
  const isOffline = status === 'offline';
  return (
    <div
      role="status"
      aria-live="polite"
      className="px-3 py-2 bg-amber-50 border-b border-amber-200 text-amber-950 text-xs flex flex-wrap items-center justify-between gap-2"
    >
      <div className="flex items-center gap-2 min-w-0">
        {isOffline ? (
          <WifiOff className="w-4 h-4 text-[var(--warning)] shrink-0" />
        ) : (
          <RefreshCw className="w-4 h-4 text-[var(--warning)] animate-spin shrink-0" />
        )}
        <span className="truncate">
          {isOffline
            ? 'Sin conexión a internet. Reconectando automáticamente al volver la red...'
            : 'Conexión en tiempo real interrumpida. Reconectando...'}
        </span>
      </div>
      {!isOffline && (
        <button
          type="button"
          onClick={onRetry}
          className="px-2.5 py-1 rounded-lg bg-amber-900 text-white font-medium hover:bg-amber-800 cursor-pointer shrink-0"
        >
          Reintentar ahora
        </button>
      )}
    </div>
  );
}

export function InboxPage() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { id?: string };
  const routeConvId = params?.id;

  const [conversations, setConversations] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [contact360, setContact360] = useState<any | null>(null);
  const [body, setBody] = useState('');
  const [filter, setFilter] = useState('');
  const [composerMode, setComposerMode] = useState<'whatsapp' | 'note'>('whatsapp');
  const [templateSelectedInClosedWindow, setTemplateSelectedInClosedWindow] = useState(false);

  const [sseStatus, setSseStatus] = useState<SSEStatus>('connecting');
  const [sseKey, setSseKey] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);

  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [sending, setSending] = useState(false);

  // Attachment upload
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [attachment, setAttachment] = useState<PendingAttachment | null>(null);

  // Transfer modal
  const [transferOpen, setTransferOpen] = useState(false);
  const [team, setTeam] = useState<any[]>([]);
  const [teamLoading, setTeamLoading] = useState(false);
  const [teamQuery, setTeamQuery] = useState('');
  const [transferring, setTransferring] = useState(false);

  // Slash quick-reply autocomplete
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);

  const selectConversation = useCallback(
    async (conv: any, syncRoute = true) => {
      setSelected(conv);
      setActionError('');
      setTemplateSelectedInClosedWindow(false);
      if (syncRoute && conv?.id && routeConvId !== conv.id) {
        void navigate({ to: '/app/inbox/$id', params: { id: conv.id } });
      }
      try {
        const [msgs, c360] = await Promise.all([
          apiFetch(`/conversations/${conv.id}/messages`),
          apiFetch(`/contacts/${conv.contact_id}`),
        ]);
        setMessages(msgs || []);
        setContact360(c360 || null);
      } catch (err: any) {
        setActionError(err.message || 'No se pudieron cargar los mensajes.');
      }
    },
    [navigate, routeConvId]
  );

  const loadConversations = useCallback(async () => {
    try {
      const data = await apiFetch<any[]>(`/conversations${filter ? `?status=${filter}` : ''}`);
      const list = data || [];
      setConversations(list);

      if (routeConvId) {
        const match = list.find((c) => c.id === routeConvId);
        if (match) {
          setSelected((prev: any) => (prev?.id === match.id ? { ...prev, ...match } : prev));
        }
      } else {
        setSelected((prev: any) => {
          if (prev) {
            const updated = list.find((c) => c.id === prev.id);
            return updated ? { ...prev, ...updated } : prev;
          }
          if (list.length > 0 && window.innerWidth >= 768) {
            return list[0];
          }
          return null;
        });
      }
    } catch {
      // Handled gracefully
    }
  }, [filter, routeConvId]);

  useEffect(() => {
    void loadConversations();
    apiFetch('/templates')
      .then((t) => setTemplates(t || []))
      .catch(() => {});
  }, [loadConversations]);

  // Deep-link sync when routeConvId changes or conversations load
  useEffect(() => {
    if (!routeConvId) return;
    if (selected?.id === routeConvId) return;
    const match = conversations.find((c) => c.id === routeConvId);
    if (match) {
      void selectConversation(match, false);
    } else if (conversations.length > 0) {
      // Fallback: fetch unfiltered conversations to locate deep-linked conversation
      apiFetch<any[]>('/conversations')
        .then((all) => {
          const found = (all || []).find((c) => c.id === routeConvId);
          if (found) {
            void selectConversation(found, false);
          }
        })
        .catch(() => {});
    }
  }, [routeConvId, conversations, selected?.id, selectConversation]);

  // Initial desktop auto-select when no route param
  useEffect(() => {
    if (!routeConvId && !selected && conversations.length > 0 && window.innerWidth >= 768) {
      void selectConversation(conversations[0], false);
    }
  }, [routeConvId, selected, conversations, selectConversation]);

  // SSE subscription with backoff + online/offline
  useEffect(() => {
    const unsub = subscribeSSE(
      (evType, parsed) => {
        const p = parsed?.payload ?? parsed;
        if (evType === 'message.created') {
          void loadConversations();
          if (selected?.id && p?.conversation_id === selected.id) {
            setMessages((prev) => (prev.some((m) => m.id === p.id) ? prev : [...prev, p]));
          }
        } else if (evType === 'conversation.updated') {
          void loadConversations();
        }
      },
      { onStatusChange: setSseStatus }
    );
    const timer = window.setInterval(() => {
      void loadConversations();
    }, 2000);
    return () => {
      unsub();
      window.clearInterval(timer);
    };
  }, [selected?.id, loadConversations, sseKey]);

  const windowClosed = selected ? is24hWindowClosed(selected) : false;
  const isUnclaimed = selected ? selected.status !== 'claimed' : false;
  const isNoteMode = composerMode === 'note';
  const whatsappBlocked = !isNoteMode && (Boolean(selected?.is_blocked) || isUnclaimed);
  const sendBlockedByWindow = !isNoteMode && windowClosed && !templateSelectedInClosedWindow;
  const freeTextDisabled = whatsappBlocked;

  // Slash autocomplete matches
  const slashMatches = useMemo(() => {
    if (slashDismissed || !body.startsWith('/')) return [];
    const query = body.slice(1).toLowerCase().trim();
    if (query.includes(' ')) return [];
    return templates
      .filter(
        (t) =>
          t.shortcut.toLowerCase().includes(query) ||
          (t.title || '').toLowerCase().includes(query)
      )
      .slice(0, 6);
  }, [body, templates, slashDismissed]);

  useEffect(() => {
    setSlashIndex(0);
  }, [slashMatches.length, body]);

  function applyTemplate(t: any) {
    let text = t.body || '';
    if (contact360?.name) {
      text = text.replace(/\{\{contact\.name\}\}/g, contact360.name);
    }
    if (contact360?.phone_number) {
      text = text.replace(/\{\{contact\.phone\}\}/g, contact360.phone_number);
    }
    setBody(text);
    setSlashDismissed(true);
    if (windowClosed) {
      setTemplateSelectedInClosedWindow(true);
    }
  }

  function handleComposerKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (slashMatches.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSlashIndex((i) => (i + 1) % slashMatches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = slashMatches[slashIndex];
      if (chosen) applyTemplate(chosen);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setSlashDismissed(true);
    }
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setActionError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const headers = new Headers();
      const token = getToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      const support = getSupportSession();
      if (support?.id) headers.set('X-Support-Session-ID', support.id);

      const res = await fetch('/api/v1/media/upload', {
        method: 'POST',
        headers,
        body: formData,
        credentials: 'include',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Error al subir archivo');
      }
      const data = await res.json();
      setAttachment({
        url: data.url || data.media_url,
        filename: data.filename || file.name,
        contentType: data.content_type || file.type || 'application/octet-stream',
      });
    } catch (err: any) {
      setActionError(err.message || 'No se pudo subir el archivo adjunto.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    if (!body.trim() && !attachment) return;
    if (freeTextDisabled) return;
    if (sendBlockedByWindow) {
      setActionError(
        'Ventana de 24 h cerrada: selecciona una plantilla con / o cambia a Nota interna.'
      );
      return;
    }

    setSending(true);
    setActionError('');
    const text = body.trim() || (attachment ? `Archivo adjunto: ${attachment.filename}` : '');
    const pendingAtt = attachment;
    setBody('');
    setAttachment(null);
    setTemplateSelectedInClosedWindow(false);

    try {
      await apiFetch(`/conversations/${selected.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          body: text,
          content_type: isNoteMode ? 'note' : 'text',
          ...(pendingAtt ? { media_url: pendingAtt.url } : {}),
        }),
      });
      const msgs = await apiFetch(`/conversations/${selected.id}/messages`);
      setMessages(msgs || []);
      await loadConversations();
    } catch (err: any) {
      setBody(text);
      setAttachment(pendingAtt);
      setActionError(err.message || 'No se pudo enviar el mensaje.');
    } finally {
      setSending(false);
    }
  }

  async function handleClaim() {
    if (!selected) return;
    setClaiming(true);
    setActionError('');
    setActionNotice('');
    try {
      const res = await apiFetch<{ status: string; service_revision: number }>(
        `/conversations/${selected.id}/claim`,
        {
          method: 'POST',
          body: JSON.stringify({ expected_revision: selected.service_revision ?? 0 }),
        }
      );
      setSelected({
        ...selected,
        status: res?.status || 'claimed',
        service_revision: res?.service_revision ?? (selected.service_revision ?? 0) + 1,
      });
      setActionNotice('Conversación reclamada.');
      await loadConversations();
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 409) {
        setActionNotice('La conversación fue modificada por otro agente. Estado actualizado.');
        await loadConversations();
      } else {
        setActionError(err.message || 'No se pudo reclamar la conversación.');
      }
    } finally {
      setClaiming(false);
    }
  }

  async function handleResolve(status: 'resolved' | 'ai_handling') {
    if (!selected) return;
    setActionError('');
    try {
      await apiFetch(`/conversations/${selected.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      setSelected({ ...selected, status });
      await loadConversations();
    } catch (err: any) {
      setActionError(err.message || 'No se pudo actualizar la conversación.');
    }
  }

  async function openTransferModal() {
    setTransferOpen(true);
    setTeamQuery('');
    setTeamLoading(true);
    try {
      const data = await apiFetch<any[]>('/team');
      setTeam(data || []);
    } catch (err: any) {
      setActionError(err.message || 'No se pudo cargar el equipo.');
    } finally {
      setTeamLoading(false);
    }
  }

  async function handleTransfer(targetUserId: string | null, autoRoute: boolean) {
    if (!selected) return;
    setTransferring(true);
    setActionError('');
    setActionNotice('');
    try {
      await apiFetch(`/conversations/${selected.id}/transfer`, {
        method: 'POST',
        body: JSON.stringify({
          target_user_id: targetUserId,
          auto_route: autoRoute,
          expected_revision: selected.service_revision ?? 0,
        }),
      });
      setTransferOpen(false);
      setActionNotice(autoRoute ? 'Conversación auto-asignada.' : 'Conversación transferida.');
      await loadConversations();
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 409) {
        setTransferOpen(false);
        setActionNotice('La conversación fue modificada por otro agente. Estado actualizado.');
        await loadConversations();
      } else {
        setActionError(err.message || 'No se pudo transferir la conversación.');
      }
    } finally {
      setTransferring(false);
    }
  }

  const availableAgents = useMemo(() => {
    const q = teamQuery.trim().toLowerCase();
    return team.filter((member) => {
      if (member.is_available === false) return false;
      if (!q) return true;
      return (
        (member.full_name || '').toLowerCase().includes(q) ||
        (member.email || '').toLowerCase().includes(q) ||
        (member.role || '').toLowerCase().includes(q)
      );
    });
  }, [team, teamQuery]);

  const statusTone = (s: string) => {
    if (s === 'claimed') return 'success';
    if (s === 'pending') return 'warning';
    if (s === 'ai_handling') return 'accent';
    return 'neutral';
  };

  const C360Content = contact360 ? (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">{contact360.name}</div>
          <div className="text-xs text-[var(--text-muted)] truncate">
            {contact360.phone_number || 'Sin teléfono'}
          </div>
          {contact360.email && (
            <div className="text-xs text-[var(--text-muted)] truncate">{contact360.email}</div>
          )}
        </div>
        <Link
          to="/app/contacts/$id"
          params={{ id: contact360.id }}
          className="text-xs font-medium text-[var(--accent)] hover:underline shrink-0"
        >
          Ver ficha 360°
        </Link>
      </div>
      <div className="flex flex-wrap gap-1">
        {(contact360.tags || []).map((t: string) => (
          <Badge key={t} tone="accent">
            {t}
          </Badge>
        ))}
        {contact360.is_blocked && <Badge tone="danger">Baja solicitada (STOP)</Badge>}
      </div>
      <div>
        <div className="text-xs font-semibold uppercase text-[var(--text-muted)] mb-2">
          Línea de tiempo
        </div>
        <div className="space-y-2">
          {(contact360.timeline || []).slice(0, 6).map((act: any) => (
            <div
              key={act.id}
              className="text-xs p-2 rounded-lg bg-[var(--surface)] border border-[var(--border)]"
            >
              <div className="font-medium">{act.summary}</div>
              <div className="text-[10px] text-[var(--text-muted)]">
                {new Date(act.performed_at).toLocaleString('es')}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  ) : (
    <div className="text-xs text-[var(--text-muted)]">
      Selecciona una conversación para ver Customer 360°
    </div>
  );

  return (
    <div className="h-[calc(100dvh-7.5rem)] md:h-dvh flex flex-col overflow-hidden min-w-0">
      <ReconnectingBanner status={sseStatus} onRetry={() => setSseKey((k) => k + 1)} />

      <div className="flex-1 flex overflow-hidden min-w-0">
        {/* Columna 1: Lista de conversaciones */}
        <div
          className={`${selected ? 'hidden md:flex' : 'flex'} w-full md:w-80 flex-col border-r border-[var(--border)] bg-[var(--bg)] min-w-0`}
        >
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
                  type="button"
                  onClick={() => {
                    setFilter(tab.k);
                    setSelected(null);
                    setConversations([]);
                  }}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium cursor-pointer shrink-0 ${
                    filter === tab.k
                      ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                      : 'bg-[var(--surface)] text-[var(--text-muted)]'
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
                  type="button"
                  onClick={() => void selectConversation(c)}
                  className={`w-full text-left p-3 hover:bg-[var(--surface)] transition-colors cursor-pointer ${
                    selected?.id === c.id ? 'bg-[var(--surface)]' : ''
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm truncate">{c.contact_name}</span>
                    <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                  </div>
                  <div className="text-xs text-[var(--text-muted)] truncate mt-1">
                    {c.last_message_preview || 'Sin mensajes aún'}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Columna 2: Hilo de chat */}
        <div
          className={`${selected ? 'flex' : 'hidden md:flex'} flex-1 flex-col bg-[var(--surface)] min-w-0`}
        >
          {selected ? (
            <>
              <div className="h-14 px-3 md:px-4 border-b border-[var(--border)] bg-[var(--bg)] flex items-center justify-between gap-2 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(null);
                      if (routeConvId) void navigate({ to: '/app/inbox' });
                    }}
                    className="md:hidden p-1.5 rounded-lg hover:bg-slate-100 cursor-pointer shrink-0"
                    aria-label="Volver a la lista"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <div className="min-w-0">
                    <div className="font-semibold text-sm truncate">{selected.contact_name}</div>
                    <div className="text-[11px] text-[var(--text-muted)] truncate">
                      {selected.contact_phone}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {selected.status !== 'claimed' && (
                    <Button size="sm" disabled={claiming} onClick={handleClaim}>
                      <UserCheck className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">
                        {claiming ? 'Reclamando...' : 'Reclamar'}
                      </span>
                    </Button>
                  )}
                  {selected.status === 'claimed' && (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void handleResolve('ai_handling')}
                      >
                        <Bot className="w-3.5 h-3.5" />{' '}
                        <span className="hidden sm:inline">Pasar a IA</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void handleResolve('resolved')}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />{' '}
                        <span className="hidden sm:inline">Resolver</span>
                      </Button>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void openTransferModal()}
                    title="Transferir conversación"
                  >
                    <ArrowRightLeft className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Transferir</span>
                  </Button>
                  <button
                    type="button"
                    onClick={() => setSheetOpen(true)}
                    className="lg:hidden p-2 rounded-lg border border-[var(--border)] cursor-pointer"
                    aria-label="Customer 360"
                  >
                    <Info className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {(actionError || actionNotice) && (
                <div
                  className={`px-3 py-2 text-xs border-b flex items-center justify-between gap-2 ${
                    actionError
                      ? 'bg-red-50 border-red-200 text-[var(--danger)]'
                      : 'bg-teal-50 border-teal-200 text-teal-900'
                  }`}
                >
                  <span>{actionError || actionNotice}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setActionError('');
                      setActionNotice('');
                    }}
                    className="p-0.5 cursor-pointer"
                    aria-label="Cerrar aviso"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.map((m) => {
                  const isNote = m.content_type === 'note';
                  const isOut = m.direction === 'outbound';

                  if (isNote) {
                    return (
                      <div key={m.id} className="flex justify-center">
                        <div className="max-w-[90%] md:max-w-[75%] rounded-2xl px-3.5 py-2.5 text-xs bg-amber-50 border border-amber-300 text-amber-950 shadow-xs space-y-1">
                          <div className="flex items-center gap-1.5 font-semibold text-amber-800">
                            <StickyNote className="w-3.5 h-3.5" />
                            <span>Nota interna</span>
                          </div>
                          <div className="whitespace-pre-wrap break-words text-sm">{m.body}</div>
                          {m.media_url && (
                            <MediaPreview url={m.media_url} contentType={m.content_type} />
                          )}
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={m.id} className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[82%] md:max-w-[70%] rounded-2xl px-3.5 py-2.5 text-sm shadow-xs space-y-1.5 ${
                          isOut
                            ? 'bg-[var(--accent)] text-[var(--on-accent)] rounded-br-sm'
                            : 'bg-[var(--bg)] border border-[var(--border)] text-[var(--text)] rounded-bl-sm'
                        }`}
                      >
                        {m.sender_type === 'ai' && (
                          <div className="flex items-center gap-1 text-[10px] opacity-80">
                            <Sparkles className="w-3 h-3" /> Asistente IA
                          </div>
                        )}
                        {m.media_url && (
                          <MediaPreview url={m.media_url} contentType={m.content_type} inverse={isOut} />
                        )}
                        <div className="whitespace-pre-wrap break-words">{m.body}</div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* BlockedUntilClaimed banner */}
              {isUnclaimed && !isNoteMode && (
                <div
                  role="status"
                  className="px-3 py-2.5 bg-amber-50 border-t border-amber-200 text-amber-950 text-xs flex flex-wrap items-center justify-between gap-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Lock className="w-4 h-4 text-[var(--warning)] shrink-0" />
                    <span>
                      Conversación sin reclamar. Reclámala en la barra superior para responder por WhatsApp o cambia a{' '}
                      <strong>Nota interna</strong>.
                    </span>
                  </div>
                </div>
              )}

              {/* 24hWindowExpired banner */}
              {!isUnclaimed && windowClosed && !isNoteMode && !selected.is_blocked && (
                <div
                  role="status"
                  className="px-3 py-2.5 bg-amber-50 border-t border-amber-200 text-amber-950 text-xs flex flex-wrap items-center justify-between gap-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Clock className="w-4 h-4 text-[var(--warning)] shrink-0" />
                    <span>
                      Ventana de 24 h de WhatsApp cerrada. Selecciona una plantilla aprobada o escribe
                      una <strong>Nota interna</strong>.
                    </span>
                  </div>
                  {templateSelectedInClosedWindow && (
                    <Badge tone="success">Plantilla lista para enviar</Badge>
                  )}
                </div>
              )}

              {/* Quick-reply chips bar */}
              {templates.length > 0 && (
                <div className="px-3 py-1.5 bg-[var(--bg)] border-t border-[var(--border)] flex gap-1.5 overflow-x-auto">
                  {templates.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => applyTemplate(t)}
                      className="shrink-0 text-[11px] px-2.5 py-1 rounded-full bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--accent)] cursor-pointer"
                    >
                      /{t.shortcut.replace(/^\/+/, '')}
                    </button>
                  ))}
                </div>
              )}

              {/* Composer area */}
              <div className="relative bg-[var(--bg)] border-t border-[var(--border)] p-3 space-y-2">
                {/* / quick-reply autocomplete dropdown */}
                {slashMatches.length > 0 && (
                  <div
                    role="listbox"
                    aria-label="Sugerencias de respuestas rápidas"
                    className="absolute left-3 right-3 bottom-full mb-1 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] shadow-lg overflow-hidden z-20"
                  >
                    {slashMatches.map((t, idx) => (
                      <button
                        key={t.id}
                        type="button"
                        role="option"
                        aria-selected={idx === slashIndex}
                        onClick={() => applyTemplate(t)}
                        className={`w-full text-left px-3 py-2 text-xs flex items-start justify-between gap-3 cursor-pointer ${
                          idx === slashIndex
                            ? 'bg-teal-50 text-[var(--text)]'
                            : 'hover:bg-[var(--surface)] text-[var(--text)]'
                        }`}
                      >
                        <div className="min-w-0">
                          <span className="font-mono font-semibold text-[var(--accent)]">
                            /{t.shortcut.replace(/^\/+/, '')}
                          </span>{' '}
                          <span className="font-medium">{t.title}</span>
                          <div className="text-[11px] text-[var(--text-muted)] truncate">{t.body}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {/* Mode toggle + pending attachment */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--surface)] p-0.5">
                    <button
                      type="button"
                      onClick={() => setComposerMode('whatsapp')}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer transition-colors ${
                        !isNoteMode
                          ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                          : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                      }`}
                    >
                      WhatsApp
                    </button>
                    <button
                      type="button"
                      onClick={() => setComposerMode('note')}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer transition-colors flex items-center gap-1 ${
                        isNoteMode
                          ? 'bg-amber-600 text-white'
                          : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                      }`}
                    >
                      <StickyNote className="w-3 h-3" /> Nota interna
                    </button>
                  </div>

                  {attachment && (
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--surface)] border border-[var(--border)] text-xs max-w-full">
                      <Paperclip className="w-3 h-3 text-[var(--accent)] shrink-0" />
                      <span className="truncate">{attachment.filename}</span>
                      <button
                        type="button"
                        onClick={() => setAttachment(null)}
                        aria-label="Quitar archivo adjunto"
                        className="text-[var(--text-muted)] hover:text-[var(--danger)] cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>

                <form onSubmit={handleSend} className="flex items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    onChange={handleFileSelect}
                    aria-label="Adjuntar archivo"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    disabled={uploading || whatsappBlocked}
                    onClick={() => fileInputRef.current?.click()}
                    title="Adjuntar archivo"
                    aria-label="Adjuntar archivo"
                  >
                    <Paperclip className="w-4 h-4" />
                  </Button>
                  <Input
                    value={body}
                    onChange={(e) => {
                      setBody(e.target.value);
                      setSlashDismissed(false);
                      if (windowClosed && !e.target.value) {
                        setTemplateSelectedInClosedWindow(false);
                      }
                    }}
                    onKeyDown={handleComposerKeyDown}
                    placeholder={
                      isNoteMode
                        ? 'Escribe una nota interna para el equipo...'
                        : selected.is_blocked
                          ? 'Contacto dado de baja (STOP)'
                          : windowClosed && !templateSelectedInClosedWindow
                            ? 'Ventana de 24 h cerrada: escribe / para elegir una plantilla...'
                            : 'Escribe un mensaje de WhatsApp...'
                    }
                    disabled={freeTextDisabled}
                    className={isNoteMode ? 'border-amber-400 bg-amber-50/40' : ''}
                  />
                  <Button
                    type="submit"
                    aria-label="Enviar mensaje"
                    disabled={
                      sending ||
                      freeTextDisabled ||
                      sendBlockedByWindow ||
                      (!body.trim() && !attachment)
                    }
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                </form>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)]">
              Selecciona una conversación para comenzar
            </div>
          )}
        </div>

        {/* Columna 3: Customer 360° escritorio */}
        <aside className="hidden lg:block w-80 border-l border-[var(--border)] bg-[var(--bg)] p-4 overflow-y-auto">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">
            Customer 360°
          </h2>
          {C360Content}
        </aside>
      </div>

      {/* Sheet Customer 360° móvil */}
      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Customer 360°">
        {C360Content}
      </Sheet>

      {/* Sheet Transferir conversación */}
      <Sheet
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        title="Transferir conversación"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2 p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)]">
            <div className="min-w-0">
              <div className="text-sm font-semibold">Auto-asignación (Round-robin)</div>
              <div className="text-xs text-[var(--text-muted)]">
                Asigna automáticamente al siguiente agente disponible.
              </div>
            </div>
            <Button
              size="sm"
              disabled={transferring}
              onClick={() => void handleTransfer(null, true)}
            >
              Auto-asignar
            </Button>
          </div>

          <div className="space-y-2">
            <Input
              placeholder="Buscar agente disponible..."
              value={teamQuery}
              onChange={(e) => setTeamQuery(e.target.value)}
            />
            {teamLoading ? (
              <div className="text-xs text-[var(--text-muted)] py-4 text-center">
                Cargando equipo...
              </div>
            ) : availableAgents.length === 0 ? (
              <div className="text-xs text-[var(--text-muted)] py-4 text-center flex items-center justify-center gap-1.5">
                <AlertTriangle className="w-4 h-4" /> No hay agentes disponibles.
              </div>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {availableAgents.map((agent) => (
                  <div
                    key={agent.id}
                    className="p-3 rounded-xl border border-[var(--border)] flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{agent.full_name}</div>
                      <div className="text-xs text-[var(--text-muted)] truncate">
                        {agent.email} · {agent.role}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={transferring || selected?.assigned_to === agent.id}
                      onClick={() => void handleTransfer(agent.id, false)}
                    >
                      {selected?.assigned_to === agent.id ? 'Asignado' : 'Transferir'}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Sheet>
    </div>
  );
}

function MediaPreview({
  url,
  contentType,
  inverse = false,
}: {
  url: string;
  contentType?: string;
  inverse?: boolean;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [blobType, setBlobType] = useState<string>('');
  const [failed, setFailed] = useState(false);

  const needsAuthFetch = url.startsWith('/api/') && isImageMedia(url, contentType);

  useEffect(() => {
    if (!needsAuthFetch) {
      setObjectUrl(url);
      return;
    }
    const controller = new AbortController();
    let createdUrl: string | null = null;
    setFailed(false);

    async function loadMedia() {
      try {
        const headers = new Headers();
        const token = getToken();
        if (token) headers.set('Authorization', `Bearer ${token}`);
        const support = getSupportSession();
        if (support?.id) headers.set('X-Support-Session-ID', support.id);

        const res = await fetch(url, {
          headers,
          credentials: 'include',
          signal: controller.signal,
        });
        if (!res.ok) {
          setFailed(true);
          return;
        }
        const blob = await res.blob();
        createdUrl = URL.createObjectURL(blob);
        setBlobType(blob.type || '');
        setObjectUrl(createdUrl);
      } catch {
        if (!controller.signal.aborted) {
          setFailed(true);
        }
      }
    }

    void loadMedia();
    return () => {
      controller.abort();
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [url, needsAuthFetch]);

  if (failed) {
    return (
      <div className="text-xs opacity-80 inline-flex items-center gap-1.5">
        <FileText className="w-3.5 h-3.5 shrink-0" />
        <span>No se pudo cargar el archivo adjunto</span>
      </div>
    );
  }

  if (!objectUrl) {
    return <div className="text-xs opacity-75">Cargando adjunto...</div>;
  }

  const effectiveType = blobType || contentType || '';
  const isImage = isImageMedia(url, effectiveType) || contentType === 'image';

  if (isImage) {
    return (
      <div className="space-y-1">
        <a href={objectUrl} target="_blank" rel="noreferrer" className="block">
          <img
            src={objectUrl}
            alt="Archivo adjunto"
            className="max-h-56 rounded-lg object-cover border border-[var(--border)]"
          />
        </a>
        <a
          href={objectUrl}
          download
          className={`inline-flex items-center gap-1 text-[11px] underline ${
            inverse ? 'text-[var(--on-accent)]' : 'text-[var(--accent)]'
          }`}
        >
          <FileText className="w-3 h-3 shrink-0" />
          <span>Descargar imagen</span>
        </a>
      </div>
    );
  }

  return (
    <a
      href={objectUrl}
      download
      className={`inline-flex items-center gap-1.5 text-xs underline ${
        inverse ? 'text-[var(--on-accent)]' : 'text-[var(--accent)]'
      }`}
    >
      <FileText className="w-3.5 h-3.5 shrink-0" />
      <span>Descargar archivo adjunto</span>
    </a>
  );
}
