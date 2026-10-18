/**
 * The Alpha's history on one canvas, three ways: its cumulative PnL beside the
 * investability-constrained PnL, how far under water it was each day, and its Sharpe over
 * the trailing year against the submission cutoff. Figures stay neutral; loss is the only hue.
 */

import { createSeriesMarkers, LineSeries, LineStyle, type Time } from 'lightweight-charts'
import { useEffect, useRef } from 'react'
import {
  addUnderwater,
  baseChart,
  color,
  compact,
  textOnlyValueLabel,
  zeroLine,
} from '@/screens/pool/pnl-chart'
import type { Point } from './analysis'

export type ChartView = 'pnl' | 'underwater' | 'sharpe'

export function ArcChildrenChart({
  series,
  label,
}: {
  series: { label: string; points: Point[] }[]
  label: string
}) {
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = element.current
    if (!node) return
    const chart = baseChart(node)
    chart.applyOptions({ localization: { priceFormatter: compact } })
    const palette = [
      color('color-primary'),
      color('color-status-profit'),
      color('color-status-warning'),
      color('color-ink-subtle'),
    ]
    for (const [index, curve] of series.entries()) {
      if (curve.points.length < 2) continue
      const childSeries = chart.addSeries(LineSeries, {
        color: palette[index % palette.length] ?? '#ffffff',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        title: curve.label,
      })
      childSeries.setData(
        curve.points.map((point) => ({ time: point.date as Time, value: point.value })),
      )
    }
    chart.timeScale().fitContent()
    return () => chart.remove()
  }, [series])
  return <div ref={element} role="img" aria-label={label} className="h-80 w-full min-w-0" />
}

export function AlphaChart({
  view,
  pnl,
  constrained,
  net,
  underwater,
  sharpe,
  cutoff,
  testStart,
  label,
  compact: compactChart = false,
  stacked = false,
}: {
  view: ChartView
  pnl: Point[]
  constrained: Point[]
  /** Cumulative PnL after the chosen trading cost; empty when no cost is set. */
  net: Point[]
  underwater: Point[]
  sharpe: Point[]
  /** The Sharpe a submission needs, drawn across the rolling view. */
  cutoff: number | null
  /** First held-out day, from BRAIN: the train years before it are drawn dimmer. */
  testStart: string | null
  label: string
  compact?: boolean
  stacked?: boolean
}) {
  const element = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = element.current
    if (!node) return
    const guide = color('color-ink-tertiary')
    const chart = baseChart(node)
    chart.applyOptions({
      localization: {
        priceFormatter:
          view === 'underwater'
            ? (p: number) => `${(p * 100).toFixed(1)}%`
            : view === 'sharpe'
              ? (p: number) => p.toFixed(2)
              : compact,
      },
    })
    const at = (points: Point[]) => points.map((p) => ({ time: p.date as Time, value: p.value }))

    if (view === 'pnl') {
      if (stacked) {
        const drawdownPane = chart.addPane()
        chart.panes()[0]?.setStretchFactor(0.72)
        drawdownPane.setStretchFactor(0.28)
        addUnderwater(chart, 1, {
          lastValueVisible: true,
          priceFormat: {
            type: 'custom',
            formatter: (p: number) => `${(p * 100).toFixed(1)}%`,
          },
        }).setData(at(underwater))
      }
      if (constrained.length > 1) {
        chart
          .addSeries(LineSeries, {
            color: color('color-ink-tertiary'),
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            priceLineVisible: false,
            lastValueVisible: false,
          })
          .setData(at(constrained))
      }
      if (net.length > 1) {
        // Its own dates, not the gross line's: this series comes from the stored daily PnL,
        // which carries the closing days BRAIN counts but exports in no recordset.
        chart
          .addSeries(LineSeries, {
            color: color('color-status-warning'),
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
          })
          .setData(at(net))
      }
      const ink = '#ffffff'
      const trained = color('color-ink-subtle')
      const series = chart.addSeries(LineSeries, {
        color: ink,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        title: 'PnL',
      })
      // Compared, not matched: the boundary BRAIN reports can fall on a day with no trading.
      const held = (p: Point) => testStart === null || p.date >= testStart
      series.setData(
        pnl.map((p) => ({ time: p.date as Time, value: p.value, color: held(p) ? ink : trained })),
      )
      series.createPriceLine(zeroLine())
      const latest = pnl.at(-1)
      if (latest) series.createPriceLine(textOnlyValueLabel(latest.value))
      const first = testStart === null ? undefined : pnl.find(held)
      if (first) {
        createSeriesMarkers(series, [
          {
            time: first.date as Time,
            position: 'aboveBar',
            shape: 'arrowDown',
            color: guide,
            text: 'Test',
          },
        ])
      }
    } else if (view === 'underwater') {
      addUnderwater(chart, undefined, { lastValueVisible: true }).setData(at(underwater))
    } else {
      const series = chart.addSeries(LineSeries, {
        color: color('color-ink'),
        lineWidth: 2,
        priceLineVisible: false,
        title: 'Sharpe, trailing year',
      })
      series.setData(at(sharpe))
      series.createPriceLine(zeroLine())
      if (cutoff !== null) {
        series.createPriceLine({
          price: cutoff,
          color: color('color-status-warning'),
          lineStyle: LineStyle.Dashed,
          lineWidth: 1,
          axisLabelVisible: true,
          title: 'Cutoff',
        })
      }
    }
    chart.timeScale().fitContent()
    return () => chart.remove()
  }, [view, pnl, constrained, net, underwater, sharpe, cutoff, testStart, stacked])

  return (
    <div
      ref={element}
      role="img"
      aria-label={label}
      className={`${compactChart ? 'h-32' : 'h-80'} w-full min-w-0`}
    />
  )
}
