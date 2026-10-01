/**
 * Settings Sampler: one proven expression, re-run everywhere BRAIN will accept it.
 *
 * One source of truth: the set of chosen markets. The Region, Delay and Universe rows are
 * views of that set rather than filters beside it, so a chip is full, part-full or empty
 * according to what is actually chosen, and clicking it selects or clears its whole group.
 * That keeps the chips and the tree from ever disagreeing while still letting a single
 * market — EUR delay 1, say — be dropped on its own.
 */

import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { today } from '@/api/core'
import { cn } from '@/lib/cn'
import { DASH, fmt } from '@/lib/format'
import { neutralizationLabel } from '@/lib/neutralization'
import { useCores } from '@/lib/preferences'
import {
  DEFAULT_SCOPE,
  marketKey,
  REGION_AGNOSTIC,
  regionLabel,
  useScopeOptions,
} from '@/lib/scope'
import { AstInspector } from '@/screens/pool/shared'
import { AddTaskButtons, useAddTask } from '@/screens/research-labs/add-task'
import { NeutralizationPicker } from '@/screens/research-labs/neutralization'
import { SimulationSettingsFields, testPeriodOf } from '@/screens/research-labs/simulation-settings'
import {
  Button,
  Chips,
  Empty,
  ErrorNotice,
  Field,
  Fieldset,
  Input,
  Metric,
  Notice,
  Page,
  PageHeader,
  Panel,
  Segmented,
  Skeleton,
  Textarea,
} from '@/ui/kit'
import {
  type Holding,
  type MarketPick,
  type Pair,
  pairLabel,
  type SettingsPlan,
  type Source,
  settingsSampler,
} from './api'

/** A multi-simulation carries at most ten children, all sharing region and delay. BRAIN fails
 *  a batch of region-agnostic ones, so those go one at a time. */
const BATCH = 10
const batchOf = (region: string) => (region === REGION_AGNOSTIC ? 1 : BATCH)

const REGION_AGNOSTIC_NOTE =
  'Region Agnostic: each Simulation runs in every Region its Fields reach and uses 4 of the ' +
  "day's simulations. Not chosen until you tick it."

const pairKey = (p: Pair) => `${p.maxTrade}|${p.maxPosition}`

type Mode = 'expression' | 'alpha'

const MODES: { value: Mode; label: string }[] = [
  { value: 'expression', label: 'Expression' },
  { value: 'alpha', label: 'Alpha ID' },
]
/** TOP200 before TOP1000: universe names are numbered, so compare them that way. */
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

const allMarkets = (plan: SettingsPlan) => plan.regions.flatMap((r) => r.markets)

/** Every market but All Regions, which costs four a simulation and so is only swept on
 *  purpose, and every pair; no neutralization, which the reader ticks before anything runs. */
function defaults(plan: SettingsPlan) {
  return {
    chosen: new Set(
      allMarkets(plan)
        .filter((m) => m.region !== REGION_AGNOSTIC)
        .map(marketKey),
    ),
    neutralizations: [] as string[],
    pairs: [...new Set(plan.regions.flatMap((r) => r.pairs.map(pairKey)))],
  }
}

/** How much of a group is chosen. Drives both the look of a chip and what clicking it does. */
interface Group {
  keys: string[]
  on: number
}

const groupOf = (
  markets: { region: string; delay: number; universe: string }[],
  chosen: ReadonlySet<string>,
): Group => {
  const keys = markets.map(marketKey)
  return { keys, on: keys.filter((k) => chosen.has(k)).length }
}

/** One region once the choice is applied: what survives, and what it costs. */
interface Branch {
  region: string
  positionAvailable: boolean
  /** Simulations of the day's allowance one run here uses. */
  cost: number
  group: Group
  neutralizations: number
  pairs: number
  rows: {
    delay: number
    group: Group
    universes: { name: string; key: string; on: boolean }[]
  }[]
  markets: number
  total: number
  coverage: [number, number] | null
}

