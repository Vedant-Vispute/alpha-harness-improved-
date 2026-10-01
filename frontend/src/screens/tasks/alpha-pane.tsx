/**
 * The Alphas a screen is looking at, narrowed by the Power Pool Workflow in three steps, each
 * on what the one before kept: unsubmitted, then no check FAIL or ERROR, then Power Pool
 * Correlation passed. The survivors carry After-Cost Sharpe to sort them by.
 *
 * Shared by a task's own results and the Submittable list across every task, because the two
 * differ only in which Alphas they start from — a second copy would be a second place for the
 * Power Pool rules to drift.
 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { PlayIcon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { tasks } from '@/api/core'
import { errorMessage } from '@/api/http'
import { cn } from '@/lib/cn'
import { DASH, fmt } from '@/lib/format'
import { useLive } from '@/lib/live'
import { BRAIN_ALPHA_URL } from '@/screens/pool/api'
import { labTasks, type RankedAlpha } from '@/screens/tasks/api'
import { type PowerPoolRow, powerPoolTone, usePowerPool } from '@/screens/tasks/power-pool'
import { Button, ErrorNotice, LINK, Notice, Panel, Progress } from '@/ui/kit'
import { type Column, DataTable, type Sort } from '@/ui/table'

const WORKFLOW = 'power-pool-workflow'

type Stored = RankedAlpha & { alphaId: string }

/** Step 1: not on the platform yet. */
const isUnsubmitted = (r: RankedAlpha): r is Stored => Boolean(r.alphaId) && !r.submitted
/** Step 2: no check FAIL or ERROR. PENDING is not a refusal. */
const isClean = (r: RankedAlpha) => r.submittable && r.refusedBy.length === 0
/** Step 3: below the ceiling, or past it with the Sharpe it takes. */
const passesPool = (row: PowerPoolRow | undefined) => {
  const tone = powerPoolTone(row)
  return tone === 'clear' || tone === 'beats'
}

/** `compare`, plus the one column that lives in the Power Pool map rather than on the row. */
function comparePool(
  a: RankedAlpha,
  b: RankedAlpha,
  sort: Sort,
  by: ReadonlyMap<string, PowerPoolRow>,
  compare: (a: RankedAlpha, b: RankedAlpha, sort: Sort) => number,
): number {
  if (sort.key !== 'poolCorrelation') return compare(a, b, sort)
  const pick = (r: RankedAlpha) => (r.alphaId ? by.get(r.alphaId)?.correlation : null) ?? null
  const x = pick(a)
  const y = pick(b)
  // Unmeasured last either way: an Alpha with no correlation is not the least correlated.
  if (x == null) return y == null ? 0 : 1
  if (y == null) return -1
  return sort.desc ? y - x : x - y
}

function poolColumn(by: ReadonlyMap<string, PowerPoolRow>): Column<RankedAlpha> {
  return {
    key: 'poolCorrelation',
    header: 'Power Pool Correlation',
    width: 'minmax(120px,1.1fr)',
    align: 'right',
    sortable: true,
    cell: (r) => {
      const found = r.alphaId ? by.get(r.alphaId) : undefined
      if (!found || found.correlation == null) {
        return <span className="text-ink-subtle">{DASH}</span>
      }
      const tone = powerPoolTone(found)
      return (
        <span
          className={cn(
            'num',
            tone === 'clear'
              ? 'text-pnl-positive-text'
              : tone === 'beats'
                ? 'text-status-warning'
                : 'text-pnl-negative-text',
          )}
        >
          {fmt.ratio(found.correlation, 4)}
        </span>
      )
    },
  }
}

/** The workflow's job, running or just finished, from the shared background task list. */
function useWorkflowJob() {
  const live = useLive((s) => s.tasks)
  const polled = useQuery({
    queryKey: ['background-tasks'],
    queryFn: tasks.list,
    enabled: live == null,
    refetchInterval: 3000,
  })
  const jobs = ((live ?? polled.data)?.tasks ?? []).filter((t) => t.kind === WORKFLOW)
  return jobs.find((t) => t.state === 'running') ?? jobs.at(-1)
}

/**
 * Ctrl-click (Cmd on a Mac) opens the row's Alpha on BRAIN, which is where the id is
 * actually useful — so the table spends no column printing one. A plain click does nothing:
 * leaving BRAIN is the kind of thing that should take a deliberate press, and the modifier
 * is the same one a browser already uses for "open this somewhere else".
 */
const openOnBrain = (r: RankedAlpha, event: React.MouseEvent | React.KeyboardEvent) => {
  if (!r.alphaId || !(event.ctrlKey || event.metaKey)) return
  event.preventDefault()
  window.open(BRAIN_ALPHA_URL(r.alphaId), '_blank', 'noopener,noreferrer')
}

