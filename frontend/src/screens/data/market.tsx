/** The filter: which market the tabs below show. Syncing lives in BRAIN › Sync. */

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { type CatalogScopeRow, catalog } from '@/api/catalog'
import { type Scope, scopeLabel } from '@/api/types'
import { fmt } from '@/lib/format'
import { ErrorNotice, LINK, Metric, Notice, Panel, Skeleton } from '@/ui/kit'
import { ScopePicker } from '@/ui/scope-picker'
import { sameScope } from './state'

const rowScope = (r: CatalogScopeRow): Scope => ({
  instrumentType: r.instrument_type,
  region: r.region,
  delay: r.delay,
  universe: r.universe,
})
export function MarketBar({
  scope,
  update,
}: {
  scope: Scope
  update: (change: Partial<Scope>) => void
}) {
  const scopes = useQuery({
    queryKey: ['catalog', 'scopes'],
    queryFn: catalog.scopes,
  })
  const counts = useQuery({
    queryKey: ['catalog', 'counts', scope],
    queryFn: () => catalog.counts(scope),
  })
  const local = scopes.data?.find((r) => sameScope(rowScope(r), scope))
  const synced = (counts.data?.fields ?? 0) > 0

  return (
    <Panel bodyClassName="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ScopePicker scope={scope} onChange={update} />
        {local && (
          <span className="text-body-compact text-ink-subtle">
            Synced {fmt.ago(local.synced_at)}
          </span>
        )}
      </div>

      {counts.isError ? (
        <ErrorNotice error={counts.error} title="Could not read the catalog" />
      ) : counts.isPending ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : synced ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(
            [
              ['Fields', counts.data.fields],
              ['Datasets', counts.data.datasets],
              ['Categories', counts.data.categories],
              ['Subcategories', counts.data.subcategories],
            ] as const
          ).map(([label, value]) => (
            <Metric key={label} boxed label={label} value={fmt.int(value)} />
          ))}
        </div>
      ) : (
        <Notice tone="warn" title={`${scopeLabel(scope)} is not synced yet`}>
          Open{' '}
          <Link to="/sync" className={LINK}>
            BRAIN › Sync
          </Link>{' '}
          to download every market.
        </Notice>
      )}
    </Panel>
  )
}
