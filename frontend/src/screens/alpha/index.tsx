/**
 * One Alpha, in full: will it submit, how it earned its PnL, and where it came from.
 * The verdict leads; everything below it is the evidence. Submission stays on BRAIN.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { ArrowLeftIcon, RefreshCwIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/http'
import { cn } from '@/lib/cn'
import { DASH, fmt, isNum } from '@/lib/format'
import { useDebounced } from '@/lib/use-debounced'
import { DetailSheet } from '@/screens/pool/detail'
import { AlphaActionsMenu, AstInspector, OpenInBrain, RecheckButton } from '@/screens/pool/shared'
import {
  Badge,
  Button,
  ErrorNotice,
  Input,
  Metric,
  Notice,
  Page,
  Panel,
  Segmented,
  Skeleton,
} from '@/ui/kit'
import {
  cumulative,
  daily,
  drawdowns,
  hitRate,
  isQuickMode,
  rollingSharpe,
  underwater,
  verdictOf,
  YEAR,
} from './analysis'
import { type AlphaInfo, type AlphaView, alpha as api } from './api'
import { AlphaChart, type ChartView } from './chart'
import {
  AggregatesPanel,
  ChecksPanel,
  ComparisonPanel,
  CorrelationsPanel,
  EligibilityPanel,
  LineagePanel,
  VerdictPanel,
  YearlyPanel,
} from './panels'
import { PropertiesPanel } from './properties'

export function AlphaScreen() {
  const { alphaId } = useParams({ from: '/alpha/$alphaId' })
  const queryClient = useQueryClient()
  const key = ['alpha', alphaId, 'page']
  const page = useQuery({ queryKey: key, queryFn: () => api.page(alphaId), retry: false })
  const [refreshing, setRefreshing] = useState(false)
  const [stored, setStored] = useState(false)

  const refresh = async () => {
    setRefreshing(true)
    try {
      queryClient.setQueryData(key, await api.page(alphaId, true))
    } catch (error) {
      toast.error(errorMessage(error))
      await page.refetch()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <Page className="mx-auto w-full max-w-[96rem]">
      <Link
        to="/pool/$tab"
        params={{ tab: 'stored' }}
        className="inline-flex w-fit items-center gap-1 px-1 text-body-compact text-ink-subtle hover:text-ink"
      >
        <ArrowLeftIcon className="size-3.5" aria-hidden />
        Alphas
      </Link>
      {page.isPending && <Skeleton className="h-[40rem]" label={`Loading ${alphaId} from BRAIN`} />}
      {page.isError && (
        <>
          <ErrorNotice error={page.error} title={`Could not load ${alphaId}`} />
          {/* This screen reads BRAIN; the vault's own copy still opens while BRAIN is away. */}
          <Button className="w-fit" variant="secondary" onClick={() => setStored(true)}>
            Show the stored copy
          </Button>
          <DetailSheet alphaId={stored ? alphaId : null} onClose={() => setStored(false)} />
        </>
      )}
      {page.data && (
        // Keyed so moving to another Alpha remounts: a still-running correlation or
        // comparison otherwise stored its result, spinner and error on the new Alpha.
        <Body
          key={alphaId}
          view={page.data}
          refresh={
            <Button size="sm" variant="ghost" loading={refreshing} onClick={refresh}>
              {!refreshing && <RefreshCwIcon />}
              Reload series
            </Button>
          }
        />
      )}
    </Page>
  )
}

/**
 * What the checks on this page cannot say about a region-agnostic alpha: it is one of a
 * family of four, and the rules that decide its fate are applied across the family.
 */
function RegionAgnosticNote({ type }: { type: string | null }) {
  if (type === 'RA_CHILD')
    return (
      <Notice tone="info" title="One region of an alpha that ran in four">
        It can be submitted once a second region also passes its tests. Production Correlation is
        judged across the whole family: it only blocks when every passing region fails it.
      </Notice>
    )
  if (type === 'RA_PARENT')
    return (
      <Notice tone="info" title="This alpha holds four, one per region">
        It carries no performance of its own — USA, Europe, Asia and Global each have their own
        alpha, and submitting it submits every region that passed, at the cost of one submission.
      </Notice>
    )
  return null
}

