/**
 * A dataset choice drawn as the catalog is: one chip per category, an indigo box per
 * subcategory inside it, and a pill per dataset. Used wherever a choice of datasets shows.
 */

import { useQuery } from '@tanstack/react-query'
import { XIcon } from 'lucide-react'
import { useMemo } from 'react'
import { catalog, type DatasetRow } from '@/api/catalog'
import type { Scope } from '@/api/types'
import { cn } from '@/lib/cn'
import { fmt } from '@/lib/format'
import { Skeleton } from '@/ui/kit'
import {
  buildTree,
  datasetNames,
  summarize,
  type Ticked,
  type TreeSource,
  type Trunk,
} from './dataset-tree'

type Remover = ((ids: string[]) => void) | undefined

const CATEGORY_BOX =
  'inline-flex min-h-9 max-w-full flex-wrap items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-2 p-1 text-body-compact'
const SUBCATEGORY_BOX =
  'inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-sm border border-primary/40 bg-primary-subtle p-1'

/** A market's dataset rows as the tree's source: every category and subcategory they name. */
function sourceOf(rows: DatasetRow[]): TreeSource {
  const categories = new Map<string, string | null>()
  const subcategories = new Map<string, string | null>()
  for (const r of rows) {
    if (r.category_id) categories.set(r.category_id, r.category_name)
    if (r.subcategory_id) subcategories.set(r.subcategory_id, r.subcategory_name)
  }
  return {
    categories: [...categories].map(([id, name]) => ({ id, name })),
    subcategories: [...subcategories].map(([id, name]) => ({ id, name })),
    datasets: rows.map((r) => ({
      id: r.dataset_id,
      category_id: r.category_id,
      subcategory_id: r.subcategory_id,
    })),
  }
}

/**
 * One market's tree and dataset names, from the same query the Data Explorer and the labs
 * read. Without a full market the tree is empty, and the chips fall back to plain pills.
 */
export function useDatasetTree(scope: Scope | null) {
  const rows = useQuery({
    queryKey: ['catalog', 'datasets', scope, ''],
    queryFn: () => (scope ? catalog.datasets(scope) : Promise.resolve([])),
    enabled: scope !== null,
  })
  // Until the rows arrive every choice would read as loose datasets, and a whole category
  // flashes open into hundreds of pills before it folds back into one chip.
  const ready = scope === null || !rows.isPending
  return useMemo(() => {
    const data = rows.data ?? []
    const names = datasetNames(data)
    return { tree: buildTree(sourceOf(data)), nameOf: (id: string) => names.get(id) ?? id, ready }
  }, [rows.data, ready])
}

/** Removable when given `onRemove`; read-only otherwise. */
export function DatasetChips({
  tree,
  value,
  nameOf,
  onRemove,
  ready = true,
}: {
  tree: Trunk[]
  value: string[]
  nameOf: (id: string) => string
  onRemove?: (ids: string[]) => void
  /** False while the tree loads: one chip's worth of placeholder, not a pill per dataset. */
  ready?: boolean
}) {
  if (!ready) return value.length > 0 ? <Skeleton className="h-9 w-40" /> : null
  const summary = summarize(tree, value, nameOf)
  if (summary.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {summary.map((trunk) =>
        // Three layers told apart by colour, not grey steps too close to see: a neutral
        // category, an indigo subcategory inside it, and lifted datasets. A whole
        // category or subcategory is its own box, removable as one.
        trunk.whole ? (
          <div key={trunk.key} className={CATEGORY_BOX}>
            <Whole pick={trunk.whole} onRemove={onRemove} />
          </div>
        ) : (
          <div key={trunk.key} className={CATEGORY_BOX}>
            {trunk.name && <Step name={trunk.name} />}
            {trunk.branches.map((branch) =>
              branch.whole ? (
                <span key={branch.key} className={SUBCATEGORY_BOX}>
                  <Whole pick={branch.whole} onRemove={onRemove} />
                </span>
              ) : branch.name ? (
                <span key={branch.key} className={SUBCATEGORY_BOX}>
                  <Step name={branch.name} />
                  {branch.datasets.map((d) => (
                    <Pick key={d.key} pick={d} onRemove={onRemove} />
                  ))}
                </span>
              ) : (
                branch.datasets.map((d) => <Pick key={d.key} pick={d} onRemove={onRemove} />)
              ),
            )}
          </div>
        ),
      )}
    </div>
  )
}

function Remove({ pick, onRemove }: { pick: Ticked; onRemove: (ids: string[]) => void }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${pick.name}`}
      className="shrink-0 rounded-xs p-0.5 text-ink-subtle transition-colors hover:text-ink"
      onClick={() => onRemove(pick.ids)}
    >
      <XIcon className="size-3.5" />
    </button>
  )
}

/** A whole category or subcategory, drawn as its own box: name, dataset count, remove. */
function Whole({ pick, onRemove }: { pick: Ticked; onRemove: Remover }) {
  return (
    <span
      title={pick.name}
      className="inline-flex h-7 max-w-full items-center gap-1.5 px-1.5 text-ink"
    >
      <span className="truncate">{pick.name}</span>
      <span className="num shrink-0 text-ink-subtle" title={`${fmt.int(pick.ids.length)} datasets`}>
        {fmt.int(pick.ids.length)}
      </span>
      {onRemove && <Remove pick={pick} onRemove={onRemove} />}
    </span>
  )
}

/** A level of the path shared by the picks after it: written once, muted. */
function Step({ name }: { name: string }) {
  return (
    <span className="flex items-center gap-1.5 pl-1.5 text-ink-muted">
      {name}
      <span className="text-ink-subtle" aria-hidden>
        &gt;
      </span>
    </span>
  )
}

/** One dataset. */
function Pick({ pick, onRemove }: { pick: Ticked; onRemove: Remover }) {
  return (
    <span
      title={pick.name}
      className={cn(
        'inline-flex h-7 max-w-full items-center gap-1.5 rounded-sm border border-hairline-strong bg-ink-tint pl-2.5 text-ink',
        onRemove ? 'pr-1' : 'pr-2.5',
      )}
    >
      <span className="truncate">{pick.name}</span>
      {onRemove && <Remove pick={pick} onRemove={onRemove} />}
    </span>
  )
}
