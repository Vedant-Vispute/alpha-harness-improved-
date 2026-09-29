/** LLM Power Pool Lab: datasets, a model, cores and simulations, then add the task to Tasks. */

import type { components } from '@/api/generated'
import { http } from '@/api/http'

type Schemas = components['schemas']

export type PowerPoolOptions = Schemas['PowerPoolOptions']
export type PowerPoolPreview = Schemas['PowerPoolPreview']

export interface PowerPoolRequest {
  region: string
  delay: number
  universe: string
  dataset_ids: string[]
  /** Only these fields, ranked, when any were chosen; the prompt lists them in this order. */
  field_ids: string[]
  /** How `field_ids` were ranked, as the prompt says it. */
  rank_by: string | null
  model: string | null
  /** A saved prompt from LLM Prompts; null sends the built-in. */
  prompt_id: number | null
  /** Empty keeps every neutralization BRAIN offers for the market. */
  neutralizations: string[]
  cores: number
  simulations: number
}

const B = '/api/power-pool-lab'

export const powerPoolLab = {
  options: () => http.get<PowerPoolOptions>(`${B}/options`),
  /** Free: no LLM call, no simulation. */
  preview: (body: PowerPoolRequest) => http.post<PowerPoolPreview>(`${B}/preview`, body),
  addTask: (body: PowerPoolRequest) => http.post<Schemas['AddedTask']>(`${B}/tasks`, body),
}
