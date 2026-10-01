/** Sync: download every market's Data Fields from BRAIN, region-agnostic ones included. */

import { useNavigate } from '@tanstack/react-router'
import type { Scope } from '@/api/types'
import { useScope } from '@/lib/scope'
import { Page, PageHeader } from '@/ui/kit'
import { RegionAgnosticHero, SyncHero } from './sync-matrix'

export function SyncScreen() {
  const navigate = useNavigate()
  const [scope, update] = useScope('data')
  // A market picked here opens in the Data Explorer.
  const open = (change: Partial<Scope>) => {
    update(change)
    void navigate({ to: '/data' })
  }
  return (
    <Page>
      <PageHeader title="Sync" description="Download Data Fields from BRAIN" />
      <SyncHero scope={scope} onPick={open} />
      <RegionAgnosticHero scope={scope} onPick={open} />
    </Page>
  )
}
