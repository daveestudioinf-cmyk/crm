import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Bot, Check, CheckCircle2, QrCode, RefreshCw, Sparkles, UserPlus, Users } from 'lucide-react';
import { type AIAgent, type ChannelSession, apiFetch } from '../lib/api';
import { useAuth } from '../App';
import { Badge, Button, Card, Input } from '../components/ui/primitives';

interface NichePreset {
  id: string;
  label: string;
  description: string;
  deal: string;
  deals: string;
  stage: string;
}

const NICHE_PRESETS: NichePreset[] = [
  {
    id: 'clinica',
    label: 'Clínica / Salud',
    description: 'Pacientes, citas médicas y seguimiento de tratamientos',
    deal: 'Paciente',
    deals: 'Pacientes',
    stage: 'Estado',
  },
  {
    id: 'inmobiliaria',
    label: 'Inmobiliaria',
    description: 'Interesados, visitas a propiedades y cierres',
    deal: 'Oportunidad',
    deals: 'Oportunidades',
    stage: 'Etapa',
  },
  {
    id: 'ecommerce',
    label: 'E-commerce',
    description: 'Pedidos, consultas de catálogo y post-venta',
    deal: 'Pedido',
    deals: 'Pedidos',
    stage: 'Estado',
  },
  {
    id: 'servicios',
    label: 'Servicios B2B/B2C',
    description: 'Leads, propuestas comerciales y proyectos',
    deal: 'Lead',
    deals: 'Leads',
    stage: 'Etapa',
  },
];

const STEPS = [
  { num: 1, title: 'Vocabulario', icon: Sparkles },
  { num: 2, title: 'WhatsApp', icon: QrCode },
  { num: 3, title: 'Asistente IA', icon: Bot },
  { num: 4, title: 'Equipo', icon: Users },
];

