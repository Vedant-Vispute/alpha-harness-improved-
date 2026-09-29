/** The Datasets and Settings panels of a lab task, and the task settings every lab asks for. */

import { DatabaseIcon, XIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { DASH, fmt } from '@/lib/format'
import { isRegionAgnostic, regionLabel, useScopeOptions } from '@/lib/scope'
import { NeutralizationPicker } from '@/screens/research-labs/neutralization'
import {
  Button,
  Chips,
  Disclosure,
  Empty,
  ErrorNotice,
  Fieldset,
  Input,
  Metric,
  Notice,
  Panel,
  Segmented,
} from '@/ui/kit'
import type { LabDraft } from './lab-task'

const DECAYS = [0, 3, 5, 7, 10]

/** Matches `labs.search.MAX_CORES`: a task may hold every slot the engine has. */
const CORES = [1, 2, 3, 4, 5, 6, 7, 8].map((v) => ({ value: v, label: v }))

export function CoresSetting({
  value,
  onChange,
}: {
  value: number
  onChange: (cores: number) => void
}) {
  return (
    <Fieldset legend="Cores">
      <Segmented label="Cores" items={CORES} value={value} onChange={onChange} />
    </Fieldset>
  )
}

/** Reports `null` while the field is empty. */
export function SimulationsSetting({
  value,
  max,
  placeholder,
  onChange,
}: {
  value: number | null
  max: number
  placeholder?: string
  onChange: (simulations: number | null) => void
}) {
  return (
    <Fieldset legend="Simulations">
      <Input
        type="number"
        min={1}
        max={max}
        step={1}
        placeholder={placeholder}
        aria-label="Simulations"
        className="w-32"
        value={value ?? ''}
        onChange={(e) => {
          const n = Number(e.target.value)
          onChange(e.target.value === '' || !Number.isFinite(n) ? null : Math.max(0, Math.floor(n)))
        }}
      />
    </Fieldset>
  )
}

/** What either lab's preview says about a task. */
export interface LabPlan {
  fields: { total: number; matrix: number; vector: number }
  leftOut: { vector: number }
  universes: string[]
  sample: { expression: string; settings: Record<string, unknown> }[]
  problems: string[]
  warnings: string[]
}

export function DatasetsPanel({
  ids,
  names,
  onChoose,
  onRemove,
  children,
}: {
  ids: string[]
  names: Map<string, string>
  onChoose: () => void
  onRemove: (id: string) => void
  /** More of what the task is given to work from, under the datasets: the LLM lab's prompt. */
  children?: ReactNode
}) {
  const chosen = ids.length > 0
  return (
    <Panel
      title="Datasets"
      actions={
        chosen && (
          <Button size="sm" onClick={onChoose}>
            <DatabaseIcon />
            Choose Datasets
          </Button>
        )
      }
    >
      {chosen ? (
        <div className="flex flex-wrap gap-1.5">
          {ids.map((id) => (
            <span
              key={id}
              title={id}
              className="inline-flex h-7 max-w-full items-center gap-1 rounded-sm border border-hairline-strong bg-surface-3 pr-1 pl-3 text-body-compact text-ink"
            >
              <span className="truncate">{names.get(id) ?? id}</span>
              <button
                type="button"
                aria-label={`Remove ${names.get(id) ?? id}`}
                className="shrink-0 rounded-xs p-0.5 text-ink-subtle transition-colors hover:text-ink"
                onClick={() => onRemove(id)}
              >
                <XIcon className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <Empty title="No datasets chosen" icon={<DatabaseIcon />}>
          <Button className="mt-2" onClick={onChoose}>
            <DatabaseIcon />
            Choose Datasets
          </Button>
        </Empty>
      )}
      {children && <div className="mt-4 border-t border-hairline pt-4">{children}</div>}
    </Panel>
  )
}

export function SettingsPanel({
  draft,
  set,
  vector,
  chosenVector,
  decays = DECAYS,
  maxSimulations,
  plan,
  error,
}: {
  draft: LabDraft
  set: (change: Partial<LabDraft>) => void
  vector: string[]
  chosenVector: string[]
  decays?: number[] | undefined
  maxSimulations: number
  plan: LabPlan | undefined
  error: unknown
}) {
  const simulations = draft.simulations
  const showVector = (plan?.fields.vector ?? 0) > 0 || (plan?.leftOut.vector ?? 0) > 0
  // BRAIN's own legal list for this market, which is wider than the four a lab searches by
  // default — picking any of them is what tells the lab to search those instead.
  const { neutralizations } = useScopeOptions({
    instrumentType: 'EQUITY',
    region: draft.region,
    delay: draft.delay,
    universe: draft.universe,
  })

  return (
    <Panel title="Settings">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
          <CoresSetting value={draft.cores} onChange={(cores) => set({ cores })} />
          <SimulationsSetting
            value={simulations}
            max={maxSimulations}
            onChange={(next) => set({ simulations: next })}
          />
          <Fieldset legend="Decay">
            <Segmented
              label="Decay"
              items={decays.map((v) => ({ value: v, label: v }))}
              value={draft.decay}
              onChange={(decay) => set({ decay })}
            />
          </Fieldset>
          {showVector && (
            <Fieldset legend="Vector Operators">
              <Chips
                label="Vector Operators"
                items={vector.map((op) => ({ value: op, label: op }))}
                value={chosenVector}
                onChange={(ops) => set({ vectorOperators: ops })}
              />
            </Fieldset>
          )}
        </div>
        {neutralizations.length > 0 && (
          <NeutralizationPicker
            available={neutralizations}
            value={draft.neutralizations}
            onChange={(next) => set({ neutralizations: next })}
            hint="None chosen searches Market, Sector, Industry and Subindustry."
          />
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric boxed label="Market" value={`${regionLabel(draft.region)} · D${draft.delay}`} />
          <Metric boxed label="Fields" value={fmt.int(plan?.fields.total)} />
          <Metric boxed label="Universes" value={fmt.int(plan?.universes.length)} />
        </div>
        {isRegionAgnostic(draft) && (
          <Notice tone="info" title="Every alpha here runs in four regions at once">
            One simulation covers USA, Europe, Asia and Global, and spends four of today's
            allowance. The alphas it makes can be submitted where two or more of those regions hold
            up.
          </Notice>
        )}
        {simulations !== null && simulations > maxSimulations && (
          <Notice
            tone="error"
            title={`A task takes at most ${fmt.int(maxSimulations)} simulations.`}
          />
        )}
        {error ? <ErrorNotice error={error} title="Could not plan the task" /> : null}
        {plan?.problems.map((m) => (
          <Notice key={m} tone="error" title={m} />
        ))}
        {plan?.warnings.map((m) => (
          <Notice key={m} tone="warn" title={m} />
        ))}
        {plan && plan.sample.length > 0 && (
          <Disclosure summary="Sample Alphas">
            <ul className="flex flex-col gap-2">
              {plan.sample.map((s, i) => (
                <li
                  key={i}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"
                >
                  <code className="num text-body-compact break-all text-ink">{s.expression}</code>
                  <span className="text-body-compact text-ink-subtle">
                    {String(s.settings['universe'] ?? DASH)} ·{' '}
                    {String(s.settings['neutralization'] ?? DASH)}
                  </span>
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </div>
    </Panel>
  )
}
