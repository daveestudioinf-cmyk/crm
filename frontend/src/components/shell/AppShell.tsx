import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
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
  Shield,
  LogOut,
  CheckSquare,
  Flame,
  Headset,
  UsersRound,
  FileText,
  Briefcase,
  Package,
  Activity,
  FileSearch,
  Megaphone,
  Calendar,
} from 'lucide-react';
import { cn, Sheet } from '../ui/primitives';
import {
  SUPPORT_SESSION_EVENT,
  type SupportSession,
  endAdminSupportSession,
  getSupportSession,
  setSupportSession,
} from '../../lib/api';

const ROLE_ORDER: Record<string, number> = {
  viewer: 0,
  agent: 1,
  manager: 2,
  admin: 3,
};

function hasMinRole(userRole: string | undefined, minRole?: string): boolean {
  if (!minRole) return true;
  return (ROLE_ORDER[userRole || 'viewer'] ?? 0) >= (ROLE_ORDER[minRole] ?? 0);
}

const NAV_ITEMS: Array<{ to: string; label: string; icon: any; minRole?: string; matchPrefixes?: string[] }> = [
  { to: '/app/crm', label: 'CRM', icon: Briefcase },
  { to: '/app/inbox', label: 'Bandeja', icon: MessageSquare },
  { to: '/app/radar', label: 'Radar', icon: Flame },
  { to: '/app/templates', label: 'Plantillas', icon: FileText },
  { to: '/app/kanban', label: 'Embudo', icon: Kanban, matchPrefixes: ['/app/kanban', '/app/pipelines', '/app/leads'] },
  { to: '/app/contacts', label: 'Contactos', icon: Users },
  { to: '/app/tasks', label: 'Tareas', icon: CheckSquare },
  { to: '/app/agenda', label: 'Agenda', icon: Calendar },
  { to: '/app/products', label: 'Productos', icon: Package },
  { to: '/app/campaigns', label: 'Campañas', icon: Megaphone, minRole: 'manager' },
  { to: '/app/ai', label: 'IA y RAG', icon: Bot, minRole: 'manager', matchPrefixes: ['/app/ai'] },
  { to: '/app/channels', label: 'WhatsApp', icon: Radio, minRole: 'manager' },
  { to: '/app/webhooks', label: 'Automatizaciones', icon: Webhook, minRole: 'manager', matchPrefixes: ['/app/webhooks'] },
  { to: '/app/metrics', label: 'Analítica', icon: BarChart3, minRole: 'manager', matchPrefixes: ['/app/metrics'] },
  { to: '/app/activities', label: 'Actividades', icon: Activity, minRole: 'manager', matchPrefixes: ['/app/activities'] },
  { to: '/app/lgpd', label: 'LGPD', icon: ShieldCheck, minRole: 'manager', matchPrefixes: ['/app/lgpd'] },
  { to: '/app/audit', label: 'Auditoría', icon: FileSearch, minRole: 'manager', matchPrefixes: ['/app/audit'] },
  { to: '/app/team', label: 'Equipo', icon: UsersRound, minRole: 'manager' },
  { to: '/app/settings', label: 'Configuración', icon: Settings, minRole: 'manager', matchPrefixes: ['/app/settings'] },
];

function formatRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function ActiveSupportSessionBanner() {
  const navigate = useNavigate();
  const [session, setSession] = useState<SupportSession | null>(() => getSupportSession());
  const [remainingMs, setRemainingMs] = useState<number>(() =>
    session ? Math.max(0, new Date(session.expires_at).getTime() - Date.now()) : 0
  );
  const [ending, setEnding] = useState(false);

  useEffect(() => {
    function sync() {
      const current = getSupportSession();
      setSession(current);
      setRemainingMs(current ? Math.max(0, new Date(current.expires_at).getTime() - Date.now()) : 0);
    }
    window.addEventListener(SUPPORT_SESSION_EVENT, sync);
    return () => window.removeEventListener(SUPPORT_SESSION_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => {
      const left = Math.max(0, new Date(session.expires_at).getTime() - Date.now());
      setRemainingMs(left);
      if (left <= 0) {
        setSupportSession(null);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [session]);

  if (!session) return null;

  async function handleEndSupport() {
    if (!session) return;
    setEnding(true);
    try {
      await endAdminSupportSession(session.id);
    } catch {
      // Clear local session even if already expired/ended on server
    } finally {
      setSupportSession(null);
      setEnding(false);
      navigate({ to: '/admin' });
    }
  }

  return (
    <div
      role="status"
      aria-label="Sesión de soporte activa"
      className="bg-amber-100 border-b border-amber-300 text-amber-950 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Headset className="w-4 h-4 text-amber-700 shrink-0" />
        <span className="truncate">
          <strong>Sesión de soporte (Solo lectura):</strong> {session.organization_name} · Expira en{' '}
          <span className="font-mono font-semibold">{formatRemaining(remainingMs)}</span>
        </span>
      </div>
      <button
        type="button"
        disabled={ending}
        onClick={handleEndSupport}
        className="px-2.5 py-1 rounded-lg bg-amber-900 text-white font-medium hover:bg-amber-800 disabled:opacity-50 cursor-pointer shrink-0"
      >
        {ending ? 'Saliendo...' : 'Salir de soporte'}
      </button>
    </div>
  );
}

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

  const visibleItems = NAV_ITEMS.filter((item) => hasMinRole(user?.role, item.minRole));
  const navItems = user?.is_platform_admin
    ? [...visibleItems, { to: '/admin', label: 'Super-Admin', icon: Shield, matchPrefixes: ['/admin'] }]
    : visibleItems;

  const isNavActive = (item: { to: string; matchPrefixes?: string[] }) =>
    item.matchPrefixes ? item.matchPrefixes.some((p) => pathname.startsWith(p)) : pathname.startsWith(item.to);

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
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isNavActive(item);
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
        <ActiveSupportSessionBanner />

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
          { to: '/app/kanban', label: 'Embudos', icon: Kanban, matchPrefixes: ['/app/kanban', '/app/pipelines', '/app/leads'] },
          { to: '/app/contacts', label: 'Contactos', icon: Users },
          { to: '/app/crm', label: 'CRM', icon: Briefcase },
        ].map((item) => {
          const Icon = item.icon;
          const active = isNavActive(item);
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
          {navItems.map((item) => {
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
