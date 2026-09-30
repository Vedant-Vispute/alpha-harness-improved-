/** Syncing alphas from BRAIN, and the counts and background progress that go with it. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCwIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { tasks } from '@/api/core'
import { cn } from '@/lib/cn'
import { fmt } from '@/lib/format'
import { useLive } from '@/lib/live'
import { useRefetchOn } from '@/lib/ws'
import { STAT } from '@/screens/data/state'
import { pool } from '@/screens/pool/api'
import { Button, ErrorNotice, Metric, Notice, Progress, Skeleton } from '@/ui/kit'
import { Confirm } from '@/ui/overlay'

/** The page's one action: import the alphas created since the last sync, reading only the alpha list. */
export function SyncAlphasButton() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const sync = useMutation({
    mutationFn: pool.sync,
    onSuccess: (r) => {
      toast.success(
        r.since
          ? `Syncing Alphas created since ${fmt.date(r.since)} from BRAIN`
          : 'Syncing every Alpha from BRAIN',
      )
      void queryClient.invalidateQueries({ queryKey: ['pool'] })
    },
    onSettled: () => setOpen(false),
  })

  return (
    <>
      <Button variant="primary" loading={sync.isPending} onClick={() => setOpen(true)}>
        {!sync.isPending && <RefreshCwIcon />}
        Sync from BRAIN
      </Button>
      <Confirm
        open={open}
        onOpenChange={setOpen}
        title="Sync Alphas from BRAIN?"
        confirmLabel="Sync"
        pending={sync.isPending}
        onConfirm={() => sync.mutate()}
      >
        Imports the Alphas created since the last sync, reading only the Alpha list. Runs in the
        background and spends no simulations.
      </Confirm>
    </>
  )
}

/** Your alpha counts on BRAIN, the last sync's error, and any import still running. */
export function AlphaCounts() {
  const overview = useQuery({
    queryKey: ['pool', 'overview'],
    queryFn: pool.overview,
  })
  const brain = useQuery({
    queryKey: ['pool', 'brain-summary'],
    queryFn: pool.summary,
    staleTime: 5 * 60_000,
  })
  const liveTasks = useLive((s) => s.tasks)
  const polled = useQuery({
    queryKey: ['background-tasks'],
    queryFn: tasks.list,
    enabled: liveTasks == null,
    refetchInterval: 5000,
  })
  useRefetchOn('tasks', ['pool', 'overview'], 3000)

  const last = overview.data?.lastSync
  const running = ((liveTasks ?? polled.data)?.tasks ?? []).filter(
    (t) => t.state === 'running' || t.state === 'failed',
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {brain.data ? (
          <>
            <Metric boxed label="Unsubmitted" value={fmt.int(brain.data['unsubmitted'] ?? 0)} />
            {/* BRAIN's Submitted tab: every alpha that went live, whether still active or since decommissioned. */}
            <Metric
              boxed
              label="Submitted"
              value={fmt.int((brain.data['active'] ?? 0) + (brain.data['decommissioned'] ?? 0))}
            />
          </>
        ) : (
          !brain.isError && [0, 1].map((i) => <Skeleton key={i} className="h-16" />)
        )}
      </div>

      {brain.isError && (
        <ErrorNotice error={brain.error} title="Could not read your Alpha counts from BRAIN" />
      )}
      {overview.isError && (
        <ErrorNotice error={overview.error} title="Could not read the last sync" />
      )}
      {last?.error && <Notice tone="error">{last.error}</Notice>}

      {running.length > 0 && (
        <div className="flex flex-col gap-3">
          {running.map((t) => (
            <div key={t.id} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-body-compact">
                <span className="min-w-0 text-ink">{t.label}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={
                      t.state === 'failed'
                        ? 'min-w-0 break-words text-pnl-negative'
                        : 'min-w-0 text-ink-subtle'
                    }
                  >
                    {t.state === 'failed' ? t.error : t.detail}
                  </span>
                  {/* Elapsed time, boxed like the Simulation Matrix's batch timers. */}
                  <span className={cn(STAT, 'num shrink-0 text-ink')}>
                    {fmt.duration(t.elapsedSeconds)}
                  </span>
                </span>
              </div>
              <Progress value={t.progress} label={t.label} />
            </div>
          ))}
        </div>
      )}
      {polled.isError && liveTasks == null && (
        <ErrorNotice error={polled.error} title="Could not read background tasks" />
      )}
    </div>
  )
}
