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

export { WebhooksPage } from './WebhooksPage';
export { RadarPage } from './RadarPage';
export { MetricsPage } from './MetricsPage';
export { ActivitiesPage } from './ActivitiesPage';
export { AuditPage } from './AuditPage';

import { Sheet } from '../components/ui/primitives';

export function LGPDPage() {
  const [reqs, setReqs] = useState<any[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [contactId, setContactId] = useState('');
  const [requestType, setRequestType] = useState<'export' | 'redact'>('export');
  const [reason, setReason] = useState('');
  const [confirmRedactReq, setConfirmRedactReq] = useState<any | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    try {
      const [r, a, c] = await Promise.all([
        apiFetch<any[]>('/lgpd/requests'),
        apiFetch<any[]>('/audit'),
        apiFetch<any[]>('/contacts').catch(() => []),
      ]);
      setReqs(r || []);
      setAudit(a || []);
      setContacts(c || []);
    } catch (err: any) {
      setError(err.message || 'Error al cargar datos LGPD.');
    }
  };

  useEffect(() => {
    load();
  }, []);

  async function createRequest(e: React.FormEvent) {
    e.preventDefault();
    if (!contactId) return;
    setError('');
    setNotice('');
    try {
      await apiFetch('/lgpd/requests', {
        method: 'POST',
        body: JSON.stringify({
          contact_id: contactId,
          request_type: requestType,
          reason: reason.trim() || undefined,
        }),
      });
      setReason('');
      setNotice('Solicitud LGPD creada correctamente.');
      await load();
    } catch (err: any) {
      setError(err.message || 'No se pudo crear la solicitud.');
    }
  }

  async function executeExport(r: any) {
    setError('');
    setNotice('');
    try {
      const res = await apiFetch<any>(`/lgpd/requests/${r.id}/execute`, { method: 'POST' });
      const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lgpd-export-${r.contact_id || r.id}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice('Exportación LGPD ejecutada y descargada en formato JSON.');
      await load();
    } catch (err: any) {
      setError(err.message || 'No se pudo ejecutar la exportación.');
    }
  }

  async function executeRedact(r: any) {
    setError('');
    setNotice('');
    try {
      await apiFetch(`/lgpd/requests/${r.id}/execute`, { method: 'POST' });
      setConfirmRedactReq(null);
      setNotice('Anonimización en cascada completada.');
      await load();
    } catch (err: any) {
      setError(err.message || 'No se pudo ejecutar la anonimización.');
    }
  }

  async function rejectRequest(r: any) {
    setError('');
    setNotice('');
    try {
      await apiFetch(`/lgpd/requests/${r.id}/reject`, { method: 'POST' });
      setNotice('Solicitud rechazada.');
      await load();
    } catch (err: any) {
      setError(err.message || 'No se pudo rechazar la solicitud.');
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-4xl min-w-0">
      <div>
        <h1 className="text-xl font-bold">Cumplimiento LGPD y Auditoría Inmutable</h1>
        <p className="text-xs text-[var(--text-muted)]">
          Gestión de solicitudes de exportación JSON y anonimización en cascada
        </p>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-[var(--danger)]">
          {error}
        </div>
      )}
      {notice && (
        <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900">
          {notice}
        </div>
      )}

      {/* Crear solicitud LGPD */}
      <Card className="p-4 space-y-3">
        <div className="font-semibold text-sm">Nueva Solicitud LGPD</div>
        <form onSubmit={createRequest} className="flex flex-wrap gap-2">
          <select
            required
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
            className="h-10 flex-1 min-w-[180px] rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
          >
            <option value="">Selecciona un contacto...</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || c.full_name || c.phone || c.email || c.id}
              </option>
            ))}
          </select>
          <select
            value={requestType}
            onChange={(e) => setRequestType(e.target.value as 'export' | 'redact')}
            className="h-10 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
          >
            <option value="export">Exportar datos (JSON)</option>
            <option value="redact">Anonimizar en cascada</option>
          </select>
          <Input
            className="flex-1 min-w-[160px]"
            placeholder="Motivo (opcional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button type="submit">Crear solicitud</Button>
        </form>
      </Card>

      {/* Cola de solicitudes LGPD */}
      <Card className="p-4 space-y-3">
        <div className="font-semibold text-sm">
          Solicitudes LGPD de Exportación / Anonimización ({reqs.length})
        </div>
        {reqs.length === 0 ? (
          <div className="text-xs text-[var(--text-muted)] py-2">No hay solicitudes registradas.</div>
        ) : (
          <div className="space-y-2">
            {reqs.map((r) => {
              const isRedact = r.request_type === 'redact';
              return (
                <div
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-xs py-2.5 border-b border-[var(--border)] last:border-0"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">
                      {r.contact_name || r.contact_id} —{' '}
                      <span className="font-mono">{r.request_type}</span>
                    </div>
                    {r.reason && (
                      <div className="text-[11px] text-[var(--text-muted)] truncate">{r.reason}</div>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        r.status === 'completed'
                          ? 'success'
                          : r.status === 'rejected'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {r.status}
                    </Badge>
                    {r.status === 'pending' && (
                      <>
                        {isRedact ? (
                          <Button size="sm" variant="danger" onClick={() => setConfirmRedactReq(r)}>
                            Anonimizar
                          </Button>
                        ) : (
                          <Button size="sm" onClick={() => executeExport(r)}>
                            Exportar JSON
                          </Button>
                        )}
                        <Button size="sm" variant="secondary" onClick={() => rejectRequest(r)}>
                          Rechazar
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="p-4 space-y-2">
        <div className="font-semibold text-sm">Registro Reciente de Auditoría</div>
        {audit.slice(0, 15).map((a) => (
          <div key={a.id} className="text-xs flex flex-wrap justify-between gap-2 py-1 border-b border-[var(--border)] last:border-0">
            <span className="font-mono">{a.action} ({a.resource_type})</span>
            <span className="text-[var(--text-muted)]">{new Date(a.created_at).toLocaleString('es')}</span>
          </div>
        ))}
      </Card>

      <Sheet
        open={Boolean(confirmRedactReq)}
        onClose={() => setConfirmRedactReq(null)}
        title="Confirmar anonimización en cascada"
      >
        <div className="space-y-4">
          <p className="text-xs text-[var(--text-muted)]">
            Esta acción es irreversible. Se anonimizarán los datos personales del contacto{' '}
            <strong>{confirmRedactReq?.contact_name || confirmRedactReq?.contact_id}</strong> en conversaciones, leads y registros asociados.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmRedactReq(null)}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={() => executeRedact(confirmRedactReq)}>
              Confirmar anonimización
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
