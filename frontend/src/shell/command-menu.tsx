/**
 * ⌘K: jump to any screen, sub-tab or lab. cmdk owns filtering, ranking and keyboard
 * navigation; a Base UI dialog owns focus trap and dismissal. Styled with tokens only.
 */

import { Dialog as BDialog } from '@base-ui/react/dialog'
import { useRouter } from '@tanstack/react-router'
import { Command } from 'cmdk'
import { SearchIcon } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { BACKDROP } from '@/ui/overlay'
import { NAV } from './nav'
import { useSettings } from './settings'

export const useCommandMenu = create<{
  open: boolean
  setOpen: (open: boolean) => void
}>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

/** Somewhere to go, or, for what floats over the page rather than replacing it, something to open. */
interface Destination {
  label: string
  href?: string
  run?: () => void
}

export function CommandMenu() {
  const { open, setOpen } = useCommandMenu()
  const router = useRouter()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(!useCommandMenu.getState().open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen])

  const groups = useMemo<[string, Destination[]][]>(
    () => [
      [
        'Quick Actions',
        [
          // A typed apostrophe is U+0027, so the typographic one would never match.
          { label: "Dispatch Today's Simulations", href: '/dashboard' },
          { label: 'View Live Simulation Matrix', href: '/matrix' },
          { label: 'Browse Submittable Alphas', href: '/pool/submittable' },
          { label: 'Sync Data Fields with BRAIN', href: '/pyramids' },
          { label: 'Ask AI Assistant', href: '/ai/assistant' },
          { label: 'Explore Data Catalog', href: '/data' },
          { label: 'Open Settings', run: () => useSettings.getState().setOpen(true) },
        ],
      ],
      [
        'Screens & Labs',
        NAV.flatMap((item) => [
          { label: item.label, href: item.to },
          ...('tabs' in item ? item.tabs : []).map((t) => ({
            label: `${item.label} · ${t.label}`,
            href: `${item.to}/${t.tab}`,
          })),
        ]),
      ],
    ],
    [],
  )

  const go = (destination: Destination) => {
    setOpen(false)
    if (destination.run) destination.run()
    else if (destination.href) void router.navigate({ href: destination.href })
  }

  return (
    <BDialog.Root open={open} onOpenChange={(next) => setOpen(next)}>
      <BDialog.Portal>
        <BDialog.Backdrop className={BACKDROP} />
        <BDialog.Popup className="fixed top-[15vh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-lg border border-hairline-strong bg-surface-3 shadow-float outline-none">
          <BDialog.Title className="sr-only">Go to</BDialog.Title>
          <Command
            label="Go to a screen or lab"
            loop
            className="flex flex-col [&_[cmdk-group-heading]]:eyebrow [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1"
          >
            <div className="flex items-center gap-2 border-b border-hairline px-3 transition-colors focus-within:border-ink-subtle">
              <SearchIcon className="size-4 shrink-0 text-ink-subtle" aria-hidden />
              <Command.Input
                autoFocus
                placeholder="Go to a screen or lab…"
                className="h-11 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-subtle"
              />
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-body text-ink-subtle">
                No destination matches.
              </Command.Empty>
              {groups.map(
                ([heading, destinations]) =>
                  destinations.length > 0 && (
                    <Command.Group key={heading} heading={heading}>
                      {destinations.map((destination) => (
                        <Command.Item
                          key={destination.href ?? destination.label}
                          // Unique across groups: cmdk selects by value, and a screen offered as
                          // both a quick action and a destination lit up twice.
                          value={destination.label}
                          keywords={destination.href ? [destination.href] : []}
                          onSelect={() => go(destination)}
                          className="flex h-8 cursor-default items-center rounded-sm px-2 text-body text-ink-muted select-none data-[selected=true]:bg-surface-4 data-[selected=true]:text-ink"
                        >
                          <span className="truncate">{destination.label}</span>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  ),
              )}
            </Command.List>
          </Command>
        </BDialog.Popup>
      </BDialog.Portal>
    </BDialog.Root>
  )
}
