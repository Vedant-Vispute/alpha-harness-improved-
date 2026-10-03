/**
 * Portfolio: submitted Alphas combined at equal weight, the way BRAIN combines its own pool.
 * Genius scores Combined Alpha Performance and Combined Power Pool Alpha Performance; filter
 * by the Power Pool Alpha classification for the second.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CopyIcon, RefreshCwIcon } from 'lucide-react'
import { Fragment, useState } from 'react'
import { toast } from 'sonner'
import { tasks } from '@/api/core'
import { errorMessage } from '@/api/http'
import { cn } from '@/lib/cn'
import { CORE_METRICS, CORE_ORDER, DASH, fmt } from '@/lib/format'
import { useLive } from '@/lib/live'
import { useDebounced } from '@/lib/use-debounced'
import { useRefetchOn } from '@/lib/ws'
import {
  Button,
  Chips,
  ErrorNotice,
  Input,
  LINK,
  Notice,
  Page,
  PageHeader,
  Panel,
  Progress,
  Skeleton,
  signTone,
  TEXT_TONE,
} from '@/ui/kit'
import { type Column, DataTable, type Sort } from '@/ui/table'
import {
  type Investability,
  type PortfolioMember,
  type PortfolioResult,
  type PortfolioStats,
  portfolio,
  type Windows,
} from './api'
import { ChartLegend, PortfolioChart } from './chart'
import { CorrelationMatrix } from './correlation'
import { PyramidPicker } from './pyramid-grid'

const INVESTABILITY: Record<Investability, string> = {
  max_trade: 'Max Trade',
  max_position: 'Max Position',
  none: 'None',
}

/** One block of filter chips. Within a block any match keeps an Alpha; blocks combine with AND. */
interface Facet {
  key: string
  title: string
  values: (m: PortfolioMember) => string[]
}

const FACETS: Facet[] = [
  { key: 'classification', title: 'Classifications', values: (m) => m.classifications },
  {
    key: 'investability',
    title: 'Investability Constraints',
    values: (m) => [INVESTABILITY[m.investability]],
  },
  { key: 'region', title: 'Region', values: (m) => (m.region ? [m.region] : []) },
  { key: 'delay', title: 'Delay', values: (m) => (m.delay === null ? [] : [`D${m.delay}`]) },
  // Category is a row of the Pyramid grid, so it needs no filter of its own.
  { key: 'pyramid', title: 'Pyramids', values: (m) => m.pyramids },
]

const facetOf = (key: string) => FACETS.find((f) => f.key === key) as Facet

type MetricKey = (typeof CORE_ORDER)[number]

const METRICS = CORE_ORDER.map((key) => ({ key, ...CORE_METRICS[key] }))

function metricColumns<T>(
  get: (row: T) => Partial<Record<MetricKey, number | null>> | null,
  width = 'minmax(84px,1fr)',
) {
  return METRICS.map(
    (m): Column<T> => ({
      key: m.key,
      header: m.label,
      align: 'right',
      // "39.23 bps" is the widest figure; at the shared width it wrapped onto two lines.
      width: m.key === 'margin' ? 'minmax(100px,1fr)' : width,
      cell: (row) => {
        const value = get(row)?.[m.key]
        return (
          <span className={cn('num', m.signed && TEXT_TONE[signTone(value)])}>{m.show(value)}</span>
        )
      },
    }),
  )
}

/** The running Portfolio sync, from the live feed or, without one, a poll. */
/** The latest Portfolio sync, running or just finished. */
function useLastSync() {
  const live = useLive((s) => s.tasks)
  const polled = useQuery({
    queryKey: ['background-tasks'],
    queryFn: tasks.list,
    enabled: live == null,
    refetchInterval: 3000,
  })
  return ((live ?? polled.data)?.tasks ?? []).filter((t) => t.kind === 'portfolio-sync').at(-1)
}

function useSyncTask() {
  const last = useLastSync()
  return last?.state === 'running' ? last : undefined
}

