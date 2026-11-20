import { useState } from 'react';
import { Power, Sparkles } from 'lucide-react';
import { type AISkill, apiFetch } from '../../lib/api';
import { Badge, Button, Card } from '../ui/primitives';

export function SkillToggleList({
  skills,
  onRefresh,
  onNotice,
}: {
  skills: AISkill[];
  onRefresh: () => void;
  onNotice: (type: 'ok' | 'err', text: string) => void;
}) {
  const [togglingId, setTogglingId] = useState<string | null>(null);

  async function toggleSkill(skill: AISkill) {
    setTogglingId(skill.id);
    try {
      await apiFetch(`/ai/skills/${skill.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_enabled: !skill.is_enabled }),
      });
      onNotice(
        'ok',
        `Habilidad "${skill.name}" ${!skill.is_enabled ? 'activada' : 'desactivada'}.`
      );
      onRefresh();
    } catch (err: any) {
      onNotice('err', err?.message || 'No se pudo actualizar la habilidad.');
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <Card className="p-4 space-y-3 min-w-0">
      <div className="font-semibold text-sm flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-[var(--accent)]" />
        Habilidades del Agente IA ({skills.length})
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Activa o desactiva herramientas MCP y capacidades disponibles para los agentes de tu organización.
      </p>

      {skills.length === 0 ? (
        <div className="text-xs text-[var(--text-muted)] py-3">
          No hay habilidades registradas para esta organización.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {skills.map((skill) => (
            <div
              key={skill.id}
              className="p-3.5 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex flex-col justify-between gap-3"
            >
              <div className="space-y-1 min-w-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-sm truncate">{skill.name}</span>
                  <Badge tone={skill.is_enabled ? 'success' : 'neutral'}>
                    {skill.is_enabled ? 'Habilitada' : 'Deshabilitada'}
                  </Badge>
                </div>
                <div className="text-[11px] font-mono text-[var(--text-muted)]">{skill.skill_key}</div>
                <p className="text-xs text-[var(--text-muted)]">{skill.description}</p>
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant={skill.is_enabled ? 'secondary' : 'primary'}
                  disabled={togglingId === skill.id}
                  onClick={() => toggleSkill(skill)}
                >
                  <Power className="w-3.5 h-3.5" />
                  {togglingId === skill.id
                    ? 'Actualizando...'
                    : skill.is_enabled
                      ? 'Desactivar'
                      : 'Activar'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
