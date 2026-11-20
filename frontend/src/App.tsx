import React, { Component, createContext, useContext, useEffect, useState } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  redirect,
} from '@tanstack/react-router';
import { apiFetch, getToken, setSupportSession, setToken } from './lib/api';
import { AppShell } from './components/shell/AppShell';
import { LandingPage } from './pages/LandingPage';
import {
  ForgotPasswordPage,
  LoginPage,
  MfaLoginPage,
  RecoveryCodePage,
  ResetPasswordPage,
  SignupPage,
} from './pages/AuthPages';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { OnboardingPage } from './pages/OnboardingPage';
import {
  ForbiddenPage,
  McpConsentPage,
  NotFoundPage,
  PrivacyPage,
  ServerErrorPage,
  TermsPage,
} from './pages/LegalPages';
import { TeamPage } from './pages/TeamPage';
import { SettingsPage } from './pages/SettingsPage';
import { InboxPage } from './pages/InboxPage';
import { KanbanPage } from './pages/KanbanPage';
import { ContactsPage } from './pages/ContactsPage';
import { ContactDetailPage } from './pages/ContactDetailPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { RadarPage } from './pages/RadarPage';
import { AIPage } from './pages/AIPage';
import { AdminPage } from './pages/AdminPage';
import { CrmHubPage } from './pages/CrmHubPage';
import { LeadDetailPage } from './pages/LeadDetailPage';
import { ProductsPage } from './pages/ProductsPage';
import { TasksPage } from './pages/TasksPage';
import {
  ActivitiesPage,
  AuditPage,
  ChannelsPage,
  LGPDPage,
  MetricsPage,
  WebhooksPage,
} from './pages/OperationsPages';

interface AuthCtx {
  user: any;
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthCtx>({
  user: null,
  refreshUser: async () => {},
  logout: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

class ErrorBoundary extends Component<{ children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return <ServerErrorPage onRetry={() => this.setState({ hasError: false })} />;
    }
    return this.props.children;
  }
}

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<any>(null);
  const [ready, setReady] = useState(false);

  async function refreshUser() {
    if (!getToken()) {
      setUser(null);
      setReady(true);
      return;
    }
    try {
      const me = await apiFetch('/auth/me');
      setUser(me);
    } catch {
      if (!getToken()) {
        setUser(null);
      }
    } finally {
      setReady(true);
    }
  }

  useEffect(() => {
    refreshUser();
  }, []);

  async function logout() {
    setSupportSession(null);
    await apiFetch('/auth/logout', { method: 'POST' }).catch(() => {});
    setToken(null);
    setUser(null);
    window.location.href = '/login';
  }

  if (!ready) {
    return (
      <div className="min-h-dvh flex items-center justify-center text-sm text-[var(--text-muted)]">
        Cargando KoraCRM...
      </div>
    );
  }

  return <AuthContext.Provider value={{ user, refreshUser, logout }}>{children}</AuthContext.Provider>;
}

function AppShellWrapper() {
  const { user, logout } = useContext(AuthContext);
  return (
    <AppShell user={user} onLogout={logout}>
      <Outlet />
    </AppShell>
  );
}

function AdminPageWrapper() {
  const { user, logout } = useContext(AuthContext);
  return (
    <AppShell user={user} onLogout={logout}>
      <AdminPage user={user} />
    </AppShell>
  );
}

function LoginWrapper() {
  const { refreshUser } = useContext(AuthContext);
  return <LoginPage onAuth={refreshUser} />;
}

function MfaLoginWrapper() {
  const { refreshUser } = useContext(AuthContext);
  return <MfaLoginPage onAuth={refreshUser} />;
}

function RecoveryCodeWrapper() {
  const { refreshUser } = useContext(AuthContext);
  return <RecoveryCodePage onAuth={refreshUser} />;
}

function SignupWrapper() {
  const { refreshUser } = useContext(AuthContext);
  return <SignupPage onAuth={refreshUser} />;
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: LandingPage });
const getStartedRoute = createRoute({ getParentRoute: () => rootRoute, path: '/get-started', component: LandingPage });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginWrapper });
const forgotRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login/forgot', component: ForgotPasswordPage });
const resetRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login/reset', component: ResetPasswordPage });
const mfaRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login/mfa', component: MfaLoginWrapper });
const recoveryRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login/recovery', component: RecoveryCodeWrapper });
const signupRoute = createRoute({ getParentRoute: () => rootRoute, path: '/signup', component: SignupWrapper });
const acceptInviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/team/accept-invite/$token',
  component: AcceptInvitePage,
});

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: OnboardingPage,
});

const onboardingStepRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding/$step',
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: OnboardingPage,
});

const privacyRoute = createRoute({ getParentRoute: () => rootRoute, path: '/legal/privacy', component: PrivacyPage });
const termsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/legal/terms', component: TermsPage });
const forbiddenRoute = createRoute({ getParentRoute: () => rootRoute, path: '/403', component: ForbiddenPage });
const serverErrorRoute = createRoute({ getParentRoute: () => rootRoute, path: '/500', component: ServerErrorPage });
const mcpConsentRoute = createRoute({ getParentRoute: () => rootRoute, path: '/oauth/mcp/consent', component: McpConsentPage });

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: AdminPageWrapper,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/app',
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: AppShellWrapper,
});