export function OnboardingPage() {
  const params = useParams({ strict: false }) as { step?: string };
  const nav = useNavigate();
  const { user, refreshUser } = useAuth();

  const parsedStep = params.step ? Math.min(4, Math.max(1, parseInt(params.step, 10) || 1)) : 1;
  const [step, setStep] = useState<number>(parsedStep);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Step 1: Niche & Vocabulary
  const [niche, setNiche] = useState('servicios');
  const [dealSingular, setDealSingular] = useState('Lead');
  const [dealPlural, setDealPlural] = useState('Leads');
  const [stageLabel, setStageLabel] = useState('Etapa');

  // Step 2: WhatsApp Channel & QR
  const [channels, setChannels] = useState<ChannelSession[]>([]);
  const [sessionName, setSessionName] = useState('ventas-principal');
  const [activeChannelId, setActiveChannelId] = useState<string>('');
  const [qrData, setQrData] = useState<{ base64?: string; payload?: string } | null>(null);
  const [waStatus, setWaStatus] = useState<string>('');

  // Step 3: AI Agent
  const [agent, setAgent] = useState<AIAgent | null>(null);
  const [agentName, setAgentName] = useState('Asistente de Ventas');
  const [agentPrompt, setAgentPrompt] = useState(
    'Eres un asistente útil de ventas y soporte por WhatsApp. Sé conciso, amable y escala a un humano si tienes dudas.'
  );
  const [providersCount, setProvidersCount] = useState<number | null>(null);

  // Step 4: Quick Team Invite
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'agent' | 'manager' | 'viewer' | 'admin'>('agent');
  const [sentInvites, setSentInvites] = useState<Array<{ email: string; role: string; token?: string }>>([]);

  useEffect(() => {
    if (params.step) {
      const s = Math.min(4, Math.max(1, parseInt(params.step, 10) || 1));
      setStep(s);
    }
  }, [params.step]);

  // Load initial org/channels/ai data depending on step
  useEffect(() => {
    if (step === 2) {
      apiFetch<ChannelSession[]>('/channels')
        .then((list) => {
          setChannels(list || []);
          if (list && list.length > 0 && !activeChannelId) {
            setActiveChannelId(list[0].id);
            setWaStatus(list[0].status);
          }
        })
        .catch(() => {});
    } else if (step === 3) {
      apiFetch<AIAgent[]>('/ai/agents')
        .then((list) => {
          if (list && list.length > 0) {
            setAgent(list[0]);
            setAgentName(list[0].name);
            setAgentPrompt(list[0].system_prompt);
          }
        })
        .catch(() => {});
      apiFetch<any[]>('/ai/providers')
        .then((p) => setProvidersCount((p || []).length))
        .catch(() => setProvidersCount(null));
    }
  }, [step, activeChannelId]);

  // Poll QR when on step 2 with an active channel not yet WORKING
  useEffect(() => {
    if (step !== 2 || !activeChannelId || waStatus === 'WORKING') return;
    let active = true;
    async function pollQR() {
      try {
        const q = await apiFetch<{ qr_base64?: string; qr_payload?: string; status?: string }>(
          `/channels/${activeChannelId}/qr`
        );
        if (!active) return;
        if (q.qr_base64 || q.qr_payload) {
          setQrData({ base64: q.qr_base64, payload: q.qr_payload });
        }
        if (q.status) setWaStatus(q.status);
      } catch {
        // Silent poll fallback
      }
    }
    pollQR();
    const timer = window.setInterval(pollQR, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [step, activeChannelId, waStatus]);

  function goToStep(next: number) {
    setError('');
    setStep(next);
  }

  function applyPreset(preset: NichePreset) {
    setNiche(preset.id);
    setDealSingular(preset.deal);
    setDealPlural(preset.deals);
    setStageLabel(preset.stage);
  }

  async function saveStep1AndNext() {
    setError('');
    setSaving(true);
    try {
      await apiFetch('/organization', {
        method: 'PATCH',
        body: JSON.stringify({
          settings: {
            niche,
            pipeline_vocabulary: {
              deal: dealSingular.trim() || 'Lead',
              deals: dealPlural.trim() || 'Leads',
              stage: stageLabel.trim() || 'Etapa',
            },
          },
        }),
      });
      goToStep(2);
    } catch (err: any) {
      setError(err.message || 'No se pudo guardar el vocabulario.');
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateChannel(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const ch = await apiFetch<ChannelSession>('/channels', {
        method: 'POST',
        body: JSON.stringify({ session_name: sessionName.trim(), provider: 'evolution_go' }),
      });
      setChannels((prev) => [ch, ...prev]);
      setActiveChannelId(ch.id);
      setWaStatus(ch.status);
      const q = await apiFetch<{ qr_base64?: string; qr_payload?: string }>(`/channels/${ch.id}/qr`).catch(() => null);
      if (q) setQrData({ base64: q.qr_base64, payload: q.qr_payload });
    } catch (err: any) {
      setError(err.message || 'No se pudo crear el canal de WhatsApp.');
    } finally {
      setSaving(false);
    }
  }

  async function refreshQR() {
    if (!activeChannelId) return;
    setError('');
    try {
      const q = await apiFetch<{ qr_base64?: string; qr_payload?: string; status?: string }>(
        `/channels/${activeChannelId}/qr`
      );
      setQrData({ base64: q.qr_base64, payload: q.qr_payload });
      if (q.status) setWaStatus(q.status);
    } catch (err: any) {
      setError(err.message || 'No se pudo refrescar el código QR.');
    }
  }

  async function saveStep3AndNext() {
    setError('');
    setSaving(true);
    try {
      if (agent?.id) {
        await apiFetch(`/ai/agents/${agent.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: agentName.trim(), system_prompt: agentPrompt.trim() }),
        });
      } else {
        await apiFetch('/ai/agents', {
          method: 'POST',
          body: JSON.stringify({ name: agentName.trim(), system_prompt: agentPrompt.trim() }),
        });
      }
      goToStep(4);
    } catch (err: any) {
      setError(err.message || 'No se pudo guardar el asistente IA.');
    } finally {
      setSaving(false);
    }
  }

  async function handleQuickInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setError('');
    setSaving(true);
    try {
      const res = await apiFetch<{ token?: string; email?: string; role?: string }>('/team/invites', {
        method: 'POST',
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      setSentInvites((prev) => [
        ...prev,
        { email: inviteEmail.trim(), role: inviteRole, token: res?.token },
      ]);
      setInviteEmail('');
    } catch (err: any) {
      setError(err.message || 'No se pudo enviar la invitación.');
    } finally {
      setSaving(false);
    }
  }

  async function finishOnboarding() {
    setError('');
    setSaving(true);
    try {
      await apiFetch('/organization', {
        method: 'PATCH',
        body: JSON.stringify({ settings: { onboarding_completed: true } }),
      }).catch(() => {});
      await refreshUser();
      nav({ to: '/app/inbox' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-dvh bg-[var(--surface)] text-[var(--text)] flex flex-col">
      <header className="border-b border-[var(--border)] bg-[var(--bg)] px-4 md:px-8 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <img src="/icon.svg" alt="KoraCRM" className="w-7 h-7 rounded-lg shrink-0" />
          <span className="font-bold text-sm truncate">KoraCRM · Configuración Inicial</span>
        </div>
        <Button variant="ghost" size="sm" onClick={finishOnboarding} disabled={saving}>
          Omitir asistente
        </Button>
      </header>

      <main className="flex-1 max-w-2xl w-full mx-auto px-4 py-6 md:py-10 space-y-6">
        <div className="space-y-1">
          <h1 className="text-xl md:text-2xl font-bold">
            ¡Bienvenido{user?.full_name ? `, ${user.full_name}` : ''}!
          </h1>
          <p className="text-xs md:text-sm text-[var(--text-muted)]">
            Configura tu espacio de trabajo en 4 pasos rápidos.
          </p>
        </div>

        {/* Stepper */}
        <nav aria-label="Pasos de configuración" className="grid grid-cols-4 gap-2">
          {STEPS.map((s) => {
            const Icon = s.icon;
            const done = step > s.num;
            const current = step === s.num;
            return (
              <button
                key={s.num}
                type="button"
                onClick={() => goToStep(s.num)}
                className={`flex flex-col items-center gap-1 p-2.5 rounded-xl border text-center transition-colors cursor-pointer ${
                  current
                    ? 'border-[var(--accent)] bg-teal-50/70 text-[var(--accent)]'
                    : done
                      ? 'border-emerald-200 bg-emerald-50 text-[var(--success)]'
                      : 'border-[var(--border)] bg-[var(--bg)] text-[var(--text-muted)]'
                }`}
              >
                <div className="flex items-center gap-1 text-xs font-semibold">
                  {done ? <Check className="w-3.5 h-3.5 shrink-0" /> : <Icon className="w-3.5 h-3.5 shrink-0" />}
                  <span>{s.num}</span>
                </div>
                <span className="text-[11px] font-medium truncate w-full">{s.title}</span>
              </button>
            );
          })}
        </nav>

        {error && (
          <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-[var(--danger)]">
            {error}
          </div>
        )}

        {/* Paso 1: Vocabulario */}
        {step === 1 && (
          <Card className="p-5 md:p-6 space-y-5">
            <div className="space-y-1">
              <h2 className="text-base font-bold">1. Bienvenida y Vocabulario del Embudo</h2>
              <p className="text-xs text-[var(--text-muted)]">
                Elige una plantilla según tu industria o personaliza los términos de tu CRM.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {NICHE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className={`text-left p-3.5 rounded-xl border transition-colors cursor-pointer ${
                    niche === p.id
                      ? 'border-[var(--accent)] bg-teal-50/60'
                      : 'border-[var(--border)] bg-[var(--bg)] hover:bg-[var(--surface)]'
                  }`}
                >
                  <div className="font-semibold text-sm">{p.label}</div>
                  <div className="text-xs text-[var(--text-muted)] mt-0.5">{p.description}</div>
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium">Elemento (singular)</label>
                <Input value={dealSingular} onChange={(e) => setDealSingular(e.target.value)} placeholder="Lead" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Elementos (plural)</label>
                <Input value={dealPlural} onChange={(e) => setDealPlural(e.target.value)} placeholder="Leads" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Etiqueta de etapa</label>
                <Input value={stageLabel} onChange={(e) => setStageLabel(e.target.value)} placeholder="Etapa" />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
              <Button variant="ghost" onClick={() => goToStep(2)}>
                Omitir por ahora
              </Button>
              <Button onClick={saveStep1AndNext} disabled={saving}>
                {saving ? 'Guardando...' : 'Guardar y continuar'}
              </Button>
            </div>
          </Card>
        )}

        {/* Paso 2: WhatsApp */}
        {step === 2 && (
          <Card className="p-5 md:p-6 space-y-5">
            <div className="space-y-1">
              <h2 className="text-base font-bold">2. Conectar WhatsApp</h2>
              <p className="text-xs text-[var(--text-muted)]">
                Crea una sesión de WhatsApp y escanea el código QR desde tu teléfono.
              </p>
            </div>

            <form onSubmit={handleCreateChannel} className="flex flex-wrap gap-2">
              <Input
                required
                className="flex-1 min-w-[180px]"
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                placeholder="ventas-principal"
              />
              <Button type="submit" disabled={saving}>
                {saving ? 'Creando...' : 'Generar QR'}
              </Button>
            </form>

            {channels.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-[var(--text-muted)]">Sesiones:</span>
                {channels.map((ch) => (
                  <button
                    key={ch.id}
                    type="button"
                    onClick={() => {
                      setActiveChannelId(ch.id);
                      setWaStatus(ch.status);
                    }}
                    className={`px-2.5 py-1 rounded-full border cursor-pointer ${
                      activeChannelId === ch.id
                        ? 'border-[var(--accent)] bg-teal-50 text-[var(--accent)] font-medium'
                        : 'border-[var(--border)] bg-[var(--bg)]'
                    }`}
                  >
                    {ch.session_name} ({ch.status})
                  </button>
                ))}
              </div>
            )}

            {qrData && (qrData.base64 || qrData.payload) && (
              <div className="p-4 rounded-xl bg-teal-50 border border-teal-200 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-teal-900">
                    Escanea con WhatsApp {waStatus ? `(${waStatus})` : ''}
                  </span>
                  <Button size="sm" variant="secondary" onClick={refreshQR}>
                    <RefreshCw className="w-3.5 h-3.5" /> Refrescar QR
                  </Button>
                </div>
                {qrData.base64 && (
                  <img
                    src={qrData.base64.startsWith('data:') ? qrData.base64 : `data:image/png;base64,${qrData.base64}`}
                    alt="Código QR WhatsApp"
                    className="w-44 h-44 rounded-lg border bg-white p-2"
                  />
                )}
                {qrData.payload && (
                  <code className="block text-[11px] break-all text-teal-900">{qrData.payload}</code>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
              <Button variant="secondary" onClick={() => goToStep(1)}>
                Atrás
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={() => goToStep(3)}>
                  Omitir por ahora
                </Button>
                <Button onClick={() => goToStep(3)}>Continuar</Button>
              </div>
            </div>
          </Card>
        )}

        {/* Paso 3: Asistente IA */}
        {step === 3 && (
          <Card className="p-5 md:p-6 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="space-y-1">
                <h2 className="text-base font-bold">3. Configurar Asistente IA</h2>
                <p className="text-xs text-[var(--text-muted)]">
                  Personaliza el nombre y las instrucciones de tu agente de atención automática.
                </p>
              </div>
              {providersCount !== null && (
                <Badge tone={providersCount > 0 ? 'success' : 'warning'}>
                  {providersCount > 0 ? `${providersCount} proveedor(es) LLM` : 'Sin proveedor LLM configurado'}
                </Badge>
              )}
            </div>

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-medium">Nombre del asistente</label>
                <Input
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="Asistente de Ventas"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Instrucciones del sistema (Prompt)</label>
                <textarea
                  rows={4}
                  value={agentPrompt}
                  onChange={(e) => setAgentPrompt(e.target.value)}
                  className="w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
              <Button variant="secondary" onClick={() => goToStep(2)}>
                Atrás
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={() => goToStep(4)}>
                  Omitir por ahora
                </Button>
                <Button onClick={saveStep3AndNext} disabled={saving}>
                  {saving ? 'Guardando...' : 'Guardar y continuar'}
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* Paso 4: Invitar Equipo */}
        {step === 4 && (
          <Card className="p-5 md:p-6 space-y-5">
            <div className="space-y-1">
              <h2 className="text-base font-bold">4. Invitar a tu Equipo</h2>
              <p className="text-xs text-[var(--text-muted)]">
                Envía invitaciones a tus agentes o gerentes para colaborar en la bandeja compartida.
              </p>
            </div>

            <form onSubmit={handleQuickInvite} className="flex flex-wrap gap-2">
              <Input
                type="email"
                required
                className="flex-1 min-w-[180px]"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="agente@empresa.com"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as any)}
                className="h-10 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
              >
                <option value="agent">Agente</option>
                <option value="manager">Gerente</option>
                <option value="viewer">Visor</option>
                <option value="admin">Administrador</option>
              </select>
              <Button type="submit" variant="secondary" disabled={saving}>
                <UserPlus className="w-4 h-4" /> Invitar
              </Button>
            </form>

            {sentInvites.length > 0 && (
              <div className="space-y-1.5">
                {sentInvites.map((inv, idx) => (
                  <div
                    key={`${inv.email}-${idx}`}
                    className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900"
                  >
                    <span className="flex items-center gap-1.5 truncate">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{inv.email}</span>
                    </span>
                    <Badge tone="accent">{inv.role}</Badge>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
              <Button variant="secondary" onClick={() => goToStep(3)}>
                Atrás
              </Button>
              <Button onClick={finishOnboarding} disabled={saving}>
                {saving ? 'Finalizando...' : 'Finalizar y entrar al CRM'}
              </Button>
            </div>
          </Card>
        )}
      </main>
    </div>
  );
}
