/** Submission Planner: pick the tasks, read the list, submit in that order.
 *
 * There is nothing to tune here on purpose. Every knob this screen could offer -- the
 * correlation ceiling, the weighting, how many to submit -- is either fixed by BRAIN or
 * decided by the data, so offering it would only be a way to get a worse answer.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/http'
import { fmt } from '@/lib/format'
import { PnlChart } from '@/screens/pool/pnl-chart'
import { labTasks } from '@/screens/tasks/api'
import {
  Checkbox,
  Chips,
  Disclosure,
  Empty,
  ErrorNotice,
  Metric,
  Notice,
  Page,
  PageHeader,
  Panel,
  Skeleton,
} from '@/ui/kit'
import { type Column, DataTable } from '@/ui/table'
import { type Pick, submissionPlanner } from './api'

/** What the basket bought, said against whichever comparison is honest.
 *
 * A multiple of the best single Alpha is the natural reading, and the wrong one when a single
 * outlier out-Sharpes the basket: BRAIN needs five tagged Alphas for the Power Pool and ten for
 * Osmosis, so submitting the one is not on the menu and "0.98x" reads as a failure rather than
 * as the diversification it is. Then the comparison moves to the members themselves.
 */
const lift = (d: {
  sharpe: number
  bestSingle: number
  size: number
  order: { sharpe: number }[]
}) => {
  if (d.bestSingle > 0 && d.sharpe >= d.bestSingle)
    return `${fmt.ratio(d.sharpe / d.bestSingle)}× the best single Alpha`
  const mean = d.order.length
    ? d.order.reduce((total, row) => total + row.sharpe, 0) / d.order.length
    : 0
  if (!(mean > 0) || !(d.bestSingle > 0)) return `${d.size} Alphas that do not repeat each other`
  return `${fmt.ratio((d.sharpe / d.bestSingle) * 100, 0)}% of the best single, spread over ${
    d.size
  } sources (${fmt.ratio(d.sharpe / mean)}× the average member)`
}

/** `size` includes the submissions the plan builds on; `candidates` counts only the unsubmitted
 *  Alphas it chose from, so the two are only comparable once those are taken out. */
const members = (d: { size: number; locked: number; candidates: number }) =>
  d.locked
    ? `${d.size - d.locked} of ${d.candidates} Alphas, beside the ${d.locked} already submitted.`
    : `${d.size} of ${d.candidates} Alphas.`

