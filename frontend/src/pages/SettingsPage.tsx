import React, { useCallback, useEffect, useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { Building2, Check, Copy, Key, RefreshCw, ShieldCheck, User } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAuth } from '../App';
import { Badge, Button, Card, Input, Sheet } from '../components/ui/primitives';

type SettingsTab = 'profile' | 'org' | 'tokens';

interface OrgData {
  id: string;
  name: string;
  slug?: string;
  branding?: { display_name?: string; primary_color?: string };
  settings?: {
    niche?: string;
    onboarding_completed?: boolean;
    pipeline_vocabulary?: { deal?: string; deals?: string; stage?: string };
  };
}

export function SettingsPage() {
  const { user, refreshUser } = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isTokensRoute = pathname.startsWith('/app/settings/api-tokens');

  const [tab, setTab] = useState<SettingsTab>(isTokensRoute ? 'tokens' : 'profile');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Profile & Security
  const [fullName, setFullName] = useState(user?.full_name || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  // MFA Setup / Manage
  const [mfaSheetOpen, setMfaSheetOpen] = useState(false);
  const [mfaSecret, setMfaSecret] = useState('');
  const [mfaOtpUrl, setMfaOtpUrl] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [mfaLoading, setMfaLoading] = useState(false);
  const [copiedRecovery, setCopiedRecovery] = useState(false);
  const [disableSheetOpen, setDisableSheetOpen] = useState(false);
  const [disableCode, setDisableCode] = useState('');

  // Organization & Vocabulary
  const [orgName, setOrgName] = useState(user?.org_name || '');
  const [displayName, setDisplayName] = useState('');
  const [orgNiche, setOrgNiche] = useState('');
  const [dealSingular, setDealSingular] = useState('Lead');
  const [dealPlural, setDealPlural] = useState('Leads');
  const [stageLabel, setStageLabel] = useState('Etapa');
  const [savingOrg, setSavingOrg] = useState(false);

  // API Tokens
  const [tokens, setTokens] = useState<any[]>([]);
  const [tokName, setTokName] = useState('');
  const [newTok, setNewTok] = useState('');
  const [copiedTok, setCopiedTok] = useState(false);

  useEffect(() => {
    if (isTokensRoute) setTab('tokens');
  }, [isTokensRoute]);

  useEffect(() => {
    if (user?.full_name) setFullName(user.full_name);
    if (user?.org_name && !orgName) setOrgName(user.org_name);
  }, [user?.full_name, user?.org_name, orgName]);

  const loadTokens = useCallback(async () => {
    try {
      const list = await apiFetch<any[]>('/api-tokens');
      setTokens(list || []);
    } catch {
      // ignore if viewer
    }
  }, []);

  const loadOrg = useCallback(async () => {
    try {
      const org = await apiFetch<OrgData>('/organization');
      if (org) {
        setOrgName(org.name || '');
        setDisplayName(org.branding?.display_name || org.name || '');
        if (org.settings?.niche) setOrgNiche(org.settings.niche);
        const vocab = org.settings?.pipeline_vocabulary || {};
        if (vocab.deal) setDealSingular(vocab.deal);
        if (vocab.deals) setDealPlural(vocab.deals);
        if (vocab.stage) setStageLabel(vocab.stage);
      }
    } catch {
      // fallback to user.org_name
    }
  }, []);

  useEffect(() => {
    loadTokens();
    loadOrg();
  }, [loadTokens, loadOrg]);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    setSavingProfile(true);
    try {
      const payload: Record<string, string> = { full_name: fullName.trim() };
      if (newPassword) {
        payload.current_password = currentPassword;
        payload.new_password = newPassword;
      }
      await apiFetch('/auth/me', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setCurrentPassword('');
      setNewPassword('');
      await refreshUser();
      setNotice('Perfil y seguridad actualizados.');
    } catch (err: any) {
      setError(err.message || 'No se pudo actualizar el perfil.');
    } finally {
      setSavingProfile(false);
    }
  }

  async function startMfaSetup() {
    setError('');
    setRecoveryCodes([]);
    setMfaCode('');
    setMfaLoading(true);
    setMfaSheetOpen(true);
    try {
      const res = await apiFetch<{ secret: string; otpauth_url: string }>('/auth/mfa/setup', {
        method: 'POST',
      });
      setMfaSecret(res.secret);
      setMfaOtpUrl(res.otpauth_url);
    } catch (err: any) {
      setError(err.message || 'No se pudo iniciar la configuración MFA.');
    } finally {
      setMfaLoading(false);
    }
  }

  async function confirmEnableMfa(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setMfaLoading(true);
    try {
      const res = await apiFetch<{ mfa_enabled: boolean; recovery_codes?: string[] }>('/auth/mfa/enable', {
        method: 'POST',
        body: JSON.stringify({ code: mfaCode.trim() }),
      });
      if (res.recovery_codes && res.recovery_codes.length > 0) {
        setRecoveryCodes(res.recovery_codes);
      } else {
        setMfaSheetOpen(false);
      }
      await refreshUser();
      setNotice('Autenticación en dos pasos (MFA) activada.');
    } catch (err: any) {
      setError(err.message || 'Código TOTP inválido.');
    } finally {
      setMfaLoading(false);
    }
  }

  async function regenerateRecoveryCodes() {
    setError('');
    setMfaLoading(true);
    try {
      const res = await apiFetch<{ recovery_codes: string[] }>('/auth/mfa/recovery-codes', {
        method: 'POST',
      });
      setRecoveryCodes(res.recovery_codes || []);
      setMfaSecret('');
      setMfaOtpUrl('');
      setMfaSheetOpen(true);
    } catch (err: any) {
      setError(err.message || 'No se pudieron regenerar los códigos de recuperación.');
    } finally {
      setMfaLoading(false);
    }
  }

  async function confirmDisableMfa(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setMfaLoading(true);
    try {
      await apiFetch('/auth/mfa/disable', {
        method: 'POST',
        body: JSON.stringify({ code: disableCode.trim(), password: disableCode.trim() }),
      });
      setDisableCode('');
      setDisableSheetOpen(false);
      await refreshUser();
      setNotice('Autenticación en dos pasos (MFA) desactivada.');
    } catch (err: any) {
      setError(err.message || 'No se pudo desactivar MFA.');
    } finally {
      setMfaLoading(false);
    }
  }

  async function saveOrganization(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    setSavingOrg(true);
    try {
      const vocab = {
        deal: dealSingular.trim() || 'Lead',
        deals: dealPlural.trim() || 'Leads',
        stage: stageLabel.trim() || 'Etapa',
      };
      await apiFetch('/organization', {
        method: 'PATCH',
        body: JSON.stringify({
          name: orgName.trim(),
          branding: { display_name: displayName.trim() || orgName.trim() },
          settings: {
            ...(orgNiche ? { niche: orgNiche } : {}),
            pipeline_vocabulary: vocab,
          },
        }),
      });
      await refreshUser();
      setNotice('Configuración de la organización guardada.');
    } catch (err: any) {
      setError(err.message || 'No se pudo guardar la organización.');
    } finally {
      setSavingOrg(false);
    }
  }

  async function createToken(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      const res = await apiFetch<{ id: string; name: string; token: string }>('/api-tokens', {
        method: 'POST',
        body: JSON.stringify({ name: tokName.trim() }),
      });
      setNewTok(res.token);
      setTokName('');
      await loadTokens();
    } catch (err: any) {
      setError(err.message || 'No se pudo generar el token API.');
    }
  }

  async function revokeToken(id: string) {
    setError('');
    try {
      await apiFetch(`/api-tokens/${id}`, { method: 'DELETE' });
      await loadTokens();
    } catch (err: any) {
      setError(err.message || 'No se pudo revocar el token.');
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-4xl min-w-0">
      <div>
        <h1 className="text-xl font-bold">Configuración y Seguridad</h1>
        <p className="text-xs text-[var(--text-muted)]">
          Perfil, autenticación MFA TOTP, vocabulario de tu organización y tokens API para MCP
        </p>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-[var(--border)] pb-2">
        {[
          { id: 'profile', label: 'Perfil y Seguridad', icon: User },
          { id: 'org', label: 'Organización y Vocabulario', icon: Building2 },
          { id: 'tokens', label: 'Tokens API (MCP)', icon: Key },
        ].map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setTab(t.id as SettingsTab);
                setError('');
                setNotice('');
              }}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-[10px] text-xs font-medium transition-colors cursor-pointer ${
                active
                  ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                  : 'bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-[var(--danger)]">
          {error}
        </div>
      )}
      {notice && (
        <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900">
          {notice}
        </div>
      )}

      {/* Tab 1: Perfil y Seguridad */}
      {tab === 'profile' && (
        <div className="space-y-5">
          <Card className="p-4 md:p-5 space-y-4">
            <h2 className="text-sm font-semibold">Información personal y contraseña</h2>
            <form onSubmit={saveProfile} className="space-y-3.5 max-w-md">
              <div className="space-y-1">
                <label className="text-xs font-medium">Correo electrónico</label>
                <Input disabled value={user?.email || ''} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Nombre completo</label>
                <Input
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </div>
              <div className="pt-2 border-t border-[var(--border)] space-y-3">
                <div className="text-xs font-semibold text-[var(--text-muted)]">
                  Cambiar contraseña (opcional)
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Contraseña actual</label>
                  <Input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="••••••••"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Nueva contraseña (mín. 8 caracteres)</label>
                  <Input
                    type="password"
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="••••••••"
                  />
                </div>
              </div>
              <Button type="submit" disabled={savingProfile}>
                {savingProfile ? 'Guardando...' : 'Guardar cambios'}
              </Button>
            </form>
          </Card>

          <Card className="p-4 md:p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-0.5">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-[var(--accent)]" />
                  Autenticación en dos pasos (MFA TOTP)
                </h2>
                <p className="text-xs text-[var(--text-muted)]">
                  Protege tu cuenta con códigos temporales desde Google Authenticator, 1Password o Authy.
                </p>
              </div>
              <Badge tone={user?.mfa_enabled ? 'success' : 'warning'}>
                {user?.mfa_enabled ? 'Activo' : 'Inactivo'}
              </Badge>
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              {!user?.mfa_enabled ? (
                <Button onClick={startMfaSetup}>Configurar MFA (TOTP)</Button>
              ) : (
                <>
                  <Button variant="secondary" onClick={regenerateRecoveryCodes} disabled={mfaLoading}>
                    <RefreshCw className="w-3.5 h-3.5" /> Regenerar códigos de recuperación
                  </Button>
                  <Button variant="danger" onClick={() => setDisableSheetOpen(true)}>
                    Desactivar MFA
                  </Button>
                </>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* Tab 2: Organización y Vocabulario */}
      {tab === 'org' && (
        <Card className="p-4 md:p-5 space-y-4">
          <h2 className="text-sm font-semibold">Organización, Marca y Vocabulario del Embudo</h2>
          <form onSubmit={saveOrganization} className="space-y-4 max-w-lg">
            <div className="space-y-1">
              <label className="text-xs font-medium">Nombre de la organización</label>
              <Input required value={orgName} onChange={(e) => setOrgName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Nombre visible (Branding)</label>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="KoraCRM" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-[var(--border)]">
              <div className="space-y-1">
                <label className="text-xs font-medium">Elemento (singular)</label>
                <Input value={dealSingular} onChange={(e) => setDealSingular(e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Elementos (plural)</label>
                <Input value={dealPlural} onChange={(e) => setDealPlural(e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Etiqueta de etapa</label>
                <Input value={stageLabel} onChange={(e) => setStageLabel(e.target.value)} />
              </div>
            </div>
            <Button type="submit" disabled={savingOrg}>
              {savingOrg ? 'Guardando...' : 'Guardar organización'}
            </Button>
          </form>
        </Card>
      )}

      {/* Tab 3: Tokens API */}
      {tab === 'tokens' && (
        <Card className="p-4 md:p-5 space-y-4">
          <div className="space-y-0.5">
            <h2 className="text-sm font-semibold">Tokens API para MCP Nativo en Go / REST</h2>
            <p className="text-xs text-[var(--text-muted)]">
              Genera tokens Bearer para conectar clientes MCP externos o integraciones REST.
            </p>
          </div>
          <form onSubmit={createToken} className="flex flex-wrap gap-2 max-w-md">
            <Input
              required
              className="flex-1 min-w-[180px]"
              placeholder="Nombre del token (ej. Claude MCP)"
              value={tokName}
              onChange={(e) => setTokName(e.target.value)}
            />
            <Button type="submit">Generar</Button>
          </form>
          {newTok && (
            <div className="p-3.5 rounded-xl bg-teal-50 border border-teal-200 text-xs space-y-2">
              <div className="font-semibold text-teal-900">
                Cópialo ahora (solo se muestra una vez):
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <code className="flex-1 min-w-0 font-mono font-bold break-all bg-[var(--bg)] p-2 rounded border border-[var(--border)]">
                  {newTok}
                </code>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    navigator.clipboard?.writeText(newTok);
                    setCopiedTok(true);
                    window.setTimeout(() => setCopiedTok(false), 2000);
                  }}
                >
                  {copiedTok ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedTok ? 'Copiado' : 'Copiar'}
                </Button>
              </div>
            </div>
          )}
          <div className="space-y-2">
            {tokens.length === 0 ? (
              <div className="text-xs text-[var(--text-muted)] py-2">Aún no has creado tokens API.</div>
            ) : (
              tokens.map((t) => (
                <div
                  key={t.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-xs py-2.5 border-b border-[var(--border)] last:border-0"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{t.name}</div>
                    {t.created_at && (
                      <div className="text-[11px] text-[var(--text-muted)]">
                        Creado: {new Date(t.created_at).toLocaleDateString('es')}
                        {t.last_used_at ? ` · Último uso: ${new Date(t.last_used_at).toLocaleDateString('es')}` : ''}
                      </div>
                    )}
                  </div>
                  <Button size="sm" variant="danger" onClick={() => revokeToken(t.id)}>
                    Revocar
                  </Button>
                </div>
              ))
            )}
          </div>
        </Card>
      )}

      {/* Sheet MFA TOTP Setup / Recovery Codes */}
      <Sheet
        open={mfaSheetOpen}
        onClose={() => setMfaSheetOpen(false)}
        title={recoveryCodes.length > 0 ? 'Códigos de recuperación MFA' : 'Configurar MFA (TOTP)'}
      >
        {recoveryCodes.length > 0 ? (
          <div className="space-y-4">
            <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-950">
              Guarda estos códigos en un lugar seguro. Cada código solo se puede usar una vez si pierdes acceso a tu app autenticadora.
            </div>
            <div className="grid grid-cols-2 gap-2">
              {recoveryCodes.map((c) => (
                <code
                  key={c}
                  className="p-2 rounded-lg bg-[var(--surface)] border border-[var(--border)] font-mono text-xs text-center"
                >
                  {c}
                </code>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => {
                  navigator.clipboard?.writeText(recoveryCodes.join('\n'));
                  setCopiedRecovery(true);
                  window.setTimeout(() => setCopiedRecovery(false), 2000);
                }}
              >
                {copiedRecovery ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copiedRecovery ? 'Copiados' : 'Copiar códigos'}
              </Button>
              <Button className="flex-1" onClick={() => setMfaSheetOpen(false)}>
                Listo
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={confirmEnableMfa} className="space-y-4">
            <p className="text-xs text-[var(--text-muted)]">
              Agrega esta clave secreta en tu aplicación autenticadora (Google Authenticator, Authy o 1Password) e ingresa el código de 6 dígitos para confirmar.
            </p>
            {mfaSecret && (
              <div className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)] space-y-2">
                <div className="text-[11px] font-medium text-[var(--text-muted)]">Clave secreta TOTP:</div>
                <code className="block font-mono text-xs font-bold break-all">{mfaSecret}</code>
                {mfaOtpUrl && (
                  <a
                    href={mfaOtpUrl}
                    className="inline-block text-xs text-[var(--accent)] underline"
                  >
                    Abrir en app autenticadora
                  </a>
                )}
              </div>
            )}
            <div className="space-y-1">
              <label className="text-xs font-medium">Código de verificación (6 dígitos)</label>
              <Input
                required
                inputMode="numeric"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                placeholder="123456"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setMfaSheetOpen(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={mfaLoading}>
                {mfaLoading ? 'Activando...' : 'Activar MFA'}
              </Button>
            </div>
          </form>
        )}
      </Sheet>

      {/* Sheet Desactivar MFA */}
      <Sheet open={disableSheetOpen} onClose={() => setDisableSheetOpen(false)} title="Desactivar MFA">
        <form onSubmit={confirmDisableMfa} className="space-y-4">
          <p className="text-xs text-[var(--text-muted)]">
            Ingresa tu código TOTP actual o contraseña para confirmar la desactivación de MFA.
          </p>
          <Input
            required
            value={disableCode}
            onChange={(e) => setDisableCode(e.target.value)}
            placeholder="Código TOTP o contraseña"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setDisableSheetOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="danger" disabled={mfaLoading}>
              {mfaLoading ? 'Desactivando...' : 'Confirmar desactivación'}
            </Button>
          </div>
        </form>
      </Sheet>
    </div>
  );
}
