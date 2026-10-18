/**
 * One Alpha, in full: will it submit, how it earned its PnL, and where it came from.
 * The verdict leads; everything below it is the evidence. Submission stays on BRAIN.
 */

import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { ArrowLeftIcon, RefreshCwIcon, SlidersHorizontalIcon, UnlinkIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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
  Disclosure,
  ErrorNotice,
  Input,
  Metric,
  Notice,
  Page,
  Panel,
  Progress,
  Segmented,
  Skeleton,
} from '@/ui/kit'
import {
  cumulative,
  daily,
  drawdowns,
  hitRate,
  isQuickMode,
  resultOf,
  rollingSharpe,
  underwater,
  verdictOf,
  YEAR,
} from './analysis'
import { type AlphaInfo, type AlphaView, alpha as api } from './api'
import { AlphaChart, ArcChildrenChart, type ChartView } from './chart'
import {
  AggregatesPanel,
  ChecksPanel,
  ComparisonPanel,
  CorrelationsPanel,
  EligibilityPanel,
  LineagePanel,
  YearlyPanel,
} from './panels'
import { PropertiesPanel } from './properties'

const arcChecksStarted = new Set<string>()

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
      <Notice tone="info" title="ARC results are split by covered region">
        The ALL-region result contains one child Alpha per covered region. Performance is shown
        below; open a child Alpha for its full chart, yearly metrics, and checks.
      </Notice>
    )
  return null
}

