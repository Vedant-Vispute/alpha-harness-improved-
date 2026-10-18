/**
 * The Alpha page's contract. Correlations and the performance comparison spend BRAIN's
 * hourly budgets, so they run on a click and come back cached with `fetchedAt`; only
 * `refresh` asks BRAIN again. Nothing here submits an Alpha.
 */

import type { components } from '@/api/generated'
import { ApiError, http, qs } from '@/api/http'
import type { AlphaCheck } from '@/api/types'
import type { BrainCorrelation } from '@/screens/pool/api'

type Schemas = components['schemas']

export type AlphaInfo = Omit<Schemas['AlphaInfo'], 'checks'> & { checks: AlphaCheck[] }
export type AlphaView = Omit<Schemas['AlphaView'], 'alpha'> & { alpha: AlphaInfo }
export type AlphaStats = Schemas['AlphaStats']
export type AlphaYear = Schemas['AlphaYear']
export type AlphaLineage = Schemas['AlphaLineage']
export type AlphaProperties = Schemas['AlphaProperties']
/** The Portfolio page's result shape, over a book of one — see `/api/alphas/{id}/after-cost`. */
export type AfterCost = Schemas['PortfolioResult']

export type CorrelationKind = 'self' | 'power-pool' | 'prod'

/** `cached: false` only answers a `cached` read that found nothing kept. */
export type Kept<T> = (T & { cached: true; fetchedAt: string }) | { cached: false }

export type Correlation = Kept<BrainCorrelation>

/** `cached` reads only what is kept; `run` asks BRAIN if nothing is; `refresh` always asks. */
export type Read = 'cached' | 'run' | 'refresh'

const read = (mode: Read) =>
  qs({ cached_only: mode === 'cached' || null, refresh: mode === 'refresh' || null })

/** Before and after the Alpha joins its pool partition, as BRAIN reports it. */
export type Performance = Kept<{
  partitionName?: string
  stats?: { before: AlphaStats | null; after: AlphaStats | null }
}>

const id = (alphaId: string) => encodeURIComponent(alphaId)

/** BRAIN's answer, 410 or 412, when a correlation does not apply to this Alpha. */
export const notApplicable = (error: unknown) =>
  error instanceof ApiError && [410, 412].includes(Number(error.body['platformStatus']))

export const alpha = {
  page: (alphaId: string, refresh = false) =>
    http.get<AlphaView>(`/api/alphas/${id(alphaId)}/page${qs({ refresh: refresh || null })}`),
  /** Run BRAIN's submission checks for an ARC child without submitting it. */
  check: (alphaId: string) =>
    http.get<{ is?: { checks?: AlphaCheck[] } }>(`/api/alphas/${id(alphaId)}/check`),
  save: (alphaId: string, body: AlphaProperties) =>
    http.patch<AlphaInfo>(`/api/alphas/${id(alphaId)}`, body),
  correlation: (alphaId: string, kind: CorrelationKind, mode: Read) =>
    http.get<Correlation>(`/api/alphas/${id(alphaId)}/correlations/${kind}${read(mode)}`),
  performance: (alphaId: string, mode: Read) =>
    http.get<Performance>(`/api/alphas/${id(alphaId)}/performance${read(mode)}`),
  /** Gross and after-cost PnL, charging `costBps` against each day's own turnover. */
  afterCost: (alphaId: string, costBps: number) =>
    http.get<AfterCost>(`/api/alphas/${id(alphaId)}/after-cost${qs({ costBps })}`),
}
