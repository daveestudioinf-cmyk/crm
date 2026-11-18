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
            <Button variant="ghost" size="sm">Sign in</Button>
          </Link>
          <Link to="/signup">
            <Button size="sm">Get Started</Button>
          </Link>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 md:px-8 py-14 md:py-20">
        <div className="max-w-3xl space-y-5">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-50 border border-teal-200 px-3 py-1 text-xs font-semibold text-teal-800">
            <Cpu className="w-3.5 h-3.5" /> Decoupled Go + PostgreSQL/pgvector + Native MCP
          </span>
          <h1 className="text-3xl md:text-5xl font-bold tracking-tight leading-tight">
            The AI-First WhatsApp Sales OS built for speed and mobile teams.
          </h1>
          <p className="text-base md:text-lg text-[var(--text-muted)] leading-relaxed">
            Run a self-hosted, multi-tenant CRM with real-time Inbox, fractional-index Kanban, deterministic Customer 360° identity resolution, RAG knowledge agents, and a native Go MCP server—without BaaS lock-in.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <Link to="/signup">
              <Button size="lg">Create Workspace</Button>
            </Link>
            <Link to="/login">
              <Button variant="secondary" size="lg">Sign in to Workspace</Button>
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-14">
          {[
            { icon: MessageSquare, title: 'Real-Time WhatsApp Inbox', desc: 'SSE-powered live messaging, claim/handoff CAS locking, quick replies, and anti-ban Redis throttling.' },
            { icon: Bot, title: 'Tenant RAG & Native MCP', desc: 'Vector knowledge search with pgvector, 4-trigger AI handoff guardrails, and a native Go MCP server.' },
            { icon: Smartphone, title: 'Mobile-First Installable PWA', desc: 'Bottom navigation, Customer 360° sheets, stage-tabbed Kanban, and zero horizontal overflow on 390px screens.' },
            { icon: Zap, title: 'WHEN/IF/THEN Automations', desc: 'Inbound webhook lead capture, background event_log Go workers, and automated stage transitions.' },
            { icon: ShieldCheck, title: 'LGPD & Audit Ready', desc: 'Append-only mutation audit log, granular consent, data export, and cascade anonymization.' },
            { icon: Cpu, title: 'Zero BaaS Lock-In', desc: 'Pure Go binaries (API, MCP, Worker) + PostgreSQL + Redis + MinIO.' },
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