function ArcChildrenPanel({ view }: { view: AlphaView }) {
  const alpha = view.alpha
  const children = alpha.type === 'RA_PARENT' ? alpha.children : []
  const results = useQueries({
    queries: children.map((alphaId) => ({
      queryKey: ['alpha', alphaId, 'page'],
      queryFn: () => api.page(alphaId),
      staleTime: 10 * 60 * 1000,
      retry: false,
    })),
  })
  const queryClient = useQueryClient()
  useEffect(() => {
    if (alpha.type !== 'RA_PARENT') return
    for (const alphaId of children) {
      if (arcChecksStarted.has(alphaId)) continue
      arcChecksStarted.add(alphaId)
      void api
        .check(alphaId)
        .then(() => queryClient.invalidateQueries({ queryKey: ['alpha', alphaId, 'page'] }))
        .catch(() => arcChecksStarted.delete(alphaId))
    }
  }, [alpha.type, children, queryClient])
  if (alpha.type !== 'RA_PARENT') return null

  const loaded = results.filter((result) => result.data).length
  const resolved = results
    .map((result) => result.data?.alpha)
    .filter((child) => child !== undefined)
  const passes = resolved.filter((child) => child.verdict === 'submittable').length
  const failures = resolved.filter((child) => child.verdict === 'refused').length
  const required = Math.ceil((2 * children.length) / 3)
  const pending = Math.max(0, children.length - passes - failures)
  const familyStatus =
    passes >= required ? 'Pass' : passes + pending < required ? 'Fail' : 'Pending'
  const childCurves = results.flatMap((result, index) => {
    const data = result.data
    if (!data || data.dates.length < 2) return []
    const region = data.alpha.settings['region']
    return [
      {
        label: typeof region === 'string' ? region : (children[index] ?? 'Child Alpha'),
        points: cumulative(data.dates, data.pnl),
      },
    ]
  })
  const curves =
    childCurves.length > 0
      ? childCurves
      : view.dates.length > 1
        ? [{ label: 'ALL (BRAIN)', points: cumulative(view.dates, view.pnl) }]
        : []
  return (
    <Panel
      title="ARC child results"
      description={
        childCurves.length > 0
          ? 'Each line is a child Alpha’s PnL curve; lines are shown separately, not combined.'
          : 'BRAIN’s separate ALL-region PnL series.'
      }
      bodyClassName="flex flex-col gap-4"
    >
      {children.length === 0 ? (
        <p className="text-body-compact text-ink-subtle">
          BRAIN has not returned regional Alphas yet.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-body-compact">
            <span className="font-semibold text-ink">ARC validation: {familyStatus}</span>
            <span className="text-ink-subtle">
              {passes} pass · {failures} fail · {pending} pending · {required} required
            </span>
          </div>
          {curves.length > 0 && (
            <ArcChildrenChart series={curves} label="Separate regional ARC child PnL curves" />
          )}
          {loaded < children.length && (
            <div className="flex items-center gap-3 px-4 py-3 text-body-compact text-ink-subtle">
              <Progress
                label="Loading ARC regional performance summaries"
                value={loaded / children.length}
                className="max-w-48"
              />
              <span>
                {fmt.int(loaded)} / {fmt.int(children.length)} summaries loaded
              </span>
            </div>
          )}
          <table className="w-full text-body">
            <thead>
              <tr className="border-y border-hairline text-body-compact text-ink-subtle">
                <th className="px-4 py-2 text-left font-medium">Region</th>
                <th className="px-4 py-2 text-right font-medium">Sharpe</th>
                <th className="px-4 py-2 text-right font-medium">Fitness</th>
                <th className="px-4 py-2 text-right font-medium">Returns</th>
                <th className="px-4 py-2 text-right font-medium">Turnover</th>
                <th className="px-4 py-2 text-right font-medium">Submission</th>
                <th className="px-4 py-2 text-right font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {children.map((alphaId, index) => {
                const child = results[index]?.data?.alpha
                const stats = child?.inSample
                const region = child?.settings['region']
                const verdict = child?.verdict
                return (
                  <tr key={alphaId} className="border-b border-hairline-subtle last:border-b-0">
                    <td className="px-4 py-2 text-ink">
                      {typeof region === 'string'
                        ? region
                        : results[index]?.isError
                          ? 'Unavailable'
                          : 'Loading'}
                    </td>
                    <td className="num px-4 py-2 text-right text-ink">
                      {fmt.ratio(stats?.sharpe ?? null)}
                    </td>
                    <td className="num px-4 py-2 text-right text-ink">
                      {fmt.ratio(stats?.fitness ?? null)}
                    </td>
                    <td className="num px-4 py-2 text-right text-ink">
                      {fmt.pct(stats?.returns ?? null)}
                    </td>
                    <td className="num px-4 py-2 text-right text-ink">
                      {fmt.pct(stats?.turnover ?? null)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Badge
                        tone={
                          verdict === 'submittable'
                            ? 'profit'
                            : verdict === 'refused'
                              ? 'loss'
                              : 'muted'
                        }
                      >
                        {verdict === 'submittable'
                          ? 'Pass'
                          : verdict === 'refused'
                            ? 'Fail'
                            : 'Checking'}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        to="/alpha/$alphaId"
                        params={{ alphaId }}
                        className="text-primary hover:underline"
                      >
                        Open full results
                      </Link>
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

function Body({ view, refresh }: { view: AlphaView; refresh: React.ReactNode }) {
  const a = view.alpha
  const verdict = verdictOf(a)
  const cutoff = a.checks.find((c) => c.name === 'LOW_SHARPE')?.limit ?? null

  return (
    <>
      <Header
        alpha={a}
        fetchedAt={view.fetchedAt}
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              render={<Link to="/tools/settings-sampler" search={{ alpha: a.alphaId }} />}
            >
              <SlidersHorizontalIcon aria-hidden />
              Send to Settings Sampler
            </Button>
            <Button
              size="sm"
              variant="secondary"
              render={<Link to="/tools/correlation-breaker" search={{ alpha: a.alphaId }} />}
            >
              <UnlinkIcon aria-hidden />
              Send to Correlation Lab
            </Button>
            {!isQuickMode(a) && <RecheckButton alphaId={a.alphaId} />}
            <OpenInBrain url={a.brainUrl} />
            <AlphaActionsMenu alphaId={a.alphaId} />
          </>
        }
      />
      {view.problems.map((p) => (
        <Notice key={p} tone="warn">
          {p}
        </Notice>
      ))}
      {view.rejected && (
        <Notice tone="error" title="Rejected by Alpha quality analysis">
          {view.rejectionReason ?? 'This Alpha failed a multi-year quality check.'}
        </Notice>
      )}
      <RegionAgnosticNote type={a.type} />
      <ExpressionPanel alpha={a} />
      {a.type === 'RA_PARENT' ? (
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <div className="flex min-w-0 flex-col gap-4">
            <ArcChildrenPanel view={view} />
            <LineagePanel lineage={view.lineage} />
          </div>
          <PropertiesPanel key={`${a.alphaId}:${a.dateModified ?? ''}`} alpha={a} />
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <div className="flex min-w-0 flex-col gap-4">
            <PerformancePanel
              view={view}
              cutoff={isNum(cutoff) ? cutoff : null}
              refresh={refresh}
            />
            <YearlyPanel years={view.yearly} cutoff={isNum(cutoff) ? cutoff : null} />
            <AggregatesPanel alpha={a} />
            <ComparisonPanel alphaId={a.alphaId} />
            <LineagePanel lineage={view.lineage} />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <ChecksPanel groups={verdict.groups} />
            <CorrelationsPanel alphaId={a.alphaId} />
            <EligibilityPanel alpha={a} />
            {/* Both, so the draft resets on a save and on a sibling. */}
            <PropertiesPanel key={`${a.alphaId}:${a.dateModified ?? ''}`} alpha={a} />
          </div>
        </div>
      )}
    </>
  )
}

function Header({
  alpha: a,
  fetchedAt,
  actions,
}: {
  alpha: AlphaInfo
  fetchedAt: string
  actions: React.ReactNode
}) {
  const scope = [a.settings['region'], a.settings['universe'], `D${a.settings['delay'] ?? '?'}`]
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 px-1">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="text-title text-balance break-words text-ink">
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
      <div className="flex flex-wrap items-center gap-2">
        {actions}
        <span className="hidden text-body-compact text-ink-subtle 2xl:inline">
          Read from BRAIN {fmt.ago(fetchedAt)}
        </span>
      </div>
    </header>
  )
}

const SETTING_LABELS: [string, string][] = [
  ['region', 'Region'],
  ['universe', 'Universe'],
  ['delay', 'Delay'],
  ['decay', 'Decay'],
  ['neutralization', 'Neutralization'],
  ['truncation', 'Truncation'],
]

const EXTRA_SETTING_LABELS: [string, string][] = [
  ['instrumentType', 'Instrument'],
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
  const settings = (labels: [string, string][]) =>
    labels.filter(([k]) => a.settings[k] !== undefined && a.settings[k] !== null)
  const main = settings(SETTING_LABELS)
  const extra = settings(EXTRA_SETTING_LABELS)
  const settingGrid = (shown: [string, string][]) => (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
      {shown.map(([k, label]) => (
        <div key={k} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-caption text-ink-subtle">{label}</dt>
          <dd className="num truncate text-body text-ink">{String(a.settings[k])}</dd>
        </div>
      ))}
    </dl>
  )
  return (
    <Panel
      title="Expression"
      description={isNum(a.operatorCount) ? `${a.operatorCount} operators` : undefined}
      actions={
        main.length > 0 && (
          <dl className="grid max-w-[48rem] grid-cols-2 gap-x-5 gap-y-1 text-right sm:grid-cols-3 lg:grid-cols-6">
            {main.map(([k, label]) => (
              <div key={k} className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-caption text-ink-subtle">{label}</dt>
                <dd className="num truncate text-body text-ink">{String(a.settings[k])}</dd>
              </div>
            ))}
          </dl>
        )
      }
      bodyClassName="flex flex-col gap-4"
    >
      <AstInspector expression={a.code} className="text-body" />
      {extra.length > 0 && (
        <Disclosure summary="Additional settings">{settingGrid(extra)}</Disclosure>
      )}
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
  const stats = view.alpha.inSample
  const thresholdTone = (names: string[]) => {
    const checks = view.alpha.checks.filter((check) => names.includes(check.name))
    if (checks.length === 0) return 'neutral' as const
    if (checks.some((check) => resultOf(check) === 'FAIL' || resultOf(check) === 'ERROR')) {
      return 'loss' as const
    }
    return checks.every((check) => resultOf(check) === 'PASS') ? ('profit' as const) : 'neutral'
  }

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
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Metric
          boxed
          label="Sharpe"
          value={fmt.ratio(stats?.sharpe)}
          hint={cutoff === null ? undefined : `Target ≥ ${fmt.ratio(cutoff)}`}
          tone={thresholdTone(['LOW_SHARPE'])}
        />
        <Metric
          boxed
          label="Fitness"
          value={fmt.ratio(stats?.fitness)}
          tone={thresholdTone(['LOW_FITNESS'])}
        />
        <Metric boxed label="Returns (ann.)" value={fmt.pct(stats?.returns, 1)} tone="profit" />
        <Metric
          boxed
          label="Turnover"
          value={fmt.pct(stats?.turnover, 1)}
          hint={stats?.turnover == null ? undefined : 'Annualized'}
          tone={thresholdTone(['LOW_TURNOVER', 'HIGH_TURNOVER'])}
        />
        <Metric boxed label="Max drawdown" value={fmt.pct(stats?.drawdown, 1)} tone="neutral" />
      </div>
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
        stacked={shown === 'pnl'}
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
                <td className="num py-1.5 text-right text-pnl-negative-text">
                  {fmt.pct(e.depth, 2)}
                </td>
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