function Body({ view, refresh }: { view: AlphaView; refresh: React.ReactNode }) {
  const a = view.alpha
  const verdict = verdictOf(a)
  const cutoff = a.checks.find((c) => c.name === 'LOW_SHARPE')?.limit ?? null

  return (
    <>
      <Header alpha={a} fetchedAt={view.fetchedAt} />
      {view.problems.map((p) => (
        <Notice key={p} tone="warn">
          {p}
        </Notice>
      ))}
      <RegionAgnosticNote type={a.type} />
      <VerdictPanel
        verdict={verdict}
        alpha={a}
        actions={
          <>
            {/* BRAIN refuses the submission check on a Quick mode alpha outright, so the
                button could only ever report its own refusal. */}
            {!isQuickMode(a) && <RecheckButton alphaId={a.alphaId} />}
            <OpenInBrain url={a.brainUrl} />
            <AlphaActionsMenu alphaId={a.alphaId} />
          </>
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="flex min-w-0 flex-col gap-4">
          <ExpressionPanel alpha={a} />
          <PerformancePanel view={view} cutoff={isNum(cutoff) ? cutoff : null} refresh={refresh} />
          <YearlyPanel years={view.yearly} cutoff={isNum(cutoff) ? cutoff : null} />
          <AggregatesPanel alpha={a} />
          <ComparisonPanel alphaId={a.alphaId} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <ChecksPanel groups={verdict.groups} />
          <EligibilityPanel alpha={a} />
          <CorrelationsPanel alphaId={a.alphaId} />
          {/* Both, so the draft resets on a save *and* on a sibling: batch children share a
              dateModified to the second, and a stale draft would save one Alpha's name onto
              another. */}
          <PropertiesPanel key={`${a.alphaId}:${a.dateModified ?? ''}`} alpha={a} />
          <LineagePanel lineage={view.lineage} />
        </div>
      </div>
    </>
  )
}

function Header({ alpha: a, fetchedAt }: { alpha: AlphaInfo; fetchedAt: string }) {
  const scope = [a.settings['region'], a.settings['universe'], `D${a.settings['delay'] ?? '?'}`]
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 px-1">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="text-headline text-balance break-words text-ink">
          {a.name || <span className="num">{a.alphaId}</span>}
        </h1>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-compact text-ink-subtle">
          {a.name && <span className="num text-ink-muted">{a.alphaId}</span>}
          <Badge tone="outline">{a.status ?? 'UNKNOWN'}</Badge>
          <span className="num">{scope.filter(Boolean).join(' / ')}</span>
          <span>Created {fmt.date(a.dateCreated)}</span>
          {a.tags.map((t) => (
            <Badge key={t} tone="muted">
              {t}
            </Badge>
          ))}
        </p>
      </div>
      <span className="text-body-compact text-ink-subtle">
        Read from BRAIN {fmt.ago(fetchedAt)}
      </span>
    </header>
  )
}

const SETTING_LABELS: [string, string][] = [
  ['instrumentType', 'Instrument'],
  ['region', 'Region'],
  ['universe', 'Universe'],
  ['delay', 'Delay'],
  ['decay', 'Decay'],
  ['neutralization', 'Neutralization'],
  ['truncation', 'Truncation'],
  ['pasteurization', 'Pasteurization'],
  ['nanHandling', 'NaN handling'],
  ['unitHandling', 'Unit handling'],
  ['maxTrade', 'Max trade'],
  ['maxPosition', 'Max position'],
  ['simulationMode', 'Simulation mode'],
  ['testPeriod', 'Test period'],
  ['language', 'Language'],
  ['startDate', 'Start'],
  ['endDate', 'End'],
]

