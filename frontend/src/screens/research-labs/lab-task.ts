/** What the labs share around a task: its draft, market and datasets, and its preview. */

import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo } from 'react'
import { catalog } from '@/api/catalog'
import type { Scope } from '@/api/types'
import { DEFAULT_SCOPE, useScope } from '@/lib/scope'
import { useDebounced } from '@/lib/use-debounced'
import { type PickedField, type PickFrom, useDatasetPick } from '@/screens/data/dataset-pick'
import { useFieldSelection } from '@/screens/data/field-pick'

export interface LabDraft {
  region: string
  delay: number
  universe: string
  datasetIds: string[]
  /**
   * Single fields chosen in the Data Explorer, ranked; `datasetIds` are theirs. Empty uses the
   * datasets whole. Absent from a draft saved before fields could be chosen.
   */
  fields?: PickedField[]
  /** How `fields` were ranked: "Alphas, most first". */
  rankBy?: string | null
  /** `null` until chosen in the form: until then Settings' default applies. */
  cores: number | null
  /** `null` until the user assigns them: a task always has simulations chosen on purpose. */
  simulations: number | null
  decay: number
  /** `null` until the user chooses: then the lab allows `vec_avg`. */
  vectorOperators: string[] | null
  /** Empty leaves the lab on its own four group neutralizations. */
  neutralizations: string[]
}

export const LAB_DEFAULTS: LabDraft = {
  region: DEFAULT_SCOPE.region,
  delay: DEFAULT_SCOPE.delay,
  universe: DEFAULT_SCOPE.universe,
  datasetIds: [],
  fields: [],
  rankBy: null,
  cores: null,
  simulations: null,
  decay: 0,
  vectorOperators: null,
  neutralizations: [],
}

export const MAX_SIMULATIONS = 100_000

/**
 * A draft's market, datasets and fields: dataset names, the round trip to the Data Explorer to
 * choose them, and the props of the Datasets panel that shows them.
 */
type LabMarket = Pick<
  LabDraft,
  'region' | 'delay' | 'universe' | 'datasetIds' | 'fields' | 'rankBy'
>

const NO_FIELDS: PickedField[] = []

export function useLabMarket(
  draft: LabMarket,
  set: (change: Partial<LabMarket>) => void,
  from: PickFrom,
) {
  const navigate = useNavigate()
  const [, setDataScope] = useScope('data')
  const scope: Scope = {
    instrumentType: 'EQUITY',
    region: draft.region,
    delay: draft.delay,
    universe: draft.universe,
  }
  const chosen = draft.datasetIds.length > 0

  // Back from the Data Explorer with a finished pick for this lab.
  useEffect(() => {
    const pick = useDatasetPick.getState().take(from)
    if (pick)
      set({
        region: pick.scope.region,
        delay: pick.scope.delay,
        universe: pick.scope.universe,
        datasetIds: pick.ids,
        // A pick of whole datasets clears fields chosen before it.
        fields: pick.fields ?? [],
        rankBy: pick.rankBy ?? null,
      })
  }, [from, set])

  const datasets = useQuery({
    queryKey: ['catalog', 'datasets', scope, ''],
    queryFn: () => catalog.datasets(scope),
    enabled: chosen,
  })
  const names = useMemo(
    () => new Map((datasets.data ?? []).map((d) => [d.dataset_id, d.name ?? d.dataset_id])),
    [datasets.data],
  )

  const fields = draft.fields ?? NO_FIELDS
  const choose = () => {
    // Chosen fields come back selected. Their datasets are not ticked as well, which would
    // narrow the table to those datasets instead of the search that found the fields.
    useDatasetPick.getState().start(scope, fields.length ? [] : draft.datasetIds, from)
    useFieldSelection.getState().load(scope, fields)
    setDataScope(scope)
    void navigate({ to: '/data' })
  }
  const panel = {
    ids: draft.datasetIds,
    fields,
    rankBy: draft.rankBy ?? null,
    names,
    onChoose: choose,
    // A dataset goes with its fields; the last field going leaves its datasets, used whole.
    onRemove: (id: string) =>
      set({
        datasetIds: draft.datasetIds.filter((x) => x !== id),
        fields: fields.filter((f) => f.dataset !== id),
      }),
    onRemoveField: (id: string) => {
      const left = fields.filter((f) => f.id !== id)
      set({
        fields: left,
        datasetIds: left.length ? [...new Set(left.map((f) => f.dataset))] : draft.datasetIds,
      })
    },
    onUseDatasets: () => set({ fields: [], rankBy: null }),
  }
  return { chosen, names, choose, panel }
}

/** The single fields a task is told to use, in rank order; empty uses its datasets whole. */
export const fieldIdsOf = (draft: Pick<LabDraft, 'fields'>) => (draft.fields ?? []).map((f) => f.id)

/**
 * A lab's free preview of `body`, asked once the form has been still for `wait` ms. `current`
 * is whether the plan answers the form as it is now rather than an earlier state of it.
 */
export function useLabPreview<Body, Plan>(
  lab: string,
  body: Body,
  preview: (body: Body) => Promise<Plan>,
  { enabled = true, wait = 300 }: { enabled?: boolean; wait?: number } = {},
) {
  const key = JSON.stringify(body)
  const settled = useDebounced(key, wait)
  const query = useQuery({
    queryKey: [lab, 'preview', settled],
    queryFn: () => preview(JSON.parse(settled) as Body),
    enabled: enabled && settled === key,
    placeholderData: keepPreviousData,
  })
  return { preview: query, current: settled === key && !query.isFetching }
}

/** `vec_avg` until the user chooses vector operators. */
export function vectorOperatorsOf(draft: LabDraft, available: string[] | undefined): string[] {
  return draft.vectorOperators ?? (available?.includes('vec_avg') ? ['vec_avg'] : [])
}

/** The market and settings both labs send to preview a task. */
export function labBody(draft: LabDraft, vectorOperators: string[], cores: number) {
  return {
    region: draft.region,
    delay: draft.delay,
    universe: draft.universe,
    dataset_ids: draft.datasetIds,
    field_ids: fieldIdsOf(draft),
    vector_operators: vectorOperators,
    neutralizations: draft.neutralizations,
    decay: draft.decay,
    cores,
  }
}

export function simulationsValid(simulations: number | null, maxSimulations: number): boolean {
  return simulations !== null && simulations >= 1 && simulations <= maxSimulations
}
