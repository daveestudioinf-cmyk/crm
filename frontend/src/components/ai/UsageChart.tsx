import { BarChart3 } from 'lucide-react';
import { type AIAgentRun, type AIBudget } from '../../lib/api';
import { Card } from '../ui/primitives';

export function UsageChart({ runs, budget }: { runs: AIAgentRun[]; budget: AIBudget | null }) {
  const recent = runs.slice(0, 14).reverse();
  const totalPrompt = runs.reduce((acc, r) => acc + (r.prompt_tokens || 0), 0);
  const totalCompletion = runs.reduce((acc, r) => acc + (r.completion_tokens || 0), 0);
  const totalCostCents = runs.reduce((acc, r) => acc + (r.cost_cents || 0), 0);

  const maxTokens = Math.max(
    1,
    ...recent.map((r) => (r.prompt_tokens || 0) + (r.completion_tokens || 0))
  );

  const chartHeight = 140;
  const barWidth = 28;
  const gap = 12;
  const svgWidth = Math.max(320, recent.length * (barWidth + gap) + 24);

  return (
    <Card className="p-4 space-y-4 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold text-sm flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-[var(--accent)]" />
          Visualización de Tokens y Costo
        </div>
        <span className="text-xs text-[var(--text-muted)]">
          Últimas {recent.length} ejecuciones
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2.5 text-xs">
        <div
          className="p-3 rounded-xl border"
          style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <div className="text-[var(--text-muted)]">Tokens Entrada</div>
          <div className="text-base font-bold mt-0.5">{totalPrompt.toLocaleString('es')}</div>
        </div>
        <div
          className="p-3 rounded-xl border"
          style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <div className="text-[var(--text-muted)]">Tokens Salida</div>
          <div className="text-base font-bold mt-0.5">{totalCompletion.toLocaleString('es')}</div>
        </div>
        <div
          className="p-3 rounded-xl border"
          style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <div className="text-[var(--text-muted)]">Costo Acumulado</div>
          <div className="text-base font-bold mt-0.5">
            ${((budget?.spent_cents ?? totalCostCents) / 100).toFixed(2)}
          </div>
        </div>
      </div>

      {recent.length === 0 ? (
        <div className="text-xs text-[var(--text-muted)] py-6 text-center">
          No hay ejecuciones suficientes para graficar tokens y costos.
        </div>
      ) : (
        <div
          className="w-full overflow-x-auto rounded-xl border p-3"
          style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <svg
            viewBox={`0 0 ${svgWidth} ${chartHeight + 28}`}
            className="w-full h-40"
            role="img"
            aria-label="Gráfico de consumo de tokens por ejecución"
          >
            <line
              x1={8}
              y1={chartHeight}
              x2={svgWidth - 8}
              y2={chartHeight}
              stroke="var(--border)"
              strokeWidth={1}
            />
            {recent.map((r, i) => {
              const promptTok = r.prompt_tokens || 0;
              const compTok = r.completion_tokens || 0;
              const totalTok = promptTok + compTok;
              const hTotal = Math.max(4, Math.round((totalTok / maxTokens) * (chartHeight - 16)));
              const hComp = totalTok > 0 ? Math.round((compTok / totalTok) * hTotal) : 0;
              const x = 12 + i * (barWidth + gap);
              const yTotal = chartHeight - hTotal;
              const yComp = chartHeight - hComp;
              return (
                <g key={r.id}>
                  <rect
                    x={x}
                    y={yTotal}
                    width={barWidth}
                    height={hTotal}
                    rx={4}
                    fill="var(--border)"
                  />
                  <rect
                    x={x}
                    y={yComp}
                    width={barWidth}
                    height={hComp}
                    rx={4}
                    fill="var(--accent)"
                  />
                  <text
                    x={x + barWidth / 2}
                    y={chartHeight + 16}
                    textAnchor="middle"
                    fontSize={9}
                    fill="var(--text-muted)"
                  >
                    #{i + 1}
                  </text>
                </g>
              );
            })}
          </svg>
          <div className="flex items-center justify-end gap-4 text-[11px] text-[var(--text-muted)] mt-1">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-[var(--border)] inline-block" />
              Entrada
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-[var(--accent)] inline-block" />
              Salida
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
