/** LLM Power Pool Lab: an LLM writes Power Pool Alphas for your datasets while the task runs in Tasks. */

import { useQuery } from '@tanstack/react-query'
import { PlusIcon } from 'lucide-react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { fmt } from '@/lib/format'
import { DEFAULT_SCOPE, useScopeOptions } from '@/lib/scope'
import type { PickedField } from '@/screens/data/dataset-pick'
import { PromptPicker, useChosenPrompt } from '@/screens/prompts/picker'
import {
  fieldIdsOf,
  MAX_SIMULATIONS,
  simulationsValid,
  useAddTask,
  useLabMarket,
  useLabPreview,
} from '@/screens/research-labs/lab-task'
import { NeutralizationPicker } from '@/screens/research-labs/neutralization'
import { type PowerPoolRequest, powerPoolLab } from '@/screens/research-labs/power-pool/api'
import {
  CoresSetting,
  DatasetsPanel,
  SimulationsSetting,
} from '@/screens/research-labs/task-settings'
import {
  Button,
  Disclosure,
  ErrorNotice,
  Fieldset,
  Metric,
  Notice,
  Page,
  PageHeader,
  Panel,
} from '@/ui/kit'
import { Select } from '@/ui/overlay'

interface PowerPoolDraft {
  region: string
  delay: number
  universe: string
  datasetIds: string[]
  /** Single fields, ranked; the prompt shows only these. Absent from an older saved draft. */
  fields?: PickedField[]
  rankBy?: string | null
  cores: number
  simulations: number | null
  model: string | null
  /** A saved prompt from LLM Prompts; null sends the built-in. */
  promptId: number | null
  /** Empty keeps every neutralization BRAIN offers for the market. */
  neutralizations: string[]
}

const useDraft = create<PowerPoolDraft>()(
  persist(
    (): PowerPoolDraft => ({
      region: DEFAULT_SCOPE.region,
      delay: DEFAULT_SCOPE.delay,
      universe: DEFAULT_SCOPE.universe,
      datasetIds: [],
      fields: [],
      rankBy: null,
      cores: 4,
      simulations: null,
      model: null,
      promptId: null,
      neutralizations: [],
    }),
    { name: 'alpha-harness-power-pool-lab' },
  ),
)

/** The built-in this lab sends, and the kind of every saved prompt it can send instead. */
const PROMPT_KIND = 'power_pool_lab'

const PRE =
  'num max-h-80 overflow-auto rounded-md border border-hairline bg-canvas p-3 text-body-compact whitespace-pre-wrap text-ink-muted'

export function PowerPoolLabScreen() {
  const draft = useDraft()
  const set = useDraft.setState
  const { panel } = useLabMarket(draft, set, '/labs/power-pool')
  const options = useQuery({
    queryKey: ['power-pool-lab', 'options'],
    queryFn: powerPoolLab.options,
  })
  const models = options.data?.models ?? []
  const model =
    draft.model && models.some((m) => m.id === draft.model)
      ? draft.model
      : (options.data?.defaultModel ?? null)

  const promptId = useChosenPrompt(PROMPT_KIND, draft.promptId ?? null)

  // BRAIN's legal list for this market; the LLM draws from whatever is chosen, or all of it.
  const scopeOptions = useScopeOptions({
    instrumentType: 'EQUITY',
    region: draft.region,
    delay: draft.delay,
    universe: draft.universe,
  })

  const body: PowerPoolRequest = {
    region: draft.region,
    delay: draft.delay,
    universe: draft.universe,
    dataset_ids: draft.datasetIds,
    field_ids: fieldIdsOf(draft),
    rank_by: draft.fields?.length ? (draft.rankBy ?? null) : null,
    model,
    prompt_id: promptId,
    neutralizations: draft.neutralizations,
    cores: draft.cores,
    simulations: draft.simulations ?? 0,
  }
  const { preview, current } = useLabPreview('power-pool-lab', body, powerPoolLab.preview)
  const plan = preview.data
  const maxSimulations = options.data?.maxSimulations ?? MAX_SIMULATIONS
  const add = useAddTask(() => powerPoolLab.addTask(body))
  const ready =
    plan !== undefined &&
    current &&
    plan.problems.length === 0 &&
    simulationsValid(draft.simulations, maxSimulations)

  return (
    <Page>
      <PageHeader
        title="LLM Power Pool Lab"
        actions={
          <Button
            variant="primary"
            disabled={!ready}
            loading={add.isPending}
            onClick={() => add.mutate()}
          >
            <PlusIcon />
            Add Task
          </Button>
        }
      />
      {options.isError && <ErrorNotice error={options.error} title="Could not load the models" />}
      {options.isSuccess && models.length === 0 && (
        <Notice tone="warn" title="Add a Key in LLM Integration to use this lab." />
      )}
      <DatasetsPanel {...panel}>
        <Fieldset
          legend="Prompt"
          hint="What the LLM is told before the datasets. Edits in LLM Prompts reach running tasks on their next call."
        >
          <PromptPicker
            kind={PROMPT_KIND}
            value={promptId}
            onChange={(next) => set({ promptId: next })}
          />
        </Fieldset>
      </DatasetsPanel>
      <Panel title="Settings">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
            <Fieldset legend="Model">
              <Select
                label="Model"
                items={models.map((m) => ({
                  value: m.id,
                  label: `${m.label} · ${fmt.int(m.remainingToday)} left today`,
                }))}
                value={model}
                onChange={(v) => set({ model: v })}
              />
            </Fieldset>
            <CoresSetting value={draft.cores} onChange={(cores) => set({ cores })} />
            <SimulationsSetting
              value={draft.simulations}
              max={maxSimulations}
              placeholder="500"
              onChange={(next) => set({ simulations: next })}
            />
          </div>
          {scopeOptions.neutralizations.length > 0 && (
            <NeutralizationPicker
              available={scopeOptions.neutralizations}
              value={draft.neutralizations}
              onChange={(next) => set({ neutralizations: next })}
              hint="None chosen draws from every one BRAIN offers here."
            />
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric boxed label="Datasets" value={fmt.int(draft.datasetIds.length)} />
            <Metric
              boxed
              label="Fields"
              value={fmt.int(plan?.fields)}
              hint={draft.fields?.length ? 'Chosen, ranked' : 'Every field of the datasets'}
            />
            <Metric boxed label="LLM Calls" value={fmt.int(plan?.llmCalls)} hint="20 Alphas each" />
            <Metric
              boxed
              label="Universes"
              value={fmt.int(plan?.universes.length)}
              hint={`${fmt.int(plan?.neutralizations.length)} Neutralizations`}
            />
          </div>
          <p className="text-body-compact text-pretty text-ink-subtle">
            Each Alpha gets a random Universe, Neutralization and Decay; Truncation 0.08.
          </p>
          {preview.isError && <ErrorNotice error={preview.error} title="Could not plan the task" />}
          {plan?.problems.map((m) => (
            <Notice key={m} tone="error" title={m} />
          ))}
          {plan?.warnings.map((m) => (
            <Notice key={m} tone="warn" title={m} />
          ))}
          {plan?.prompt && (
            <Disclosure
              summary={`Prompt · ${plan.prompt.name} · ~${fmt.int(plan.prompt.tokens)} tokens`}
            >
              <div className="flex flex-col gap-2">
                <pre className={PRE} role="region" aria-label="System prompt">
                  {plan.prompt.system}
                </pre>
                <pre className={PRE} role="region" aria-label="User prompt">
                  {plan.prompt.user}
                </pre>
              </div>
            </Disclosure>
          )}
        </div>
      </Panel>
    </Page>
  )
}