function ExpressionPanel({ alpha: a }: { alpha: AlphaInfo }) {
  const shown = SETTING_LABELS.filter(
    ([k]) => a.settings[k] !== undefined && a.settings[k] !== null,
  )
  return (
    <Panel
      title="Expression"
      description={isNum(a.operatorCount) ? `${a.operatorCount} operators` : undefined}
      bodyClassName="flex flex-col gap-4"
    >
      <AstInspector expression={a.code} className="text-body" />
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        {shown.map(([k, label]) => (
          <div key={k} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-caption text-ink-subtle">{label}</dt>
            <dd className="num truncate text-body text-ink">{String(a.settings[k])}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  )
}

const VIEWS: { value: ChartView; label: string }[] = [
  { value: 'pnl', label: 'PnL' },
  { value: 'underwater', label: 'Drawdown' },
  { value: 'sharpe', label: 'Rolling Sharpe' },
]

function PerformancePanel({
  view,
  cutoff,
  refresh,
}: {
  view: AlphaView
  cutoff: number | null
  refresh: React.ReactNode
}) {
  const [shown, setShown] = useState<ChartView>('pnl')
  const book = view.alpha.inSample?.bookSize ?? 20_000_000
  const alphaId = view.alpha.alphaId

  // Cost is opt-in: at 0 bps the page is exactly what BRAIN reports, and nothing is fetched.
  const [costText, setCostText] = useState('5')
  const costBps = useDebounced(Math.min(100, Math.max(0, Number(costText) || 0)), 400)
  const cost = useQuery({
    queryKey: ['alpha', alphaId, 'after-cost', costBps],
    queryFn: () => api.afterCost(alphaId, costBps),
    enabled: costBps > 0 && shown === 'pnl',
    staleTime: 10 * 60 * 1000,
  })
  const netCurve = useMemo(() => {
    const d = costBps > 0 ? cost.data : undefined
    return d ? cumulative(d.dates, d.afterCostCurve) : []
  }, [cost.data, costBps])
  const netStats = costBps > 0 ? (cost.data?.afterCost?.inSample ?? null) : null

  const series = useMemo(() => {
    const pnl = cumulative(view.dates, view.pnl)
    const constrained = cumulative(view.dates, view.investabilityPnl)
    const days = daily(pnl)
    return {
      pnl,
      constrained,
      days,
      underwater: underwater(pnl, book),
      sharpe: rollingSharpe(days),
      episodes: drawdowns(pnl, book),
      hitRate: hitRate(days),
    }
  }, [view.dates, view.pnl, view.investabilityPnl, book])

  if (series.pnl.length < 2) {
    return (
      <Panel title="Performance" actions={refresh}>
        <p className="text-body-compact text-ink-subtle">
          BRAIN returned no PnL series for this Alpha.
        </p>
      </Panel>
    )
  }

  const rolling = series.sharpe.map((p) => p.value)
  const weakest = rolling.length ? Math.min(...rolling) : null
  const below =
    cutoff !== null && rolling.length
      ? rolling.filter((v) => v < cutoff).length / rolling.length
      : null

  return (
    <Panel
      title="Performance"
      description={`${fmt.int(series.pnl.length)} trading days, ${fmt.date(series.pnl[0]?.date)} to ${fmt.date(series.pnl.at(-1)?.date)}`}
      actions={
        <>
          {shown === 'pnl' && (
            <label className="flex items-center gap-2 text-body text-ink-muted">
              Cost
              <Input
                type="number"
                min={0}
                max={100}
                step={0.5}
                aria-label="Trading cost in basis points"
                value={costText}
                onChange={(e) => setCostText(e.target.value)}
                className="w-20"
              />
              bps
            </label>
          )}
          <Segmented label="Chart" items={VIEWS} value={shown} onChange={setShown} />
          {refresh}
        </>
      }
      bodyClassName="flex flex-col gap-4"
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric size="sm" label="Profitable days" value={fmt.pct(series.hitRate, 1)} />
        <Metric
          size="sm"
          label="Weakest trailing year"
          value={fmt.ratio(weakest)}
          tone={weakest !== null && cutoff !== null && weakest < cutoff ? 'warn' : 'neutral'}
        />
        <Metric
          size="sm"
          label="Time below cutoff"
          value={below === null ? DASH : fmt.pct(below, 0)}
        />
      </div>
      {costBps > 0 && (cost.isPending || cost.isError || cost.data?.problem) && (
        <Notice tone={cost.isError || cost.data?.problem ? 'warn' : 'info'}>
          {cost.isError
            ? errorMessage(cost.error)
            : (cost.data?.problem ??
              `Working out the after-cost PnL of ${alphaId}. Its daily turnover downloads the first time.`)}
        </Notice>
      )}
      <AlphaChart
        view={shown}
        pnl={series.pnl}
        constrained={series.constrained}
        net={netCurve}
        underwater={series.underwater}
        sharpe={series.sharpe}
        cutoff={cutoff}
        testStart={view.testStart}
        label={`${VIEWS.find((v) => v.value === shown)?.label} of ${view.alpha.alphaId}`}
      />
      {shown === 'pnl' &&
        (series.constrained.length > 1 || view.testStart !== null || netCurve.length > 1) && (
          <p className="flex flex-wrap items-center gap-4 text-body-compact text-ink-subtle">
            {view.testStart === null ? (
              <span className="flex items-center gap-1.5">
                <span className="h-0.5 w-4 bg-ink" aria-hidden /> PnL
              </span>
            ) : (
              <>
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-4 bg-ink-subtle" aria-hidden /> Train
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-4 bg-ink" aria-hidden /> Test, from{' '}
                  <span className="num">{fmt.date(view.testStart)}</span>
                </span>
              </>
            )}
            {series.constrained.length > 1 && (
              <span className="flex items-center gap-1.5">
                <span className="w-4 border-t border-dashed border-ink-tertiary" aria-hidden />{' '}
                Investability constrained
              </span>
            )}
            {netCurve.length > 1 && (
              <span className="flex items-center gap-1.5">
                <span className="h-0.5 w-4 bg-status-warning" aria-hidden /> After {costBps} bps
                {netStats?.sharpe != null && (
                  <>
                    {' '}
                    · Sharpe <span className="num">{fmt.ratio(netStats.sharpe)}</span> from{' '}
                    <span className="num">{fmt.ratio(view.alpha.inSample?.sharpe)}</span>
                  </>
                )}
              </span>
            )}
          </p>
        )}
      {shown === 'underwater' && series.episodes.length > 0 && (
        <table className="w-full text-body">
          <thead>
            <tr className="border-b border-hairline text-body-compact text-ink-subtle">
              <th className="py-1.5 text-left font-medium">Deepest drawdowns</th>
              <th className="py-1.5 text-right font-medium">Depth</th>
              <th className="py-1.5 text-right font-medium">Bottom</th>
              <th className="py-1.5 text-right font-medium">Recovered</th>
              <th className="py-1.5 text-right font-medium">Days</th>
            </tr>
          </thead>
          <tbody>
            {series.episodes.map((e) => (
              <tr key={e.peak} className="border-b border-hairline-subtle last:border-b-0">
                <td className="num py-1.5 text-ink-muted">From {fmt.date(e.peak)}</td>
                <td className="num py-1.5 text-right text-pnl-negative">{fmt.pct(e.depth, 2)}</td>
                <td className="num py-1.5 text-right text-ink-muted">{fmt.date(e.trough)}</td>
                <td
                  className={cn(
                    'num py-1.5 text-right',
                    e.recovered ? 'text-ink-muted' : 'text-status-warning',
                  )}
                >
                  {e.recovered ? fmt.date(e.recovered) : 'Not yet'}
                </td>
                <td className="num py-1.5 text-right text-ink-muted">{fmt.int(e.days)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {shown === 'sharpe' && (
        <p className="text-body-compact text-ink-subtle">
          Sharpe over each trailing {YEAR} trading days, against the{' '}
          <span className="num">{fmt.ratio(cutoff)}</span> a submission needs. BRAIN's IS ladder
          test weighs the latest years most.
        </p>
      )}
    </Panel>
  )
}
