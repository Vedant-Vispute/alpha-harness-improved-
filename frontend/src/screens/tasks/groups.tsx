/**
 * ARC Alpha results: each expression once, with a row for its run in every region.
 * Runs come back at different times and land in their group as they do. Calibrate runs BRAIN's
 * submission checks on them, and the groups rank themselves most submittable first.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GaugeIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/cn'
import { DASH, fmt } from '@/lib/format'
import { type AlphaGroup, type GroupAlpha, type LabTask, labTasks } from '@/screens/tasks/api'
import {
  Badge,
  Button,
  Disclosure,
  ErrorNotice,
  Metric,
  Notice,
  Progress,
  signTone,
  TEXT_TONE,
} from '@/ui/kit'
import { Dialog } from '@/ui/overlay'
import { type Column, DataTable } from '@/ui/table'

/** A table row: one region's run, with its group's facts on the group's first row. */
type Row = GroupAlpha & { rank: number; group: AlphaGroup; first: boolean }

const STATE: Record<
  GroupAlpha['state'],
  { label: string; tone: 'profit' | 'warn' | 'loss' | 'muted' }
> = {
  complete: { label: 'Back', tone: 'profit' },
  running: { label: 'On BRAIN', tone: 'warn' },
  waiting: { label: 'Waiting', tone: 'muted' },
  failed: { label: 'Failed', tone: 'loss' },
}

const checks = (passed: number, failed: number, pending: number) => (
  <span className="num">
    <span className="text-pnl-positive">{fmt.int(passed)}</span>
    {' / '}
    <span className={failed ? 'text-pnl-negative' : 'text-ink-subtle'}>{fmt.int(failed)}</span>
    {pending > 0 && <span className="text-ink-subtle"> · {fmt.int(pending)}?</span>}
  </span>
)

const columnsFor = (onOpenGroup: (group: AlphaGroup, rank: number) => void): Column<Row>[] => [
  {
    key: 'rank',
    header: '#',
    width: '48px',
    align: 'right',
    cell: (r) => (r.first ? fmt.int(r.rank) : ''),
  },
  {
    key: 'expression',
    header: 'Alpha',
    width: 'minmax(260px,3fr)',
    cell: (r) =>
      r.first ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-auto max-w-full min-w-0 justify-start whitespace-normal px-0 py-1 text-left text-ink hover:text-primary"
          title="Open this ARC Alpha and follow its regional simulations"
          onClick={(event) => {
            event.stopPropagation()
            onOpenGroup(r.group, r.rank)
          }}
        >
          <span className="num line-clamp-2 break-all">{r.group.expression}</span>
        </Button>
      ) : (
        <span className="text-ink-tertiary">″</span>
      ),
  },
  {
    key: 'arc-simulation',
    header: 'ARC simulation',
    width: '132px',
    cell: (r) => (r.first ? <ArcStatus group={r.group} /> : ''),
  },
  {
    key: 'group-checks',
    header: 'Group Checks',
    width: '112px',
    align: 'right',
    cell: (r) => (r.first ? checks(r.group.passed, r.group.failed, r.group.pending) : ''),
  },
  {
    key: 'region',
    header: 'Region',
    width: '72px',
    cell: (r) => <Badge tone="outline">{r.region ?? DASH}</Badge>,
  },
  {
    key: 'universe',
    header: 'Universe',
    width: '100px',
    cell: (r) => <span className="num truncate text-ink-muted">{r.universe ?? DASH}</span>,
  },
  {
    key: 'state',
    header: 'Status',
    width: '88px',
    cell: (r) => <Badge tone={STATE[r.state].tone}>{STATE[r.state].label}</Badge>,
  },
  {
    key: 'sharpe',
    header: 'Sharpe',
    width: '72px',
    align: 'right',
    cell: (r) => <span className={TEXT_TONE[signTone(r.sharpe)]}>{fmt.ratio(r.sharpe)}</span>,
  },
  {
    key: 'fitness',
    header: 'Fitness',
    width: '72px',
    align: 'right',
    cell: (r) => fmt.ratio(r.fitness),
  },
  {
    key: 'turnover',
    header: 'Turnover',
    width: '80px',
    align: 'right',
    cell: (r) => fmt.pct(r.turnover),
  },
  {
    key: 'checks',
    header: 'Checks Pass / Fail',
    width: '120px',
    align: 'right',
    cell: (r) => (r.state === 'complete' ? checks(r.passed, r.failed, r.pending) : DASH),
  },
  {
    key: 'failing',
    header: 'Failing',
    width: 'minmax(140px,1.4fr)',
    cell: (r) =>
      r.failing.length ? (
        <span className="num truncate text-pnl-negative" title={r.failing.join(', ')}>
          {r.failing.join(', ')}
        </span>
      ) : (
        ''
      ),
  },
]

