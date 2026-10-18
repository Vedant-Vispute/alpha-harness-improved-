/**
 * Navigation: the six areas, a live count of submittable Alphas, and the account menu.
 * Collapses to icons below `lg`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import {
  BookOpenIcon,
  ChevronsUpDownIcon,
  ExternalLinkIcon,
  LogOutIcon,
  PanelLeftIcon,
  PowerIcon,
  SettingsIcon,
} from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { auth } from '@/api/core'
import type { Today } from '@/api/types'
import { cn } from '@/lib/cn'
import { useRefetchOn } from '@/lib/ws'
import { pool } from '@/screens/pool/api'
import { Button, Kbd } from '@/ui/kit'
import { Confirm, Dialog, Menu, Tooltip } from '@/ui/overlay'
import { NAV } from './nav'
import { SETTINGS_SHORTCUT, useSettings } from './settings'
import { UpdateBadge, useQuitApp, useUpdateStatus, VersionBadge } from './update'

/** Areas a new consultant has to open once: Data (download fields) and AI (add a key). They flash until visited. */
const ONBOARDING: readonly string[] = ['data', 'ai']

const useVisited = create<{
  visited: string[]
  visit: (area: string) => void
}>()(
  persist(
    (set) => ({
      visited: [],
      visit: (area) =>
        set((s) => (s.visited.includes(area) ? s : { visited: [...s.visited, area] })),
    }),
    { name: 'alpha-harness-onboarding' },
  ),
)

/** Pending close of a peek, so crossing from the button onto the panel does not flicker it shut. */
let closing: ReturnType<typeof setTimeout> | undefined
const PEEK_CLOSE_MS = 200

/** The docked sidebar's width until it is first measured. */
export const SIDEBAR_WIDTH = 248

/**
 * Whether the sidebar is hidden altogether, rail included, and the width it docks at, both kept
 * across reloads; and whether a hidden one is peeking out under the pointer, which is not. The
 * peek is drawn at the docked width, so showing it moves nothing but the page beside it.
 */
export const useSidebarHidden = create<{
  hidden: boolean
  peek: boolean
  width: number
  setWidth: (width: number) => void
  toggle: () => void
  openPeek: () => void
  closePeek: () => void
}>()(
  persist(
    (set) => ({
      hidden: false,
      peek: false,
      width: SIDEBAR_WIDTH,
      setWidth: (width) => set({ width }),
      toggle: () => {
        clearTimeout(closing)
        set((s) => ({ hidden: !s.hidden, peek: false }))
      },
      openPeek: () => {
        clearTimeout(closing)
        set((s) => (s.hidden ? { peek: true } : s))
      },
      closePeek: () => {
        clearTimeout(closing)
        closing = setTimeout(() => set({ peek: false }), PEEK_CLOSE_MS)
      },
    }),
    { name: 'alpha-harness-sidebar', partialize: (s) => ({ hidden: s.hidden, width: s.width }) },
  ),
)

/** The shortcut as this keyboard writes it: most consultants are on Windows, not a Mac. */
export const SIDEBAR_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘B' : 'Ctrl+B'

/** Shows or hides the sidebar. Lives in the header, so it stays put whichever it is. */
export function SidebarToggle() {
  const hidden = useSidebarHidden((s) => s.hidden)
  const toggle = useSidebarHidden((s) => s.toggle)
  const openPeek = useSidebarHidden((s) => s.openPeek)
  const closePeek = useSidebarHidden((s) => s.closePeek)
  const label = hidden ? 'Show sidebar' : 'Hide sidebar'
  return (
    <Tooltip
      content={
        <span className="flex items-center gap-2">
          {label} <Kbd>{SIDEBAR_SHORTCUT}</Kbd>
        </span>
      }
    >
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={label}
        aria-expanded={!hidden}
        onClick={toggle}
        // Hovered while hidden, the sidebar peeks out over the page; a click pins it.
        onMouseEnter={openPeek}
        onMouseLeave={closePeek}
      >
        <PanelLeftIcon />
      </Button>
    </Tooltip>
  )
}

