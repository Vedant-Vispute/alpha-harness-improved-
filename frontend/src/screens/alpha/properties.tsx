/** Name, category, colour, tags and description, saved to the Alpha on BRAIN. Saving never submits. */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/cn'
import { Button, ErrorNotice, Field, Input, Panel, Textarea } from '@/ui/kit'
import { Select } from '@/ui/overlay'
import { POWER_POOL_HEADINGS } from './analysis'
import { type AlphaInfo, type AlphaView, alpha as api } from './api'

const CATEGORIES = [
  'NONE',
  'PRICE_REVERSION',
  'PRICE_MOMENTUM',
  'VOLUME',
  'FUNDAMENTAL',
  'ANALYST',
  'PRICE_VOLUME',
  'RELATION',
  'SENTIMENT',
] as const

const readable = (value: string) =>
  value === 'NONE' ? 'None' : value.charAt(0) + value.slice(1).toLowerCase().replaceAll('_', ' ')

/** BRAIN's five colours, as it names them. */
const COLORS: { value: string; swatch: string }[] = [
  { value: 'RED', swatch: 'bg-(--red-400)' },
  { value: 'YELLOW', swatch: 'bg-(--amber-300)' },
  { value: 'GREEN', swatch: 'bg-(--sea-400)' },
  { value: 'BLUE', swatch: 'bg-(--teal-400)' },
  { value: 'PURPLE', swatch: 'bg-(--orchid-400)' },
]

/** BRAIN's Power Pool description template, with a line to explain each field and operator. */
const template = (alpha: AlphaInfo) => {
  const [idea, data, operators] = POWER_POOL_HEADINGS
  const lines = (items: string[] | null, call: boolean) =>
    (items ?? []).map((item) => `\n- ${item}${call ? '()' : ''}: `).join('')
  return (
    `${idea}: \n\n` +
    `${data}: ${lines(alpha.dataFields, false)}\n\n` +
    `${operators}: ${lines(alpha.operators, true)}`
  )
}

/** The minimum a Power Pool Alpha's description needs. */
const MINIMUM = 100

interface Draft {
  name: string
  category: string
  color: string
  tags: string
  description: string
}

const draftOf = (a: AlphaInfo): Draft => ({
  name: a.name ?? '',
  category: a.category ?? 'NONE',
  color: a.color ?? 'NONE',
  tags: a.tags.join(', '),
  description: a.description ?? '',
})

export function PropertiesPanel({ alpha }: { alpha: AlphaInfo }) {
  const queryClient = useQueryClient()
  const saved = draftOf(alpha)
  const [draft, setDraft] = useState<Draft>(saved)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft({ ...draft, [key]: value })

  const save = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      // BRAIN drops an empty description from the request rather than clearing it, so refuse
      // the save instead of reporting one that never happened.
      if (saved.description.trim() && !draft.description.trim()) {
        throw new Error(
          'BRAIN keeps a description once it is set and cannot clear it. Write a new one ' +
            'instead. Nothing was saved.',
        )
      }
      return api.save(alpha.alphaId, {
        name: draft.name,
        category: draft.category,
        color: draft.color,
        tags: draft.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        description: draft.description,
      })
    },
    onSuccess: (info) => {
      queryClient.setQueryData<AlphaView>(['alpha', alpha.alphaId, 'page'], (page) =>
        page ? { ...page, alpha: info } : page,
      )
      setDraft(draftOf(info))
      toast.success(`Saved the properties of ${alpha.alphaId}`)
    },
  })

  const length = draft.description.trim().length

  return (
    <Panel
      title="Properties"
      description="Saved to the Alpha on BRAIN"
      actions={
        <>
          {dirty && (
            <Button size="sm" variant="ghost" onClick={() => setDraft(saved)}>
              Discard
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save to BRAIN
          </Button>
        </>
      }
      bodyClassName="flex flex-col gap-4"
    >
      {save.isError && <ErrorNotice error={save.error} title="The properties were not saved" />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input
            value={draft.name}
            placeholder={alpha.alphaId}
            onChange={(e) => set('name', e.target.value)}
          />
        </Field>
        <Field label="Category">
          <Select
            label="Category"
            value={draft.category}
            onChange={(v) => set('category', v)}
            items={CATEGORIES.map((c) => ({ value: c, label: readable(c) }))}
          />
        </Field>
        <Field label="Tags" hint="Separate tags with commas">
          <Input
            value={draft.tags}
            placeholder="reversion, usa"
            onChange={(e) => set('tags', e.target.value)}
          />
        </Field>
        <fieldset className="flex min-w-0 flex-col gap-1.5">
          <legend className="float-left w-full text-caption font-medium text-ink-muted">
            Color
          </legend>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-pressed={draft.color === 'NONE'}
              onClick={() => set('color', 'NONE')}
              className={cn(
                'h-7 rounded-sm border px-2 text-body-compact transition-colors',
                draft.color === 'NONE'
                  ? 'border-ink-subtle bg-surface-3 text-ink'
                  : 'border-hairline-strong text-ink-subtle hover:text-ink',
              )}
            >
              None
            </button>
            {COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                aria-label={readable(c.value)}
                aria-pressed={draft.color === c.value}
                onClick={() => set('color', c.value)}
                className={cn(
                  'size-7 rounded-sm ring-offset-2 ring-offset-surface-1 transition-shadow',
                  c.swatch,
                  draft.color === c.value
                    ? 'ring-2 ring-ink'
                    : 'hover:ring-1 hover:ring-ink-subtle',
                )}
              />
            ))}
          </div>
        </fieldset>
      </div>
      <div className="flex flex-col gap-1.5">
        <Field
          label="Description"
          hint={
            <>
              Power Pool Alphas need{' '}
              <span
                className={cn(
                  'num',
                  length >= MINIMUM ? 'text-pnl-positive-text' : 'text-ink-muted',
                )}
              >
                {length} of {MINIMUM}
              </span>{' '}
              characters: the idea, and why these data and operators.
            </>
          }
        >
          <Textarea
            rows={6}
            value={draft.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="Idea, rationale for data used, rationale for operators used"
          />
        </Field>
        {!draft.description.trim() && (
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() => set('description', template(alpha))}
          >
            Use the Power Pool template
          </Button>
        )}
      </div>
    </Panel>
  )
}
