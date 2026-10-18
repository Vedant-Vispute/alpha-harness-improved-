/** Entry points reserved for the general lab workflows. */

import { ConstructionIcon } from 'lucide-react'
import { Page, PageHeader, Panel } from '@/ui/kit'

function GeneralLabPlaceholder({ title }: { title: string }) {
  return (
    <Page>
      <PageHeader title={title} />
      <Panel title="General mode">
        <div className="flex items-start gap-3 text-body text-ink-subtle">
          <ConstructionIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p>This general lab is reserved for a future workflow.</p>
        </div>
      </Panel>
    </Page>
  )
}

export function GeneralEvolutionLabScreen() {
  return <GeneralLabPlaceholder title="Evolution Lab" />
}