/** IDs shown before the rest are counted: a large account has hundreds. */
const SHOWN_IDS = 12

function SyncProgress() {
  const task = useLastSync()
  if (!task) return null
  if (task.state === 'failed')
    return (
      <Notice tone="error" title="The sync stopped">
        {task.error}
      </Notice>
    )
  if (task.state !== 'running')
    return <p className="text-body-compact text-ink-muted">{task.detail}</p>
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-body-compact text-ink-muted">{task.detail ?? task.label}</span>
      <Progress value={task.progress ?? null} label="Sync progress" />
    </div>
  )
}

function SyncButton() {
  const queryClient = useQueryClient()
  const running = useSyncTask() !== undefined
  const sync = useMutation({
    mutationFn: portfolio.sync,
    onSuccess: () => {
      toast.success('Syncing your SUBMITTED Alphas from BRAIN')
      void queryClient.invalidateQueries({ queryKey: ['portfolio'] })
    },
  })
  const busy = sync.isPending || running
  return (
    <Button variant="primary" loading={busy} onClick={() => sync.mutate()}>
      {!busy && <RefreshCwIcon />}
      Sync from BRAIN
    </Button>
  )
}

export function PortfolioScreen() {
  const members = useQuery({ queryKey: ['portfolio', 'members'], queryFn: portfolio.members })
  useRefetchOn('tasks', ['portfolio'], 2000)

  const [picked, setPicked] = useState<Record<string, string[]>>({})
  /** Ticked or unticked by hand, over what the filters pick. A filter change clears it. */
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [costText, setCostText] = useState('5')
  const cost = useDebounced(Math.min(100, Math.max(0, Number(costText) || 0)), 400)

  const all = members.data?.members ?? []
  const matches = (m: PortfolioMember) =>
    FACETS.every((f) => {
      const want = picked[f.key] ?? []
      return !want.length || f.values(m).some((v) => want.includes(v))
    })
  const choose = (key: string, value: string[]) => {
    setPicked((prev) => ({ ...prev, [key]: value }))
    setOverrides(new Map())
  }
  const block = (key: string, size?: 'lg') => (
    <FacetBlock
      facet={facetOf(key)}
      members={all}
      value={picked[key] ?? []}
      onChange={(v) => choose(key, v)}
      {...(size ? { size } : {})}
    />
  )
  const isIncluded = (m: PortfolioMember) => overrides.get(m.alphaId) ?? matches(m)
  // Ticked Alphas first, each group in its original order.
  const rows = [...all.filter(isIncluded), ...all.filter((m) => !isIncluded(m))]
  const included = all.filter(isIncluded).map((m) => m.alphaId)
  const ids = [...included].sort()

  const computed = useQuery({
    queryKey: ['portfolio', 'compute', ids, cost],
    queryFn: () => portfolio.compute(ids, cost),
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
  })
  // A disabled query keeps its last answer, which would outlive deselecting every Alpha.
  const result = ids.length ? computed.data : undefined
  const unlabelled = all.filter((m) => !m.labelled).length
  const syncing = useSyncTask() !== undefined

  return (
    <Page>
      <PageHeader title="Portfolio" actions={<SyncButton />} />
      <SyncProgress />
      {members.error ? <ErrorNotice error={members.error} /> : null}
      {computed.error ? <ErrorNotice error={computed.error} /> : null}
      {unlabelled > 0 && (
        <Notice tone="warn" title="Classifications and pyramids not read yet">
          Sync from BRAIN to read them for {unlabelled} SUBMITTED Alpha
          {unlabelled === 1 ? '' : 's'}.
        </Notice>
      )}
      {result && result.missing.length > 0 && (
        <Notice
          tone={syncing ? 'info' : 'warn'}
          title={
            syncing
              ? `Downloading PnL: ${fmt.int(result.missing.length)} Alphas to go`
              : `${fmt.int(result.missing.length)} Alpha${result.missing.length === 1 ? ' has' : 's have'} no PnL stored`
          }
        >
          {syncing
            ? 'They join the charts below as they arrive.'
            : 'They are left out until it is downloaded. Sync from BRAIN to download it; one that stays after a sync is one BRAIN gave no PnL for.'}{' '}
          <span className="num text-ink-subtle">
            {result.missing.slice(0, SHOWN_IDS).join(', ')}
            {result.missing.length > SHOWN_IDS &&
              ` and ${fmt.int(result.missing.length - SHOWN_IDS)} more`}
          </span>
        </Notice>
      )}

      <Panel
        title="Alphas"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body text-ink-muted">
              <span className="num text-ink">{included.length}</span> of{' '}
              <span className="num">{all.length}</span> SUBMITTED selected
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setOverrides(new Map(all.map((m) => [m.alphaId, true])))}
            >
              Select All
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setOverrides(new Map(all.map((m) => [m.alphaId, false])))}
            >
              Deselect All
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!included.length}
              onClick={() =>
                navigator.clipboard.writeText(included.join(', ')).then(
                  () =>
                    toast.success(
                      `Copied ${included.length} Alpha ID${included.length === 1 ? '' : 's'}`,
                    ),
                  (e: unknown) => toast.error(errorMessage(e)),
                )
              }
            >
              <CopyIcon />
              Copy IDs
            </Button>
          </div>
        }
        bodyClassName="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-5">
          {block('classification', 'lg')}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 *:rounded-md *:border *:border-hairline *:bg-surface-2 *:p-3">
            {block('region')}
            {block('delay')}
            {block('investability')}
            <PyramidPicker
              members={all}
              value={picked['pyramid'] ?? []}
              onChange={(v) => choose('pyramid', v)}
            />
          </div>
        </div>
        <MembersTable
          rows={rows}
          selected={new Set(included)}
          onSelect={(id, on) => setOverrides((prev) => new Map(prev).set(id, on))}
          loading={members.isPending}
        />
      </Panel>

      {ids.length > 0 && !result ? (
        <Skeleton className="h-96" label="Combining Alphas" />
      ) : !result || result.alphas === 0 ? (
        <Panel>
          <p className="text-body text-ink-subtle">
            {all.length === 0
              ? 'No SUBMITTED Alphas stored yet. Sync from BRAIN to fetch them.'
              : 'Select at least one Alpha.'}
          </p>
        </Panel>
      ) : (
        <>
          <Panel
            title="Combined In-Sample Performance"
            actions={<ChartLegend testStart={result.testStart} />}
            bodyClassName="flex flex-col gap-4"
          >
            <StatsTable result={result} windows={result.stats} />
            <PortfolioChart
              dates={result.dates}
              curve={result.curve}
              testStart={result.testStart}
              label="Cumulative PnL and drawdown of the combined Alphas"
            />
          </Panel>

          <Panel
            title="Estimated After-Cost Performance"
            actions={
              <label className="flex items-center gap-2 text-body text-ink-muted">
                Cost
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={costText}
                  onChange={(e) => setCostText(e.target.value)}
                  className="w-20"
                />
                bps
              </label>
            }
            bodyClassName="flex flex-col gap-4"
          >
            <StatsTable result={result} windows={result.afterCost} />
            <PortfolioChart
              dates={result.dates}
              curve={result.afterCostCurve}
              testStart={result.testStart}
              label="Cumulative after-cost PnL and drawdown of the combined Alphas"
            />
          </Panel>

          <Panel title="Yearly">
            <DataTable
              label="Yearly stats of the combined Alphas"
              rows={result.yearly}
              rowKey={(r) => String(r.year)}
              columns={YEARLY_COLUMNS}
              maxHeight="none"
            />
          </Panel>

          {result.alphas > 1 && (
            <Panel
              title="Correlation"
              description={
                <>
                  Pearson Correlation of Daily PnL over the last 4 years.
                  <br />
                  Each square is a pair of Alphas, in submission order: newest at the top left,
                  oldest at the bottom right. Hover a square for the pair.
                </>
              }
              actions={
                <div className="grid grid-cols-[auto_auto_auto] items-baseline gap-x-2 gap-y-0.5 text-body text-ink-muted">
                  {(
                    [
                      ['Highest', result.highest],
                      ['Lowest', result.lowest],
                    ] as const
                  ).map(
                    ([label, pair]) =>
                      pair && (
                        <Fragment key={label}>
                          <span>{label}</span>
                          <span className="num text-right text-ink">
                            {fmt.ratio(pair.correlation)}
                          </span>
                          <span className="mono-metric text-ink-subtle">
                            {pair.a} · {pair.b}
                          </span>
                        </Fragment>
                      ),
                  )}
                </div>
              }
            >
              <CorrelationMatrix result={result} />
            </Panel>
          )}
        </>
      )}
    </Page>
  )
}

