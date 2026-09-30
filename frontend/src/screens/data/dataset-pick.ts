/** Picking datasets, or single fields of them, in the Data Explorer's Fields table for a lab. */

import { createPick } from '@/lib/pick'

export type PickFrom =
  | '/labs/search'
  | '/labs/template'
  | '/labs/power-pool'
  | '/labs/region-agnostic'

/** A field ticked in the Fields table, with the dataset it belongs to. */
export interface PickedField {
  id: string
  dataset: string
  /** MATRIX, VECTOR or GROUP; absent from a field chosen before it was recorded. */
  type?: string | null
}

/** Ticked fields, ranked by the table's order when the pick was finished. */
export interface FieldPick {
  fields: PickedField[]
  /** How they were ranked, as a lab's prompt says it: "Alphas, most first". */
  rankBy: string | null
}

export const useDatasetPick = createPick<PickFrom, FieldPick>(
  'alpha-harness-dataset-pick',
  '/labs/search',
)
