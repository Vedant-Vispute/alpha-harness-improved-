/** Alphas that pass every resolved submission check. Submission itself happens on BRAIN. */

import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { CopyIcon } from 'lucide-react'
import { toast } from 'sonner'
import { type AlphaCheck, type Scope, scopeLabel } from '@/api/types'
import { cn } from '@/lib/cn'
import { fmt, isNum } from '@/lib/format'
import { marketKey, useScope } from '@/lib/scope'
import { useRefetchOn } from '@/lib/ws'
import {
  type AlphaSettings,
  pool,
  type SubmittableAlpha,
  type SubmittableResponse,
} from '@/screens/pool/api'
import { Sparkline } from '@/screens/pool/pnl-chart'
import {
  Badge,
  Button,
  checkTone,
  Disclosure,
  Empty,
  ErrorNotice,
  Metric,
  Panel,
  Skeleton,
  type Tone,
} from '@/ui/kit'
import { Tooltip } from '@/ui/overlay'
import { ScopePicker } from '@/ui/scope-picker'
import { AlphaActionsMenu, AstInspector, checkFigure, OpenInBrain, RecheckButton } from './shared'

/** Why Submittable Alphas are missing from Top picks, one clause per reason. */
const hiddenReasons = (data: SubmittableResponse) =>
  [
    data.heldOutFailed > 0 &&
      `${fmt.int(data.heldOutFailed)} left out because their Sharpe collapsed in the test years`,
    data.correlatedPruned > 0 &&
      `${fmt.int(data.correlatedPruned)} left out as near-duplicates of a better pick`,
    data.unvalidated > 0 &&
      `${fmt.int(data.unvalidated)} left out because they were simulated without a test period`,
  ]
    .filter(Boolean)
    .join('; ')

const pass = (ok: boolean | null): Tone => (ok === null ? 'neutral' : ok ? 'profit' : 'loss')

export function Submittable({ onOpen }: { onOpen: (alphaId: string) => void }) {
  const [scope, setScope] = useScope('pool-submittable')
  const q = useQuery({
    queryKey: ['pool', 'submittable', scope],
    queryFn: () => pool.submittable(scope),
    placeholderData: keepPreviousData,
  })
  useRefetchOn('simulations', ['pool', 'submittable'], 5000)
  const data = q.data

  return (
    <Panel
      title="Submittable"
      actions={<ScopePicker scope={scope} onChange={setScope} />}
      bodyClassName="flex flex-col gap-4"
    >
      {data && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Metric
            boxed
            label="Submittable"
            value={fmt.int(data.total)}
            tone={data.total > 0 ? 'profit' : 'neutral'}
          />
          <Metric
            boxed
            label="Not Submittable"
            value={fmt.int(data.nearMisses)}
            tone={data.nearMisses > 0 ? 'warn' : 'neutral'}
          />
        </div>
      )}
      {q.isError && <ErrorNotice error={q.error} title="Could not read submittable Alphas" />}

      {q.isPending ? (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton
              key={i}
              className="h-56"
              {...(i === 0 && { label: 'Loading Submittable Alphas' })}
            />
          ))}
        </div>
      ) : data && data.alphas.length === 0 ? (
        <Empty title={`No submittable Alphas in ${scopeLabel(scope)}`}>
          <Elsewhere onPick={setScope} />
        </Empty>
      ) : (
        data && (
          <>
            <section className="flex flex-col gap-2">
              <h3 className="font-semibold text-body text-ink">Top picks</h3>
              <p className="text-body-compact text-ink-subtle">
                {data.shortlist.length === 0
                  ? 'No Submittable Alpha has held up in the test years yet.'
                  : 'The most stable Alphas that held up in the test years, each distinct from the others.'}{' '}
                {hiddenReasons(data)}
              </p>
              {data.shortlist.length > 0 && (
                <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                  {data.shortlist.map((a) => (
                    <Card key={a.alphaId} alpha={a} onOpen={onOpen} />
                  ))}
                </div>
              )}
            </section>
            <Disclosure
              summary={
                data.alphas.length < data.total
                  ? `Top ${fmt.int(data.alphas.length)} of ${fmt.int(data.total)} Submittable Alphas, by Sharpe`
                  : `All ${fmt.int(data.total)} Submittable Alphas, by Sharpe`
              }
            >
              <div className="grid grid-cols-1 gap-3 p-3 xl:grid-cols-2">
                {data.alphas.map((a) => (
                  <Card key={a.alphaId} alpha={a} onOpen={onOpen} />
                ))}
              </div>
            </Disclosure>
          </>
        )
      )}
    </Panel>
  )
}

