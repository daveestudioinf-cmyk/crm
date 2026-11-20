import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Kanban,
  Users,
  CheckSquare,
  Package,
  FileText,
  Flame,
  BarChart3,
  Webhook,
  Settings,
  ArrowRight,
  RefreshCw,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAuth } from '../App';
import { Badge, Button, Card } from '../components/ui/primitives';

interface HubSummary {
  pipelines: number;
  contacts: number;
  tasksPending: number;
  products: number;
}

const ROLE_ORDER: Record<string, number> = {
  viewer: 0,
  agent: 1,
  manager: 2,
  admin: 3,
};

export function CrmHubPage() {
  const { user } = useAuth();
  const [summary, setSummary] = useState<HubSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function fetchSummary() {
    try {
      const [pipes, contacts, tasks, products] = await Promise.all([
        apiFetch<any[]>('/pipelines'),
        apiFetch<any[]>('/contacts'),
        apiFetch<any[]>('/tasks'),
        apiFetch<any[]>('/products'),
      ]);
      const pendingCount = (tasks || []).filter(
        (t) => t.status === 'pending' || t.status === 'in_progress'
      ).length;
      setSummary({
        pipelines: (pipes || []).length,
        contacts: (contacts || []).length,
        tasksPending: pendingCount,
        products: (products || []).length,
      });
      setError('');
    } catch (err: any) {
      setError(err?.message || 'No se pudo cargar el resumen del CRM.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [pipes, contacts, tasks, products] = await Promise.all([
          apiFetch<any[]>('/pipelines'),
          apiFetch<any[]>('/contacts'),
          apiFetch<any[]>('/tasks'),
          apiFetch<any[]>('/products'),
        ]);
        if (!active) return;
        const pendingCount = (tasks || []).filter(
          (t) => t.status === 'pending' || t.status === 'in_progress'
        ).length;
        setSummary({
          pipelines: (pipes || []).length,
          contacts: (contacts || []).length,
          tasksPending: pendingCount,
          products: (products || []).length,
        });
        setError('');
      } catch (err: any) {
        if (!active) return;
        setError(err?.message || 'No se pudo cargar el resumen del CRM.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const roleRank = ROLE_ORDER[user?.role || 'viewer'] ?? 0;

  const coreDestinations = [
    {
      to: '/app/kanban',
      title: 'Embudos y Oportunidades',
      description: 'Gestiona tus pipelines de ventas y soporte, mueve leads y realiza acciones masivas.',
      icon: Kanban,
      metric: summary ? `${summary.pipelines} embudos` : '—',
      tone: 'accent' as const,
    },
    {
      to: '/app/contacts',
      title: 'Contactos 360°',
      description: 'Directorio unificado con teléfonos E.164, CPF, historial y cola de fusión.',
      icon: Users,
      metric: summary ? `${summary.contacts} contactos` : '—',
      tone: 'neutral' as const,
    },
    {
      to: '/app/tasks',
      title: 'Tareas y Planes',
      description: 'Seguimientos con fecha límite, recurrencia y plantillas de planes de tareas.',
      icon: CheckSquare,
      metric: summary ? `${summary.tasksPending} pendientes` : '—',
      tone: 'warning' as const,
    },
    {
      to: '/app/products',
      title: 'Catálogo de Productos',
      description: 'Administra productos, SKU, categorías, precios y stock para ventas e IA.',
      icon: Package,
      metric: summary ? `${summary.products} productos` : '—',
      tone: 'success' as const,
    },
    {
      to: '/app/templates',
      title: 'Plantillas de Respuesta',
      description: 'Atajos rápidos con `/` para responder más rápido desde la bandeja.',
      icon: FileText,
      metric: 'Respuestas rápidas',
      tone: 'neutral' as const,
    },
    {
      to: '/app/radar',
      title: 'Radar de Enfriamiento',
      description: 'Detecta conversaciones abiertas sin respuesta reciente antes de perder oportunidades.',
      icon: Flame,
      metric: 'Monitoreo activo',
      tone: 'danger' as const,
    },
  ];

  const managerDestinations = [
    {
      to: '/app/metrics',
      title: 'Analítica y Rendimiento',
      description: 'Métricas del embudo, tasa de conversión y desempeño del equipo.',
      icon: BarChart3,
      metric: 'Reportes',
      tone: 'accent' as const,
    },
    {
      to: '/app/webhooks',
      title: 'Automatizaciones y Webhooks',
      description: 'Captura automática de leads y reglas WHEN/IF/THEN.',
      icon: Webhook,
      metric: 'Flujos',
      tone: 'neutral' as const,
    },
    {
      to: '/app/settings',
      title: 'Configuración de Organización',
      description: 'Ajustes del espacio de trabajo, tokens API y seguridad.',
      icon: Settings,
      metric: 'Ajustes',
      tone: 'neutral' as const,
    },
  ];

  const visibleManagerCards = roleRank >= 2 ? managerDestinations : [];

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-[var(--text)]">Centro CRM</h1>
          <p className="text-xs text-[var(--text-muted)]">
            Acceso rápido a tus embudos, contactos, tareas, catálogo y herramientas comerciales
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setLoading(true);
            fetchSummary();
          }}
          disabled={loading}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Actualizar
        </Button>
      </div>

      {error && (
        <div className="px-3.5 py-2.5 rounded-xl border border-red-200 bg-red-50 text-xs text-red-800">
          {error}
        </div>
      )}

      {/* Resumen rápido */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-4 min-w-0">
          <div className="text-xs text-[var(--text-muted)]">Embudos activos</div>
          <div className="text-2xl font-bold mt-1 text-[var(--text)]">
            {loading ? '...' : summary?.pipelines ?? 0}
          </div>
        </Card>
        <Card className="p-4 min-w-0">
          <div className="text-xs text-[var(--text-muted)]">Contactos</div>
          <div className="text-2xl font-bold mt-1 text-[var(--text)]">
            {loading ? '...' : summary?.contacts ?? 0}
          </div>
        </Card>
        <Card className="p-4 min-w-0">
          <div className="text-xs text-[var(--text-muted)]">Tareas pendientes</div>
          <div className="text-2xl font-bold mt-1 text-[var(--text)]">
            {loading ? '...' : summary?.tasksPending ?? 0}
          </div>
        </Card>
        <Card className="p-4 min-w-0">
          <div className="text-xs text-[var(--text-muted)]">Productos</div>
          <div className="text-2xl font-bold mt-1 text-[var(--text)]">
            {loading ? '...' : summary?.products ?? 0}
          </div>
        </Card>
      </div>

      {/* HubSectionGrid: Operación Comercial */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-[var(--text)]">Operación Comercial</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {coreDestinations.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.to} to={item.to} className="group block min-w-0">
                <Card className="p-4 h-full flex flex-col justify-between gap-3 transition-colors hover:border-[var(--accent)]">
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="w-9 h-9 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex items-center justify-center text-[var(--accent)]">
                        <Icon className="w-4 h-4" />
                      </div>
                      <Badge tone={item.tone}>{item.metric}</Badge>
                    </div>
                    <div>
                      <div className="font-semibold text-sm text-[var(--text)] group-hover:text-[var(--accent)] transition-colors">
                        {item.title}
                      </div>
                      <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                        {item.description}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 text-xs font-medium text-[var(--accent)]">
                    Abrir módulo <ArrowRight className="w-3.5 h-3.5" />
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      </section>

      {/* HubSectionGrid: Administración (solo manager/admin) */}
      {visibleManagerCards.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text)]">Gestión y Analítica</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
            {visibleManagerCards.map((item) => {
              const Icon = item.icon;
              return (
                <Link key={item.to} to={item.to} className="group block min-w-0">
                  <Card className="p-4 h-full flex flex-col justify-between gap-3 transition-colors hover:border-[var(--accent)]">
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="w-9 h-9 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex items-center justify-center text-[var(--accent)]">
                          <Icon className="w-4 h-4" />
                        </div>
                        <Badge tone={item.tone}>{item.metric}</Badge>
                      </div>
                      <div>
                        <div className="font-semibold text-sm text-[var(--text)] group-hover:text-[var(--accent)] transition-colors">
                          {item.title}
                        </div>
                        <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                          {item.description}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 text-xs font-medium text-[var(--accent)]">
                      Configurar <ArrowRight className="w-3.5 h-3.5" />
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
