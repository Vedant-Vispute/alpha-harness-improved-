/**
 * Pyramids laid out as BRAIN lays them out: a row per Category, a column per Region and Delay.
 * A cell picks one Pyramid; a row or column heading picks every Pyramid in it. However many
 * Pyramids an account fills, the grid stays one table rather than a wall of chips.
 */

import { XIcon } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/cn'
import { fmt } from '@/lib/format'
import { Button } from '@/ui/kit'
import { Sheet } from '@/ui/overlay'
import type { PortfolioMember } from './api'

const OFF =
  'border-(--field-border) bg-surface-1 text-ink-muted hover:border-(--field-border-hover) hover:text-ink'
const ON = 'border-primary bg-primary-subtle text-ink'

/** Most-held first, so the busiest rows and columns sit top left. */
function byCount(counts: Map<string, number>): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k)
}

function PyramidGrid({
  members,
  value,
  onChange,
}: {
  members: PortfolioMember[]
  /** Pyramids as BRAIN names them: `USA/D1/PV`. */
  value: string[]
  onChange: (value: string[]) => void
}) {
  const held = new Map<string, number>()
  for (const m of members) for (const p of m.pyramids) held.set(p, (held.get(p) ?? 0) + 1)
  const cells = new Map<string, { pyramid: string; count: number }>()
  const markets = new Map<string, number>()
  const categories = new Map<string, number>()
  for (const [pyramid, count] of held) {
    const [region = '', delay = '', category = ''] = pyramid.split('/')
    const market = `${region} ${delay}`
    cells.set(`${category}|${market}`, { pyramid, count })
    markets.set(market, (markets.get(market) ?? 0) + count)
    categories.set(category, (categories.get(category) ?? 0) + count)
  }
  const columns = byCount(markets)
  const rows = byCount(categories)
  const chosen = new Set(value)

  const of = (pick: (key: string) => boolean) =>
    [...cells.entries()].filter(([key]) => pick(key)).map(([, cell]) => cell.pyramid)
  const allOn = (pyramids: string[]) => pyramids.length > 0 && pyramids.every((p) => chosen.has(p))
  const toggle = (pyramids: string[]) => {
    const next = new Set(chosen)
    const on = !allOn(pyramids)
    for (const p of pyramids) {
      if (on) next.add(p)
      else next.delete(p)
    }
    onChange([...next])
  }

  if (!cells.size) return <span className="text-body-compact text-ink-subtle">—</span>
  return (
    <div className="overflow-x-auto">
      <table className="border-separate border-spacing-1 text-body-compact">
        <thead>
          <tr>
            <th scope="col" className="pr-2 text-left font-medium text-ink-subtle">
              Category
            </th>
            {columns.map((market) => {
              const pyramids = of((key) => key.endsWith(`|${market}`))
              return (
                <th key={market} scope="col" className="font-normal">
                  <button
                    type="button"
                    aria-pressed={allOn(pyramids)}
                    title={`Every ${market} Pyramid`}
                    onClick={() => toggle(pyramids)}
                    className={cn(
                      'num h-8 w-full rounded-sm border px-2 whitespace-nowrap transition-colors',
                      allOn(pyramids) ? ON : OFF,
                    )}
                  >
                    {market}
                  </button>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((category) => {
            const pyramids = of((key) => key.startsWith(`${category}|`))
            return (
              <tr key={category}>
                <th scope="row" className="font-normal">
                  <button
                    type="button"
                    aria-pressed={allOn(pyramids)}
                    title={`Every ${category} Pyramid`}
                    onClick={() => toggle(pyramids)}
                    className={cn(
                      'h-8 w-full rounded-sm border px-2 text-left whitespace-nowrap transition-colors',
                      allOn(pyramids) ? ON : OFF,
                    )}
                  >
                    {category}
                  </button>
                </th>
                {columns.map((market) => {
                  const cell = cells.get(`${category}|${market}`)
                  if (!cell) return <td key={market} />
                  const on = chosen.has(cell.pyramid)
                  return (
                    <td key={market}>
                      <button
                        type="button"
                        aria-pressed={on}
                        aria-label={`${cell.pyramid.split('/').join(' / ')}: ${cell.count} Alphas`}
                        onClick={() => toggle([cell.pyramid])}
                        className={cn(
                          'num h-8 w-full min-w-12 rounded-sm border px-2 transition-colors',
                          on ? ON : OFF,
                        )}
                      >
                        {fmt.int(cell.count)}
                      </button>
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** The filter's place on the page: what is picked, and the grid in a side pane. Rarely changed,
 *  so the grid stays out of the way until asked for. */
export function PyramidPicker({
  members,
  value,
  onChange,
}: {
  members: PortfolioMember[]
  value: string[]
  onChange: (value: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-body-compact font-medium text-ink-muted">Pyramids</h3>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" onClick={() => setOpen(true)}>
          {value.length === 0
            ? 'All Pyramids'
            : `${fmt.int(value.length)} Pyramid${value.length === 1 ? '' : 's'}`}
        </Button>
        {value.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => onChange([])}>
            Clear
          </Button>
        )}
      </div>
      {value.length > 0 && (
        <ul aria-label="Picked Pyramids" className="flex flex-wrap gap-1.5">
          {[...value].sort().map((pyramid) => (
            <li key={pyramid}>
              <button
                type="button"
                aria-label={`Remove ${pyramid.split('/').join(' / ')}`}
                onClick={() => onChange(value.filter((p) => p !== pyramid))}
                className="num inline-flex h-7 items-center gap-1.5 rounded-sm border border-primary bg-primary-subtle px-2 text-body-compact whitespace-nowrap text-ink transition-colors hover:border-primary-hover"
              >
                {pyramid.split('/').join(' / ')}
                <XIcon aria-hidden className="size-3 text-ink-muted" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="Pyramids"
        description="Pick a cell for one Pyramid, or a Category or Market for its whole row or column. Nothing picked keeps every Pyramid."
      >
        <PyramidGrid members={members} value={value} onChange={onChange} />
      </Sheet>
    </div>
  )
}