export function AlphaPane({
  title,
  rows,
  columns,
  compare,
  sort,
  onSort,
  loading,
  error,
  poolColumnAfter,
  onRefresh,
}: {
  title: string
  rows: RankedAlpha[]
  /** Everything but the Power Pool column, which the pane owns and inserts itself. */
  columns: () => Column<RankedAlpha>[]
  /** Where the Power Pool column goes. Defaults to the end. */
  poolColumnAfter?: string
  compare: (a: RankedAlpha, b: RankedAlpha, sort: Sort) => number
  sort: Sort
  onSort: (sort: Sort) => void
  loading?: boolean
  error?: unknown
  /** Re-read the rows themselves: submitting an Alpha changes a flag that lives on the row. */
  onRefresh?: () => Promise<unknown>
}) {
  const [showAll, setShowAll] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const unsubmitted = useMemo(() => rows.filter(isUnsubmitted), [rows])
  const clean = useMemo(() => unsubmitted.filter(isClean), [unsubmitted])
  const cleanIds = useMemo(() => clean.map((r) => r.alphaId), [clean])
  const pool = usePowerPool(cleanIds)
  const survivors = useMemo(
    () => clean.filter((r) => passesPool(pool.by.get(r.alphaId))),
    [clean, pool.by],
  )
  const shown = showAll ? rows : survivors
  const sorted = useMemo(
    () => [...shown].sort((a, b) => comparePool(a, b, sort, pool.by, compare)),
    [shown, sort, pool.by, compare],
  )

  const refresh = () => Promise.all([onRefresh?.(), cleanIds.length ? pool.refresh() : null])

  const job = useWorkflowJob()
  const running = job?.state === 'running'
  // Read again once the job lands, so the table shows what it downloaded. Once per job: a
  // finished one lingers in the task list for a minute.
  const settled = useRef<string | null>(null)
  // The job seen running here, so opening the page on one that finished earlier does not
  // take over the reader's sort.
  const watched = useRef<string | null>(null)
  useEffect(() => {
    if (running) watched.current = job.id
    if (!job || running || settled.current === job.id) return
    settled.current = job.id
    void refresh()
    if (job.state === 'done' && watched.current === job.id) {
      onSort({ key: 'afterCostSharpe', desc: true })
    }
  })
  const start = useMutation({
    // Every Alpha here: the server runs the three steps itself rather than trusting ours.
    mutationFn: () => labTasks.powerPoolWorkflow(rows.flatMap((r) => r.alphaId ?? [])),
    onSuccess: () => setShowAll(false),
    onError: (e) => toast.error('Could not start the workflow', { description: errorMessage(e) }),
  })

  // No PnL of its own yet, or nothing in its region's pool to compare it with.
  const unmeasured =
    (pool.found?.withoutPnl.length ?? 0) +
    (pool.found?.rows.filter((r) => r.verdict === 'unmeasured').length ?? 0)
  const unsynced = pool.found?.scopes.flatMap((s) => s.poolWithoutPnl).length ?? 0
  const uncosted = survivors.filter((r) => r.afterCostSharpe == null).length
  const columnsShown = () => {
    const own = columns()
    if (!pool.found) return own
    const at = own.findIndex((c) => c.key === poolColumnAfter)
    const cut = at === -1 ? own.length : at + 1
    return [...own.slice(0, cut), poolColumn(pool.by), ...own.slice(cut)]
  }

  return (
    <Panel
      title={title}
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Read these Alphas again"
            title="Read again — after submitting an Alpha and syncing the Portfolio"
            onClick={() => {
              setRefreshing(true)
              void refresh().finally(() => setRefreshing(false))
            }}
          >
            <RefreshCwIcon className={cn((refreshing || pool.refreshing) && 'animate-spin')} />
          </Button>
          <Button
            size="sm"
            variant={showAll ? 'primary' : 'secondary'}
            aria-pressed={showAll}
            onClick={() => setShowAll(!showAll)}
            title="Every Alpha here, not only the ones the workflow keeps"
          >
            Show All
          </Button>
          {running ? (
            <div className="flex w-52 flex-col gap-1">
              <span className="num text-caption text-ink-muted">{job.detail || job.label}</span>
              <Progress value={job.progress ?? null} label="Power Pool Workflow progress" />
            </div>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={cleanIds.length === 0}
              loading={start.isPending}
              onClick={() => start.mutate()}
              title="Downloads PnL where Power Pool Correlation is unmeasured, then turnover for the Alphas that satisfy it. No simulation quota."
            >
              <PlayIcon />
              Run Power Pool Workflow
            </Button>
          )}
          <span className="num text-ink-subtle">{fmt.int(sorted.length)}</span>
        </div>
      }
    >
      <p className="num mb-3 text-body-compact text-ink-muted">
        {fmt.int(unsubmitted.length)} Unsubmitted Alphas → {fmt.int(clean.length)} with no Checks
        FAIL or ERROR → {pool.found ? fmt.int(survivors.length) : DASH} Pass Power Pool Correlation
        {unmeasured > 0 && ` · ${fmt.int(unmeasured)} not measured yet`}
        {uncosted > 0 && ` · ${fmt.int(uncosted)} without After-Cost Sharpe yet`}
      </p>
      {job?.state === 'failed' && (
        <Notice tone="error" className="mb-3" title="The Power Pool Workflow stopped">
          {job.error}
        </Notice>
      )}
      {unsynced > 0 && (
        <Notice tone="warn" className="mb-3" title="Sync your Portfolio first">
          {fmt.int(unsynced)} submitted Power Pool Alpha{unsynced === 1 ? ' has' : 's have'} no PnL
          stored, so Power Pool Correlation is not measured against {unsynced === 1 ? 'it' : 'them'}
          . Sync from BRAIN on the{' '}
          <Link to="/portfolio" className={LINK}>
            Portfolio
          </Link>{' '}
          page, then read these again.
        </Notice>
      )}
      {pool.error != null && (
        <ErrorNotice error={pool.error} title="Could not measure Power Pool correlation" />
      )}
      <DataTable
        label={title}
        rows={sorted}
        columns={columnsShown()}
        rowKey={(r) => String(r.trialId)}
        onRowClick={openOnBrain}
        sort={sort}
        onSort={onSort}
        loading={(loading ?? false) || (!showAll && cleanIds.length > 0 && pool.pending)}
        error={error}
        maxHeight="70vh"
        empty={
          showAll || rows.length === 0
            ? 'No Alphas back yet.'
            : unmeasured > 0
              ? 'Run Power Pool Workflow to measure the rest.'
              : 'No Alpha here satisfies Power Pool Correlation.'
        }
      />
    </Panel>
  )
}