function FacetBlock({
  facet,
  members,
  value,
  onChange,
  size,
}: {
  facet: Facet
  members: PortfolioMember[]
  value: string[]
  onChange: (value: string[]) => void
  size?: 'lg'
}) {
  const counts = new Map<string, number>()
  for (const m of members) for (const v of facet.values(m)) counts.set(v, (counts.get(v) ?? 0) + 1)
  const items = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([v, n]) => ({
      value: v,
      label:
        size === 'lg' ? (
          <span className="flex w-full items-center justify-between gap-3">
            {v}
            <span className="num text-ink-muted">{n}</span>
          </span>
        ) : (
          `${v} · ${n}`
        ),
    }))
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-body-compact font-medium text-ink-muted">{facet.title}</h3>
      {items.length ? (
        <Chips
          label={facet.title}
          items={items}
          value={value}
          onChange={onChange}
          {...(size ? { size } : {})}
        />
      ) : (
        <span className="text-body-compact text-ink-subtle">{DASH}</span>
      )}
    </div>
  )
}

const WINDOWS: { key: keyof Windows; label: string }[] = [
  { key: 'inSample', label: 'In Sample' },
  { key: 'train', label: 'Train Period' },
  { key: 'test', label: 'Test Period' },
]

interface WindowRow {
  label: string
  span: string
  stats: PortfolioStats | null
}

