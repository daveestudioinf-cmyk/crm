import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Activity,
  BookOpen,
  Bot,
  Brain,
  Cpu,
  GitBranch,
  Inbox,
  KeyRound,
  Plus,
  Repeat,
  Search,
  ShieldAlert,
  ShieldQuestion,
  Sparkles,
  Trash2,
  Upload,
  Wallet,
} from 'lucide-react';
import {
  type AIAgent,
  type AIAgentRun,
  type AIBudget,
  type AIProviderCredential,
  type AIRouter,
  type AISkill,
  type AgentCase,
  type AgentInboxItem,
  type FollowupFlow,
  type OrgMemoryEntry,
  apiFetch,
  subscribeSSE,
} from '../lib/api';
import { Badge, Button, Card, Input, Sheet } from '../components/ui/primitives';
import { FollowupsPanel, RoutersPanel } from '../components/ai/FollowupsAndRouters';
import { UsageChart } from '../components/ai/UsageChart';
import { SkillToggleList } from '../components/ai/SkillsPanel';
import { AgentInboxPanel, CaseList } from '../components/ai/CasesAndInbox';

type TabKey =
  | 'agents'
  | 'followups'
  | 'routers'
  | 'providers'
  | 'usage'
  | 'runs'
  | 'knowledge'
  | 'memory'
  | 'skills'
  | 'cases'
  | 'inbox';

const VALID_TABS: TabKey[] = [
  'agents',
  'followups',
  'routers',
  'providers',
  'usage',
  'runs',
  'knowledge',
  'memory',
  'skills',
  'cases',
  'inbox',
];

function tabFromPathname(pathname: string): TabKey {
  const parts = pathname.split('/').filter(Boolean);
  const sub = parts[2] as TabKey | undefined;
  if (sub && VALID_TABS.includes(sub)) return sub;
  return 'knowledge';
}

