/** Picking seed Alphas on Pool › Stored for Evolution Lab. */

import { createPick } from '@/lib/pick'

/** A task breeds from at least two seeds and at most a hundred. */
export const MIN_SEEDS = 2
export const MAX_SEEDS = 100

export const useSeedPick = createPick<'/labs/evolution' | '/labs/evolution-general'>(
  'alpha-harness-seed-pick',
  '/labs/evolution',
)