function resolve(
  plan: SettingsPlan | undefined,
  chosen: ReadonlySet<string>,
  neutralizations: string[],
  pairs: string[],
  marketNeutralOnly: boolean,
) {
  const neutral = new Set(neutralizations)
  const pairSet = new Set(pairs)
  const branches: Branch[] = []
  const picks: MarketPick[] = []
  const perDelay = new Map<string, number>()

  for (const region of plan?.regions ?? []) {
    const live = region.markets
    const neutHere = region.neutralizations.filter((n) => neutral.has(n)).length
    const legalPairs = region.pairs.filter((p) => pairSet.has(pairKey(p)))
    const pairsHere = legalPairs.length
    // The one combination the sweep drops when it is asked to: neither neutralized nor
    // constrained. Counted per market, so the estimate matches what actually runs.
    const unhedged =
      marketNeutralOnly &&
      neutral.has('NONE') &&
      region.neutralizations.includes('NONE') &&
      legalPairs.some((p) => p.maxTrade === 'OFF' && p.maxPosition === 'OFF')
        ? 1
        : 0
    const runs = neutHere * pairsHere - unhedged

    const byDelay = new Map<number, typeof live>()
    for (const market of live) {
      byDelay.set(market.delay, [...(byDelay.get(market.delay) ?? []), market])
    }

    const covers: number[] = []
    let markets = 0
    for (const market of live) {
      if (!chosen.has(marketKey(market))) continue
      markets += 1
      covers.push(market.coverage)
      picks.push({ region: market.region, delay: market.delay, universe: market.universe })
      const key = `${market.region}|${market.delay}`
      perDelay.set(key, (perDelay.get(key) ?? 0) + runs)
    }

    branches.push({
      region: region.region,
      positionAvailable: region.positionAvailable,
      cost: region.cost,
      group: groupOf(live, chosen),
      neutralizations: neutHere,
      pairs: pairsHere,
      rows: [...byDelay.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([delay, list]) => ({
          delay,
          group: groupOf(list, chosen),
          universes: list
            .map((m) => ({ name: m.universe, key: marketKey(m), on: chosen.has(marketKey(m)) }))
            .sort((a, b) => byName(a.name, b.name)),
        })),
      markets,
      total: markets * runs * region.cost,
      coverage: covers.length ? [Math.min(...covers), Math.max(...covers)] : null,
    })
  }

  let batches = 0
  for (const [key, count] of perDelay)
    batches += Math.ceil(count / batchOf(key.slice(0, key.indexOf('|'))))
  return {
    branches,
    picks,
    simulations: branches.reduce((sum, b) => sum + b.total, 0),
    batches,
    markets: picks.length,
  }
}

/** One figure when the region agrees with itself, a range when it does not. */
function coverageLabel(span: [number, number] | null): string {
  if (!span) return DASH
  const [low, high] = span
  const lo = fmt.pct(low, 0)
  return lo === fmt.pct(high, 0) ? lo : `${lo}\u2013${fmt.pct(high, 0)}`
}

/** Region, its three factors, then what they multiply to. The units are named once in the
 *  header above the list, so no row has to carry them. */
const GRID =
  'grid min-w-184 grid-cols-[7.5rem_4rem_6.5rem_3rem_5.5rem_4.5rem_1fr] items-center gap-x-3'

/** Keeps the Region column in view when the list scrolls sideways. A surface, not a shadow:
 *  shadows belong to what floats over the page. */
const STICKY = 'sticky left-0 z-10 bg-surface-1'

/**
 * A chip standing for a group of markets: full, part-full, or empty. Clicking clears the
 * group when any of it is chosen and restores it when none is.
 */