export function AIPage() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const tab = tabFromPathname(pathname);

  const [agents, setAgents] = useState<AIAgent[]>([]);
  const [providers, setProviders] = useState<AIProviderCredential[]>([]);
  const [budget, setBudget] = useState<AIBudget | null>(null);
  const [runs, setRuns] = useState<AIAgentRun[]>([]);
  const [memory, setMemory] = useState<OrgMemoryEntry[]>([]);
  const [knowledge, setKnowledge] = useState<any[]>([]);
  const [followups, setFollowups] = useState<FollowupFlow[]>([]);
  const [routers, setRouters] = useState<AIRouter[]>([]);
  const [skills, setSkills] = useState<AISkill[]>([]);
  const [cases, setCases] = useState<AgentCase[]>([]);
  const [inboxItems, setInboxItems] = useState<AgentInboxItem[]>([]);
  const [notice, setNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // RAG state
  const [kTitle, setKTitle] = useState('');
  const [kSourceType, setKSourceType] = useState<'faq' | 'markdown' | 'pdf'>('faq');
  const [kContent, setKContent] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<any[]>([]);

  // Agent editor state
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [agName, setAgName] = useState('');
  const [agPrompt, setAgPrompt] = useState('');
  const [agProvider, setAgProvider] = useState('openai');
  const [agModel, setAgModel] = useState('gpt-4o-mini');
  const [agTemp, setAgTemp] = useState('0.3');
  const [agMaxTokens, setAgMaxTokens] = useState('500');
  const [agHandoff, setAgHandoff] = useState(true);
  const [confirmDeleteAgent, setConfirmDeleteAgent] = useState<AIAgent | null>(null);

  // Provider credential state
  const [provName, setProvName] = useState('openai');
  const [provLabel, setProvLabel] = useState('');
  const [provBaseURL, setProvBaseURL] = useState('');
  const [provModel, setProvModel] = useState('');
  const [provKey, setProvKey] = useState('');

  // Budget state
  const [limitUSD, setLimitUSD] = useState('50.00');
  const [warnPct, setWarnPct] = useState('80');
  const [hardStop, setHardStop] = useState(true);

  // Org memory state
  const [memCategory, setMemCategory] = useState('general');
  const [memContent, setMemContent] = useState('');

  function showNotice(type: 'ok' | 'err', text: string) {
    setNotice({ type, text });
  }

  function fillAgentForm(a: AIAgent) {
    setSelectedAgentId(a.id);
    setAgName(a.name);
    setAgPrompt(a.system_prompt);
    setAgProvider(a.provider);
    setAgModel(a.model);
    setAgTemp(String(a.temperature ?? 0.3));
    setAgMaxTokens(String(a.max_tokens ?? 500));
    setAgHandoff(a.handoff_enabled ?? true);
  }

  function resetNewAgentForm() {
    setSelectedAgentId('');
    setAgName('');
    setAgPrompt('Eres un asesor comercial amable y conciso en español.');
    setAgProvider('openai');
    setAgModel('gpt-4o-mini');
    setAgTemp('0.3');
    setAgMaxTokens('500');
    setAgHandoff(true);
  }

  const load = useCallback(async () => {
    try {
      const [ags, kn, usg, provs, rns, mem, flw, rts, skl, cas, ibx] = await Promise.all([
        apiFetch<AIAgent[]>('/ai/agents').catch(() => []),
        apiFetch<any[]>('/ai/knowledge').catch(() => []),
        apiFetch<AIBudget>('/ai/usage').catch(() => null),
        apiFetch<AIProviderCredential[]>('/ai/providers').catch(() => []),
        apiFetch<AIAgentRun[]>('/ai/runs').catch(() => []),
        apiFetch<OrgMemoryEntry[]>('/ai/memory').catch(() => []),
        apiFetch<FollowupFlow[]>('/ai/followups').catch(() => []),
        apiFetch<AIRouter[]>('/ai/routers').catch(() => []),
        apiFetch<AISkill[]>('/ai/skills').catch(() => []),
        apiFetch<AgentCase[]>('/ai/cases').catch(() => []),
        apiFetch<AgentInboxItem[]>('/ai/inbox').catch(() => []),
      ]);
      setAgents(ags || []);
      setSelectedAgentId((prev) => {
        if (!prev && ags?.length) {
          const first = ags[0];
          setAgName(first.name);
          setAgPrompt(first.system_prompt);
          setAgProvider(first.provider);
          setAgModel(first.model);
          setAgTemp(String(first.temperature ?? 0.3));
          setAgMaxTokens(String(first.max_tokens ?? 500));
          setAgHandoff(first.handoff_enabled ?? true);
          return first.id;
        }
        return prev;
      });
      setKnowledge(kn || []);
      setBudget(usg);
      if (usg) {
        setLimitUSD(((usg.monthly_limit_cents ?? 5000) / 100).toFixed(2));
        setWarnPct(String(usg.warn_at_percent ?? 80));
        setHardStop(usg.hard_stop ?? true);
      }
      setProviders(provs || []);
      setRuns(rns || []);
      setMemory(mem || []);
      setFollowups(flw || []);
      setRouters(rts || []);
      setSkills(skl || []);
      setCases(cas || []);
      setInboxItems(ibx || []);
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || 'Error al cargar módulo de IA' });
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    const unsub = subscribeSSE((evType) => {
      if (evType === 'ai.case_created') {
        void load();
      }
    });
    return () => {
      window.clearTimeout(timer);
      unsub();
    };
  }, [load]);

  async function handleKnowledgeFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!kTitle.trim()) {
      setKTitle(file.name.replace(/\.[^.]+$/, ''));
    }
    if (file.name.toLowerCase().endsWith('.pdf')) {
      setKSourceType('pdf');
      const buf = await file.arrayBuffer();
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      const printable = text.replace(/[^\x20-\x7E\xA0-\xFF\n\r\t]/g, ' ').replace(/\s{2,}/g, ' ').trim();
      setKContent(printable.slice(0, 20000) || `Documento PDF: ${file.name}`);
    } else {
      setKSourceType('markdown');
      const text = await file.text();
      setKContent(text.slice(0, 20000));
    }
  }

  async function addKnowledge(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    try {
      await apiFetch('/ai/knowledge', {
        method: 'POST',
        body: JSON.stringify({ title: kTitle, source_type: kSourceType, content: kContent }),
      });
      setKTitle('');
      setKContent('');
      setNotice({ type: 'ok', text: 'Conocimiento RAG indexado.' });
      await load();
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || 'No se pudo indexar el conocimiento.' });
    }
  }

  async function deleteKnowledge(id: string) {
    setNotice(null);
    try {
      await apiFetch(`/ai/knowledge/${id}`, { method: 'DELETE' });
      setNotice({ type: 'ok', text: 'Fuente de conocimiento eliminada.' });
      await load();
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || 'No se pudo eliminar la fuente.' });
    }
  }

  async function testSearch(e: React.FormEvent) {
    e.preventDefault();
    const res = await apiFetch('/ai/knowledge/search', {
      method: 'POST',
      body: JSON.stringify({ query, top_k: 3 }),
    });
    setHits(res || []);
  }

  async function saveAgent(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    try {
      const payload = {
        name: agName,
        system_prompt: agPrompt,
        provider: agProvider,
        model: agModel,
        temperature: parseFloat(agTemp) || 0.3,
        max_tokens: parseInt(agMaxTokens, 10) || 500,
        handoff_enabled: agHandoff,
      };
      if (selectedAgentId) {
        await apiFetch(`/ai/agents/${selectedAgentId}`, { method: 'PATCH', body: JSON.stringify(payload) });
        setNotice({ type: 'ok', text: 'Agente IA actualizado.' });
      } else {
        const created = await apiFetch<AIAgent>('/ai/agents', { method: 'POST', body: JSON.stringify(payload) });
        setSelectedAgentId(created.id);
        setNotice({ type: 'ok', text: 'Agente IA creado.' });
      }
      await load();
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || 'No se pudo guardar el agente' });
    }
  }

  async function deleteAgent(agent: AIAgent) {
    setNotice(null);
    try {
      await apiFetch(`/ai/agents/${agent.id}`, { method: 'DELETE' });
      setConfirmDeleteAgent(null);
      if (selectedAgentId === agent.id) {
        resetNewAgentForm();
      }
      setNotice({ type: 'ok', text: `Agente "${agent.name}" eliminado.` });
      await load();
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || 'No se pudo eliminar el agente.' });
    }
  }

  async function saveProvider(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    try {
      await apiFetch('/ai/providers', {
        method: 'POST',
        body: JSON.stringify({
          provider: provName,
          label: provLabel,
          base_url: provBaseURL,
          default_model: provModel,
          api_key: provKey,
          is_active: true,
        }),
      });
      setProvKey('');
      setNotice({ type: 'ok', text: 'Credencial de proveedor cifrada y guardada.' });
      await load();
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || 'Error al guardar credencial' });
    }
  }

  async function removeProvider(id: string) {
    setNotice(null);
    await apiFetch(`/ai/providers/${id}`, { method: 'DELETE' });
    setNotice({ type: 'ok', text: 'Credencial eliminada.' });
    await load();
  }

  async function saveBudget(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    try {
      const cents = Math.max(0, Math.round((parseFloat(limitUSD) || 0) * 100));
      await apiFetch('/ai/budget', {
        method: 'PUT',
        body: JSON.stringify({
          monthly_limit_cents: cents,
          warn_at_percent: parseInt(warnPct, 10) || 80,
          hard_stop: hardStop,
        }),
      });
      setNotice({ type: 'ok', text: 'Presupuesto mensual actualizado.' });
      await load();
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || 'Error al actualizar presupuesto' });
    }
  }

  async function addMemory(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    await apiFetch('/ai/memory', {
      method: 'POST',
      body: JSON.stringify({ category: memCategory, content: memContent }),
    });
    setMemContent('');
    setNotice({ type: 'ok', text: 'Memoria organizacional guardada.' });
    await load();
  }

  const pct = Math.min(100, Math.round(budget?.pct ?? 0));
  const warnThreshold = budget?.warn_at_percent ?? 80;
  const barTone =
    pct >= 100 ? 'bg-red-500' : pct >= warnThreshold ? 'bg-amber-500' : 'bg-emerald-500';

  const pendingCasesCount = cases.filter((c) => c.status === 'awaiting_human').length;
  const unreadInboxCount = inboxItems.filter((i) => !i.is_read).length;

  const tabs: { key: TabKey; label: string; icon: React.ReactNode; badge?: number }[] = [
    { key: 'knowledge', label: 'Conocimiento RAG', icon: <BookOpen className="w-3.5 h-3.5" /> },
    { key: 'agents', label: 'Agentes IA', icon: <Bot className="w-3.5 h-3.5" /> },
    { key: 'followups', label: 'Seguimientos', icon: <Repeat className="w-3.5 h-3.5" /> },
    { key: 'routers', label: 'Routers', icon: <GitBranch className="w-3.5 h-3.5" /> },
    { key: 'skills', label: 'Habilidades', icon: <Sparkles className="w-3.5 h-3.5" /> },
    { key: 'memory', label: 'Memoria', icon: <Brain className="w-3.5 h-3.5" /> },
    { key: 'cases', label: 'Casos', icon: <ShieldQuestion className="w-3.5 h-3.5" />, badge: pendingCasesCount || undefined },
    { key: 'inbox', label: 'Alertas', icon: <Inbox className="w-3.5 h-3.5" />, badge: unreadInboxCount || undefined },
    { key: 'providers', label: 'Proveedores', icon: <KeyRound className="w-3.5 h-3.5" /> },
    { key: 'usage', label: 'Uso y Presupuesto', icon: <Wallet className="w-3.5 h-3.5" /> },
    { key: 'runs', label: 'Trazas', icon: <Activity className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-6xl min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">Motor de IA, Agentes, Flujos y RAG</h1>
          <p className="text-xs text-[var(--text-muted)]">
            Agentes multi-tenant, seguimientos automáticos, routers de intención, habilidades, casos y presupuesto
          </p>
        </div>
        {budget && (
          <Card className="px-4 py-2.5 flex items-center gap-3">
            <Cpu className="w-4 h-4 text-[var(--accent)] shrink-0" />
            <div className="text-xs">
              <span className="font-semibold">${(budget.spent_cents / 100).toFixed(2)}</span> / $
              {(budget.monthly_limit_cents / 100).toFixed(2)} ({pct}%)
              {pct >= 100 && budget.hard_stop && (
                <Badge tone="danger" className="ml-2">Tope 100%</Badge>
              )}
              {pct >= warnThreshold && pct < 100 && (
                <Badge tone="warning" className="ml-2">Alerta {warnThreshold}%</Badge>
              )}
            </div>
          </Card>
        )}
      </div>

      {notice && (
        <div
          role="status"
          className={`px-3 py-2 rounded-xl text-xs border ${
            notice.type === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 border-b border-[var(--border)] pb-2" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={tab === t.key}
            onClick={() => navigate({ to: `/app/ai/${t.key}` })}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
              tab === t.key
                ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                : 'bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            {t.icon}
            <span>{t.label}</span>
            {t.badge !== undefined && (
              <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-amber-500 text-white font-bold">
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === 'knowledge' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="p-4 space-y-3 min-w-0">
              <div className="flex items-center gap-2 font-semibold text-sm">
                <Bot className="w-4 h-4 text-[var(--accent)]" /> Agentes de IA Activos
              </div>
              {agents.length === 0 ? (
                <div className="text-xs text-[var(--text-muted)]">No hay agentes creados todavía.</div>
              ) : (
                agents.map((a) => (
                  <div key={a.id} className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)] space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-sm truncate">{a.name}</span>
                      <Badge tone="accent">{a.model}</Badge>
                    </div>
                    <p className="text-xs text-[var(--text-muted)] line-clamp-2">{a.system_prompt}</p>
                  </div>
                ))
              )}
            </Card>

            <Card className="p-4 space-y-3 min-w-0">
              <div className="flex items-center gap-2 font-semibold text-sm">
                <BookOpen className="w-4 h-4 text-[var(--accent)]" /> Agregar Conocimiento (FAQ / PDF / MD)
              </div>
              <form onSubmit={addKnowledge} className="space-y-2.5">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <Input
                    required
                    className="sm:col-span-2"
                    placeholder="Título (ej. Políticas de Envío)"
                    value={kTitle}
                    onChange={(e) => setKTitle(e.target.value)}
                  />
                  <select
                    value={kSourceType}
                    onChange={(e) => setKSourceType(e.target.value as 'faq' | 'markdown' | 'pdf')}
                    className="h-10 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-2.5 text-sm"
                  >
                    <option value="faq">FAQ / Texto</option>
                    <option value="markdown">Markdown (.md)</option>
                    <option value="pdf">PDF (.pdf)</option>
                  </select>
                </div>
                <label className="flex items-center gap-2 text-xs text-[var(--text-muted)] cursor-pointer">
                  <Upload className="w-3.5 h-3.5 text-[var(--accent)]" />
                  <span>Cargar archivo .md, .txt o .pdf:</span>
                  <input
                    type="file"
                    accept=".md,.txt,.pdf,text/markdown,text/plain,application/pdf"
                    onChange={handleKnowledgeFile}
                    className="text-xs max-w-full"
                  />
                </label>
                <textarea
                  required
                  rows={4}
                  placeholder="Pega preguntas frecuentes, políticas o contenido Markdown..."
                  value={kContent}
                  onChange={(e) => setKContent(e.target.value)}
                  className="w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] p-3 text-sm"
                />
                <Button type="submit" size="sm">Indexar Conocimiento</Button>
              </form>
            </Card>
          </div>

          <Card className="p-4 space-y-3">
            <div className="font-semibold text-sm flex items-center gap-2">
              <Search className="w-4 h-4 text-[var(--accent)]" /> Probar Búsqueda Semántica RAG
            </div>
            <form onSubmit={testSearch} className="flex flex-wrap gap-2">
              <Input
                className="flex-1 min-w-[200px]"
                placeholder="Haz una pregunta como cliente..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Button type="submit" size="sm">Buscar</Button>
            </form>
            {hits.length > 0 && (
              <div className="space-y-2">
                {hits.map((h, i) => (
                  <div key={i} className="p-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border)] text-xs flex justify-between gap-2">
                    <span>{h.content}</span>
                    <Badge tone="success">{(h.score * 100).toFixed(0)}%</Badge>
                  </div>
                ))}
              </div>
            )}
            <div className="pt-2 space-y-1.5">
              <div className="text-xs font-semibold text-[var(--text-muted)]">Fuentes Indexadas ({knowledge.length})</div>
              {knowledge.map((k) => (
                <div key={k.id} className="text-xs flex items-center justify-between gap-2 py-1.5 border-b border-[var(--border)] last:border-0">
                  <div className="min-w-0 flex items-center gap-2">
                    <span className="font-medium truncate">{k.title}</span>
                    {k.source_type && <Badge tone="neutral">{k.source_type}</Badge>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge tone={k.status === 'error' ? 'danger' : k.status === 'processing' ? 'warning' : 'success'}>
                      {k.status === 'ready' ? 'Listo' : k.status === 'processing' ? 'Procesando' : k.status === 'error' ? 'Error' : k.status}
                    </Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label={`Eliminar ${k.title}`}
                      onClick={() => deleteKnowledge(k.id)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {tab === 'agents' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="p-4 space-y-2.5 min-w-0">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-sm">Agentes ({agents.length})</span>
              <Button size="sm" variant="secondary" onClick={resetNewAgentForm}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Nuevo
              </Button>
            </div>
            {agents.map((a) => (
              <div
                key={a.id}
                className={`p-2.5 rounded-xl border text-xs transition flex items-start justify-between gap-2 ${
                  selectedAgentId === a.id
                    ? 'border-[var(--accent)] bg-[var(--surface)]'
                    : 'border-[var(--border)]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => fillAgentForm(a)}
                  className="text-left flex-1 min-w-0 cursor-pointer"
                >
                  <div className="font-semibold truncate">{a.name}</div>
                  <div className="text-[var(--text-muted)] truncate">
                    {a.provider} • {a.model} • v{a.version}
                  </div>
                </button>
                <button
                  type="button"
                  aria-label={`Eliminar agente ${a.name}`}
                  onClick={() => setConfirmDeleteAgent(a)}
                  className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-red-50 cursor-pointer shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </Card>

          <Card className="p-4 md:col-span-2 min-w-0">
            <form onSubmit={saveAgent} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold text-sm">
                  {selectedAgentId ? 'Editar Agente IA' : 'Crear Agente IA'}
                </div>
                {selectedAgentId && (
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      const found = agents.find((a) => a.id === selectedAgentId);
                      if (found) setConfirmDeleteAgent(found);
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Eliminar agente
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium block mb-1">Nombre del agente</label>
                  <Input required placeholder="Asesor Comercial" value={agName} onChange={(e) => setAgName(e.target.value)} />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1">Proveedor</label>
                  <select
                    value={agProvider}
                    onChange={(e) => setAgProvider(e.target.value)}
                    className="w-full h-10 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
                  >
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="gemini">Google Gemini</option>
                    <option value="openrouter">OpenRouter</option>
                    <option value="openai_compatible">Compatible OpenAI</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1">Modelo</label>
                  <Input required placeholder="gpt-4o-mini" value={agModel} onChange={(e) => setAgModel(e.target.value)} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs font-medium block mb-1">Temperatura</label>
                    <Input type="number" step="0.1" min="0" max="2" value={agTemp} onChange={(e) => setAgTemp(e.target.value)} />
                  </div>
                  <div>
                    <label className="text-xs font-medium block mb-1">Máx. tokens</label>
                    <Input type="number" min="50" max="8192" value={agMaxTokens} onChange={(e) => setAgMaxTokens(e.target.value)} />
                  </div>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1">Prompt del sistema</label>
                <textarea
                  required
                  rows={4}
                  value={agPrompt}
                  onChange={(e) => setAgPrompt(e.target.value)}
                  className="w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] p-3 text-sm"
                />
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={agHandoff} onChange={(e) => setAgHandoff(e.target.checked)} />
                Habilitar handoff automático a humano ante solicitud o temas críticos
              </label>
              <Button type="submit" size="sm">Guardar Agente</Button>
            </form>
          </Card>
        </div>
      )}

      {tab === 'followups' && (
        <FollowupsPanel
          followups={followups}
          onRefresh={() => void load()}
          onNotice={showNotice}
        />
      )}

      {tab === 'routers' && (
        <RoutersPanel
          routers={routers}
          agents={agents}
          onRefresh={() => void load()}
          onNotice={showNotice}
        />
      )}

      {tab === 'skills' && (
        <SkillToggleList skills={skills} onRefresh={() => void load()} onNotice={showNotice} />
      )}

      {tab === 'memory' && (
        <Card className="p-4 space-y-3 min-w-0">
          <div className="font-semibold text-sm flex items-center gap-2">
            <Brain className="w-4 h-4 text-[var(--accent)]" /> Memoria Organizacional ({memory.length})
          </div>
          <form onSubmit={addMemory} className="flex flex-wrap gap-2">
            <Input
              className="w-36"
              placeholder="Categoría"
              value={memCategory}
              onChange={(e) => setMemCategory(e.target.value)}
            />
            <Input
              required
              className="flex-1 min-w-[200px]"
              placeholder="Regla o dato persistente (ej. Horario L-V 9am a 6pm)"
              value={memContent}
              onChange={(e) => setMemContent(e.target.value)}
            />
            <Button type="submit" size="sm">Agregar Memoria</Button>
          </form>
          <div className="space-y-1.5">
            {memory.length === 0 ? (
              <div className="text-xs text-[var(--text-muted)] py-2">Aún no hay entradas de memoria.</div>
            ) : (
              memory.map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-2 text-xs py-1.5 border-b border-[var(--border)] last:border-0">
                  <span className="truncate">
                    <strong className="mr-1.5">[{m.category}]</strong>
                    {m.content}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label="Eliminar memoria"
                    onClick={() => apiFetch(`/ai/memory/${m.id}`, { method: 'DELETE' }).then(() => void load())}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </Card>
      )}

      {tab === 'cases' && (
        <CaseList cases={cases} onRefresh={() => void load()} onNotice={showNotice} />
      )}

      {tab === 'inbox' && (
        <AgentInboxPanel items={inboxItems} onRefresh={() => void load()} onNotice={showNotice} />
      )}

      {tab === 'providers' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="p-4 space-y-3 min-w-0">
            <div className="font-semibold text-sm flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-[var(--accent)]" /> Configurar Credencial LLM
            </div>
            <form onSubmit={saveProvider} className="space-y-2.5">
              <div>
                <label className="text-xs font-medium block mb-1">Proveedor</label>
                <select
                  value={provName}
                  onChange={(e) => setProvName(e.target.value)}
                  className="w-full h-10 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="openai_compatible">Compatible OpenAI</option>
                </select>
              </div>
              <Input placeholder="Etiqueta (ej. Producción OpenAI)" value={provLabel} onChange={(e) => setProvLabel(e.target.value)} />
              <Input placeholder="Modelo por defecto (opcional, ej. gpt-4o-mini)" value={provModel} onChange={(e) => setProvModel(e.target.value)} />
              <Input placeholder="Base URL personalizada (opcional)" value={provBaseURL} onChange={(e) => setProvBaseURL(e.target.value)} />
              <Input
                type="password"
                placeholder="API Key (sk-... / AIza...)"
                value={provKey}
                onChange={(e) => setProvKey(e.target.value)}
              />
              <Button type="submit" size="sm">Guardar Credencial Cifrada</Button>
            </form>
          </Card>

          <Card className="p-4 space-y-3 min-w-0">
            <div className="font-semibold text-sm">Credenciales Configuradas ({providers.length})</div>
            {providers.length === 0 ? (
              <div className="text-xs text-[var(--text-muted)]">
                Sin claves externas: el motor usará el modo determinista local con tu RAG.
              </div>
            ) : (
              <div className="space-y-2">
                {providers.map((p) => (
                  <div key={p.id} className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-xs flex items-center gap-2">
                        <span>{p.provider.toUpperCase()}</span>
                        <Badge tone={p.is_active ? 'success' : 'warning'}>{p.is_active ? 'Activa' : 'Inactiva'}</Badge>
                      </div>
                      <div className="text-xs font-mono text-[var(--text-muted)] truncate">{p.api_key_mask}</div>
                      {p.label && <div className="text-[11px] text-[var(--text-muted)] truncate">{p.label}</div>}
                    </div>
                    <Button size="sm" variant="secondary" aria-label={`Eliminar ${p.provider}`} onClick={() => removeProvider(p.id)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'usage' && (
        <div className="space-y-4">
          <UsageChart runs={runs} budget={budget} />

          {budget && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card className="p-4 space-y-3 min-w-0">
                <div className="font-semibold text-sm flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-[var(--accent)]" /> Consumo Mensual de IA
                </div>
                <div className="text-2xl font-bold">
                  ${(budget.spent_cents / 100).toFixed(2)}{' '}
                  <span className="text-sm font-normal text-[var(--text-muted)]">
                    de ${(budget.monthly_limit_cents / 100).toFixed(2)} USD
                  </span>
                </div>
                <div className="w-full h-3 rounded-full bg-[var(--surface)] overflow-hidden border border-[var(--border)]">
                  <div className={`h-full transition-all ${barTone}`} style={{ width: `${pct}%` }} />
                </div>
                <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
                  <span>Alerta configurada: {budget.warn_at_percent}%</span>
                  <span>{pct}% consumido</span>
                </div>
              </Card>

              <Card className="p-4 space-y-3 min-w-0">
                <div className="font-semibold text-sm">Configurar Límites</div>
                <form onSubmit={saveBudget} className="space-y-3">
                  <div>
                    <label className="text-xs font-medium block mb-1">Tope mensual (USD)</label>
                    <Input type="number" step="0.50" min="0" value={limitUSD} onChange={(e) => setLimitUSD(e.target.value)} />
                  </div>
                  <div>
                    <label className="text-xs font-medium block mb-1">Porcentaje de alerta (%)</label>
                    <Input type="number" min="1" max="100" value={warnPct} onChange={(e) => setWarnPct(e.target.value)} />
                  </div>
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={hardStop} onChange={(e) => setHardStop(e.target.checked)} />
                    Corte automático al 100% (hard stop + handoff a humano)
                  </label>
                  <Button type="submit" size="sm">Guardar Presupuesto</Button>
                </form>
              </Card>
            </div>
          )}
        </div>
      )}

      {tab === 'runs' && (
        <Card className="p-4 space-y-3 min-w-0">
          <div className="font-semibold text-sm">Trazas de Ejecución Recientes ({runs.length})</div>
          {runs.length === 0 ? (
            <div className="text-xs text-[var(--text-muted)]">Aún no hay ejecuciones registradas.</div>
          ) : (
            <div className="space-y-2">
              {runs.map((r) => (
                <div key={r.id} className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-xs space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge
                        tone={
                          r.status === 'completed'
                            ? 'success'
                            : r.status === 'handoff'
                              ? 'warning'
                              : 'danger'
                        }
                      >
                        {r.status === 'completed'
                          ? 'Completado'
                          : r.status === 'handoff'
                            ? 'Derivado'
                            : r.status === 'blocked_budget'
                              ? 'Presupuesto agotado'
                              : r.status === 'failed'
                                ? 'Fallido'
                                : r.status}
                      </Badge>
                      <span className="font-mono">{r.provider} / {r.model}</span>
                    </div>
                    <span className="text-[var(--text-muted)]">
                      {r.prompt_tokens}+{r.completion_tokens} tok • ${((r.cost_cents || 0) / 100).toFixed(2)} • {r.latency_ms}ms
                    </span>
                  </div>
                  {r.input_preview && <div className="text-[var(--text-muted)] truncate">Entrada: {r.input_preview}</div>}
                  {r.handoff_reason && <div className="text-amber-700">Handoff: {r.handoff_reason}</div>}
                  {r.error_message && <div className="text-red-700">Error: {r.error_message}</div>}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <Sheet
        open={Boolean(confirmDeleteAgent)}
        onClose={() => setConfirmDeleteAgent(null)}
        title="Confirmar eliminación de agente"
      >
        <div className="space-y-4">
          <p className="text-xs text-[var(--text-muted)]">
            ¿Seguro que deseas eliminar el agente <strong>{confirmDeleteAgent?.name}</strong>? Esta acción no se puede deshacer.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmDeleteAgent(null)}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={() => confirmDeleteAgent && deleteAgent(confirmDeleteAgent)}>
              Eliminar agente
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
