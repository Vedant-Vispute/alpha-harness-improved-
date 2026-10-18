/**
 * LLM Prompts: write system prompts, copy the built-ins, and edit them in place. Every edit
 * saves itself as it is typed, and a task using the prompt sends the new text on its next call.
 */

import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import {
  ChevronRightIcon,
  CopyIcon,
  PlusIcon,
  ScrollTextIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/http'
import { cn } from '@/lib/cn'
import { fmt } from '@/lib/format'
import {
  Button,
  Disclosure,
  Empty,
  ErrorNotice,
  Field,
  Input,
  KV,
  Notice,
  Page,
  PageHeader,
  Panel,
  Segmented,
  Skeleton,
  Textarea,
} from '@/ui/kit'
import { Confirm, Menu } from '@/ui/overlay'
import { SplitPane } from '@/ui/panels'
import {
  countText,
  LIBRARY_KEY,
  type LibraryPrompt,
  type NewPrompt,
  type PromptKind,
  type PromptLibrary,
  promptKey,
  prompts,
  usePromptLibrary,
} from './api'
import { diffCounts, diffWords } from './diff'

const TEXT =
  'num min-h-[50vh] resize-y text-body-compact leading-relaxed whitespace-pre-wrap text-ink'

/** Change one saved prompt in the cached library, so the list and every picker agree at once. */
function patchLibrary(queryClient: QueryClient, id: number, patch: Partial<LibraryPrompt>) {
  queryClient.setQueryData<PromptLibrary>(
    LIBRARY_KEY,
    (lib) =>
      lib && { ...lib, prompts: lib.prompts.map((p) => (p.id === id ? { ...p, ...patch } : p)) },
  )
}

/** The lab previews show the prompt's text; they are keyed by the request, not by it. */
const refreshPreviews = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: ['power-pool-lab', 'preview'] })

export function PromptsScreen() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { open } = useSearch({ from: '/prompts' })
  const library = usePromptLibrary()
  const all = library.data?.prompts ?? []
  const kinds = library.data?.kinds ?? []
  const current = all.find((p) => promptKey(p) === String(open)) ?? all[0]
  const [search, setSearch] = useState('')

  const select = useCallback(
    (key: string) =>
      void navigate({
        to: '/prompts',
        search: { open: /^\d+$/.test(key) ? Number(key) : key },
        replace: true,
      }),
    [navigate],
  )

  const create = useMutation({
    mutationFn: (body: NewPrompt) => prompts.create(body),
    onSuccess: (row) => {
      queryClient.setQueryData<PromptLibrary>(LIBRARY_KEY, (lib) => {
        if (!lib) return lib
        const builtIns = lib.prompts.filter((p) => p.builtIn)
        const saved = lib.prompts.filter((p) => !p.builtIn)
        return { ...lib, prompts: [...builtIns, row, ...saved] }
      })
      setSearch('')
      select(promptKey(row))
      toast.success(`Saved “${row.name}”`)
    },
  })

  return (
    <Page>
      <PageHeader
        title="LLM Prompts"
        description="Manage the instructions used by LLM Alpha Lab and the Assistant."
        actions={
          <Menu
            trigger={
              <Button variant="primary" loading={create.isPending} disabled={kinds.length === 0}>
                <PlusIcon />
                New Prompt
              </Button>
            }
            items={kinds.map((k) => ({
              label: `For ${k.label}`,
              onClick: () =>
                create.mutate({ name: `New ${k.label} prompt`, kind: k.slug, body: '' }),
            }))}
          />
        }
      />
      {library.isError && <ErrorNotice title="Could not load the prompts" error={library.error} />}
      {create.isError && <ErrorNotice title="Could not save the prompt" error={create.error} />}
      {!library.data ? (
        !library.isError && <Skeleton className="h-96" />
      ) : (
        <SplitPane id="llm-prompts" first={{ default: 360, min: 280, max: 500 }}>
          <Panel
            title="Prompt library"
            description="Choose a prompt to view or edit it."
            bodyClassName="p-3"
          >
            <PromptList
              kinds={kinds}
              prompts={all}
              current={current}
              search={search}
              onSearch={setSearch}
              onSelect={select}
            />
          </Panel>
          {current ? (
            <Editor
              key={promptKey(current)}
              prompt={current}
              kind={kinds.find((k) => k.slug === current.kind)}
              original={all.find((p) => p.builtIn && p.kind === current.kind)}
              copying={create.isPending}
              onCopy={(body) => create.mutate(body)}
              onDeleted={() => select(current.kind)}
            />
          ) : (
            <Panel>
              <Empty title="No prompts" icon={<ScrollTextIcon />} />
            </Panel>
          )}
        </SplitPane>
      )}
    </Page>
  )
}

