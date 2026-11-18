import React, { createContext, useContext, useEffect, useState } from 'react';
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
import { LoginPage, SignupPage } from './pages/AuthPages';
import { InboxPage } from './pages/InboxPage';
import { KanbanPage } from './pages/KanbanPage';
import { ContactsPage } from './pages/ContactsPage';
import { AIPage } from './pages/AIPage';
import { AdminPage } from './pages/AdminPage';
import {
  ChannelsPage,
  LGPDPage,
  MetricsPage,
  RadarPage,
  SettingsPage,
  TasksPage,
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
    return <div className="min-h-dvh flex items-center justify-center text-sm text-[var(--text-muted)]">Cargando KoraCRM...</div>;
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

function SignupWrapper() {
  const { refreshUser } = useContext(AuthContext);
  return <SignupPage onAuth={refreshUser} />;
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: LandingPage });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginWrapper });
const signupRoute = createRoute({ getParentRoute: () => rootRoute, path: '/signup', component: SignupWrapper });

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

const inboxRoute = createRoute({ getParentRoute: () => appRoute, path: '/inbox', component: InboxPage });
const radarRoute = createRoute({ getParentRoute: () => appRoute, path: '/radar', component: RadarPage });
const kanbanRoute = createRoute({ getParentRoute: () => appRoute, path: '/kanban', component: KanbanPage });
const contactsRoute = createRoute({ getParentRoute: () => appRoute, path: '/contacts', component: ContactsPage });
const tasksRoute = createRoute({ getParentRoute: () => appRoute, path: '/tasks', component: TasksPage });
const aiRoute = createRoute({ getParentRoute: () => appRoute, path: '/ai', component: AIPage });
const channelsRoute = createRoute({ getParentRoute: () => appRoute, path: '/channels', component: ChannelsPage });
const webhooksRoute = createRoute({ getParentRoute: () => appRoute, path: '/webhooks', component: WebhooksPage });
const metricsRoute = createRoute({ getParentRoute: () => appRoute, path: '/metrics', component: MetricsPage });
const lgpdRoute = createRoute({ getParentRoute: () => appRoute, path: '/lgpd', component: LGPDPage });
const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: '/settings', component: SettingsPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  signupRoute,
  adminRoute,
  appRoute.addChildren([
    inboxRoute,
    radarRoute,
    kanbanRoute,
    contactsRoute,
    tasksRoute,
    aiRoute,
    channelsRoute,
    webhooksRoute,
    metricsRoute,
    lgpdRoute,
    settingsRoute,
  ]),
]);

const router = createRouter({ routeTree, defaultNotFoundComponent: LandingPage });

export function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}

export default App;