const STATS_COLUMNS: Column<WindowRow>[] = [
  {
    key: 'period',
    header: 'Period',
    width: 'minmax(300px,2fr)',
    cell: (r) => (
      <span className="flex min-w-0 items-baseline gap-3">
        <span className="text-ink">{r.label}</span>
        <span className="num truncate text-body-compact text-ink-subtle">{r.span}</span>
      </span>
    ),
  },
  ...metricColumns<WindowRow>((r) => r.stats),
]

function StatsTable({ result, windows }: { result: PortfolioResult; windows: Windows | null }) {
  const rows = WINDOWS.flatMap((w): WindowRow[] => {
    const period = result.periods?.[w.key]
    if (!period) return []
    return [
      {
        label: w.label,
        span: `${fmt.date(period.start)} – ${fmt.date(period.end)}`,
        stats: windows?.[w.key] ?? null,
      },
    ]
  })
  return (
    <DataTable
      label="Performance by period"
      rows={rows}
      rowKey={(r) => r.label}
      columns={STATS_COLUMNS}
      maxHeight="none"
    />
  )
}

type YearRow = PortfolioResult['yearly'][number]

const YEARLY_COLUMNS: Column<YearRow>[] = [
  {
    key: 'year',
    header: 'Year',
    width: '80px',
    cell: (r) => <span className="num">{r.year}</span>,
  },
  ...metricColumns<YearRow>((r) => r),
  {
    key: 'pnl',
    header: 'PnL',
    align: 'right',
    width: 'minmax(110px,1fr)',
    cell: (r) => <span className={cn('num', TEXT_TONE[signTone(r.pnl)])}>{fmt.int(r.pnl)}</span>,
  },
]

/** (Long − Short) ÷ (Long + Short) in stocks held, or null without both counts. */
function imbalanceOf(m: PortfolioMember): number | null {
  const { longCount: long, shortCount: short } = m
  if (long == null || short == null || long + short === 0) return null
  return (long - short) / (long + short)
}

