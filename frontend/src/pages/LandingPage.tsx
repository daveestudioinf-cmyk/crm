import { Link } from '@tanstack/react-router';
import { Bot, Cpu, MessageSquare, ShieldCheck, Smartphone, Zap } from 'lucide-react';
import { Button, Card } from '../components/ui/primitives';

export function LandingPage() {
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--text)]">
      <header className="border-b border-[var(--border)] px-4 md:px-8 h-16 flex items-center justify-between max-w-6xl mx-auto">
        <div className="flex items-center gap-2.5">
          <img src="/icon.svg" alt="KoraCRM" className="w-8 h-8 rounded-lg" />
          <span className="font-bold text-lg tracking-tight">KoraCRM</span>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/login">
            <Button variant="ghost" size="sm">Iniciar sesión</Button>
          </Link>
          <Link to="/signup">
            <Button size="sm">Comenzar</Button>
          </Link>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 md:px-8 py-14 md:py-20">
        <div className="max-w-3xl space-y-5">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-50 border border-teal-200 px-3 py-1 text-xs font-semibold text-teal-800">
            <Cpu className="w-3.5 h-3.5" /> Go Desacoplado + PostgreSQL/pgvector + MCP Nativo
          </span>
          <h1 className="text-3xl md:text-5xl font-bold tracking-tight leading-tight">
            El CRM de Ventas por WhatsApp con IA diseñado para velocidad y equipos móviles.
          </h1>
          <p className="text-base md:text-lg text-[var(--text-muted)] leading-relaxed">
            Opera un CRM multi-tenant autoalojado con Bandeja en tiempo real, Kanban con orden fraccional, resolución determinística Customer 360°, agentes RAG y un servidor MCP nativo en Go, sin ataduras a terceros.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <Link to="/signup">
              <Button size="lg">Crear Espacio de Trabajo</Button>
            </Link>
            <Link to="/login">
              <Button variant="secondary" size="lg">Iniciar sesión</Button>
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-14">
          {[
            { icon: MessageSquare, title: 'Bandeja WhatsApp en Tiempo Real', desc: 'Mensajería en vivo por SSE, bloqueo de reclamo/handoff, respuestas rápidas y control anti-ban en Redis.' },
            { icon: Bot, title: 'RAG por Tenant y MCP Nativo', desc: 'Búsqueda vectorial con pgvector, handoff a humano por 4 disparadores y servidor MCP nativo en Go.' },
            { icon: Smartphone, title: 'PWA Móvil Instalable', desc: 'Barra de navegación inferior, sheets de Customer 360°, Kanban por pestañas y cero scroll horizontal.' },
            { icon: Zap, title: 'Automatizaciones y Webhooks', desc: 'Captura de leads por webhook, workers en Go con event_log y reglas WHEN/IF/THEN.' },
            { icon: ShieldCheck, title: 'LGPD y Auditoría Inmutable', desc: 'Registro de auditoría de mutaciones, consentimiento granular, exportación y anonimización en cascada.' },
            { icon: Cpu, title: 'Infraestructura Propia', desc: 'Binarios Go (API, MCP, Worker) + PostgreSQL + Redis + MinIO + Evolution Go.' },
          ].map((f) => {
            const Icon = f.icon;
            return (
              <Card key={f.title} className="p-5 space-y-2">
                <Icon className="w-5 h-5 text-[var(--accent)]" />
                <h2 className="font-semibold text-base">{f.title}</h2>
                <p className="text-sm text-[var(--text-muted)] leading-relaxed">{f.desc}</p>
              </Card>
            );
          })}
        </div>
      </main>
    </div>
  );
}
