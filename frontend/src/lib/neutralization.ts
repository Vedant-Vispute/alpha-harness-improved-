/**
 * BRAIN's neutralizations, in the two families its own documentation splits them into.
 *
 * The risk family neutralizes an Alpha against a risk model: RAM, the statistical model, the
 * crowding factors, and the fundamental factor models — "In BRAIN Research, fundamental models
 * such as SLOW, FAST, and SLOW_AND_FAST are already represented". Everything else
 * neutralizes against a group of instruments, or against nothing at all.
 *
 * Which of them a market actually offers is BRAIN's to say, so the groups here are only an
 * ordering: a picker intersects them with the legal values for the scope it is showing.
 */

/** Neutralization against a risk model. */
export const RISK_NEUTRALIZATIONS: readonly string[] = [
  'REVERSION_AND_MOMENTUM',
  'STATISTICAL',
  'CROWDING',
  'SLOW',
  'FAST',
  'SLOW_AND_FAST',
]

export interface NeutralizationGroup {
  id: 'risk' | 'other'
  label: string
}

export const NEUTRALIZATION_GROUPS: readonly NeutralizationGroup[] = [
  { id: 'risk', label: 'Risk Neutralization' },
  { id: 'other', label: 'Other' },
]

/**
 * What to call a neutralization: BRAIN's own label where the market gives one, otherwise its
 * value made readable.
 *
 * A sweep spans regions, and a value legal in one arrives in another's list with no label of
 * its own — `COUNTRY` among `Market` and `Subindustry`. `scope.choices` fills a missing label
 * with the value, so a label equal to its value is the signal that none came through. Nothing
 * is renamed here: the words are BRAIN's, only the shouting is taken off.
 */
export const neutralizationLabel = (value: string, label?: string): string =>
  label && label !== value
    ? label
    : value
        .split('_')
        .filter(Boolean)
        .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
        .join(' ')

export const groupOf = (value: string): NeutralizationGroup['id'] =>
  RISK_NEUTRALIZATIONS.includes(value) ? 'risk' : 'other'

/**
 * The legal values for a scope, split into the two families and kept in BRAIN's own order
 * within each. A family the scope offers nothing for is dropped rather than shown empty.
 */
export function splitNeutralizations<T extends { value: string }>(
  available: readonly T[],
): { group: NeutralizationGroup; items: T[] }[] {
  return NEUTRALIZATION_GROUPS.map((group) => ({
    group,
    items: available.filter((choice) => groupOf(choice.value) === group.id),
  })).filter((block) => block.items.length > 0)
}
