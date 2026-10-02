/** The Alpha page's panels. Each reads what the page already loaded unless it says it spends a budget. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CheckIcon, CircleDashedIcon, RefreshCwIcon, XIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { AlphaCheck } from '@/api/types'
import { cn } from '@/lib/cn'
import { CORE_METRICS, DASH, fmt, isNum } from '@/lib/format'
import {
  Badge,
  Button,
  checkTone,
  Disclosure,
  Empty,
  ErrorNotice,
  KV,
  LINK,
  Notice,
  Panel,
  Skeleton,
  TEXT_TONE,
  type Tone,
} from '@/ui/kit'
import {
  type CheckGroups,
  checkName,
  isCeiling,
  isQuickMode,
  matches,
  powerPoolRules,
  type Rule,
  resultOf,
  type Verdict,
} from './analysis'
import {
  type AlphaInfo,
  type AlphaLineage,
  type AlphaStats,
  type AlphaYear,
  alpha as api,
  type CorrelationKind,
  notApplicable,
  type Read,
} from './api'

// ── Figures ────────────────────────────────────────────────────────────────────────────────

/** A check's figure in its own unit: turnover as a percent, everything else as a ratio. */
const figure = (name: string, v: number | null | undefined) =>
  name.includes('TURNOVER') ? fmt.pct(v, 2) : fmt.ratio(v)

/**
 * Where a check's value sits against its limit. The track runs to a little past whichever is
 * larger, the tick marks the limit, and the fill says which side of it the value landed.
 */
function Gauge({ check }: { check: AlphaCheck }) {
  const { value, limit } = check
  if (!isNum(value) || !isNum(limit) || limit <= 0) return null
  const span = Math.max(value, limit) * 1.2
  // BRAIN's own verdict when it gave one; the comparison is only for a check still pending.
  const result = check.result
  const passed =
    result === 'PASS' || result === 'FAIL' || result === 'ERROR'
      ? result === 'PASS'
      : isCeiling(check.name)
        ? value <= limit
        : value >= limit
  return (
    <div className="relative my-1 h-1 w-full rounded-pill bg-surface-3" aria-hidden>
      <div
        className={cn(
          'absolute inset-y-0 left-0 rounded-pill',
          passed ? 'bg-pnl-positive' : 'bg-pnl-negative',
        )}
        style={{ width: `${Math.min(100, (Math.max(0, value) / span) * 100)}%` }}
      />
      <div
        className="absolute -inset-y-1 w-px bg-ink"
        style={{ left: `${(limit / span) * 100}%` }}
      />
    </div>
  )
}

function CheckRow({ check }: { check: AlphaCheck }) {
  const result = resultOf(check)
  const { value, limit } = check
  return (
    <li className="flex flex-col gap-1.5 py-2">
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-body text-ink" title={check.name}>
          {checkName(check.name)}
        </span>
        {isNum(value) ? (
          <span className="num shrink-0 text-body-compact text-ink-muted">
            {figure(check.name, value)}
            {isNum(limit) && (
              <span className="text-ink-subtle">
                {isCeiling(check.name) ? ' ≤ ' : ' ≥ '}
                {figure(check.name, limit)}
              </span>
            )}
          </span>
        ) : (
          // Not every check measures a number: the orthogonal-neutralization one names the
          // neutralization it found and the one it wanted.
          typeof value === 'string' && (
            <span className="num shrink-0 text-body-compact text-ink-muted">
              {value}
              {typeof limit === 'string' && limit !== value && (
                <span className="text-ink-subtle"> · wants {limit}</span>
              )}
            </span>
          )
        )}
        <Badge tone={checkTone(result)}>{result}</Badge>
      </div>
      <Gauge check={check} />
    </li>
  )
}

// ── The verdict ────────────────────────────────────────────────────────────────────────────

const VERDICT: Record<Verdict['kind'], { title: (g: CheckGroups) => string; tone: Tone }> = {
  submitted: { title: () => 'Submitted on BRAIN', tone: 'neutral' },
  blocked: {
    title: (g) =>
      `Not submittable: ${g.failing.length} ${g.failing.length === 1 ? 'check fails' : 'checks fail'}`,
    tone: 'loss',
  },
  pending: {
    title: (g) =>
      g.pending.length === 0
        ? 'Not judged yet: BRAIN has run no submission checks on this Alpha'
        : `Passes every finished check. ${g.pending.length} still ${g.pending.length === 1 ? 'runs' : 'run'} on Check Submission`,
    tone: 'warn',
  },
  ready: { title: () => 'Ready to submit on BRAIN', tone: 'profit' },
}