function GroupChip({
  label,
  group,
  onChange,
  size = 'md',
  disabled,
  title,
}: {
  label: ReactNode
  group: Group
  onChange: (keys: string[], on: boolean) => void
  size?: 'md' | 'sm'
  disabled?: boolean
  title?: string | undefined
}) {
  const { keys, on } = group
  const part = on > 0 && on < keys.length
  return (
    <button
      type="button"
      disabled={disabled || keys.length === 0}
      aria-pressed={on > 0}
      title={part ? `${on} of ${keys.length} chosen` : title}
      onClick={() => onChange(keys, on === 0)}
      className={cn(
        'num flex items-center gap-1.5 rounded-sm border whitespace-nowrap transition-colors',
        size === 'md' ? 'h-8 px-2.5 text-body' : 'h-7 px-2 text-body-compact',
        on === 0 && 'border-(--field-border) bg-surface-1 text-ink-subtle line-through',
        part && 'border-hairline-strong bg-surface-2 text-ink-muted',
        on === keys.length && on > 0 && 'border-hairline-strong bg-surface-3 text-ink',
        !disabled && 'hover:border-(--field-border-hover) hover:text-ink',
      )}
    >
      {label}
      {part && (
        <span className="text-body-compact text-ink-subtle">
          {on}/{keys.length}
        </span>
      )}
    </button>
  )
}

