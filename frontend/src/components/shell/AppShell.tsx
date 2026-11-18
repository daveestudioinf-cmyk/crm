import React, { useState } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import {
  MessageSquare,
  Kanban,
  Users,
  Bot,
  Menu,
  Radio,
  Webhook,
  BarChart3,
  Settings,
  ShieldCheck,
  LogOut,
  CheckSquare,
  Flame,
} from 'lucide-react';
import { cn, Sheet } from '../ui/primitives';

const NAV_ITEMS = [
  { to: '/app/inbox', label: 'Bandeja', icon: MessageSquare },
  { to: '/app/radar', label: 'Radar', icon: Flame },
  { to: '/app/kanban', label: 'Embudo', icon: Kanban },
  { to: '/app/contacts', label: 'Contactos', icon: Users },
  { to: '/app/tasks', label: 'Tareas', icon: CheckSquare },
  { to: '/app/ai', label: 'IA y RAG', icon: Bot },
  { to: '/app/channels', label: 'WhatsApp', icon: Radio },
  { to: '/app/webhooks', label: 'Automatizaciones', icon: Webhook },
  { to: '/app/metrics', label: 'Analítica', icon: BarChart3 },
  { to: '/app/lgpd', label: 'LGPD y Auditoría', icon: ShieldCheck },
  { to: '/app/settings', label: 'Configuración', icon: Settings },
];

export function AppShell({
  user,
  onLogout,
  children,
}: {
  user: any;
  onLogout: () => void;
  children: React.ReactNode;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="min-h-dvh flex flex-col md:flex-row bg-[var(--bg)] text-[var(--text)] overflow-x-hidden">
      {/* Barra lateral escritorio */}
      <aside className="hidden md:flex md:w-60 md:flex-col md:fixed md:inset-y-0 border-r border-[var(--border)] bg-[var(--surface)]">
        <div className="h-14 flex items-center gap-2.5 px-4 border-b border-[var(--border)]">
          <img src="/icon.svg" alt="KoraCRM" className="w-7 h-7 rounded-lg" />
          <div className="min-w-0">
            <div className="text-sm font-bold tracking-tight truncate">KoraCRM</div>
            <div className="text-[11px] text-[var(--text-muted)] truncate">{user?.org_name || 'Espacio'}</div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto p-2.5 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-sm font-medium transition-colors',
                  active
                    ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                    : 'text-[var(--text-muted)] hover:bg-slate-200/60 hover:text-[var(--text)]'
                )}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t border-[var(--border)] flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold truncate">{user?.full_name}</div>
            <div className="text-[11px] text-[var(--text-muted)] uppercase">{user?.role}</div>
          </div>
          <button
            onClick={onLogout}
            title="Cerrar sesión"
            className="p-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-red-50 cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </aside>

      {/* Contenido principal */}
      <div className="flex-1 md:pl-60 flex flex-col min-w-0 pb-16 md:pb-0">
        {/* Barra superior móvil */}
        <header className="md:hidden h-14 flex items-center justify-between px-4 border-b border-[var(--border)] bg-[var(--bg)] sticky top-0 z-30">
          <div className="flex items-center gap-2 min-w-0">
            <img src="/icon.svg" alt="KoraCRM" className="w-6 h-6 rounded-md" />
            <span className="font-bold text-sm truncate">{user?.org_name || 'KoraCRM'}</span>
          </div>
          <button
            onClick={() => setMoreOpen(true)}
            aria-label="Abrir menú"
            className="p-2 rounded-lg border border-[var(--border)] text-[var(--text)] cursor-pointer"
          >
            <Menu className="w-4 h-4" />
          </button>
        </header>

        <main className="flex-1 min-w-0">{children}</main>
      </div>

      {/* Barra inferior móvil */}
      <nav
        aria-label="Navegación móvil"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 h-16 bg-[var(--bg)] border-t border-[var(--border)] grid grid-cols-5 px-1 pb-[env(safe-area-inset-bottom)]"
      >
        {[
          { to: '/app/inbox', label: 'Bandeja', icon: MessageSquare },
          { to: '/app/kanban', label: 'Embudo', icon: Kanban },
          { to: '/app/contacts', label: 'Contactos', icon: Users },
          { to: '/app/ai', label: 'IA', icon: Bot },
        ].map((item) => {
          const Icon = item.icon;
          const active = pathname.startsWith(item.to);
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                'flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium min-h-[44px]',
                active ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'
              )}
            >
              <Icon className="w-5 h-5" />
              <span>{item.label}</span>
            </Link>
          );
        })}
        <button
          onClick={() => setMoreOpen(true)}
          className="flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-[var(--text-muted)] min-h-[44px] cursor-pointer"
        >
          <Menu className="w-5 h-5" />
          <span>Más</span>
        </button>
      </nav>

      {/* Sheet Más en móvil */}
      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="Navegación">
        <div className="grid grid-cols-2 gap-2">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={() => setMoreOpen(false)}
                className="flex items-center gap-2.5 p-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-sm font-medium"
              >
                <Icon className="w-4 h-4 text-[var(--accent)]" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
        <button
          onClick={() => {
            setMoreOpen(false);
            onLogout();
          }}
          className="mt-4 w-full flex items-center justify-center gap-2 p-3 rounded-xl border border-red-200 bg-red-50 text-[var(--danger)] text-sm font-medium cursor-pointer"
        >
          <LogOut className="w-4 h-4" /> Cerrar sesión
        </button>
      </Sheet>
    </div>
  );
}
