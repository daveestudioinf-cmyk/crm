import React, { useEffect, useState } from 'react';
import { Bot, BookOpen, Search, Cpu } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { Badge, Button, Card, Input } from '../components/ui/primitives';

export function AIPage() {
  const [agents, setAgents] = useState<any[]>([]);
  const [knowledge, setKnowledge] = useState<any[]>([]);
  const [usage, setUsage] = useState<any>(null);
  const [kTitle, setKTitle] = useState('');
  const [kContent, setKContent] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<any[]>([]);

  async function load() {
    const [ags, kn, usg] = await Promise.all([
      apiFetch('/ai/agents'),
      apiFetch('/ai/knowledge'),
      apiFetch('/ai/usage'),
    ]);
    setAgents(ags);
    setKnowledge(kn);
    setUsage(usg);
  }

  useEffect(() => {
    load();
  }, []);

  async function addKnowledge(e: React.FormEvent) {
    e.preventDefault();
    await apiFetch('/ai/knowledge', {
      method: 'POST',
      body: JSON.stringify({ title: kTitle, source_type: 'faq', content: kContent }),
    });
    setKTitle('');
    setKContent('');
    load();
  }

  async function testSearch(e: React.FormEvent) {
    e.preventDefault();
    const res = await apiFetch('/ai/knowledge/search', {
      method: 'POST',
      body: JSON.stringify({ query, top_k: 3 }),
    });
    setHits(res || []);
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Agentes de IA, RAG y MCP Nativo</h1>
          <p className="text-xs text-[var(--text-muted)]">Base de conocimiento vectorial aislada por tenant y handoff a humano</p>
        </div>
        {usage && (
          <Card className="px-4 py-2 flex items-center gap-3">
            <Cpu className="w-4 h-4 text-[var(--accent)]" />
            <div className="text-xs">
              <span className="font-semibold">${(usage.spent_cents / 100).toFixed(2)}</span> / ${(usage.monthly_cap_cents / 100).toFixed(2)} tope ({usage.calls} llamadas)
            </div>
          </Card>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2 font-semibold text-sm">
            <Bot className="w-4 h-4 text-[var(--accent)]" /> Agentes de IA Activos
          </div>
          {agents.map((a) => (
            <div key={a.id} className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)] space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm">{a.name}</span>
                <Badge tone="accent">{a.model}</Badge>
              </div>
              <p className="text-xs text-[var(--text-muted)] line-clamp-2">{a.system_prompt}</p>
            </div>
          ))}
        </Card>

        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2 font-semibold text-sm">
            <BookOpen className="w-4 h-4 text-[var(--accent)]" /> Agregar Conocimiento RAG
          </div>
          <form onSubmit={addKnowledge} className="space-y-2.5">
            <Input required placeholder="Título (ej. Políticas de Envío y Devolución)" value={kTitle} onChange={(e) => setKTitle(e.target.value)} />
            <textarea
              required
              rows={3}
              placeholder="Pega preguntas frecuentes o políticas..."
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
        <form onSubmit={testSearch} className="flex gap-2">
          <Input placeholder="Haz una pregunta como cliente..." value={query} onChange={(e) => setQuery(e.target.value)} />
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
            <div key={k.id} className="text-xs flex items-center justify-between py-1 border-b border-[var(--border)] last:border-0">
              <span className="font-medium">{k.title}</span>
              <Badge tone="success">{k.status}</Badge>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
