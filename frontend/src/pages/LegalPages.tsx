import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { AlertTriangle, CheckCircle2, FileText, Lock, ShieldAlert, ShieldCheck } from 'lucide-react';
import { apiFetch, getToken } from '../lib/api';
import { Badge, Button, Card } from '../components/ui/primitives';

function PublicLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-[var(--surface)] text-[var(--text)] flex flex-col">
      <header className="border-b border-[var(--border)] bg-[var(--bg)] px-4 md:px-8 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5 min-w-0">
          <img src="/icon.svg" alt="KoraCRM" className="w-7 h-7 rounded-lg shrink-0" />
          <span className="font-bold text-base tracking-tight truncate">KoraCRM</span>
        </Link>
        <div className="flex items-center gap-2 shrink-0">
          <Link to="/login">
            <Button variant="ghost" size="sm">Iniciar sesión</Button>
          </Link>
          <Link to="/signup">
            <Button size="sm">Comenzar</Button>
          </Link>
        </div>
      </header>
      <main className="flex-1 max-w-3xl w-full mx-auto px-4 md:px-8 py-8 md:py-12 space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-[var(--text-muted)]">{subtitle}</p>}
        </div>
        {children}
      </main>
      <footer className="border-t border-[var(--border)] bg-[var(--bg)] px-4 md:px-8 py-5 text-xs text-[var(--text-muted)]">
        <div className="max-w-3xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <span>© {new Date().getFullYear()} KoraCRM. Todos los derechos reservados.</span>
          <div className="flex flex-wrap items-center gap-4">
            <Link to="/legal/privacy" className="hover:text-[var(--text)] underline-offset-2 hover:underline">
              Política de Privacidad
            </Link>
            <Link to="/legal/terms" className="hover:text-[var(--text)] underline-offset-2 hover:underline">
              Términos de Servicio
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <PublicLayout
      title="Política de Privacidad y Cumplimiento LGPD"
      subtitle="Última actualización: Noviembre 2026 · KoraCRM"
    >
      <Card className="p-5 md:p-6 space-y-4 text-sm leading-relaxed text-[var(--text)]">
        <div className="flex items-center gap-2 text-[var(--accent)] font-semibold">
          <ShieldCheck className="w-4 h-4 shrink-0" />
          <span>1. Responsable y Aislamiento Multi-Tenant</span>
        </div>
        <p className="text-[var(--text-muted)]">
          KoraCRM procesa los datos de contactos, conversaciones de WhatsApp, oportunidades y archivos exclusivamente dentro del espacio aislado (<code className="font-mono text-xs">organization_id</code>) de cada organización cliente.
        </p>

        <div className="flex items-center gap-2 text-[var(--accent)] font-semibold pt-2">
          <FileText className="w-4 h-4 shrink-0" />
          <span>2. Derechos del Titular (LGPD)</span>
        </div>
        <p className="text-[var(--text-muted)]">
          Los titulares de datos pueden solicitar en cualquier momento la exportación estructurada en formato JSON de su historial o la anonimización en cascada de sus datos personales a través del módulo de Cumplimiento LGPD.
        </p>

        <div className="flex items-center gap-2 text-[var(--accent)] font-semibold pt-2">
          <Lock className="w-4 h-4 shrink-0" />
          <span>3. Seguridad, Cifrado y Auditoría</span>
        </div>
        <p className="text-[var(--text-muted)]">
          Las credenciales de proveedores de IA se almacenan cifradas con AES-256-GCM. Todas las mutaciones administrativas y de datos sensibles quedan registradas en un historial de auditoría inmutable.
        </p>
      </Card>
    </PublicLayout>
  );
}

