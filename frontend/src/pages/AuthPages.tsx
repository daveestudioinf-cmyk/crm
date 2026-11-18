import React, { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { apiFetch, setToken } from '../lib/api';
import { Button, Card, Input } from '../components/ui/primitives';

export function LoginPage({ onAuth }: { onAuth: () => Promise<void> }) {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mfaToken) {
        const res = await apiFetch('/auth/mfa/verify', {
          method: 'POST',
          body: JSON.stringify({ mfa_token: mfaToken, code: mfaCode }),
        });
        setToken(res.access_token);
        await onAuth();
        nav({ to: '/app/inbox' });
        return;
      }
      const res = await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      if (res.mfa_required) {
        setMfaToken(res.mfa_token);
        setLoading(false);
        return;
      }
      setToken(res.access_token);
      await onAuth();
      nav({ to: '/app/inbox' });
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center p-4 bg-[var(--surface)]">
      <Card className="w-full max-w-md p-6 space-y-5">
        <div className="flex items-center gap-2.5">
          <img src="/icon.svg" alt="KoraCRM" className="w-8 h-8 rounded-lg" />
          <div>
            <h1 className="text-xl font-bold">Sign in to KoraCRM</h1>
            <p className="text-xs text-[var(--text-muted)]">Access your WhatsApp Sales OS workspace</p>
          </div>
        </div>
        {error && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-[var(--danger)]">{error}</div>}
        <form onSubmit={handleSubmit} className="space-y-4">
          {!mfaToken ? (
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium">Email</label>
                <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Password</label>
                <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
              </div>
            </>
          ) : (
            <div className="space-y-1">
              <label className="text-xs font-medium">Authenticator Code (TOTP)</label>
              <Input required value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} placeholder="123456" />
            </div>
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Signing in...' : mfaToken ? 'Verify MFA' : 'Sign in'}
          </Button>
        </form>
        <div className="text-center text-xs text-[var(--text-muted)]">
          New to KoraCRM? <Link to="/signup" className="text-[var(--accent)] font-medium">Create an organization</Link>
        </div>
      </Card>
    </div>
  );
}

export function SignupPage({ onAuth }: { onAuth: () => Promise<void> }) {
  const nav = useNavigate();
  const [orgName, setOrgName] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch('/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ org_name: orgName, full_name: fullName, email, password }),
      });
      setToken(res.access_token);
      await onAuth();
      nav({ to: '/app/inbox' });
    } catch (err: any) {
      setError(err.message || 'Signup failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center p-4 bg-[var(--surface)]">
      <Card className="w-full max-w-md p-6 space-y-5">
        <div className="flex items-center gap-2.5">
          <img src="/icon.svg" alt="KoraCRM" className="w-8 h-8 rounded-lg" />
          <div>
            <h1 className="text-xl font-bold">Create your CRM Workspace</h1>
            <p className="text-xs text-[var(--text-muted)]">Provisions Sales & Support pipelines + AI Agent</p>
          </div>
        </div>
        {error && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-[var(--danger)]">{error}</div>}
        <form onSubmit={handleSubmit} className="space-y-3.5">
          <div className="space-y-1">
            <label className="text-xs font-medium">Organization Name</label>
            <Input required value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Acme Commerce" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Your Name</label>
            <Input required value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Ana Silva" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Email</label>
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ana@acme.com" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Password (min 6 chars)</label>
            <Input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Creating workspace...' : 'Create Workspace'}
          </Button>
        </form>
        <div className="text-center text-xs text-[var(--text-muted)]">
          Already have an account? <Link to="/login" className="text-[var(--accent)] font-medium">Sign in</Link>
        </div>
      </Card>
    </div>
  );
}