export function VerdictPanel({
  verdict,
  alpha,
  actions,
}: {
  verdict: Verdict
  alpha: AlphaInfo
  actions: ReactNode
}) {
  const { kind, groups } = verdict
  const { title, tone } = VERDICT[kind]
  const shown = kind === 'blocked' ? groups.failing : kind === 'pending' ? groups.pending : []
  const edge = {
    neutral: 'before:bg-ink-tertiary',
    muted: 'before:bg-ink-tertiary',
    profit: 'before:bg-pnl-positive',
    loss: 'before:bg-pnl-negative',
    warn: 'before:bg-status-warning',
  }[tone]

  return (
    <section
      aria-live="polite"
      className={cn(
        'panel-highlight relative flex flex-col gap-3 overflow-hidden rounded-lg border border-hairline bg-surface-1 py-4 pr-4 pl-5',
        'before:absolute before:inset-y-0 before:left-0 before:w-1',
        edge,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className={cn('text-headline text-balance', TEXT_TONE[tone])}>{title(groups)}</h2>
          <p className="text-body text-pretty text-ink-subtle">
            {kind === 'submitted' &&
              `Status ${alpha.status}${alpha.dateSubmitted ? `, submitted ${fmt.date(alpha.dateSubmitted)}` : ''}.`}
            {kind === 'blocked' &&
              (isQuickMode(alpha)
                ? 'This was run in Quick mode. Every figure on this page is the real one, but BRAIN does not run the submission checks on a Quick mode alpha and will not accept it. A task simulates each Quick Alpha that passes every check again in full, and that Alpha can be submitted.'
                : 'Each bar shows the value against the limit it must clear. Fix these, then run Check Submission again.')}
            {kind === 'pending' &&
              (groups.pending.length === 0
                ? 'Nothing here has been checked, so nothing says it can be submitted. Run Check Submission.'
                : 'Correlation and quota checks resolve only when BRAIN runs Check Submission. Re-check to settle them.')}
            {kind === 'ready' &&
              'Every submission check passes. Submitting stays on BRAIN, where it is permanent.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">{actions}</div>
      </div>
      {shown.length > 0 && (
        <ul className="divide-y divide-hairline-subtle border-t border-hairline-subtle">
          {shown.map((c, i) => (
            <CheckRow key={`${c.name}-${i}`} check={c} />
          ))}
        </ul>
      )}
    </section>
  )
}

// ── Checks ─────────────────────────────────────────────────────────────────────────────────

export function ChecksPanel({ groups }: { groups: CheckGroups }) {
  const count = groups.failing.length + groups.pending.length + groups.passing.length
  return (
    <Panel
      title="Submission checks"
      description={`${groups.passing.length} of ${count} pass, as BRAIN last reported them`}
      bodyClassName="flex flex-col gap-3 py-2"
    >
      <ul className="divide-y divide-hairline-subtle">
        {[...groups.failing, ...groups.pending, ...groups.passing].map((c, i) => (
          <CheckRow key={`${c.name}-${i}`} check={c} />
        ))}
      </ul>
      {groups.notes.length > 0 && (
        <Disclosure summary={`${groups.notes.length} notes that do not block submission`}>
          <ul className="divide-y divide-hairline-subtle">
            {groups.notes.map((c, i) => (
              <CheckRow key={`${c.name}-${i}`} check={c} />
            ))}
          </ul>
        </Disclosure>
      )}
    </Panel>
  )
}

// ── Aggregates ─────────────────────────────────────────────────────────────────────────────

const ROWS: {
  key: keyof AlphaStats
  label: string
  format: (v: number | null | undefined) => string
}[] = [
  ...(['sharpe', 'fitness', 'turnover', 'returns', 'drawdown', 'margin'] as const).map((key) => ({
    key,
    label: CORE_METRICS[key].label,
    format: CORE_METRICS[key].show,
  })),
  { key: 'pnl', label: 'PnL', format: fmt.compact },
  { key: 'longCount', label: 'Long count', format: fmt.int },
  { key: 'shortCount', label: 'Short count', format: fmt.int },
]

/** In-sample beside investability constrained, and how much of each figure survives the constraint. */
export function AggregatesPanel({ alpha }: { alpha: AlphaInfo }) {
  const base = alpha.inSample
  const kept = alpha.investability
  if (!base) return null
  return (
    <Panel
      title="In-sample aggregates"
      description="Beside the same Alpha under BRAIN's investability constraint"
      bodyClassName="overflow-x-auto p-0"
    >
      <table className="w-full text-body">
        <thead>
          <tr className="border-b border-hairline text-body-compact text-ink-subtle">
            <th className="px-4 py-2 text-left font-medium">Measure</th>
            <th className="px-4 py-2 text-right font-medium">In-sample</th>
            <th className="px-4 py-2 text-right font-medium">Constrained</th>
            <th className="px-4 py-2 text-right font-medium">Kept</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map(({ key, label, format }) => {
            const a = base[key]
            const b = kept?.[key]
            // Only from a positive baseline: -2.0 kept of -1.5 is 133%, which reads as a healthy
            // share of a number that was never good.
            const share =
              isNum(a) && isNum(b) && a > 0 && ['sharpe', 'fitness', 'returns', 'pnl'].includes(key)
                ? b / a
                : null
            return (
              <tr key={key} className="border-b border-hairline-subtle last:border-b-0">
                <td className="px-4 py-1.5 text-ink-muted">{label}</td>
                <td className="num px-4 py-1.5 text-right text-ink">{format(a)}</td>
                <td className="num px-4 py-1.5 text-right text-ink-muted">
                  {kept ? format(b) : DASH}
                </td>
                <td
                  className={cn(
                    'num px-4 py-1.5 text-right',
                    share === null
                      ? 'text-ink-subtle'
                      : share >= 0.7
                        ? 'text-ink-muted'
                        : 'text-status-warning',
                  )}
                  title={
                    share !== null && share < 0.7
                      ? 'BRAIN asks ASI, JPN, HKG, TWN and KOR Alphas to keep at least 70% of their Sharpe'
                      : undefined
                  }
                >
                  {share === null ? '' : fmt.pct(share, 0)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Panel>
  )
}

// ── Yearly ─────────────────────────────────────────────────────────────────────────────────

/** One row a year; Sharpe also as a bar, so a weak year is seen before it is read. */
const STAGE_LABEL: Record<string, string> = { TRAIN: 'Train', TEST: 'Test', OS: 'OS' }

export function YearlyPanel({ years, cutoff }: { years: AlphaYear[]; cutoff: number | null }) {
  if (years.length === 0) return null
  const top = Math.max(...years.map((y) => Math.abs(y.sharpe ?? 0)), cutoff ?? 0, 0.01)
  return (
    <Panel title="Year by year" bodyClassName="overflow-x-auto p-0">
      <table className="w-full min-w-[40rem] text-body">
        <thead>
          <tr className="border-b border-hairline text-body-compact text-ink-subtle">
            {[
              'Year',
              'Sharpe',
              '',
              'Fitness',
              'Turnover',
              'Returns',
              'Drawdown',
              'Margin',
              'PnL',
            ].map((h, i) => (
              <th
                key={i}
                className={cn(
                  'px-3 py-2 font-medium',
                  i === 0 || i === 2 ? 'text-left' : 'text-right',
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {years.map((y) => {
            const s = y.sharpe ?? 0
            const below = cutoff !== null && s < cutoff
            return (
              // BRAIN splits a year at each stage boundary, so the year alone repeats.
              <tr
                key={`${y.year}-${y.stage ?? ''}`}
                className="border-b border-hairline-subtle last:border-b-0"
              >
                <td className="num px-3 py-1.5 text-ink-muted">
                  {y.year}
                  {y.stage && (
                    <span className="ml-2 text-ink-subtle">{STAGE_LABEL[y.stage] ?? y.stage}</span>
                  )}
                </td>
                <td
                  className={cn(
                    'num px-3 py-1.5 text-right',
                    below ? 'text-status-warning' : 'text-ink',
                  )}
                >
                  {fmt.ratio(y.sharpe)}
                </td>
                <td className="w-40 px-3 py-1.5">
                  <div className="relative h-1.5 rounded-pill bg-surface-3" aria-hidden>
                    <div
                      className={cn(
                        'absolute inset-y-0 left-0 rounded-pill',
                        s < 0 ? 'bg-pnl-negative' : below ? 'bg-status-warning' : 'bg-ink-muted',
                      )}
                      style={{ width: `${(Math.abs(s) / top) * 100}%` }}
                    />
                    {cutoff !== null && (
                      <div
                        className="absolute -inset-y-1 w-px bg-ink-subtle"
                        style={{ left: `${(cutoff / top) * 100}%` }}
                      />
                    )}
                  </div>
                </td>
                <td className="num px-3 py-1.5 text-right text-ink-muted">
                  {fmt.ratio(y.fitness)}
                </td>
                <td className="num px-3 py-1.5 text-right text-ink-muted">
                  {fmt.pct(y.turnover, 1)}
                </td>
                <td
                  className={cn(
                    'num px-3 py-1.5 text-right',
                    TEXT_TONE[(y.returns ?? 0) < 0 ? 'loss' : 'neutral'],
                  )}
                >
                  {fmt.pct(y.returns, 2)}
                </td>
                <td className="num px-3 py-1.5 text-right text-ink-muted">
                  {fmt.pct(y.drawdown, 2)}
                </td>
                <td className="num px-3 py-1.5 text-right text-ink-muted">
                  {fmt.bps(y.margin, 1)}
                </td>
                <td
                  className={cn(
                    'num px-3 py-1.5 text-right',
                    TEXT_TONE[(y.pnl ?? 0) < 0 ? 'loss' : 'neutral'],
                  )}
                >
                  {fmt.compact(y.pnl)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Panel>
  )
}

// ── Eligibility ────────────────────────────────────────────────────────────────────────────

const RULE_ICON: Record<Rule, ReactNode> = {
  pass: <CheckIcon className="size-3.5 text-pnl-positive-text" aria-label="Passes" />,
  fail: <XIcon className="size-3.5 text-pnl-negative-text" aria-label="Fails" />,
  unknown: <CircleDashedIcon className="size-3.5 text-ink-subtle" aria-label="Not known yet" />,
}

export function EligibilityPanel({ alpha }: { alpha: AlphaInfo }) {
  const rules = powerPoolRules(alpha)
  const failing = rules.filter((r) => r.state === 'fail').length
  const { pyramids, themes, competitions } = matches(alpha.checks)
  return (
    <Panel
      title="Where it counts"
      description="Power Pool rules, and the pyramids, themes and competitions BRAIN matched"
      bodyClassName="flex flex-col gap-4"
    >
      {alpha.classifications.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {alpha.classifications.map((c) => (
            <Badge key={c.id} tone="outline" title={c.id}>
              {c.name}
            </Badge>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-2">
        <p className="text-body font-medium text-ink">
          Power Pool{' '}
          <span className="font-normal text-ink-subtle">
            {failing === 0
              ? '— no rule fails'
              : `— ${failing} ${failing === 1 ? 'rule fails' : 'rules fail'}`}
          </span>
        </p>
        <ul className="flex flex-col gap-1.5">
          {rules.map((r) => (
            <li key={r.label} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-body">
              <span className="relative top-0.5">{RULE_ICON[r.state]}</span>
              <span className="text-ink-muted">{r.label}</span>
              <span className="num col-start-2 text-body-compact break-all text-ink-subtle">
                {r.detail}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <KV
        items={[
          [
            'Pyramids',
            pyramids.length
              ? pyramids.map((p) => `${p.name} ×${fmt.ratio(p.multiplier, 1)}`).join(', ')
              : 'None matched',
          ],
          ['Themes', themes.length ? themes.map((t) => t.name).join(', ') : 'None matched'],
          ['Competitions', competitions.length ? competitions.join(', ') : 'None matched'],
        ]}
        className="[&_dd]:whitespace-normal"
      />
    </Panel>
  )
}

// ── Correlations ───────────────────────────────────────────────────────────────────────────

const KINDS: { kind: CorrelationKind; label: string; limit: number }[] = [
  { kind: 'self', label: 'Self-Correlation', limit: 0.7 },
  { kind: 'power-pool', label: 'Power Pool Correlation', limit: 0.5 },
  { kind: 'prod', label: 'Production Correlation', limit: 0.7 },
]

/**
 * Kept answers show on load for free; the button is the only thing that spends the budget.
 * One query per row, keyed by what it holds, so a run replaces the kept answer in place.
 */
function useBudgeted<T extends { cached: boolean }>(
  key: unknown[],
  fetch: (mode: Read) => Promise<T>,
) {
  const queryClient = useQueryClient()
  const kept = useQuery({
    queryKey: key,
    queryFn: () => fetch('cached'),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const run = useMutation({
    meta: { inline: true },
    mutationFn: () => fetch(kept.data?.cached ? 'refresh' : 'run'),
    onSuccess: (data) => queryClient.setQueryData(key, data),
  })
  return { kept, run }
}

function CorrelationRow({
  alphaId,
  kind,
  label,
  limit,
}: {
  alphaId: string
  kind: CorrelationKind
  label: string
  limit: number
}) {
  const { kept, run } = useBudgeted(['alpha', alphaId, 'correlation', kind], (mode) =>
    api.correlation(alphaId, kind, mode),
  )
  const data = kept.data?.cached ? kept.data : null
  const max = data?.max
  const rows = data?.records ?? []
  const props = data?.schema?.properties ?? []
  const error = run.error ?? kept.error

  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-body text-ink">{label}</span>
        {isNum(max) && (
          <span
            className={cn('num text-body', max >= limit ? 'text-pnl-negative-text' : 'text-ink')}
          >
            max {fmt.ratio(max)}
            <span className="text-ink-subtle"> of {fmt.ratio(limit, 1)}</span>
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {data && (
            <span className="text-body-compact text-ink-subtle">{fmt.ago(data.fetchedAt)}</span>
          )}
          <Button
            size="sm"
            variant={data ? 'ghost' : 'secondary'}
            loading={run.isPending}
            disabled={kept.isPending}
            onClick={() => run.mutate()}
          >
            {data && !run.isPending && <RefreshCwIcon />}
            {data ? 'Run again' : 'Run'}
          </Button>
        </span>
      </div>
      {error &&
        (notApplicable(error) ? (
          <p className="text-body-compact text-ink-subtle">Not applicable to this Alpha.</p>
        ) : (
          <ErrorNotice error={error} title={`${label} did not run`} />
        ))}
      {data && rows.length > 0 && (
        <Disclosure summary={`${rows.length} most correlated Alphas`}>
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-body-compact">
              <thead>
                <tr className="text-ink-subtle">
                  {props.map((p) => (
                    <th key={p.name} className="px-2 py-1 text-left font-medium">
                      {p.title ?? p.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((record, i) => (
                  <tr key={i} className="border-t border-hairline-subtle">
                    {props.map((p, j) => {
                      const v = record[j]
                      return (
                        <td key={p.name} className={cn('num px-2 py-1', isNum(v) && 'text-right')}>
                          {p.name === 'id' && typeof v === 'string' ? (
                            <Link to="/alpha/$alphaId" params={{ alphaId: v }} className={LINK}>
                              {v}
                            </Link>
                          ) : isNum(v) ? (
                            Number.isInteger(v) ? (
                              fmt.int(v)
                            ) : (
                              fmt.ratio(v, 3)
                            )
                          ) : v == null ? (
                            DASH
                          ) : (
                            String(v)
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Disclosure>
      )}
    </li>
  )
}

export function CorrelationsPanel({ alphaId }: { alphaId: string }) {
  return (
    <Panel
      title="Correlations"
      description="Each is a slow BRAIN job, so it runs when you ask. Answers are kept here."
    >
      <ul className="divide-y divide-hairline-subtle">
        {KINDS.map((k) => (
          <CorrelationRow key={k.kind} alphaId={alphaId} {...k} />
        ))}
      </ul>
    </Panel>
  )
}

// ── Performance comparison ─────────────────────────────────────────────────────────────────

const COMPARED = ROWS.filter((r) =>
  ['sharpe', 'fitness', 'returns', 'turnover', 'drawdown', 'margin'].includes(r.key),
)

export function ComparisonPanel({ alphaId }: { alphaId: string }) {
  const { kept, run } = useBudgeted(['alpha', alphaId, 'performance'], (mode) =>
    api.performance(alphaId, mode),
  )
  const data = kept.data?.cached ? kept.data : null
  const before = data?.stats?.before ?? null
  const after = data?.stats?.after ?? null
  const error = run.error ?? kept.error

  return (
    <Panel
      title="Effect on your pool"
      description={
        data?.partitionName
          ? `Partition ${data.partitionName}, compared ${fmt.ago(data.fetchedAt)}`
          : 'Your pool before and after this Alpha joins it'
      }
      actions={
        <Button
          size="sm"
          variant={data ? 'ghost' : 'secondary'}
          loading={run.isPending}
          disabled={kept.isPending}
          onClick={() => run.mutate()}
        >
          {data && !run.isPending && <RefreshCwIcon />}
          {data ? 'Compare again' : 'Compare'}
        </Button>
      }
      bodyClassName={data ? 'p-0' : ''}
    >
      {error && <ErrorNotice error={error} title="The comparison did not run" />}
      {run.isPending && !data && <Skeleton className="h-32" label="BRAIN is comparing" />}
      {!data && !run.isPending && !error && (
        <p className="text-body-compact text-ink-subtle">
          BRAIN works this out on request, which can take a minute.
        </p>
      )}
      {data && (
        <>
          {!before && (
            <Notice tone="info" className="m-4 mb-0">
              This partition of your pool is empty, so this would be its first Alpha.
            </Notice>
          )}
          <table className="w-full text-body">
            <thead>
              <tr className="border-b border-hairline text-body-compact text-ink-subtle">
                <th className="px-4 py-2 text-left font-medium">Measure</th>
                <th className="px-4 py-2 text-right font-medium">Before</th>
                <th className="px-4 py-2 text-right font-medium">After</th>
              </tr>
            </thead>
            <tbody>
              {COMPARED.map(({ key, label, format }) => {
                const b = before?.[key]
                const a = after?.[key]
                const lowerIsBetter = key === 'drawdown' || key === 'turnover'
                const better = isNum(a) && isNum(b) ? (lowerIsBetter ? a < b : a > b) : null
                return (
                  <tr key={key} className="border-b border-hairline-subtle last:border-b-0">
                    <td className="px-4 py-1.5 text-ink-muted">{label}</td>
                    <td className="num px-4 py-1.5 text-right text-ink-muted">{format(b)}</td>
                    <td
                      className={cn(
                        'num px-4 py-1.5 text-right',
                        better === null
                          ? 'text-ink'
                          : better
                            ? 'text-pnl-positive-text'
                            : 'text-pnl-negative-text',
                      )}
                    >
                      {format(a)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}
    </Panel>
  )
}

// ── Lineage ────────────────────────────────────────────────────────────────────────────────

export function LineagePanel({ lineage }: { lineage: AlphaLineage | null }) {
  if (!lineage) {
    return (
      <Panel title="Where it came from">
        <Empty title="Not made by this app">
          It was simulated on BRAIN directly, or before this app kept records.
        </Empty>
      </Panel>
    )
  }
  const params = Object.entries(lineage.params)
  return (
    <Panel title="Where it came from" bodyClassName="flex flex-col gap-4">
      <KV
        items={[
          ['Lab', lineage.labName ?? lineage.lab ?? DASH],
          ...(lineage.templateName && lineage.templateName !== lineage.labName
            ? [['Template', lineage.templateName] as [string, string]]
            : []),
          [
            'Task',
            <Link key="task" to="/tasks" className={LINK}>
              {lineage.taskName ?? lineage.task}
            </Link>,
          ],
          ...(lineage.generation !== null && lineage.generation !== undefined
            ? [['Generation', fmt.int(lineage.generation)] as [string, string]]
            : []),
          ['Simulated', fmt.dateTime(lineage.simulatedAt)],
          ...params.map(([k, v]): [string, string] => [
            k,
            typeof v === 'string' ? v : JSON.stringify(v),
          ]),
        ]}
      />
      {lineage.lab === 'ga' && (
        <p className="text-body-compact text-ink-subtle">
          Evolution Lab does not record which parents a child was bred from.
        </p>
      )}
      {lineage.siblings.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-body-compact text-ink-subtle">Best others from the same task</p>
          <ul className="flex flex-col divide-y divide-hairline-subtle">
            {lineage.siblings.map((s) => (
              <li key={s.alphaId} className="flex items-center gap-3 py-1.5">
                <Link
                  to="/alpha/$alphaId"
                  params={{ alphaId: s.alphaId }}
                  className={cn(LINK, 'num text-body-compact')}
                >
                  {s.alphaId}
                </Link>
                <span
                  className="num min-w-0 flex-1 truncate text-body-compact text-ink-subtle"
                  title={s.expression ?? undefined}
                >
                  {s.expression}
                </span>
                <span className="num text-body-compact text-ink">{fmt.ratio(s.value)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  )
}
