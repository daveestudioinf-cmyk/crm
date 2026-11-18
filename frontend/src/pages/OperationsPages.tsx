import React, { useEffect, useState } from 'react';
import { type ChannelSession, apiFetch, subscribeSSE } from '../lib/api';
import { Badge, Button, Card, Input } from '../components/ui/primitives';

export function ChannelsPage() {
  const [channels, setChannels] = useState<ChannelSession[]>([]);
  const [sessionName, setSessionName] = useState('');
  const [provider, setProvider] = useState('evolution_go');
  const [qr, setQr] = useState<{ id?: string; session?: string; base64?: string; payload?: string } | null>(null);
  const [warmupDrafts, setWarmupDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    const list = await apiFetch<ChannelSession[]>('/channels');
    setChannels(list || []);
    const drafts: Record<string, string> = {};
    for (const ch of list || []) {
      drafts[ch.id] = String(ch.warmup_daily_limit ?? 100);
    }
    setWarmupDrafts(drafts);
  };

  useEffect(() => {
    load();
    const unsub = subscribeSSE((evType) => {
      if (evType === 'channel.updated' || evType === 'channel.deleted') {
        load();
      }
    });
    return unsub;
  }, []);

  async function openQR(chId: string, sname: string) {
    const q = await apiFetch(`/channels/${chId}/qr`);
    setQr({ id: chId, session: sname, base64: q.qr_base64, payload: q.qr_payload });
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    const res = await apiFetch('/channels', {
      method: 'POST',
      body: JSON.stringify({ session_name: sessionName, provider }),
    });
    setSessionName('');
    await load();
    await openQR(res.id, res.session_name);
  }

  async function saveWarmup(chId: string) {
    const limit = parseInt(warmupDrafts[chId] || '100', 10);
    await apiFetch(`/channels/${chId}`, {
      method: 'PATCH',
      body: JSON.stringify({ warmup_daily_limit: limit }),
    });
    setNotice('Límite diario de calentamiento actualizado.');
    load();
  }

  function healthDotClass(status: string) {
    switch (status) {
      case 'WORKING':
        return 'bg-emerald-500';
      case 'SCAN_QR_CODE':
      case 'STARTING':
        return 'bg-amber-500';
      case 'FAILED':
        return 'bg-red-500';
      default:
        return 'bg-slate-400';
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-4xl min-w-0">
      <div>
        <h1 className="text-xl font-bold">Canales de WhatsApp (Evolution Go / WAHA)</h1>
        <p className="text-xs text-[var(--text-muted)]">
          Conexión multi-tenant por código QR, control anti-ban diario y estado en tiempo real
        </p>
      </div>

      {notice && (
        <div className="px-3 py-2 rounded-xl text-xs bg-emerald-50 border border-emerald-200 text-emerald-800">
          {notice}
        </div>
      )}

      <form onSubmit={create} className="flex flex-wrap gap-2 max-w-xl">
        <Input
          required
          className="flex-1 min-w-[180px]"
          placeholder="Nombre de sesión (ej. ventas-principal)"
          value={sessionName}
          onChange={(e) => setSessionName(e.target.value)}
        />
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="h-10 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
        >
          <option value="evolution_go">Evolution Go (Multi-tenant)</option>
          <option value="waha">WAHA</option>
        </select>
        <Button type="submit">Conectar Número</Button>
      </form>

      {qr && (qr.base64 || qr.payload) && (
        <Card className="p-4 bg-teal-50 border-teal-200 text-xs space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold">QR listo ({qr.session}) — Escanea con WhatsApp:</div>
            <div className="flex gap-2">
              {qr.id && (
                <Button size="sm" variant="secondary" onClick={() => openQR(qr.id!, qr.session || '')}>
                  Refrescar QR
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => setQr(null)}>
                Cerrar
              </Button>
            </div>
          </div>
          {qr.base64 && (
            <img
              src={qr.base64.startsWith('data:') ? qr.base64 : `data:image/png;base64,${qr.base64}`}
              alt="QR WhatsApp"
              className="w-48 h-48 rounded-lg border bg-white p-2"
            />
          )}
          {qr.payload && <code className="block break-all text-[11px]">{qr.payload}</code>}
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {channels.map((ch) => (
          <Card key={ch.id} className="p-4 space-y-3 min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-semibold text-sm flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${healthDotClass(ch.status)}`} aria-label={`Salud ${ch.status}`} />
                  <span className="truncate">{ch.session_name}</span>
                </div>
                <div className="text-xs text-[var(--text-muted)]">
                  {ch.provider} • {ch.engine} {ch.phone_number ? `• ${ch.phone_number}` : ''}
                </div>
              </div>
              <Badge tone={ch.status === 'WORKING' ? 'success' : ch.status === 'FAILED' ? 'danger' : 'warning'}>
                {ch.status}
              </Badge>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs text-[var(--text-muted)]">Límite diario:</label>
              <Input
                type="number"
                min="1"
                max="5000"
                className="w-24 h-8 text-xs"
                value={warmupDrafts[ch.id] ?? String(ch.warmup_daily_limit)}
                onChange={(e) => setWarmupDrafts((prev) => ({ ...prev, [ch.id]: e.target.value }))}
              />
              <Button size="sm" variant="secondary" onClick={() => saveWarmup(ch.id)}>
                Guardar límite
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => openQR(ch.id, ch.session_name)}>
                Ver QR
              </Button>
              {ch.status !== 'WORKING' && (
                <Button size="sm" variant="secondary" onClick={() => apiFetch(`/channels/${ch.id}/reconnect`, { method: 'POST' }).then(load)}>
                  Reconectar
                </Button>
              )}
              {ch.status === 'WORKING' && (
                <Button size="sm" variant="secondary" onClick={() => apiFetch(`/channels/${ch.id}/disconnect`, { method: 'POST' }).then(load)}>
                  Desconectar
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => apiFetch(`/channels/${ch.id}`, { method: 'DELETE' }).then(load)}>
                Eliminar
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function WebhooksPage() {
  const [sources, setSources] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [name, setName] = useState('');

  const load = () => Promise.all([apiFetch('/webhooks/sources').then(setSources), apiFetch('/automations').then(setRules)]);
  useEffect(() => { load(); }, []);

  async function addSource(e: React.FormEvent) {
    e.preventDefault();
    await apiFetch('/webhooks/sources', { method: 'POST', body: JSON.stringify({ name }) });
    setName('');
    load();
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-4xl">
      <h1 className="text-xl font-bold">Webhooks y Automatizaciones WHEN/IF/THEN</h1>
      <form onSubmit={addSource} className="flex gap-2 max-w-md">
        <Input required placeholder="Nombre de fuente (ej. Formulario Web)" value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit">Crear Fuente</Button>
      </form>
      <div className="space-y-2">
        {sources.map((s) => (
          <Card key={s.id} className="p-3.5 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-semibold text-sm">{s.name}</div>
              <code className="text-xs text-[var(--text-muted)]">POST /api/v1/webhooks/in/{s.token}</code>
            </div>
            <Badge tone="success">Activo</Badge>
          </Card>
        ))}
      </div>
      <Card className="p-4 space-y-2">
        <div className="font-semibold text-sm">Reglas de Automatización ({rules.length})</div>
        {rules.length === 0 && <div className="text-xs text-[var(--text-muted)]">Aún no hay reglas configuradas.</div>}
      </Card>
    </div>
  );
}

export function TasksPage() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [title, setTitle] = useState('');
  const load = () => apiFetch('/tasks').then(setTasks);
  useEffect(() => { load(); }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    await apiFetch('/tasks', { method: 'POST', body: JSON.stringify({ title }) });
    setTitle('');
    load();
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-3xl">
      <h1 className="text-xl font-bold">Tareas</h1>
      <form onSubmit={add} className="flex gap-2">
        <Input required placeholder="Hacer seguimiento con el cliente..." value={title} onChange={(e) => setTitle(e.target.value)} />
        <Button type="submit">Agregar Tarea</Button>
      </form>
      <div className="space-y-2">
        {tasks.map((t) => (
          <Card key={t.id} className="p-3 flex items-center justify-between">
            <span className={`text-sm ${t.status === 'done' ? 'line-through text-[var(--text-muted)]' : 'font-medium'}`}>{t.title}</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => apiFetch(`/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status: t.status === 'done' ? 'pending' : 'done' }) }).then(load)}
            >
              {t.status === 'done' ? 'Reabrir' : 'Completar'}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function RadarPage() {
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => { apiFetch('/radar').then(setItems); }, []);
  return (
    <div className="p-4 md:p-6 space-y-4 max-w-4xl">
      <h1 className="text-xl font-bold">Radar (Conversaciones enfriándose)</h1>
      <div className="space-y-2">
        {items.length === 0 ? (
          <Card className="p-6 text-center text-xs text-[var(--text-muted)]">Todas las conversaciones están al día.</Card>
        ) : (
          items.map((i) => (
            <Card key={i.id} className="p-3.5 flex items-center justify-between">
              <div>
                <div className="font-semibold text-sm">{i.contact_name}</div>
                <div className="text-xs text-[var(--text-muted)]">{i.last_message_preview || 'Esperando respuesta'}</div>
              </div>
              <Badge tone="warning">{i.status}</Badge>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

export function MetricsPage() {
  const [m, setM] = useState<any>(null);
  useEffect(() => { apiFetch('/metrics').then(setM); }, []);
  return (
    <div className="p-4 md:p-6 space-y-4 max-w-4xl">
      <h1 className="text-xl font-bold">Analítica y Rendimiento</h1>
      {m && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            ['Contactos', m.contacts_total],
            ['Leads Abiertos', m.leads_open],
            ['Ganados', m.leads_won],
            ['Chats Activos', m.conversations_open],
            ['Mensajes Hoy', m.messages_today],
          ].map(([k, v]) => (
            <Card key={String(k)} className="p-4">
              <div className="text-xs text-[var(--text-muted)]">{k}</div>
              <div className="text-2xl font-bold mt-1">{v}</div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export function LGPDPage() {
  const [reqs, setReqs] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const load = () => Promise.all([apiFetch('/lgpd/requests').then(setReqs), apiFetch('/audit').then(setAudit)]);
  useEffect(() => { load(); }, []);

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-4xl">
      <h1 className="text-xl font-bold">Cumplimiento LGPD y Auditoría Inmutable</h1>
      <Card className="p-4 space-y-2">
        <div className="font-semibold text-sm">Solicitudes LGPD de Exportación / Borrado ({reqs.length})</div>
        {reqs.map((r) => (
          <div key={r.id} className="flex items-center justify-between text-xs py-1.5 border-b border-[var(--border)]">
            <span>{r.contact_name} — {r.request_type}</span>
            <div className="flex items-center gap-2">
              <Badge tone={r.status === 'completed' ? 'success' : 'warning'}>{r.status}</Badge>
              {r.status === 'pending' && (
                <Button size="sm" onClick={() => apiFetch(`/lgpd/requests/${r.id}/execute`, { method: 'POST' }).then(load)}>Ejecutar</Button>
              )}
            </div>
          </div>
        ))}
      </Card>
      <Card className="p-4 space-y-2">
        <div className="font-semibold text-sm">Registro Reciente de Auditoría</div>
        {audit.slice(0, 15).map((a) => (
          <div key={a.id} className="text-xs flex justify-between py-1 border-b border-[var(--border)] last:border-0">
            <span className="font-mono">{a.action} ({a.resource_type})</span>
            <span className="text-[var(--text-muted)]">{new Date(a.created_at).toLocaleString()}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

export function SettingsPage() {
  const [tokens, setTokens] = useState<any[]>([]);
  const [team, setTeam] = useState<any[]>([]);
  const [tokName, setTokName] = useState('');
  const [newTok, setNewTok] = useState('');
  const load = () => Promise.all([apiFetch('/api-tokens').then(setTokens), apiFetch('/team').then(setTeam)]);
  useEffect(() => { load(); }, []);

  async function createToken(e: React.FormEvent) {
    e.preventDefault();
    const res = await apiFetch('/api-tokens', { method: 'POST', body: JSON.stringify({ name: tokName }) });
    setNewTok(res.token);
    setTokName('');
    load();
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-4xl">
      <h1 className="text-xl font-bold">Configuración, Equipo y Tokens MCP</h1>
      <Card className="p-4 space-y-3">
        <div className="font-semibold text-sm">Tokens API para MCP Nativo en Go / REST</div>
        <form onSubmit={createToken} className="flex gap-2 max-w-md">
          <Input required placeholder="Nombre del token (ej. Claude MCP)" value={tokName} onChange={(e) => setTokName(e.target.value)} />
          <Button type="submit">Generar</Button>
        </form>
        {newTok && (
          <div className="p-3 rounded-lg bg-teal-50 border border-teal-200 text-xs">
            Cópialo ahora (solo se muestra una vez): <code className="font-mono font-bold break-all">{newTok}</code>
          </div>
        )}
        <div className="space-y-1.5">
          {tokens.map((t) => (
            <div key={t.id} className="flex items-center justify-between text-xs py-1.5 border-b border-[var(--border)]">
              <span className="font-medium">{t.name}</span>
              <Button size="sm" variant="danger" onClick={() => apiFetch(`/api-tokens/${t.id}`, { method: 'DELETE' }).then(load)}>Revocar</Button>
            </div>
          ))}
        </div>
      </Card>
      <Card className="p-4 space-y-2">
        <div className="font-semibold text-sm">Miembros del Equipo ({team.length})</div>
        {team.map((m) => (
          <div key={m.id} className="flex items-center justify-between text-xs py-1.5 border-b border-[var(--border)] last:border-0">
            <span>{m.full_name} ({m.email})</span>
            <Badge tone="accent">{m.role}</Badge>
          </div>
        ))}
      </Card>
    </div>
  );
}
