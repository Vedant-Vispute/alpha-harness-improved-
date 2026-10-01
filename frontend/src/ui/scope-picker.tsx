/**
 * Region, Delay and Universe from BRAIN's own settings schema. Keeps the universe legal:
 * when the region changes to one without the current universe, the first legal one is chosen.
 */

import { useEffect } from 'react'
import type { Scope } from '@/api/types'
import { type Choice, useScopeOptions } from '@/lib/scope'
import { Select } from './overlay'

export type ScopePart = 'region' | 'delay' | 'universe'

const PARTS: ScopePart[] = ['region', 'delay', 'universe']

const LABELS: Record<ScopePart, string> = {
  region: 'Region',
  delay: 'Delay',
  universe: 'Universe',
}

export function ScopePicker({
  scope,
  onChange,
  disabled,
  parts = PARTS,
}: {
  scope: Scope
  onChange: (change: Partial<Scope>) => void
  disabled?: boolean
  /** Which of Region, Delay and Universe to offer; a screen that searches universes leaves it out. */
  parts?: readonly ScopePart[]
}) {
  const options = useScopeOptions(scope)

  // The delay first: the universes are resolved *against* it, so an impossible delay leaves
  // the universe list empty and nothing below it can correct itself. All regions runs at
  // delay 1 only, so arriving there from a delay-0 market would otherwise stick.
  useEffect(() => {
    const first = options.delays[0]
    if (first && !options.delays.some((d) => d.value === String(scope.delay)))
      onChange({ delay: Number(first.value) })
  }, [options.delays, scope.delay, onChange])

  useEffect(() => {
    const first = options.universes[0]
    if (options.ready && first && !options.universes.some((u) => u.value === scope.universe))
      onChange({ universe: first.value })
  }, [options.ready, options.universes, scope.universe, onChange])

  const lists: Record<ScopePart, Choice[]> = {
    region: options.regions.length
      ? options.regions
      : [{ value: scope.region, label: scope.region }],
    delay: options.delays.length
      ? options.delays
      : [{ value: String(scope.delay), label: String(scope.delay) }],
    universe: options.universes.length
      ? options.universes
      : [{ value: scope.universe, label: scope.universe }],
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {parts.map((part) => (
        <label key={part} className="flex items-center gap-1.5">
          <span className="text-body-compact text-ink-subtle">{LABELS[part]}</span>
          <Select
            label={LABELS[part]}
            mono
            disabled={disabled}
            items={lists[part]}
            value={String(scope[part])}
            onChange={(value) =>
              onChange(part === 'delay' ? { delay: Number(value) } : { [part]: value })
            }
          />
        </label>
      ))}
    </div>
  )
}