export function TermsPage() {
  return (
    <PublicLayout
      title="Términos de Servicio"
      subtitle="Condiciones de uso de la plataforma KoraCRM"
    >
      <Card className="p-5 md:p-6 space-y-4 text-sm leading-relaxed text-[var(--text)]">
        <h2 className="font-semibold text-base">1. Uso Aceptable y Mensajería</h2>
        <p className="text-[var(--text-muted)]">
          El cliente se compromete a utilizar los canales de WhatsApp y las campañas automatizadas respetando el consentimiento previo de los destinatarios, las ventanas de atención y los límites de calentamiento configurados en la plataforma.
        </p>
        <h2 className="font-semibold text-base">2. Cuentas, Roles y Seguridad</h2>
        <p className="text-[var(--text-muted)]">
          Cada organización administra sus propios usuarios, roles (Visor, Agente, Gerente, Administrador), tokens API y autenticación multifactor (MFA TOTP). El acceso de soporte técnico temporal se realiza únicamente bajo sesiones auditadas.
        </p>
        <h2 className="font-semibold text-base">3. Disponibilidad y Propiedad de los Datos</h2>
        <p className="text-[var(--text-muted)]">
          Todos los datos ingresados por la organización pertenecen exclusivamente a la organización. KoraCRM proporciona herramientas de exportación estándar y API REST/MCP para portabilidad completa.
        </p>
      </Card>
    </PublicLayout>
  );
}