function PromptList({
  kinds,
  prompts: all,
  current,
  search,
  onSearch,
  onSelect,
}: {
  kinds: PromptKind[]
  prompts: LibraryPrompt[]
  current: LibraryPrompt | undefined
  search: string
  onSearch: (value: string) => void
  onSelect: (key: string) => void
}) {
  const needle = search.trim().toLocaleLowerCase()
  const groups = kinds
    .map((kind) => ({
      kind,
      prompts: all.filter(
        (prompt) =>
          prompt.kind === kind.slug &&
          (!needle || prompt.name.toLocaleLowerCase().includes(needle)),
      ),
    }))
    .filter((group) => group.prompts.length > 0)

  return (
    <div className="flex max-h-[75vh] min-h-72 flex-col gap-3">
      <div className="relative shrink-0">
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2 text-ink-tertiary"
          aria-hidden
        />
        <Input
          aria-label="Search prompts"
          placeholder="Search prompts"
          className="h-10 pl-9 pr-9"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
        {search && (
          <Button
            size="icon-sm"
            variant="ghost"
            className="absolute top-1/2 right-2 -translate-y-1/2"
            aria-label="Clear prompt search"
            onClick={() => onSearch('')}
          >
            <XIcon />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {groups.length ? (
          <div className="flex flex-col gap-5">
            {groups.map(({ kind, prompts }) => (
              <section
                key={kind.slug}
                aria-label={`Prompts for ${kind.label}`}
                className="flex flex-col gap-2"
              >
                <h3
                  className="flex min-h-12 items-center justify-between gap-3 rounded-md border border-white/10 border-l-4 px-3 py-2 text-title font-semibold text-white shadow-sm"
                  style={{
                    backgroundImage:
                      'linear-gradient(105deg, color-mix(in oklab, #0f3156 55%, var(--color-surface-2)), color-mix(in oklab, #0d463c 48%, var(--color-surface-2)))',
                    borderLeftColor: 'color-mix(in oklab, #28665c 48%, var(--color-surface-2))',
                  }}
                >
                  <span className="truncate">{kind.label}</span>
                  <span className="num rounded-pill border border-white/10 bg-black/15 px-2.5 py-0.5 text-caption font-semibold text-white">
                    {prompts.length}
                  </span>
                </h3>
                <ul className="flex flex-col gap-1.5">
                  {prompts.map((prompt) => {
                    const active = current !== undefined && promptKey(prompt) === promptKey(current)
                    return (
                      <li key={promptKey(prompt)}>
                        <button
                          type="button"
                          onClick={() => onSelect(promptKey(prompt))}
                          aria-current={active ? 'true' : undefined}
                          className={cn(
                            'flex min-h-10 w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-body transition-colors',
                            active
                              ? 'border-primary/50 bg-primary-subtle text-ink'
                              : 'border-hairline bg-surface-1 text-ink-muted hover:border-hairline-strong hover:bg-surface-2',
                          )}
                        >
                          <span className="truncate">{prompt.name || 'Untitled'}</span>
                          <ChevronRightIcon
                            className={cn(
                              'size-4 shrink-0 text-ink-tertiary transition-transform',
                              active && 'translate-x-0.5 text-primary',
                            )}
                            aria-hidden
                          />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <p className="px-2 py-4 text-body-compact text-ink-subtle">
            {needle ? 'No prompts match your search.' : 'No prompts in this library yet.'}
          </p>
        )}
      </div>
    </div>
  )
}

type Change = { name?: string; body?: string; read_metrics?: string[] }
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

/**
 * Saves a prompt's edits as they are typed: the cache changes on every keystroke, the backend
 * a moment after typing pauses. Saves go out one at a time and in order, so a slow one can never
 * land after a newer one, and whatever is still waiting is sent when the editor closes.
 */
function useAutosave(id: number | null) {
  const queryClient = useQueryClient()
  const pending = useRef<Change>({})
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const inFlight = useRef(0)
  const alive = useRef(true)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<unknown>(null)

  const flush = useCallback(() => {
    clearTimeout(timer.current)
    const change = pending.current
    pending.current = {}
    if (id === null || Object.keys(change).length === 0) return
    inFlight.current++
    chain.current = chain.current
      .then(() => prompts.edit(id, change))
      .then(
        (row) => {
          patchLibrary(queryClient, id, { updatedAt: row.updatedAt })
          void refreshPreviews(queryClient)
          if (alive.current && inFlight.current === 1 && !Object.keys(pending.current).length)
            setStatus('saved')
        },
        (e: unknown) => {
          // Kept, so the next keystroke or Retry sends it again.
          pending.current = { ...change, ...pending.current }
          if (alive.current) {
            setError(e)
            setStatus('error')
          }
        },
      )
      .finally(() => inFlight.current--)
  }, [id, queryClient])

  const queue = useCallback(
    (change: Change) => {
      if (id === null) return
      pending.current = { ...pending.current, ...change }
      patchLibrary(queryClient, id, {
        ...change,
        ...(change.body !== undefined && countText(change.body)),
      })
      setStatus('saving')
      clearTimeout(timer.current)
      timer.current = setTimeout(flush, 400)
    },
    [id, queryClient, flush],
  )

  const discard = useCallback(() => {
    clearTimeout(timer.current)
    pending.current = {}
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      flush()
    }
  }, [flush])

  return { status, error, queue, flush, discard }
}

function SaveState({
  status,
  error,
  onRetry,
}: {
  status: SaveStatus
  error: unknown
  onRetry: () => void
}) {
  if (status === 'saving') return <span className="text-body-compact text-ink-subtle">Saving…</span>
  if (status === 'saved') return <span className="text-body-compact text-ink-subtle">Saved</span>
  if (status === 'error')
    return (
      <span className="flex items-center gap-2 text-body-compact text-pnl-negative" role="alert">
        Not saved: {errorMessage(error)}
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      </span>
    )
  return null
}

function Editor({
  prompt,
  kind,
  original,
  copying,
  onCopy,
  onDeleted,
}: {
  prompt: LibraryPrompt
  kind: PromptKind | undefined
  /** The built-in this prompt stands in for, which Changes compares against. */
  original: LibraryPrompt | undefined
  copying: boolean
  onCopy: (body: NewPrompt) => void
  onDeleted: () => void
}) {
  const queryClient = useQueryClient()
  const readOnly = prompt.builtIn
  const [name, setName] = useState(prompt.name)
  const [body, setBody] = useState(prompt.body)
  const [readMetrics, setReadMetrics] = useState(
    prompt.readMetrics?.length ? prompt.readMetrics : ['sharpe'],
  )
  const [view, setView] = useState<'edit' | 'changes'>('edit')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const save = useAutosave(prompt.id)
  const counts = countText(body)
  const metricOptions: [string, string][] = [
    ['sharpe', 'Sharpe'],
    ['fitness', 'Fitness'],
    ['turnover', 'Turnover'],
    ['returns', 'Returns'],
    ['drawdown', 'Drawdown'],
  ]

  const remove = useMutation({
    mutationFn: () => prompts.remove(prompt.id as number),
    onSuccess: () => {
      queryClient.setQueryData<PromptLibrary>(
        LIBRARY_KEY,
        (lib) => lib && { ...lib, prompts: lib.prompts.filter((p) => p.id !== prompt.id) },
      )
      void refreshPreviews(queryClient)
      setConfirmDelete(false)
      toast.success(`Deleted “${name}”`)
      onDeleted()
    },
  })

  const copy = () => {
    save.flush()
    onCopy({
      name: `${name.trim() || 'Untitled'} (copy)`.slice(0, 120),
      kind: prompt.kind,
      body,
      read_metrics: readMetrics,
      based_on: readOnly ? prompt.kind : name.trim() || null,
    })
  }

  return (
    <Panel
      title={readOnly ? name.trim() || 'Untitled' : 'Edit prompt'}
      description={kind?.purpose}
      actions={
        <>
          {!readOnly && <SaveState status={save.status} error={save.error} onRetry={save.flush} />}
          <Button
            size="sm"
            variant={readOnly ? 'primary' : 'secondary'}
            loading={copying}
            onClick={copy}
          >
            <CopyIcon />
            Save a Copy
          </Button>
          {!readOnly && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Delete prompt"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2Icon />
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {readOnly ? (
          <p className="text-body-compact text-ink-subtle">
            Built-in prompt · Save a copy to edit it.
          </p>
        ) : (
          <Field label="Name">
            <Input
              value={name}
              maxLength={120}
              aria-invalid={!name.trim() || undefined}
              onChange={(e) => {
                setName(e.target.value)
                if (e.target.value.trim()) save.queue({ name: e.target.value })
              }}
              onBlur={save.flush}
            />
          </Field>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <KV
            items={[
              ['For', kind?.label ?? prompt.kind],
              ...(prompt.basedOn
                ? [
                    [
                      'Copied from',
                      prompt.basedOn === prompt.kind ? `Built-in · ${kind?.label}` : prompt.basedOn,
                    ] as [string, string],
                  ]
                : []),
              [
                'Size',
                `${fmt.int(counts.words)} words · ${fmt.int(counts.characters)} chars · ~${fmt.int(counts.estimatedTokens)} tokens`,
              ],
              ...(prompt.updatedAt
                ? ([['Updated', fmt.ago(prompt.updatedAt)]] as [string, string][])
                : []),
            ]}
          />
          {!readOnly && original && (
            <Segmented
              label="View"
              items={[
                { value: 'edit', label: 'Edit' },
                { value: 'changes', label: 'Changes' },
              ]}
              value={view}
              onChange={setView}
            />
          )}
        </div>
        <Disclosure summary={`Alpha context metrics · ${readMetrics.length} selected`}>
          <div className="flex flex-col gap-2">
            <p className="text-body-compact text-ink-subtle">
              Choose which metrics the LLM can see for earlier Alphas. The first selected metric
              controls the ordering.
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-body-compact text-ink">
              {metricOptions.map(([value, label]) => (
                <label key={value} className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={readMetrics.includes(value)}
                    disabled={readOnly}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...readMetrics, value]
                        : readMetrics.filter((metric) => metric !== value)
                      if (!next.length) return
                      setReadMetrics(next)
                      save.queue({ read_metrics: next })
                    }}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
        </Disclosure>

        {view === 'changes' && original ? (
          <Changes before={original.body} after={body} label={original.name} />
        ) : (
          <Textarea
            aria-label="Prompt text"
            className={TEXT}
            value={body}
            readOnly={readOnly}
            placeholder="Write the instructions the model gets first. Say what to return, and in what shape."
            onChange={(e) => {
              setBody(e.target.value)
              save.queue({ body: e.target.value })
            }}
            onBlur={save.flush}
          />
        )}
        {!readOnly && !body.trim() && (
          <Notice tone="warn" title="This prompt is empty, so a task can't use it yet." />
        )}
      </div>

      <Confirm
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${name}”?`}
        confirmLabel="Delete"
        danger
        pending={remove.isPending}
        onConfirm={() => {
          save.discard()
          remove.mutate()
        }}
      >
        A task that already uses it keeps sending the text it had when the task was added.
        {remove.isError && (
          <ErrorNotice className="mt-3" title="Could not delete it" error={remove.error} />
        )}
      </Confirm>
    </Panel>
  )
}

function Changes({ before, after, label }: { before: string; after: string; label: string }) {
  // Deferred: the table is rebuilt from scratch, and typing must not wait on it.
  const text = useDeferredValue(after)
  const parts = diffWords(before, text)
  if (!parts)
    return <Notice tone="info" title="Too different from the built-in to compare word by word." />
  const { added, removed } = diffCounts(parts)
  return (
    <div className="flex flex-col gap-2">
      <p className="num text-body-compact text-ink-subtle">
        Against Built-in · {label}: <span className="text-pnl-positive">+{fmt.int(added)}</span>{' '}
        words, <span className="text-pnl-negative">−{fmt.int(removed)}</span> words
      </p>
      <pre
        className="num max-h-[60vh] overflow-auto rounded-md border border-hairline bg-canvas p-3 text-body-compact leading-relaxed whitespace-pre-wrap text-ink-muted"
        role="region"
        aria-label="Changes from the built-in"
      >
        {parts.map((p, i) =>
          p.op === 'same' ? (
            p.text
          ) : p.op === 'add' ? (
            <ins key={i} className="rounded-xs bg-pnl-positive-tint text-pnl-positive no-underline">
              {p.text}
            </ins>
          ) : (
            <del key={i} className="rounded-xs bg-pnl-negative-tint text-pnl-negative">
              {p.text}
            </del>
          ),
        )}
      </pre>
    </div>
  )
}
