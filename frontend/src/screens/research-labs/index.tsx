/** Research Labs hub. */

import { Link } from '@tanstack/react-router'
import {
  ArrowUpRightIcon,
  BlocksIcon,
  BracesIcon,
  DnaIcon,
  GlobeIcon,
  LayersIcon,
  type LucideIcon,
  SearchIcon,
  ZapIcon,
} from 'lucide-react'
import { useLabMode } from '@/lib/lab-mode'
import { LAB_TABS } from '@/shell/nav'
import { Page, PageHeader } from '@/ui/kit'

const ICONS: Record<(typeof LAB_TABS)[number]['tab'], LucideIcon> = {
  search: SearchIcon,
  'template-blocks': BlocksIcon,
  'template-expression': BracesIcon,
  'region-agnostic': GlobeIcon,
  'super-alpha': LayersIcon,
}

/** What each one searches, since a name alone does not say which to start with. */
const ABOUT: Record<(typeof LAB_TABS)[number]['tab'], string> = {
  search: 'Writes one- and two-operator Alphas from the datasets you pick, steering to Sharpe.',
  'template-blocks': 'Build and search Alpha templates with the legacy block builder.',
  'template-expression': 'Build and search Alpha templates with a Fast Expression.',
  'region-agnostic':
    'Build an ARC Alpha from shared fields, then follow its separate simulation in each selected region.',
  'super-alpha': "Combines your submitted Alphas into SuperAlphas that pass BRAIN's checks.",
}

/** The card a hub screen links each of its entries with; the `Link` carries it. */
export const HUB_CARD =
  'panel-highlight group flex min-h-56 flex-col justify-between rounded-lg border border-hairline bg-surface-1 p-6 transition-colors hover:border-hairline-strong hover:bg-surface-2'

export function HubCardBody({
  icon: Icon,
  index,
  label,
  about,
}: {
  icon: LucideIcon
  index: number
  label: string
  about?: string
}) {
  return (
    <>
      <div className="flex items-start justify-between">
        <span className="flex size-12 items-center justify-center rounded-md border border-hairline-strong bg-surface-2 text-ink-muted transition-colors group-hover:border-primary group-hover:text-primary">
          <Icon className="size-6" aria-hidden />
        </span>
        <ArrowUpRightIcon
          className="size-5 text-ink-tertiary transition-colors group-hover:text-ink"
          aria-hidden
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="num text-body-compact text-ink-subtle">
          {String(index + 1).padStart(2, '0')}
        </span>
        <h2 className="text-headline font-semibold text-balance text-ink">{label}</h2>
        {about && <p className="max-w-prose text-body text-pretty text-ink-subtle">{about}</p>}
      </div>
    </>
  )
}

export function ResearchLabsScreen() {
  const powerPool = useLabMode((s) => s.powerPool)
  const setPowerPool = useLabMode((s) => s.setPowerPool)
  const ordinaryLabs = LAB_TABS.filter(
    (lab) => lab.tab !== 'template-blocks' && lab.tab !== 'template-expression',
  )

  return (
    <Page>
      <PageHeader title="Research Labs" />
      <div className="grid gap-3 sm:grid-cols-2">
        <ModeCard
          powerPool={powerPool}
          setPowerPool={setPowerPool}
          icon={DnaIcon}
          label="Evolution Lab"
          powerPoolTo="/labs/evolution"
          generalTo="/labs/evolution-general"
        />
        <ModeCard
          powerPool={powerPool}
          setPowerPool={setPowerPool}
          icon={ZapIcon}
          label="LLM Alpha Lab"
          powerPoolTo="/labs/power-pool"
          generalTo="/labs/regular-alpha"
        />
        <TemplateChoiceCard />
        {ordinaryLabs.map((lab, index) => (
          <Link key={lab.tab} to={lab.to} className={HUB_CARD}>
            <HubCardBody
              icon={ICONS[lab.tab]}
              index={index + 5}
              label={lab.label}
              about={ABOUT[lab.tab]}
            />
          </Link>
        ))}
      </div>
    </Page>
  )
}

function TemplateChoiceCard() {
  return (
    <section className="overflow-hidden rounded-lg border border-hairline bg-surface-1">
      <header className="flex min-h-24 items-center gap-4 border-b border-hairline px-5 py-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-md border border-hairline-strong bg-surface-2 text-ink-muted">
          <BracesIcon className="size-5" aria-hidden />
        </span>
        <h2 className="text-headline font-semibold text-ink">Template Lab</h2>
      </header>
      <div className="grid grid-cols-2 divide-x divide-hairline">
        <Link
          to="/labs/template/basic"
          className="flex min-h-32 items-center justify-center px-5 py-4 text-center transition-colors hover:bg-surface-2"
        >
          <span className="text-headline font-semibold text-ink">Build with Blocks (Legacy)</span>
        </Link>
        <Link
          to="/labs/template"
          className="flex min-h-32 items-center justify-center px-5 py-4 text-center transition-colors hover:bg-surface-2"
        >
          <span className="text-headline font-semibold text-ink">Build with Expression</span>
        </Link>
      </div>
    </section>
  )
}

function ModeCard({
  powerPool,
  setPowerPool,
  icon: Icon,
  label,
  powerPoolTo,
  generalTo,
}: {
  powerPool: boolean
  setPowerPool: (powerPool: boolean) => void
  icon: LucideIcon
  label: string
  powerPoolTo: '/labs/evolution' | '/labs/power-pool'
  generalTo: '/labs/evolution-general' | '/labs/regular-alpha'
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-hairline bg-surface-1">
      <header className="flex min-h-24 items-center gap-4 border-b border-hairline px-5 py-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-md border border-hairline-strong bg-surface-2 text-ink-muted">
          <Icon className="size-5" aria-hidden />
        </span>
        <h2 className="text-headline font-semibold text-ink">{label}</h2>
      </header>
      <div className="grid grid-cols-2 divide-x divide-hairline">
        <Link
          to={powerPoolTo}
          onClick={() => setPowerPool(true)}
          aria-current={powerPool ? 'page' : undefined}
          className={`flex min-h-32 items-center justify-center px-5 py-4 text-center transition-colors hover:bg-surface-2 ${powerPool ? 'bg-surface-2' : 'opacity-55 grayscale'}`}
        >
          <span className="text-headline font-semibold text-ink">Power Pool</span>
        </Link>
        <Link
          to={generalTo}
          onClick={() => setPowerPool(false)}
          aria-current={!powerPool ? 'page' : undefined}
          className={`flex min-h-32 items-center justify-center px-5 py-4 text-center transition-colors hover:bg-surface-2 ${!powerPool ? 'bg-surface-2' : 'opacity-55 grayscale'}`}
        >
          <span className="text-headline font-semibold text-ink">Regular</span>
        </Link>
      </div>
    </section>
  )
}
