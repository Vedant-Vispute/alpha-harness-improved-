/** Correlation of the selected Alphas' daily PnL, as a heatmap small enough to take in at once. */

import { fmt } from '@/lib/format'
import type { PortfolioResult } from './api'

/** The lowest and highest correlation shown, which the colour scale runs between. */
type Range = { low: number; high: number }

function rangeOf(values: number[]): Range {
  return { low: Math.min(...values), high: Math.max(...values) }
}

const GREEN = 'var(--color-pnl-positive)'
const AMBER = 'var(--color-status-warning)'
const RED = 'var(--color-pnl-negative)'
/** Where amber sits on the scale. Squared, so the many pairs near the low end stay green and
 *  only the high ones heat up: amber lands at the square root of the halfway point. */
const AMBER_AT = Math.SQRT1_2

/** Green at the lowest correlation, red at the highest, through amber. */
function fill(value: number, { low, high }: Range) {
  const t = high > low ? ((value - low) / (high - low)) ** 2 : 1
  return t < 0.5
    ? `color-mix(in oklch, ${AMBER} ${Math.round(t * 200)}%, ${GREEN})`
    : `color-mix(in oklch, ${RED} ${Math.round((t - 0.5) * 200)}%, ${AMBER})`
}

function Legend({ range }: { range: Range }) {
  return (
    <div className="flex items-center justify-center gap-2 text-body-compact text-ink-muted">
      <span className="num">{fmt.ratio(range.low)}</span>
      <span
        className="h-2 w-48 rounded-pill"
        style={{
          background: `linear-gradient(to right in oklch, ${GREEN}, ${AMBER} ${Math.round(AMBER_AT * 100)}%, ${RED})`,
        }}
        aria-hidden
      />
      <span className="num">{fmt.ratio(range.high)}</span>
    </div>
  )
}

/** Past its grid limit the backend sends only the most correlated pairs, highest first. */
function TopPairs({ result }: { result: PortfolioResult }) {
  const { ids, topPairs, measuredPairs } = result
  const range = rangeOf(topPairs.map((p) => p.correlation))
  if (!topPairs.length) {
    return (
      <p className="text-body-compact text-ink-subtle">
        No two of these {ids.length} Alphas share the 250 trading days a correlation needs.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-body-compact text-ink-subtle">
        The {topPairs.length} most correlated of{' '}
        <span className="num">{fmt.int(measuredPairs)}</span> pairs; {ids.length} Alphas are too
        many for the grid.
      </p>
      <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
        {topPairs.map((p) => (
          <div
            key={`${p.a}-${p.b}`}
            className="flex items-center justify-between gap-3 rounded-xs border border-hairline px-3 py-2 text-body-compact"
          >
            <span className="flex items-center gap-2">
              <span
                className="size-3 rounded-xs"
                style={{ background: fill(p.correlation, range) }}
                aria-hidden
              />
              <span className="mono-metric text-ink-muted">
                {p.a} · {p.b}
              </span>
            </span>
            <span className="num text-ink">{fmt.ratio(p.correlation)}</span>
          </div>
        ))}
      </div>
      <Legend range={range} />
    </div>
  )
}

export function CorrelationMatrix({ result }: { result: PortfolioResult }) {
  const { ids, correlation } = result
  // The backend decides: a grid it can send, or only the top pairs when it cannot.
  if (!correlation.length) return <TopPairs result={result} />
  const measured = correlation.flatMap((row, i) =>
    row.filter((v, j): v is number => j !== i && v !== null),
  )
  if (!measured.length) return <TopPairs result={result} />
  const range = rangeOf(measured)
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <div
          role="img"
          aria-label={`Correlation of ${ids.length} Alphas, newest first`}
          className="mx-auto grid w-fit gap-px bg-surface-1"
          style={{ gridTemplateColumns: `repeat(${ids.length}, 0.75rem)` }}
        >
          {ids.flatMap((row, i) =>
            ids.map((column, j) => {
              const value = correlation[i]?.[j] ?? null
              const blank = i === j ? 'bg-surface-3' : value === null ? 'bg-surface-2' : ''
              const title =
                i === j
                  ? row
                  : value === null
                    ? `${row} · ${column}: under 250 shared days`
                    : `${row} · ${column}: ${fmt.ratio(value)}`
              return (
                <div
                  key={`${row}-${column}`}
                  title={title}
                  className={`size-3 ${blank}`}
                  style={blank || value === null ? undefined : { background: fill(value, range) }}
                />
              )
            }),
          )}
        </div>
      </div>
      <Legend range={range} />
    </div>
  )
}