export function NotFoundPage() {
  return (
    <div className="min-h-dvh bg-[var(--surface)] text-[var(--text)] flex items-center justify-center p-4">
      <Card className="w-full max-w-md p-6 text-center space-y-4">
        <div className="mx-auto w-12 h-12 rounded-full bg-teal-50 border border-teal-200 flex items-center justify-center text-[var(--accent)]">
          <AlertTriangle className="w-6 h-6" />
        </div>
        <div className="space-y-1">
          <div className="text-xs font-mono font-semibold text-[var(--accent)]">ERROR 404</div>
          <h1 className="text-xl font-bold">Página no encontrada</h1>
          <p className="text-sm text-[var(--text-muted)]">
            La ruta que buscas no existe o fue movida dentro de KoraCRM.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2 pt-2">
          <Link to="/app/inbox">
            <Button>Ir a la Bandeja</Button>
          </Link>
          <Link to="/">
            <Button variant="secondary">Ir al inicio</Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}

export function ForbiddenPage() {
  return (
    <div className="min-h-dvh bg-[var(--surface)] text-[var(--text)] flex items-center justify-center p-4">
      <Card className="w-full max-w-md p-6 text-center space-y-4">
        <div className="mx-auto w-12 h-12 rounded-full bg-red-50 border border-red-200 flex items-center justify-center text-[var(--danger)]">
          <ShieldAlert className="w-6 h-6" />
        </div>
        <div className="space-y-1">
          <div className="text-xs font-mono font-semibold text-[var(--danger)]">ERROR 403</div>
          <h1 className="text-xl font-bold">Acceso denegado</h1>
          <p className="text-sm text-[var(--text-muted)]">
            No tienes permisos suficientes para acceder a este recurso o realizar esta acción.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2 pt-2">
          <Link to="/app/inbox">
            <Button>Volver a la Bandeja</Button>
          </Link>
          <Link to="/login">
            <Button variant="secondary">Iniciar sesión</Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}

export function ServerErrorPage({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="min-h-dvh bg-[var(--surface)] text-[var(--text)] flex items-center justify-center p-4">
      <Card className="w-full max-w-md p-6 text-center space-y-4">
        <div className="mx-auto w-12 h-12 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center text-[var(--warning)]">
          <AlertTriangle className="w-6 h-6" />
        </div>
        <div className="space-y-1">
          <div className="text-xs font-mono font-semibold text-[var(--warning)]">ERROR 500</div>
          <h1 className="text-xl font-bold">Error del servidor</h1>
          <p className="text-sm text-[var(--text-muted)]">
            Ocurrió un problema inesperado al procesar tu solicitud. Intenta nuevamente en unos momentos.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2 pt-2">
          {onRetry ? (
            <Button onClick={onRetry}>Reintentar</Button>
          ) : (
            <Button onClick={() => window.location.reload()}>Recargar página</Button>
          )}
          <Link to="/">
            <Button variant="secondary">Ir al inicio</Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}

export function McpConsentPage() {
  const navigate = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const clientName = params.get('client_name') || params.get('client_id') || 'Cliente MCP Externo';
  const rawScope = params.get('scope') || params.get('scopes') || 'crm:read crm:write inbox:read';
  const scopes = rawScope.split(/[\s,]+/).filter(Boolean);
  const redirectUri = params.get('redirect_uri') || '';
  const stateParam = params.get('state') || '';

  const [isAuth] = useState(() => Boolean(getToken()));
  const [loading, setLoading] = useState(false);
  const [issuedToken, setIssuedToken] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!getToken()) {
      navigate({ to: '/login' });
    }
  }, [navigate]);

  if (!isAuth) {
    return (
      <div className="min-h-dvh flex items-center justify-center p-4 text-sm text-[var(--text-muted)]">
        Redirigiendo a inicio de sesión...
      </div>
    );
  }

  async function handleApprove() {
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ id: string; name: string; token: string }>('/api-tokens', {
        method: 'POST',
        body: JSON.stringify({ name: `MCP: ${clientName}`, scopes }),
      });
      if (redirectUri) {
        try {
          const url = new URL(redirectUri);
          url.searchParams.set('token', res.token);
          if (stateParam) url.searchParams.set('state', stateParam);
          window.location.href = url.toString();
          return;
        } catch {
          // Si redirect_uri no es URL absoluta válida, mostramos el token aquí
        }
      }
      setIssuedToken(res.token);
    } catch (err: any) {
      setError(err.message || 'No se pudo autorizar el acceso MCP.');
    } finally {
      setLoading(false);
    }
  }

  function handleDeny() {
    if (redirectUri) {
      try {
        const url = new URL(redirectUri);
        url.searchParams.set('error', 'access_denied');
        if (stateParam) url.searchParams.set('state', stateParam);
        window.location.href = url.toString();
        return;
      } catch {
        // fallback
      }
    }
    navigate({ to: '/app/settings/api-tokens' });
  }

  return (
    <div className="min-h-dvh bg-[var(--surface)] text-[var(--text)] flex items-center justify-center p-4">
      <Card className="w-full max-w-md p-6 space-y-5">
        <div className="flex items-center gap-3">
          <img src="/icon.svg" alt="KoraCRM" className="w-9 h-9 rounded-lg shrink-0" />
          <div className="min-w-0">
            <h1 className="text-lg font-bold truncate">Consentimiento de acceso MCP</h1>
            <p className="text-xs text-[var(--text-muted)] truncate">
              <strong className="text-[var(--text)]">{clientName}</strong> solicita acceso a tu CRM
            </p>
          </div>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-[var(--danger)]">
            {error}
          </div>
        )}

        {issuedToken ? (
          <div className="space-y-4">
            <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 space-y-2">
              <div className="flex items-center gap-1.5 font-semibold">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>Acceso MCP autorizado</span>
              </div>
              <p>Copia este token Bearer ahora (solo se muestra una vez):</p>
              <code className="block p-2 rounded bg-[var(--bg)] border border-[var(--border)] font-mono text-[11px] break-all">
                {issuedToken}
              </code>
            </div>
            <div className="flex gap-2">
              <Button
                className="flex-1"
                onClick={() => navigator.clipboard?.writeText(issuedToken)}
              >
                Copiar token
              </Button>
              <Link to="/app/settings/api-tokens" className="flex-1">
                <Button variant="secondary" className="w-full">Ver tokens</Button>
              </Link>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <div className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                Permisos solicitados (Scopes)
              </div>
              <div className="flex flex-wrap gap-1.5">
                {scopes.map((sc) => (
                  <Badge key={sc} tone="accent">{sc}</Badge>
                ))}
              </div>
              <p className="text-xs text-[var(--text-muted)] pt-1">
                Al autorizar, el cliente podrá ejecutar las herramientas MCP de KoraCRM dentro de tu organización. Puedes revocar el acceso en cualquier momento desde Configuración.
              </p>
            </div>

            <div className="flex flex-wrap gap-2 pt-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={handleDeny}
                disabled={loading}
              >
                Denegar
              </Button>
              <Button
                className="flex-1"
                onClick={handleApprove}
                disabled={loading}
              >
                {loading ? 'Autorizando...' : 'Autorizar acceso'}
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