/** An empty market is often not an empty pool: the sidebar counts every market, this tab one. */
function Elsewhere({ onPick }: { onPick: (scope: Scope) => void }) {
  const everywhere = useQuery(pool.everywhere)
  const markets = everywhere.data?.markets ?? []
  if (markets.length === 0) return null
  const total = everywhere.data?.total ?? 0
  return (
    <div className="flex flex-col items-center gap-2">
      <p>
        <span className="num">{fmt.int(total)}</span> {total === 1 ? 'is' : 'are'} in other markets:
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {markets.map((m) => (
          <Button
            key={marketKey(m)}
            size="sm"
            variant="secondary"
            onClick={() =>
              onPick({
                instrumentType: m.instrumentType,
                region: m.region,
                delay: m.delay,
                universe: m.universe,
              })
            }
          >
            <span className="num">{scopeLabel(m)}</span>
            <Badge tone="profit">{fmt.int(m.count)}</Badge>
          </Button>
        ))}
      </div>
    </div>
  )
}

function Card({
  alpha: a,
  onOpen,
}: {
  alpha: SubmittableAlpha
  onOpen: (alphaId: string) => void
}) {
  const d0 = a.settings.delay === 0
  const sharpeBar = limitOf(a.checks, 'LOW_SHARPE') ?? (d0 ? 2.69 : 1.58)
  const fitnessBar = limitOf(a.checks, 'LOW_FITNESS') ?? (d0 ? 1.5 : 1.0)
  const passed = a.checks.filter((c) => c.result === 'PASS')

  const copy = () =>
    navigator.clipboard.writeText(a.expression ?? '').then(
      () => toast.success(`Copied the expression of ${a.alphaId}`),
      () => toast.error('Could not write to the clipboard.'),
    )

  return (
    <article className="panel-highlight flex min-w-0 flex-col gap-3 rounded-lg border border-hairline bg-surface-1 p-4 transition-colors hover:border-hairline-strong">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline-subtle pb-2 text-body-compact">
        <button
          type="button"
          className="num font-semibold text-body text-ink transition-colors hover:text-link hover:underline"
          onClick={() => onOpen(a.alphaId)}
        >
          {a.alphaId}
        </button>
        <span className="num text-caption text-ink-subtle">{fmt.dateTime(a.dateCreated)}</span>
      </div>
      <AstInspector expression={a.expression} />
      <SettingsLine settings={a.settings} />
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <Metric
          boxed
          size="sm"
          label="Sharpe"
          hint={`≥ ${fmt.ratio(sharpeBar)}`}
          value={fmt.ratio(a.sharpe)}
          tone={pass(isNum(a.sharpe) ? a.sharpe >= sharpeBar : null)}
        />
        <Metric
          boxed
          size="sm"
          label="Fitness"
          hint={`≥ ${fmt.ratio(fitnessBar)}`}
          value={fmt.ratio(a.fitness)}
          tone={pass(isNum(a.fitness) ? a.fitness >= fitnessBar : null)}
        />
        <Metric
          boxed
          size="sm"
          label="Turnover"
          hint="1%–70%"
          value={fmt.pct(a.turnover)}
          tone={pass(isNum(a.turnover) ? a.turnover >= 0.01 && a.turnover <= 0.7 : null)}
        />
        <Metric
          boxed
          size="sm"
          label="Returns"
          value={fmt.pct(a.returns)}
          tone={isNum(a.returns) && a.returns !== 0 ? pass(a.returns > 0) : 'neutral'}
        />
        <Metric boxed size="sm" label="Drawdown" value={fmt.pct(a.drawdown)} />
        <Metric boxed size="sm" label="Margin" value={fmt.bps(a.margin)} />
      </div>
      {isNum(a.testSharpe) && (
        <div className="grid grid-cols-3 gap-2">
          <Metric boxed size="sm" label="Train Sharpe" value={fmt.ratio(a.trainSharpe)} />
          <Metric
            boxed
            size="sm"
            label="Test Sharpe"
            hint="held-out years"
            value={fmt.ratio(a.testSharpe)}
            tone={pass(a.testSharpe > 0)}
          />
        </div>
      )}
      {a.pnl.length > 1 && (
        <div className="rounded-md border border-hairline bg-surface-2 p-2">
          <Sparkline values={a.pnl} label={`Cumulative PnL of ${a.alphaId}`} />
        </div>
      )}
      {passed.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {passed.map((c, i) => (
            <CheckBadge key={`${c.name}-${i}`} check={c} />
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2 border-t border-hairline-subtle pt-2">
        <OpenInBrain url={a.brainUrl} />
        <RecheckButton alphaId={a.alphaId} />
        <AlphaActionsMenu alphaId={a.alphaId} />
        <Button size="sm" variant="ghost" disabled={!a.expression} onClick={copy}>
          <CopyIcon />
          Copy expression
        </Button>
      </div>
    </article>
  )
}

/** The limit BRAIN reported for a check, e.g. LOW_SHARPE → 1.58. */
const limitOf = (checks: AlphaCheck[], name: string) => {
  const limit = checks.find((c) => c.name === name)?.limit
  return isNum(limit) ? limit : null
}

function CheckBadge({ check }: { check: AlphaCheck }) {
  const result = check.result ?? 'PENDING'
  const figures = isNum(check.value)
    ? `${checkFigure(check.name, check.value)}${isNum(check.limit) ? ` / ${checkFigure(check.name, check.limit)}` : ''}`
    : null
  const tone = checkTone(check.result ?? 'PENDING')
  return (
    <Tooltip
      content={`${result}${check.message ? ` · ${check.message}` : figures && isNum(check.limit) ? ' · value / limit' : ''}`}
    >
      <span>
        <span
          className={cn(
            'mono-metric inline-flex items-center gap-1 rounded-xs border px-1.5 py-0.5 text-caption',
            tone === 'profit' &&
              'border-pnl-positive-edge bg-pnl-positive-tint text-pnl-positive-text',
            tone === 'loss' &&
              'border-pnl-negative-edge bg-pnl-negative-tint text-pnl-negative-text',
            tone === 'warn' &&
              'border-status-warning-edge bg-status-warning-tint text-status-warning',
            (tone === 'neutral' || tone === 'muted') &&
              'border-hairline bg-surface-2 text-ink-subtle',
          )}
        >
          <span>{check.name}</span>
          {figures && <span className="text-ink-subtle">{figures}</span>}
        </span>
      </span>
    </Tooltip>
  )
}

function SettingsLine({ settings: s }: { settings: AlphaSettings }) {
  const parts = [
    s.region,
    s.universe,
    isNum(s.delay) ? `D${s.delay}` : null,
    s.neutralization,
    isNum(s.decay) ? `Decay ${s.decay}` : null,
    isNum(s.truncation) ? `Truncation ${fmt.ratio(s.truncation)}` : null,
  ]
  return (
    <p className="num text-body-compact text-ink-subtle">{parts.filter(Boolean).join(' · ')}</p>
  )
}