export function SubmissionPlannerScreen() {
  const { task } = useSearch({ from: '/tools/submission-planner' })
  const client = useQueryClient()
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set())

  const tasks = useQuery({ queryKey: ['lab-tasks'], queryFn: labTasks.list })
  const usable = useMemo(
    () => (tasks.data?.tasks ?? []).filter((t) => (t.simulated ?? 0) > 0),
    [tasks.data],
  )
  // Every task by default. Power Pool correlation is account-wide, so planning over all of
  // them can only beat planning over one task's share.
  const selected = useMemo(
    () => (picked.size ? [...picked] : usable.map((t) => t.id)),
    [picked, usable],
  )

  const plan = useQuery({
    queryKey: ['submission-planner', selected],
    queryFn: () => submissionPlanner.plan(selected),
    enabled: selected.length > 0,
    retry: false,
  })

  const mark = useMutation({
    mutationFn: ({ alphaId, submitted }: { alphaId: string; submitted: boolean }) =>
      submissionPlanner.setSubmitted(alphaId, submitted),
    onSuccess: () => client.invalidateQueries({ queryKey: ['submission-planner'] }),
    onError: (e) => toast.error('Could not save', { description: errorMessage(e) }),
  })

  const data = plan.data
  // The strongest *member*, which is not always the strongest candidate: `bestSingle` is taken
  // over everything considered, including Alphas the search left out.
  const best = data?.order[0]
  const mean = data?.order.length
    ? data.order.reduce((total, row) => total + row.sharpe, 0) / data.order.length
    : 0
  const columns: Column<Pick>[] = [
    {
      key: 'position',
      header: '#',
      width: '44px',
      cell: (r) => (data?.order.indexOf(r) ?? 0) + 1,
    },
    {
      key: 'alpha',
      header: 'Alpha',
      width: 'minmax(140px,1fr)',
      cell: (r) => <span className="font-mono">{r.alphaId}</span>,
    },
    {
      key: 'sharpe',
      header: 'Sharpe on its own',
      width: 'minmax(140px,1fr)',
      align: 'right',
      cell: (r) => <span className="tabular-nums">{fmt.ratio(r.sharpe)}</span>,
    },
    {
      key: 'submitted',
      header: 'Submitted',
      width: '110px',
      align: 'right',
      cell: (r) => (
        <Checkbox
          label=""
          checked={r.submitted}
          onChange={(next) => mark.mutate({ alphaId: r.alphaId, submitted: next })}
          aria-label={`Mark ${r.alphaId} submitted on BRAIN`}
        />
      ),
    },
  ]

  return (
    <Page>
      <PageHeader
        title="Submission Planner"
        description="Which of your submittable Alphas to submit, and in what order."
      />

      <Panel
        title="Alphas to plan over"
        description="Every finished task counts, unless you narrow it."
      >
        {/* Folded: an account holds hundreds of tasks, and their toggles buried the plan. */}
        <Disclosure
          summary={
            selected.length === usable.length
              ? `All ${fmt.int(usable.length)} finished tasks`
              : `${fmt.int(selected.length)} of ${fmt.int(usable.length)} finished tasks`
          }
        >
          <Chips
            label="Tasks to plan over"
            items={usable.map((t) => ({
              value: String(t.id),
              label: (
                <>
                  Task {t.id}
                  {t.id === task && <span className="ml-1 text-primary">•</span>}
                  <span className="num ml-1.5 text-ink-subtle">{t.simulated}</span>
                </>
              ),
            }))}
            value={selected.map(String)}
            onChange={(next) => {
              // The last one will not come off: nothing selected is nothing to plan, and
              // silently reverting to every task reads as the click misfiring.
              if (next.length) setPicked(new Set(next.map(Number)))
            }}
          />
        </Disclosure>
      </Panel>

      {plan.isError && <ErrorNotice error={plan.error} />}

      {/* Outside both branches below: an Alpha left out is worth saying whether or not a
          portfolio came back. */}
      {data?.missing.length ? (
        <Notice tone="warn" title={`${data.missing.length} Alphas left out`}>
          No stored daily PnL for <span className="font-mono">{data.missing.join(', ')}</span>, so
          they could not be judged against the rest. Download their PnL in the Pool to include them.
        </Notice>
      ) : null}

      {plan.isPending && selected.length > 0 ? (
        <Skeleton className="h-96" label="Working out the best portfolio" />
      ) : data?.order.length ? (
        <>
          <Panel
            title="Submit these, in this order"
            description={`${members(data)} ${
              data.escapeUsed
                ? 'BRAIN accepts all of them — one pair is over 0.50 under a rule explained below.'
                : 'Every pair inside correlates below 0.50, so BRAIN accepts all of them.'
            }`}
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric
                boxed
                label="Combined Sharpe"
                value={fmt.ratio(data.sharpe)}
                tone="profit"
                hint={lift(data)}
              />
              <Metric
                boxed
                label="Size check"
                value={fmt.ratio(data.heldOutSharpe)}
                hint="what picked how many, not these members"
              />
              <Metric
                boxed
                label="Best single Alpha"
                value={fmt.ratio(data.bestSingle)}
                hint="for comparison"
              />
              <Metric
                boxed
                label="Max correlation"
                value={fmt.ratio(data.maxCorrelation, 3)}
                tone={data.escapeUsed ? 'warn' : 'neutral'}
                hint={
                  data.maxCorrelation == null
                    ? 'no pair shares enough history to measure'
                    : data.escapeUsed
                      ? 'over 0.50, and allowed — see below'
                      : "BRAIN's limit is 0.50"
                }
              />
            </div>
            {/* A number above BRAIN's own limit reads as a broken tool unless the reason sits
                next to it, and the consultant is the one who has to press Submit. */}
            {data.escapeUsed ? (
              <Notice tone="info" title="One pair is over 0.50, and BRAIN still takes it">
                <span className="font-mono">{data.worstPair.join(' and ')}</span> correlate at{' '}
                {fmt.ratio(data.maxCorrelation, 3)}. Past 0.50 BRAIN accepts an Alpha whose Sharpe
                beats the one it collides with by 10%, and this one does — against an Alpha you have
                already submitted, which is not something you can undo. The rest of the book stays
                under the limit.
              </Notice>
            ) : null}
            <DataTable
              label="Submission order"
              rows={data.order}
              columns={columns}
              rowKey={(r) => r.alphaId}
              rowClass={(r) => (r.submitted ? 'bg-pnl-positive-tint' : undefined)}
            />
            <p className="text-body text-ink-muted">
              The search weighs each Alpha by its own risk so a loud one cannot crowd out a quiet
              one, then every figure here is measured on what you will actually hold: each Alpha at
              the size BRAIN gives it. Adding Alphas helps until {data.size}, after which each new
              one repeats a bet already in the book and the combined Sharpe falls — so {data.size}{' '}
              is where it stops. That number was fixed on the first four-fifths of history and
              scored {fmt.ratio(data.heldOutSharpe)} on the last fifth, which that search never saw.
              The members below were then chosen over the whole history, so {fmt.ratio(data.sharpe)}{' '}
              is a fit rather than a forecast: the split vouches for how many to submit, not for
              which.
            </p>
            <p className="text-body text-ink-muted">
              {best && best.sharpe >= data.sharpe ? (
                <>
                  Submitting <span className="font-mono text-ink">{best.alphaId}</span> on its own
                  would score {fmt.ratio(best.sharpe)}, a little above this book — but one Alpha is
                  not a submission plan. A Power Pool Thematic leaderboard needs at least five
                  tagged Alphas, and Osmosis needs points across at least ten in each of three
                  scopes, so the question is never whether to submit a basket, only whether the
                  basket repeats itself. This one does not: it reaches {fmt.ratio(data.sharpe)} from
                  members averaging {fmt.ratio(mean)} apiece, which is what {data.size} genuinely
                  separate bets buys you.
                </>
              ) : (
                <>
                  The best Alpha here scores {fmt.ratio(data.bestSingle)} alone. Together these{' '}
                  {data.size} reach {fmt.ratio(data.sharpe)} — more than any of them manages by
                  itself, because each one is carrying a bet the others are not.
                </>
              )}
            </p>
          </Panel>

          <Panel
            title="Combined performance"
            description={`Equity curve and drawdown of all ${data.size} together, over ${data.days} trading days.`}
          >
            <PnlChart
              values={data.curve}
              dates={data.dates}
              label={`Combined PnL of the ${data.size} selected Alphas`}
            />
          </Panel>
        </>
      ) : plan.isError ? null : (
        <Panel>
          <Empty title="Nothing to plan yet">
            Run a sweep first — its submittable Alphas are what this chooses between.
          </Empty>
        </Panel>
      )}
    </Page>
  )
}
