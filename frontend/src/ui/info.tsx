/**
 * An "i" beside a control a reader may not know, opening a pane from the right that explains
 * it. The pane's parts are shared too, so every explanation reads and looks the same.
 */

import { ArrowDownIcon, InfoIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/ui/kit'
import { Sheet } from '@/ui/overlay'

export function InfoButton({
  title,
  description,
  children,
}: {
  /** Names the feature: the pane's title and the button's accessible name. */
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`About ${title}`}
        title={`About ${title}`}
        onClick={() => setOpen(true)}
      >
        <InfoIcon />
      </Button>
      <Sheet open={open} onOpenChange={setOpen} title={title} description={description}>
        <div className="flex flex-col gap-6">{children}</div>
      </Sheet>
    </>
  )
}

export function InfoSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-title">{title}</h3>
      <div className="flex flex-col gap-2 text-body text-pretty text-ink-muted">{children}</div>
    </section>
  )
}

export type FlowNode =
  | { kind: 'step'; text: ReactNode }
  | { kind: 'decision'; question: ReactNode; branches: { answer: ReactNode; result: ReactNode }[] }

/** Top to bottom: a box per step, a question with its answers side by side, an arrow between. */
export function Flowchart({ nodes, label }: { nodes: FlowNode[]; label: string }) {
  return (
    <ol aria-label={label} className="flex flex-col items-stretch">
      {nodes.map((node, i) => (
        <li key={i} className="flex flex-col items-center">
          {i > 0 && <ArrowDownIcon aria-hidden className="my-1 size-4 text-ink-subtle" />}
          {node.kind === 'step' ? (
            <div className="w-full rounded-md border border-hairline-strong bg-surface-2 px-3 py-2 text-center text-body text-ink">
              {node.text}
            </div>
          ) : (
            <div className="flex w-full flex-col gap-2 rounded-md border border-primary/60 bg-surface-2 p-3">
              <p className="text-center text-body font-medium text-ink">{node.question}</p>
              <div className="grid gap-2 sm:grid-flow-col sm:auto-cols-fr">
                {node.branches.map((branch, b) => (
                  <div
                    key={b}
                    className="flex flex-col gap-1 rounded-sm border border-hairline bg-surface-3 px-2 py-1.5 text-center"
                  >
                    <span className="text-caption text-ink-subtle">{branch.answer}</span>
                    <span className="num text-body text-ink">{branch.result}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </li>
      ))}
    </ol>
  )
}