const crmHubRoute = createRoute({ getParentRoute: () => appRoute, path: '/crm', component: CrmHubPage });
const inboxRoute = createRoute({ getParentRoute: () => appRoute, path: '/inbox', component: InboxPage });
const inboxDetailRoute = createRoute({ getParentRoute: () => appRoute, path: '/inbox/$id', component: InboxPage });
const radarRoute = createRoute({ getParentRoute: () => appRoute, path: '/radar', component: RadarPage });
const templatesRoute = createRoute({ getParentRoute: () => appRoute, path: '/templates', component: TemplatesPage });
const kanbanRoute = createRoute({ getParentRoute: () => appRoute, path: '/kanban', component: KanbanPage });
const pipelineDetailRoute = createRoute({ getParentRoute: () => appRoute, path: '/pipelines/$id', component: KanbanPage });
const leadDetailRoute = createRoute({ getParentRoute: () => appRoute, path: '/leads/$id', component: LeadDetailPage });
const contactsRoute = createRoute({ getParentRoute: () => appRoute, path: '/contacts', component: ContactsPage });
const contactDetailRoute = createRoute({ getParentRoute: () => appRoute, path: '/contacts/$id', component: ContactDetailPage });
const tasksRoute = createRoute({ getParentRoute: () => appRoute, path: '/tasks', component: TasksPage });
const productsRoute = createRoute({ getParentRoute: () => appRoute, path: '/products', component: ProductsPage });
const aiRoute = createRoute({ getParentRoute: () => appRoute, path: '/ai', component: AIPage });
const aiAgentsRoute = createRoute({ getParentRoute: () => appRoute, path: '/ai/agents', component: AIPage });
const aiFollowupsRoute = createRoute({ getParentRoute: () => appRoute, path: '/ai/followups', component: AIPage });
const aiRoutersRoute = createRoute({ getParentRoute: () => appRoute, path: '/ai/routers', component: AIPage });
const aiProvidersRoute = createRoute({ getParentRoute: () => appRoute, path: '/ai/providers', component: AIPage });
const aiUsageRoute = createRoute({ getParentRoute: () => appRoute, path: '/ai/usage', component: AIPage });
const aiRunsRoute = createRoute({ getParentRoute: () => appRoute, path: '/ai/runs', component: AIPage });
const aiKnowledgeRoute = createRoute({ getParentRoute: () => appRoute, path: '/ai/knowledge', component: AIPage });
const aiMemoryRoute = createRoute({ getParentRoute: () => appRoute, path: '/ai/memory', component: AIPage });
const aiSkillsRoute = createRoute({ getParentRoute: () => appRoute, path: '/ai/skills', component: AIPage });
const aiCasesRoute = createRoute({ getParentRoute: () => appRoute, path: '/ai/cases', component: AIPage });
const aiInboxRoute = createRoute({ getParentRoute: () => appRoute, path: '/ai/inbox', component: AIPage });
const channelsRoute = createRoute({ getParentRoute: () => appRoute, path: '/channels', component: ChannelsPage });
const webhooksRoute = createRoute({ getParentRoute: () => appRoute, path: '/webhooks', component: WebhooksPage });
const metricsRoute = createRoute({ getParentRoute: () => appRoute, path: '/metrics', component: MetricsPage });
const activitiesRoute = createRoute({ getParentRoute: () => appRoute, path: '/activities', component: ActivitiesPage });
const auditRoute = createRoute({ getParentRoute: () => appRoute, path: '/audit', component: AuditPage });
const lgpdRoute = createRoute({ getParentRoute: () => appRoute, path: '/lgpd', component: LGPDPage });
const lgpdRequestsRoute = createRoute({ getParentRoute: () => appRoute, path: '/lgpd/requests', component: LGPDPage });
const teamRoute = createRoute({ getParentRoute: () => appRoute, path: '/team', component: TeamPage });
const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: '/settings', component: SettingsPage });
const apiTokensRoute = createRoute({ getParentRoute: () => appRoute, path: '/settings/api-tokens', component: SettingsPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  getStartedRoute,
  loginRoute,
  forgotRoute,
  resetRoute,
  mfaRoute,
  recoveryRoute,
  signupRoute,
  acceptInviteRoute,
  onboardingRoute,
  onboardingStepRoute,
  privacyRoute,
  termsRoute,
  forbiddenRoute,
  serverErrorRoute,
  mcpConsentRoute,
  adminRoute,
  appRoute.addChildren([
    crmHubRoute,
    inboxRoute,
    inboxDetailRoute,
    radarRoute,
    templatesRoute,
    kanbanRoute,
    pipelineDetailRoute,
    leadDetailRoute,
    contactsRoute,
    contactDetailRoute,
    tasksRoute,
    productsRoute,
    aiRoute,
    aiAgentsRoute,
    aiFollowupsRoute,
    aiRoutersRoute,
    aiProvidersRoute,
    aiUsageRoute,
    aiRunsRoute,
    aiKnowledgeRoute,
    aiMemoryRoute,
    aiSkillsRoute,
    aiCasesRoute,
    aiInboxRoute,
    channelsRoute,
    webhooksRoute,
    metricsRoute,
    activitiesRoute,
    auditRoute,
    lgpdRoute,
    lgpdRequestsRoute,
    teamRoute,
    settingsRoute,
    apiTokensRoute,
  ]),
]);

const router = createRouter({ routeTree, defaultNotFoundComponent: NotFoundPage });

export function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