function Tree({
  branches,
  onChange,
}: {
  branches: Branch[]
  onChange: (keys: string[], on: boolean) => void
}) {
  return (
    <div className="overflow-x-auto">
      <div
        aria-hidden
        className={cn(GRID, 'px-3 pb-1.5 text-caption tracking-wide text-ink-subtle uppercase')}
      >
        <span className={STICKY}>Region</span>
        <span className="text-right">Markets</span>
        <span className="text-right">Neutralizations</span>
        <span className="text-right">Pairs</span>
        <span className="text-right">Simulations</span>
        <span className="text-right">Coverage</span>
        <span />
      </div>
      <ul className="flex flex-col gap-1.5">
        {branches.map((branch) => (
          <li
            key={branch.region}
            className={cn(
              'rounded-md border border-hairline px-3 py-2 transition-opacity',
              branch.group.on === 0 && 'opacity-55',
            )}
          >
            <div className={GRID}>
              <div className={STICKY}>
                <GroupChip
                  label={<span className="font-medium">{regionLabel(branch.region)}</span>}
                  group={branch.group}
                  onChange={onChange}
                  title={branch.region === REGION_AGNOSTIC ? REGION_AGNOSTIC_NOTE : undefined}
                />
              </div>
              <span className="num text-right text-body-compact text-ink-muted">
                {branch.markets}
              </span>
              <span className="num text-right text-body-compact text-ink-muted">
                {branch.neutralizations}
              </span>
              <span className="num text-right text-body-compact text-ink-muted">
                {branch.pairs}
              </span>
              <span className="num text-right text-body font-semibold text-ink">
                {fmt.int(branch.total)}
              </span>
              <span className="num text-right text-body-compact text-ink-subtle">
                {coverageLabel(branch.coverage)}
              </span>
              <span className="text-body-compact text-ink-subtle">
                {[
                  branch.cost > 1 && `${branch.cost} simulations each`,
                  !branch.positionAvailable && 'no Max Position',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>

            <div className="mt-1.5 flex flex-col gap-1 border-t border-hairline-subtle pt-1.5">
              {branch.rows.map((row) => (
                <div key={row.delay} className="flex flex-wrap items-center gap-1.5">
                  {/* This region's markets at this delay only, so EUR D1 can go on its own. */}
                  <GroupChip
                    size="sm"
                    label={`D${row.delay}`}
                    group={row.group}
                    onChange={onChange}
                  />
                  {row.universes.map((universe) => (
                    <GroupChip
                      key={universe.key}
                      size="sm"
                      label={universe.name}
                      group={{ keys: [universe.key], on: universe.on ? 1 : 0 }}
                      onChange={onChange}
                    />
                  ))}
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function SettingsSamplerScreen() {
  const search = useSearch({ from: '/tools/settings-sampler' })
  const navigate = useNavigate()
  // The URL owns which Alpha is open, so arriving without one shows an empty screen rather
  // than the last one analysed.
  const alphaId = search.alpha ?? ''
  const [mode, setMode] = useState<Mode>(alphaId ? 'alpha' : 'expression')
  const [draft, setDraft] = useState(alphaId)
  const [expression, setExpression] = useState('')
  const [decay, setDecay] = useState('0')
  const [truncation, setTruncation] = useState('0.08')
  const [nanHandling, setNanHandling] = useState<'ON' | 'OFF'>('ON')
  const [testYears, setTestYears] = useState('2')
  const [testMonths, setTestMonths] = useState('0')
  /** Which Alpha's settings have been read into the fields above, so a refetch of the same
   *  plan does not overwrite an edit made since. */
  const [inherited, setInherited] = useState('')
  /** The expression last analysed; the draft above only counts once Analyse is pressed. */
  const [typed, setTyped] = useState<Source | null>(null)
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [neutralizations, setNeutralizations] = useState<string[]>([])
  const [pairs, setPairs] = useState<string[]>([])
  /** `null` until chosen here: until then Settings' default for new tasks applies. */
  const [chosenCores, setCores] = useState<number | null>(null)
  const wantedCores = useCores(chosenCores)
  const [marketNeutralOnly, setMarketNeutralOnly] = useState(true)

  useEffect(() => {
    setDraft(search.alpha ?? '')
    if (search.alpha) setMode('alpha')
  }, [search.alpha])

  const holding: Holding = {
    decay: Math.max(0, Math.round(Number(decay) || 0)),
    truncation: Number(truncation) || 0.08,
    nanHandling,
    testPeriod: testPeriodOf(testYears, testMonths),
  }
  const source: Source | null = mode === 'alpha' ? (alphaId ? { alphaId } : null) : typed
  const query = useQuery({
    queryKey: ['settings-sampler', source],
    queryFn: () => settingsSampler.preview(source ?? { alphaId: '' }),
    enabled: source !== null,
    retry: false,
  })
  const plan = query.data
  const cores = Math.min(wantedCores, plan?.maxCores ?? wantedCores)

  // An Alpha's own settings fill the fields the first time its plan arrives, so what is shown
  // is what would run — and stays editable, because an edit is the whole point of having them
  // here. Keyed on the Alpha, so a refetch never overwrites a change made since.
  useEffect(() => {
    const own = plan?.settings
    if (!own || !plan.alphaId || plan.alphaId === inherited) return
    setInherited(plan.alphaId)
    setDecay(String(own.decay ?? 0))
    setTruncation(String(own.truncation ?? 0.08))
    setNanHandling(own.nanHandling === 'OFF' ? 'OFF' : 'ON')
    const period = /^P(\d+)Y(\d+)M/.exec(own.testPeriod ?? '')
    setTestYears(period?.[1] ?? '2')
    setTestMonths(period?.[2] ?? '0')
  }, [plan?.settings, plan?.alphaId, inherited])

  const reset = (from: SettingsPlan) => {
    const start = defaults(from)
    setChosen(start.chosen)
    setNeutralizations(start.neutralizations)
    setPairs(start.pairs)
  }

  useEffect(() => {
    if (!plan) return
    const start = defaults(plan)
    setChosen(start.chosen)
    setNeutralizations(start.neutralizations)
    setPairs(start.pairs)
    setCores(null)
  }, [plan])

  const change = (keys: string[], on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev)
      for (const key of keys) {
        if (on) next.add(key)
        else next.delete(key)
      }
      return next
    })

  const all = useMemo(() => (plan ? allMarkets(plan) : []), [plan])
  const whole = useMemo(
    () =>
      plan
        ? resolve(
            plan,
            new Set(all.map(marketKey)),
            [...new Set(plan.regions.flatMap((r) => r.neutralizations))],
            [...new Set(plan.regions.flatMap((r) => r.pairs.map(pairKey)))],
            marketNeutralOnly,
          ).simulations
        : 0,
    [plan, all, marketNeutralOnly],
  )
  const { branches, picks, simulations, batches, markets } = useMemo(
    () => resolve(plan, chosen, neutralizations, pairs, marketNeutralOnly),
    [plan, chosen, neutralizations, pairs, marketNeutralOnly],
  )
  // What the skip is worth right now, so the choice is made against a number.
  const unhedged = useMemo(
    () =>
      resolve(plan, chosen, neutralizations, pairs, false).simulations -
      resolve(plan, chosen, neutralizations, pairs, true).simulations,
    [plan, chosen, neutralizations, pairs],
  )

  /** The Region, Delay and Universe rows, each a view of the chosen markets. */
  const axes = useMemo(() => {
    const by = <K extends string | number>(pick: (m: (typeof all)[number]) => K) => {
      const buckets = new Map<K, typeof all>()
      for (const market of all)
        buckets.set(pick(market), [...(buckets.get(pick(market)) ?? []), market])
      return [...buckets.entries()]
    }
    return {
      regions: by((m) => m.region).map(([value, list]) => ({
        value,
        group: groupOf(list, chosen),
      })),
      delays: by((m) => m.delay)
        .sort((a, b) => a[0] - b[0])
        .map(([value, list]) => ({ value, group: groupOf(list, chosen) })),
      universes: by((m) => m.universe)
        .sort((a, b) => byName(a[0], b[0]))
        .map(([value, list]) => ({ value, group: groupOf(list, chosen) })),
    }
  }, [all, chosen])

  const allPairs = useMemo(
    () =>
      (plan?.regions ?? [])
        .flatMap((r) => r.pairs)
        .filter((p, i, list) => list.findIndex((q) => pairKey(q) === pairKey(p)) === i),
    [plan],
  )
  // Every neutralization the sweep's markets offer between them, under BRAIN's own labels
  // where the source market knows them. A sweep spans regions, so one that only exists
  // elsewhere keeps its bare name rather than being dropped.
  const labelled = useScopeOptions({
    instrumentType: 'EQUITY',
    region: String(plan?.settings.region ?? DEFAULT_SCOPE.region),
    delay: Number(plan?.settings.delay ?? DEFAULT_SCOPE.delay),
    universe: String(plan?.settings.universe ?? DEFAULT_SCOPE.universe),
  }).neutralizations
  const allNeutralizations = useMemo(() => {
    const names = [...new Set((plan?.regions ?? []).flatMap((r) => r.neutralizations))]
    const labels = new Map(labelled.map((c) => [c.value, c.label]))
    // BRAIN's order where it has one, so the two families read the same as everywhere else.
    const rank = (v: string) => {
      const at = labelled.findIndex((c) => c.value === v)
      return at === -1 ? labelled.length : at
    }
    return names
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
      .map((value) => ({ value, label: neutralizationLabel(value, labels.get(value)) }))
  }, [plan, labelled])

  // The header's own query, so both read one cache. What is already queued will spend first.
  const bar = useQuery({ queryKey: ['bar'], queryFn: () => today.bar() })
  const quota = bar.data?.simulations
  const left = quota ? Math.max(0, quota.remaining - quota.queued) : null
  const overQuota = left !== null && simulations > left
  const leftLabel = quota
    ? `${quota.exact ? '' : '~'}${fmt.int(left)} left today${quota.queued ? ' after queued work' : ''}`
    : undefined

  const add = useAddTask(() =>
    settingsSampler.addTask({
      ...(source ?? { alphaId: '' }),
      ...holding,
      markets: picks,
      marketNeutralOnly,
      neutralizations,
      pairs: allPairs.filter((p) => pairs.includes(pairKey(p))),
      cores,
    }),
  )

  const analyse = (event: React.FormEvent) => {
    event.preventDefault()
    if (mode === 'expression') {
      setTyped({ expression: expression.trim() })
      return
    }
    const next = draft.trim()
    void navigate({
      to: '/tools/settings-sampler',
      search: { alpha: next || undefined },
      replace: true,
    })
  }

  return (
    <Page>
      <PageHeader
        title="Settings Sampler"
        description="Run an expression everywhere BRAIN accepts it"
        actions={<AddTaskButtons add={add} disabled={simulations === 0} />}
      />

      <Panel
        title="Source"
        actions={<Segmented label="Source" items={MODES} value={mode} onChange={setMode} />}
      >
        {mode === 'alpha' ? (
          <form onSubmit={analyse} className="flex flex-wrap items-end gap-3">
            <Field label="Alpha ID" className="min-w-48 flex-1">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="num"
              />
            </Field>
            <Button type="submit" variant="primary" disabled={!draft.trim()}>
              Analyse
            </Button>
          </form>
        ) : (
          <form onSubmit={analyse} className="flex flex-col gap-3">
            <Field label="Alpha Expression">
              <Textarea
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                spellCheck={false}
                rows={6}
                className="num"
              />
            </Field>
            <div className="flex flex-wrap items-end gap-3">
              <Button type="submit" variant="primary" disabled={!expression.trim()}>
                Analyse
              </Button>
            </div>
          </form>
        )}

        {plan?.expression && (
          <div className="mt-4 flex flex-col gap-4 border-t border-hairline pt-4">
            <AstInspector expression={plan.expression} />

            <section className="flex flex-col gap-2">
              <h3 className="text-body-compact font-medium tracking-wide text-ink-muted uppercase">
                Data Fields
              </h3>
              <div className="flex flex-wrap gap-2">
                {plan.dataFields.length + plan.groupingFields.length === 0 ? (
                  <span className="text-body-compact text-ink-subtle">{DASH}</span>
                ) : (
                  <>
                    {plan.dataFields.map((field) => (
                      <span
                        key={field}
                        className="num rounded-md border border-hairline-strong bg-surface-2 px-2.5 py-1.5 text-body-compact text-ink"
                      >
                        {field}
                      </span>
                    ))}
                    {/* Read and required in every market, though BRAIN counts none as data. */}
                    {plan.groupingFields.map((field) => (
                      <span
                        key={field}
                        title="Grouping field: must exist where it runs, but BRAIN does not count it as a data field"
                        className="flex items-baseline gap-1.5 rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 text-body-compact"
                      >
                        <span className="num text-ink">{field}</span>
                        <span className="text-ink-subtle">grouping</span>
                      </span>
                    ))}
                  </>
                )}
              </div>
            </section>
          </div>
        )}
      </Panel>

      {plan?.expression && (
        <Panel
          title="Simulation Settings"
          description={
            plan.alphaId
              ? 'Read from the Alpha, and yours to change. Every market in the sweep runs at these.'
              : 'Every market in the sweep runs at these.'
          }
        >
          <SimulationSettingsFields
            decay={decay}
            setDecay={setDecay}
            truncation={truncation}
            setTruncation={setTruncation}
            nanHandling={nanHandling}
            setNanHandling={setNanHandling}
            testYears={testYears}
            setTestYears={setTestYears}
            testMonths={testMonths}
            setTestMonths={setTestMonths}
          />
        </Panel>
      )}

      {query.isError && <ErrorNotice error={query.error} title="Could not read that Alpha" />}
      {plan?.problems.map((problem) => (
        <Notice key={problem} tone="error" title="Cannot run this Alpha elsewhere">
          {problem}
        </Notice>
      ))}
      {plan?.warnings.map((warning) => (
        <Notice key={warning} tone="warn">
          {warning}
        </Notice>
      ))}

      {query.isPending && source ? (
        <Skeleton className="h-96" />
      ) : plan && branches.length > 0 ? (
        <Panel
          title="Search Space"
          actions={
            <Fieldset legend="Cores">
              <Segmented
                label="Cores"
                items={Array.from({ length: plan.maxCores }, (_, i) => ({
                  value: i + 1,
                  label: i + 1,
                }))}
                value={cores}
                onChange={setCores}
              />
            </Fieldset>
          }
        >
          <div className="flex flex-col gap-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Metric
                boxed
                label="Simulations"
                value={
                  <span>
                    {fmt.int(simulations)}
                    <span className="text-ink-subtle"> / {fmt.int(whole)}</span>
                  </span>
                }
                tone={overQuota ? 'warn' : 'neutral'}
              />
              <Metric boxed label="Markets" value={fmt.int(markets)} />
              <Metric
                boxed
                label="Batches"
                value={fmt.int(batches)}
                // Batches are fixed by the work; cores decide how many run at once.
                hint={
                  batches
                    ? `${cores} at a time \u2248 ${fmt.int(Math.ceil(batches / cores))} rounds`
                    : ''
                }
              />
            </div>

            {overQuota && (
              <Notice tone="warn" title="This sweep needs more than today has left">
                {fmt.int(simulations)} simulations against {leftLabel}. The rest waits in the queue
                and starts once BRAIN resets the quota.
              </Notice>
            )}

            <div className="flex flex-col gap-3">
              <Fieldset
                legend={
                  // Region, Delay and Universe are views of one set of markets, so one pair
                  // serves all three rows.
                  <span className="flex items-center justify-between gap-3">
                    Region
                    <span className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => change(all.map(marketKey), true)}
                      >
                        All
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => change(all.map(marketKey), false)}
                      >
                        Clear
                      </Button>
                    </span>
                  </span>
                }
              >
                <div className="flex flex-wrap gap-1.5">
                  {axes.regions.map((axis) => (
                    <GroupChip
                      key={axis.value}
                      label={axis.value}
                      group={axis.group}
                      onChange={change}
                      title={axis.value === REGION_AGNOSTIC ? REGION_AGNOSTIC_NOTE : undefined}
                    />
                  ))}
                </div>
              </Fieldset>
              <Fieldset legend="Delay">
                <div className="flex flex-wrap gap-1.5">
                  {axes.delays.map((axis) => (
                    <GroupChip
                      key={axis.value}
                      label={`D${axis.value}`}
                      group={axis.group}
                      onChange={change}
                    />
                  ))}
                </div>
              </Fieldset>
              <Fieldset legend="Universe">
                <div className="flex flex-wrap gap-1.5">
                  {axes.universes.map((axis) => (
                    <GroupChip
                      key={axis.value}
                      label={axis.value}
                      group={axis.group}
                      onChange={change}
                    />
                  ))}
                </div>
              </Fieldset>
              <NeutralizationPicker
                available={allNeutralizations}
                value={neutralizations}
                onChange={setNeutralizations}
                hint={
                  neutralizations.length === 0 ? 'Choose at least one Neutralization.' : undefined
                }
              />
              {/* A chip, like every other choice in this column, rather than a checkbox
                  that would be the only one of its kind here. It sits between the two pickers
                  because it is a rule about their combination, not about either one: NONE
                  neutralization is fine with an investability constraint, and no constraint is
                  fine with a neutralization. */}
              <Chips
                label="Market-Neutral"
                value={marketNeutralOnly ? ['on'] : []}
                onChange={(next) => setMarketNeutralOnly(next.includes('on'))}
                items={[
                  {
                    value: 'on',
                    label: 'Market-Neutral',
                    title:
                      'Skips NONE Neutralization with no Max Trade and no Max Position.' +
                      (unhedged > 0
                        ? ` Skipping ${fmt.int(unhedged)} Simulation${unhedged === 1 ? '' : 's'}.`
                        : ''),
                  },
                ]}
              />
              <Fieldset legend="Investability">
                <div className="flex flex-wrap gap-1.5">
                  {allPairs.map((pair) => (
                    <GroupChip
                      key={pairKey(pair)}
                      label={pairLabel(pair)}
                      group={{ keys: [pairKey(pair)], on: pairs.includes(pairKey(pair)) ? 1 : 0 }}
                      onChange={(keys, on) =>
                        setPairs((prev) =>
                          on ? [...prev, ...keys] : prev.filter((k) => !keys.includes(k)),
                        )
                      }
                    />
                  ))}
                </div>
              </Fieldset>
            </div>

            <div className="flex flex-col gap-2 border-t border-hairline pt-4">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-body-compact font-medium tracking-wide text-ink-muted uppercase">
                  By market
                </h3>
                <Button size="sm" variant="ghost" onClick={() => reset(plan)}>
                  Reset to Defaults
                </Button>
              </div>
              <Tree branches={branches} onChange={change} />
            </div>
          </div>
        </Panel>
      ) : source && plan ? (
        <Panel>
          <Empty title="Nowhere to run it">
            No downloaded market holds every data field this expression reads.
          </Empty>
        </Panel>
      ) : (
        <Panel>
          <Empty title="Start with an Expression">
            Paste an Alpha Expression above, or switch to Alpha ID to run an existing Alpha with its
            own Settings.
          </Empty>
        </Panel>
      )}
    </Page>
  )
}