function sortValue(m: PortfolioMember, key: string): number | null {
  if (key === 'imbalance') return imbalanceOf(m)
  const value = (m as unknown as Record<string, unknown>)[key]
  return typeof value === 'number' ? value : null
}

function MembersTable({
  rows,
  selected,
  onSelect,
  loading,
}: {
  rows: PortfolioMember[]
  selected: ReadonlySet<string>
  onSelect: (id: string, on: boolean) => void
  loading: boolean
}) {
  const [sort, setSort] = useState<Sort | null>(null)
  const sorted = sort
    ? [...rows].sort((a, b) => {
        const x = sortValue(a, sort.key)
        const y = sortValue(b, sort.key)
        // Blank last whichever way: an Alpha with no figure is not the lowest.
        if (x === null) return y === null ? 0 : 1
        if (y === null) return -1
        return sort.desc ? y - x : x - y
      })
    : rows
  const columns: Column<PortfolioMember>[] = [
    {
      key: 'id',
      header: 'Alpha',
      width: '104px',
      cell: (m) => (
        <Link to="/alpha/$alphaId" params={{ alphaId: m.alphaId }} className={LINK}>
          {m.alphaId}
        </Link>
      ),
    },
    {
      key: 'classifications',
      header: 'Classifications',
      width: 'minmax(112px,2fr)',
      cell: (m) => {
        const names = m.classifications.join(', ')
        return (
          <span className="truncate text-body-compact text-ink-muted" title={names}>
            {names || DASH}
          </span>
        )
      },
    },
    { key: 'region', header: 'Region', width: '72px', cell: (m) => m.region ?? DASH },
    {
      key: 'delay',
      header: 'Delay',
      width: '64px',
      cell: (m) => <span className="num">{m.delay == null ? DASH : `D${m.delay}`}</span>,
    },
    {
      key: 'investability',
      header: 'Investability',
      width: '112px',
      cell: (m) => INVESTABILITY[m.investability],
    },
    ...metricColumns<PortfolioMember>((m) => m).map((c) => ({ ...c, sortable: true })),
    {
      key: 'imbalance',
      sortable: true,
      header: (
        <span title="(Long − Short) ÷ (Long + Short), in stocks held. 0% is balanced; +20% holds more stocks long, −20% more short.">
          Long/Short Imbalance
        </span>
      ),
      width: 'minmax(112px,1fr)',
      align: 'right',
      cell: (m) => {
        const share = imbalanceOf(m)
        if (share === null) return DASH
        const imbalance = Math.round(share * 100)
        return (
          <span
            className="num"
            title={`${fmt.int(m.longCount ?? 0)} long · ${fmt.int(m.shortCount ?? 0)} short`}
          >
            {imbalance > 0 ? '+' : ''}
            {imbalance}%
          </span>
        )
      },
    },
    {
      key: 'correlation',
      sortable: true,
      header: (
        <span title="Highest daily PnL correlation with any other submitted Alpha, over the last 4 years">
          Correlation
        </span>
      ),
      width: 'minmax(96px,1fr)',
      align: 'right',
      cell: (m) =>
        m.correlation == null ? (
          DASH
        ) : (
          <span
            className={cn(
              'num',
              m.correlation >= 0.7
                ? 'text-pnl-negative-text'
                : m.correlation >= 0.5
                  ? 'text-status-warning'
                  : 'text-pnl-positive-text',
            )}
          >
            {fmt.ratio(m.correlation)}
          </span>
        ),
    },
  ]
  return (
    <DataTable
      label="SUBMITTED Alphas"
      rows={sorted}
      rowKey={(m) => m.alphaId}
      columns={columns}
      {...(sort ? { sort } : {})}
      onSort={setSort}
      selected={selected}
      onSelect={onSelect}
      loading={loading}
      maxHeight="28rem"
      empty="No SUBMITTED Alpha matches these filters."
    />
  )
}