export function Sidebar({
  you,
  collapsed,
  onMouseEnter,
  onMouseLeave,
}: {
  you: Today['you']
  collapsed: boolean
  /** For a hidden sidebar peeking out, which stays open while the pointer is over it. */
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}) {
  const queryClient = useQueryClient()
  const area = useRouterState({
    select: (s) => s.location.pathname.split('/')[1] ?? '',
  })
  const visited = useVisited((s) => s.visited)
  const visit = useVisited((s) => s.visit)
  // Reaching the area any way counts (sidebar, ⌘K or a link), so the flash never outlives the visit.
  useEffect(() => {
    if (ONBOARDING.includes(area)) visit(area)
  }, [area, visit])
  const submittable = useQuery(pool.everywhere)
  useRefetchOn('simulations', pool.everywhere.queryKey, 5000)
  const total = submittable.data?.total ?? 0

  const [quitting, setQuitting] = useState(false)
  const [tutorialOpen, setTutorialOpen] = useState(false)
  const quit = useQuitApp()
  const launched = useUpdateStatus().data?.launcher != null

  const signOut = useMutation({
    mutationFn: () => auth.logout(),
    onSuccess: async () => {
      // Dropped, not invalidated: invalidating would refetch every mounted screen against a
      // dead session, and leave the last account's data in the cache behind the sign-in screen.
      // Today is kept and refetched: the shell observes it, and clearing it would leave the
      // shell watching a query nothing refetches, so the workspace stayed on screen.
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'today' })
      await queryClient.refetchQueries({ queryKey: ['today'] })
    },
  })

  const name = you.fullName ?? you.userId ?? 'Signed in'
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return (
    // A step up from the canvas, so the sidebar reads as its own column without a rule inside it.
    <aside
      className="flex h-full min-h-0 flex-col border-r border-hairline bg-surface-1"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <nav
        aria-label="Main"
        className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pt-2 pb-3"
      >
        {NAV.map((item, i) => (
          <Fragment key={item.to}>
            {item.group &&
              item.group !== NAV[i - 1]?.group &&
              // A heading on the wide sidebar; on the rail, where it cannot fit, a rule.
              (collapsed ? (
                <hr className="mx-2 my-2 border-hairline" />
              ) : (
                <div className="px-2 pt-4 pb-1 text-caption font-medium text-ink-subtle">
                  {item.group}
                </div>
              ))}
            <Link
              to={item.to}
              title={item.label}
              {...(collapsed && { 'aria-label': item.label })}
              className={cn(
                'group flex h-8 items-center gap-3 rounded-md text-body text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink data-[status=active]:bg-surface-4 data-[status=active]:font-medium data-[status=active]:text-ink',
                collapsed ? 'justify-center' : 'px-2',
                ONBOARDING.includes(item.to.slice(1)) &&
                  !visited.includes(item.to.slice(1)) &&
                  'animate-attention text-status-warning motion-reduce:bg-status-warning-tint',
              )}
            >
              <item.icon className="size-4 shrink-0" aria-hidden />
              {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
              {!collapsed && item.to === '/pool' && total > 0 && (
                <span
                  className="num rounded-pill border border-pnl-positive-edge bg-pnl-positive-tint px-1.5 py-0.5 text-caption font-medium text-pnl-positive-text"
                  title="Submittable Alphas"
                >
                  {total}
                </span>
              )}
            </Link>
          </Fragment>
        ))}
        <Button
          variant="ghost"
          title="Tutorial"
          aria-label="Tutorial"
          onClick={() => setTutorialOpen(true)}
          className={cn(
            'h-8 justify-start gap-3 rounded-md text-body text-ink-muted hover:bg-surface-3 hover:text-ink',
            collapsed && 'justify-center px-0',
          )}
        >
          <BookOpenIcon className="size-4 shrink-0" aria-hidden />
          {!collapsed && <span className="truncate">Tutorial</span>}
        </Button>
      </nav>

      <div className="flex flex-col gap-1 border-t border-hairline p-2">
        {/* Both above the account, where someone reading a screenshot looks for them. The
            update stays on the rail as an icon — it is the one thing here worth interrupting
            for — while the version hides: 52px has no room for a date. */}
        <UpdateBadge collapsed={collapsed} />
        <BrowserMemoryUsage collapsed={collapsed} />
        {!collapsed && (
          <div className="px-1.5 pt-0.5 pb-1">
            <VersionBadge />
          </div>
        )}
        <Menu
          align="start"
          trigger={
            <button
              type="button"
              aria-label={`Account: ${name}`}
              className={cn(
                'flex h-11 w-full items-center gap-2.5 rounded-md text-left transition-colors hover:bg-surface-3 active:bg-surface-4 data-[popup-open]:bg-surface-4',
                collapsed ? 'justify-center' : 'px-1.5',
              )}
            >
              <span className="num flex size-7 shrink-0 items-center justify-center rounded-pill bg-surface-4 text-caption font-medium text-ink-muted">
                {initials}
              </span>
              {!collapsed && (
                <>
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate text-body font-medium text-ink">{name}</span>
                    <span className="truncate text-caption text-ink-subtle">
                      {you.email ?? you.userId}
                    </span>
                  </span>
                  {/* Says it opens, which a name and an address alone do not. */}
                  <ChevronsUpDownIcon className="size-4 shrink-0 text-ink-subtle" aria-hidden />
                </>
              )}
            </button>
          }
          items={[
            {
              label: 'Settings',
              icon: <SettingsIcon />,
              shortcut: SETTINGS_SHORTCUT,
              onClick: () => useSettings.getState().setOpen(true),
            },
            {
              label: 'Open the BRAIN Platform',
              icon: <ExternalLinkIcon />,
              onClick: () =>
                window.open(
                  'https://platform.worldquantbrain.com',
                  '_blank',
                  'noopener,noreferrer',
                ),
            },
            {
              label: 'Sign Out',
              icon: <LogOutIcon />,
              danger: true,
              disabled: signOut.isPending,
              onClick: () => signOut.mutate(),
            },
            // Only a launcher can bring the app back, so only a launched app offers to close.
            // On macOS and Linux this is the only way to close it: there is no tray icon.
            ...(launched
              ? [
                  {
                    label: 'Quit Alpha Harness',
                    icon: <PowerIcon />,
                    onClick: () => setQuitting(true),
                  },
                ]
              : []),
          ]}
        />
      </div>
      <Confirm
        open={quitting}
        onOpenChange={setQuitting}
        title="Quit Alpha Harness?"
        confirmLabel="Quit"
        pending={quit.isPending}
        onConfirm={() => quit.mutate()}
      >
        Simulations already on BRAIN keep running there. Queued work waits until you open Alpha
        Harness again.
      </Confirm>
      <Dialog
        open={tutorialOpen}
        onOpenChange={setTutorialOpen}
        title="Alpha Research Tutorial"
        description="A practical path from data and an idea to reviewed Alpha results."
        className="max-w-3xl"
      >
        <div className="flex flex-col gap-5 text-body text-ink-muted">
          <section className="flex flex-col gap-2">
            <h3 className="text-headline font-semibold text-ink">Before you start</h3>
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                Connect your WorldQuant BRAIN account in{' '}
                <Link className="text-primary" to="/sync" onClick={() => setTutorialOpen(false)}>
                  Sync
                </Link>
                , then sync the data and Alphas you need.
              </li>
              <li>
                For LLM workflows, add a provider and API key in{' '}
                <Link className="text-primary" to="/ai" onClick={() => setTutorialOpen(false)}>
                  LLM Integration
                </Link>
                . Choose or create instructions in{' '}
                <Link className="text-primary" to="/prompts" onClick={() => setTutorialOpen(false)}>
                  LLM Prompts
                </Link>
                .
              </li>
              <li>
                Use{' '}
                <Link className="text-primary" to="/data" onClick={() => setTutorialOpen(false)}>
                  Data Explorer
                </Link>{' '}
                to find datasets and fields for your region, delay, and universe.
              </li>
            </ol>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-headline font-semibold text-ink">Build and test an Alpha</h3>
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                Open{' '}
                <Link className="text-primary" to="/labs" onClick={() => setTutorialOpen(false)}>
                  Research Labs
                </Link>
                . Start with Search Lab to generate expressions from selected fields, Build with
                Expression or Build with Blocks to define a template, or LLM Alpha Lab to have a
                selected prompt generate expressions.
              </li>
              <li>
                Set the market scope and simulation settings. Review the planned simulations and
                available fields before running.
              </li>
              <li>
                Choose <em>Add to Tasks</em> to queue work or <em>Run Now</em> to start immediately.
                Follow progress in{' '}
                <Link className="text-primary" to="/tasks" onClick={() => setTutorialOpen(false)}>
                  Tasks
                </Link>
                .
              </li>
              <li>
                Open completed results, inspect Alpha metrics and charts, then refine promising
                candidates with Settings Sampler or Correlation Breaker from{' '}
                <Link className="text-primary" to="/tools" onClick={() => setTutorialOpen(false)}>
                  Tools
                </Link>
                .
              </li>
            </ol>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-headline font-semibold text-ink">Build a SuperAlpha</h3>
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                First build, simulate, review, and submit individual Alphas on BRAIN. The Super
                Alpha Lab selects your submitted ACTIVE Alphas.
              </li>
              <li>
                Open{' '}
                <Link
                  className="text-primary"
                  to="/labs/super-alpha"
                  onClick={() => setTutorialOpen(false)}
                >
                  Super Alpha Lab
                </Link>
                , choose a single region, delay, universe, neutralization, selection limit,
                activation, and core count.
              </li>
              <li>
                Review the planned selections, combinations, and simulation count. Add the plan to
                Tasks or run it now.
              </li>
              <li>
                Review completed SuperAlpha checks in Tasks. Eligible results appear in the
                Submission Planner; submission itself is completed on BRAIN.
              </li>
            </ol>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-headline font-semibold text-ink">Build an ARC Alpha</h3>
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                Open the{' '}
                <Link
                  className="text-primary"
                  to="/labs/region-agnostic"
                  onClick={() => setTutorialOpen(false)}
                >
                  ARC Alpha Lab
                </Link>{' '}
                and choose fields from All Regions. Choose at least two regions where the fields
                have coverage.
              </li>
              <li>
                Choose delay, region universe size, model, prompt, cores, number of expressions, and
                any shared neutralizations. The harness groups each expression and schedules its
                regional simulations, with at most two running on BRAIN at once.
              </li>
              <li>Add the task to Tasks or run it now. Follow its progress in Tasks.</li>
              <li>
                In task results, click an expression, then choose <em>Run ARC simulation</em> to
                simulate it once in ALL. Follow its progress and open the completed ARC results.
                Click a region row to open that individual regional simulation.
              </li>
            </ol>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-headline font-semibold text-ink">Build a competition Alpha</h3>
            <p>
              Check the competition&apos;s rules, scope, and eligibility before submitting on BRAIN.
              Use{' '}
              <Link
                className="text-primary"
                to="/competitions"
                onClick={() => setTutorialOpen(false)}
              >
                Competitions
              </Link>{' '}
              to view competition information in the harness.
            </p>
          </section>

          <section className="flex flex-col gap-2 border-t border-hairline pt-3">
            <h3 className="text-headline font-semibold text-ink">Review and submit</h3>
            <p>
              Use{' '}
              <Link className="text-primary" to="/pool" onClick={() => setTutorialOpen(false)}>
                Alphas
              </Link>{' '}
              to review stored and submittable candidates. Use the Submission Planner to choose and
              order candidates, then complete submission on the BRAIN platform. Harness metrics and
              checks help you review candidates; BRAIN determines final submission status.
            </p>
          </section>
        </div>
      </Dialog>
    </aside>
  )
}

/** Chromium's non-standard heap estimate; browsers do not expose the tab hover-card figure. */
function BrowserMemoryUsage({ collapsed }: { collapsed: boolean }) {
  const [bytes, setBytes] = useState<number | null>(null)

  useEffect(() => {
    const read = () => {
      const memory = (
        performance as Performance & {
          memory?: { usedJSHeapSize: number }
        }
      ).memory
      setBytes(typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : null)
    }
    read()
    const timer = window.setInterval(read, 5000)
    return () => window.clearInterval(timer)
  }, [])

  const label =
    bytes == null
      ? 'Page memory unavailable in this browser'
      : `JS heap ${Math.round(bytes / 1024 / 1024)} MB`
  return (
    <Tooltip content={`${label}. Approximate JavaScript heap for this page, not total tab memory.`}>
      <div
        role="status"
        aria-label={label}
        className={cn(
          'flex min-h-8 items-center text-caption text-ink-subtle',
          collapsed ? 'justify-center px-0.5' : 'px-1.5',
        )}
      >
        <span className="num">
          {collapsed ? `M ${bytes == null ? '—' : `${Math.round(bytes / 1024 / 1024)}MB`}` : label}
        </span>
      </div>
    </Tooltip>
  )
}