export function AlphaGroups({
  task,
  onOpenAlpha,
}: {
  task: LabTask
  onOpenAlpha: (alphaId: string) => void
}) {
  const queryClient = useQueryClient()
  const groups = useQuery({
    queryKey: ['lab-tasks', 'groups', task.id],
    queryFn: () => labTasks.groups(task.id),
    // Regional runs, ARC runs and calibrated checks land independently.
    refetchInterval: (q) => {
      const arcRunning = q.state.data?.groups.some((group) =>
        ['queued', 'running'].includes(group.arcSimulation?.state ?? ''),
      )
      return q.state.data?.calibrating || task.status === 'RUNNING' || arcRunning ? 4000 : false
    },
  })
  const arcSimulation = useMutation({
    mutationFn: (groupId: number) => labTasks.arcSimulate(task.id, groupId),
    onSuccess: () => {
      toast.success('ARC simulation queued', {
        description: 'BRAIN will simulate this expression in the ALL region.',
      })
      void queryClient.invalidateQueries({ queryKey: ['lab-tasks', 'groups', task.id] })
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Could not start ARC simulation'),
  })
  const calibrate = useMutation({
    mutationFn: () => labTasks.calibrate(task.id),
    onSuccess: () => {
      toast.success('Calibrating', {
        description: 'BRAIN checks each Alpha in turn; the groups re-rank as answers land.',
      })
      void queryClient.invalidateQueries({ queryKey: ['lab-tasks', 'groups', task.id] })
    },
  })
  const data = groups.data
  const [focusedGroup, setFocusedGroup] = useState<number | null>(null)
  const focused = data?.groups.find((group) => group.group === focusedGroup) ?? null
  const focusedRank = focused
    ? (data?.groups.findIndex((group) => group.group === focused.group) ?? -1) + 1
    : null
  const rows: Row[] = (data?.groups ?? []).flatMap((group, i) =>
    group.alphas.map((a, j) => ({ ...a, rank: i + 1, group, first: j === 0 })),
  )

  return (
    <section aria-label="Alpha groups" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-title font-medium text-ink">ARC Alphas</h3>
        {data && (
          <span className="num text-body-compact text-ink-subtle">
            {fmt.int(data.groups.length)} Alphas · {fmt.int(data.complete)} regional runs back ·{' '}
            {fmt.int(data.calibrated)} calibrated
          </span>
        )}
        <Button
          size="sm"
          variant="primary"
          className="ml-auto"
          loading={calibrate.isPending || data?.calibrating}
          disabled={!data?.complete}
          title="Run BRAIN's submission checks on every Alpha back. No quota is spent."
          onClick={() => calibrate.mutate()}
        >
          <GaugeIcon />
          {data?.calibrating ? 'Calibrating…' : 'Calibrate'}
        </Button>
      </div>
      <p className="text-body-compact text-pretty text-ink-subtle">
        Click an expression to run it once as an ARC Alpha in BRAIN&apos;s ALL region. Click another
        part of a regional row to open that individual result.
      </p>
      {groups.isError && <ErrorNotice error={groups.error} title="Could not load the groups" />}
      {calibrate.isError && <ErrorNotice error={calibrate.error} title="Could not calibrate" />}
      <DataTable
        label="Alpha groups"
        rows={rows}
        columns={columnsFor((group) => setFocusedGroup(group.group))}
        rowKey={(r) => String(r.trialId)}
        rowClass={(r) => cn(r.first && 'border-t border-t-hairline-strong')}
        onRowClick={(r) => r.alphaId && onOpenAlpha(r.alphaId)}
        loading={groups.isPending}
        empty="No Alphas written yet."
        maxHeight="70vh"
      />
      <Dialog
        open={focusedGroup !== null}
        onOpenChange={(open) => !open && setFocusedGroup(null)}
        title={`ARC Alpha${focusedRank ? ` · ${fmt.int(focusedRank)}` : ''}`}
        description="Run this expression once in BRAIN's ALL region, then open its full performance and summary."
        className="max-w-3xl"
      >
        {focused && (
          <GroupResults
            group={focused}
            running={arcSimulation.isPending}
            error={arcSimulation.isError ? arcSimulation.error : null}
            onRun={() => arcSimulation.mutate(focused.group)}
            onOpenAlpha={(alphaId) => {
              setFocusedGroup(null)
              onOpenAlpha(alphaId)
            }}
          />
        )}
      </Dialog>
    </section>
  )
}

function GroupResults({
  group,
  running,
  error,
  onRun,
  onOpenAlpha,
}: {
  group: AlphaGroup
  running: boolean
  error: Error | null
  onRun: () => void
  onOpenAlpha: (alphaId: string) => void
}) {
  const simulation = group.arcSimulation
  const active = simulation?.state === 'queued' || simulation?.state === 'running'
  const arcAlphaId = simulation?.alphaId
  const finished = simulation?.state === 'complete' && arcAlphaId != null
  return (
    <div className="flex flex-col gap-4">
      <code className="num rounded-md border border-hairline bg-canvas p-3 text-body-compact break-all text-ink">
        {group.expression ?? 'Expression unavailable'}
      </code>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3 text-body-compact text-ink-muted">
          <span>ARC simulation in ALL</span>
          <ArcStatus group={group} />
        </div>
        <Progress
          label="ARC Alpha simulation progress in ALL"
          value={finished ? 1 : active ? (simulation?.progress ?? null) : 0}
        />
      </div>
      {simulation?.message && simulation.state === 'failed' && (
        <Notice tone="error" title="ARC simulation failed">
          {simulation.message}
        </Notice>
      )}
      {error && <ErrorNotice error={error} title="Could not start ARC simulation" />}
      <div className="flex flex-wrap justify-end gap-2">
        {finished && arcAlphaId ? (
          <Button variant="primary" onClick={() => onOpenAlpha(arcAlphaId)}>
            Open ARC results
          </Button>
        ) : (
          <Button
            variant="primary"
            loading={running}
            disabled={!group.expression || active}
            onClick={onRun}
          >
            {simulation?.state === 'failed' ? 'Retry ARC simulation' : 'Run ARC simulation'}
          </Button>
        )}
      </div>
      <Disclosure summary={`Regional runs (${fmt.int(group.alphas.length)})`}>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric boxed size="sm" label="Checks Passed" value={fmt.int(group.passed)} />
            <Metric boxed size="sm" label="Checks Failed" value={fmt.int(group.failed)} />
            <Metric boxed size="sm" label="Checks Pending" value={fmt.int(group.pending)} />
            <Metric boxed size="sm" label="Best Sharpe" value={fmt.ratio(group.bestSharpe)} />
          </div>
          <div className="flex flex-col divide-y divide-hairline rounded-md border border-hairline">
            {group.alphas.map((alpha) => (
              <div
                key={alpha.trialId}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2"
              >
                <Badge tone="outline">{alpha.region ?? DASH}</Badge>
                <span className="num min-w-24 text-body-compact text-ink-muted">
                  {alpha.universe ?? DASH}
                </span>
                <Badge tone={STATE[alpha.state].tone}>{STATE[alpha.state].label}</Badge>
                <span
                  className={`num ml-auto text-body-compact ${TEXT_TONE[signTone(alpha.sharpe)]}`}
                >
                  Sharpe {fmt.ratio(alpha.sharpe)}
                </span>
                {alpha.alphaId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => alpha.alphaId && onOpenAlpha(alpha.alphaId)}
                  >
                    Open individual
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      </Disclosure>
    </div>
  )
}

function ArcStatus({ group }: { group: AlphaGroup }) {
  const status = group.arcSimulation?.state
  if (status === 'complete') return <Badge tone="profit">ARC simulated</Badge>
  if (status === 'running') return <Badge tone="warn">Simulating in ALL</Badge>
  if (status === 'queued') return <Badge tone="muted">Queued for ALL</Badge>
  if (status === 'failed') return <Badge tone="loss">ARC simulation failed</Badge>
  return <Badge tone="muted">Not ARC simulated</Badge>
}
