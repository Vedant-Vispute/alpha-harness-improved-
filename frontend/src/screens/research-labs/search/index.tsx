/**
 * Search Lab: choose datasets, cores and simulations, then run the search as a task in
 * Tasks. It writes one- and two-operator Alphas from the datasets' fields, steering towards
 * the best Sharpe.
 */

import { useQuery } from '@tanstack/react-query'
import { PlayIcon } from 'lucide-react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { today } from '@/api/core'
import {
  LAB_DEFAULTS,
  type LabDraft,
  labBody,
  MAX_SIMULATIONS,
  simulationsValid,
  useAddTask,
  useLabMarket,
  useLabPreview,
  vectorOperatorsOf,
} from '@/screens/research-labs/lab-task'
import { type SearchLabRequest, searchLab } from '@/screens/research-labs/search/api'
import { DatasetsPanel, SettingsPanel } from '@/screens/research-labs/task-settings'
import { Button, ErrorNotice, Page, PageHeader } from '@/ui/kit'

/** The Search Lab's choices, kept between visits. */
const useSearchLab = create<LabDraft>()(
  persist(() => LAB_DEFAULTS, { name: 'alpha-harness-search-lab' }),
)

export function SearchLabScreen() {
  const stored = useSearchLab()
  const set = useSearchLab.setState
  const day = useQuery({ queryKey: ['today'], queryFn: () => today.get() })
  const { chosen, panel } = useLabMarket(stored, set, '/labs/search')

  const options = useQuery({
    queryKey: ['search-lab', 'options'],
    queryFn: searchLab.options,
    staleTime: 5 * 60_000,
  })
  // Until the user types a number, the task takes what is left of today (never stored).
  const maxSimulations = options.data?.maxSimulations ?? MAX_SIMULATIONS
  const unspoken = day.data?.simulations.unspoken ?? 0
  const draft = {
    ...stored,
    simulations: stored.simulations ?? (unspoken > 0 ? Math.min(unspoken, maxSimulations) : null),
  }
  const vectorOperators = vectorOperatorsOf(draft, options.data?.vector)
  const body: SearchLabRequest = labBody(draft, vectorOperators)
  const { preview, current } = useLabPreview('search-lab', body, searchLab.preview, {
    enabled: chosen && options.isSuccess,
  })
  const plan = chosen ? preview.data : undefined

  const add = useAddTask(
    (count: number) => searchLab.runTask({ ...body, simulations: count }),
    'Task running',
  )
  const ready =
    plan !== undefined &&
    current &&
    plan.problems.length === 0 &&
    simulationsValid(draft.simulations, maxSimulations)
  // What stops Run Task that no panel below already says.
  const blocked = !chosen
    ? 'Choose datasets to run.'
    : draft.simulations === null
      ? 'Enter the simulations to run.'
      : null

  return (
    <Page>
      <PageHeader
        title="Search Lab"
        actions={
          <>
            {blocked && (
              <span id="run-task-blocked" className="text-body-compact text-ink-subtle">
                {blocked}
              </span>
            )}
            <Button
              variant="primary"
              disabled={!ready}
              loading={add.isPending}
              aria-describedby={blocked ? 'run-task-blocked' : undefined}
              onClick={() => draft.simulations !== null && add.mutate(draft.simulations)}
            >
              <PlayIcon />
              Run Task
            </Button>
          </>
        }
      />
      {options.isError && (
        <ErrorNotice error={options.error} title="Could not read your operators" />
      )}
      <DatasetsPanel {...panel} />
      <SettingsPanel
        draft={draft}
        set={set}
        vector={options.data?.vector ?? []}
        chosenVector={vectorOperators}
        decays={options.data?.decays}
        maxSimulations={maxSimulations}
        plan={plan}
        error={chosen && preview.isError ? preview.error : null}
      />
    </Page>
  )
}
