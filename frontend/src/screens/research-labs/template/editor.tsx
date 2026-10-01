/**
 * The template editor: CodeMirror, with Fast Expression coloured the way VS Code's Dark+ theme
 * colours code, bracket pairs coloured by depth, completions for operators, `$variables`,
 * grouping and data fields, hovers that document whatever is under the pointer, and the
 * preview's problems drawn on the text they are about.
 */

import {
  acceptCompletion,
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  snippetCompletion,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { type Diagnostic, forceLinting, linter, lintKeymap } from '@codemirror/lint'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Annotation, EditorState, RangeSetBuilder, StateEffect } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  hoverTooltip,
  keymap,
  lineNumbers,
  rectangularSelection,
  type Tooltip,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { useEffect, useRef } from 'react'
import { catalog, type DataFieldDetail } from '@/api/catalog'
import type { Scope } from '@/api/types'
import { fmt } from '@/lib/format'
import type { VariableDef, VariableInfo } from './api'
import {
  brackets,
  code,
  fastExpression,
  GROUPS,
  group,
  hole,
  local,
  locals,
  NAMES,
  type OperatorDoc,
  snippetOf,
  variable,
  WORDS,
} from './fast-expression'
import { namesIn } from './variables'

/** What the editor reads at the moment it is asked: kept in a ref, so nothing rebuilds it. */
interface Live {
  reference: OperatorDoc[]
  presets: Record<string, string>
  variables: Record<string, VariableDef | null>
  infos: Map<string, VariableInfo>
  problems: string[]
  scope: Scope | null
  onChange: (text: string) => void
}

/** VS Code's Dark+ colours, and its default bracket pair colours. */
const darkPlus = HighlightStyle.define([
  { tag: t.function(t.variableName), color: '#dcdcaa' },
  { tag: t.variableName, color: '#9cdcfe' },
  { tag: t.propertyName, color: '#9cdcfe', fontStyle: 'italic' },
  { tag: local, color: '#4fc1ff' },
  { tag: group, color: '#4ec9b0' },
  { tag: variable, color: '#c586c0', fontWeight: '600' },
  {
    tag: hole,
    color: '#f48771',
    backgroundColor: 'rgb(244 135 113 / 0.14)',
    outline: '1px dashed rgb(244 135 113 / 0.6)',
    borderRadius: '3px',
  },
  { tag: t.number, color: '#b5cea8' },
  { tag: t.string, color: '#ce9178' },
  { tag: t.comment, color: '#6a9955', fontStyle: 'italic' },
  { tag: t.bool, color: '#569cd6' },
  { tag: t.operator, color: '#d4d4d4' },
  { tag: t.punctuation, color: '#d4d4d4' },
  { tag: t.invalid, color: '#f44747' },
  { tag: brackets[0], color: '#ffd700' },
  { tag: brackets[1], color: '#da70d6' },
  { tag: brackets[2], color: '#179fff' },
])

const theme = EditorView.theme(
  {
    '&': {
      color: '#d4d4d4',
      backgroundColor: '#1e1e1e',
      fontSize: '13px',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.65' },
    '.cm-content': { caretColor: '#aeafad', padding: '10px 0', minHeight: '9rem' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#aeafad', borderLeftWidth: '2px' },
    '.cm-gutters': { backgroundColor: '#1e1e1e', color: '#6e7681', border: 'none' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 16px', minWidth: '40px' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#cccccc' },
    '.cm-activeLine': { backgroundColor: 'rgb(255 255 255 / 0.04)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      { backgroundColor: '#264f78' },
    '.cm-selectionMatch': { backgroundColor: 'rgb(173 214 255 / 0.15)' },
    '&.cm-focused .cm-matchingBracket': {
      backgroundColor: 'rgb(0 100 0 / 0.1)',
      outline: '1px solid #888888',
    },
    '&.cm-focused .cm-nonmatchingBracket': { color: '#f44747' },
    '.cm-fx-local, .cm-fx-local *': { color: '#4fc1ff' },
    '.cm-tooltip': {
      backgroundColor: '#252526',
      color: '#cccccc',
      border: '1px solid #454545',
      borderRadius: '4px',
      boxShadow: '0 4px 16px rgb(0 0 0 / 0.45)',
    },
    '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', maxHeight: '18rem' },
    '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: '#04395e',
      color: '#ffffff',
    },
    '.cm-completionMatchedText': { color: '#2aaaff', textDecoration: 'none', fontWeight: '600' },
    '.cm-completionDetail': { color: '#9d9d9d', fontStyle: 'normal', marginLeft: '1.5em' },
    '.cm-completionIcon-function': { color: '#b180d7' },
    '.cm-completionIcon-variable': { color: '#75beff' },
    '.cm-completionIcon-constant': { color: '#4ec9b0' },
    '.cm-completionIcon-property': { color: '#9cdcfe' },
    '.cm-completionInfo': { padding: '8px 10px', maxWidth: '28rem' },
    '.cm-fx-doc': {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      padding: '8px 10px',
      maxWidth: '30rem',
    },
    '.cm-fx-doc code': { fontFamily: 'var(--font-mono)', color: '#dcdcaa', whiteSpace: 'pre-wrap' },
    '.cm-fx-doc .cm-fx-kind': { color: '#9d9d9d', fontSize: '12px' },
    '.cm-fx-doc p': { margin: '0', lineHeight: '1.5' },
    '.cm-diagnostic': { padding: '6px 10px', borderLeftWidth: '3px' },
    '.cm-diagnostic-error': { borderLeftColor: '#f14c4c' },
    '.cm-diagnostic-warning': { borderLeftColor: '#cca700' },
  },
  { dark: true },
)

// --- reading the document -------------------------------------------------------------

/** A name's uses coloured like its definition, as VS Code colours a local variable. */
const localNames = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = marked(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = marked(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

const localMark = Decoration.mark({ class: 'cm-fx-local' })

function marked(view: EditorView): DecorationSet {
  const blank = code(view.state.doc.toString())
  const names = locals(blank)
  const builder = new RangeSetBuilder<Decoration>()
  if (names.size === 0) return builder.finish()
  for (const m of blank.matchAll(NAMES)) {
    if (names.has(m[0])) builder.add(m.index, m.index + m[0].length, localMark)
  }
  return builder.finish()
}

/** The word under `pos`, `$` included. */
function wordAt(view: EditorView, pos: number): { from: number; to: number; text: string } | null {
  const line = view.state.doc.lineAt(pos)
  for (const m of line.text.matchAll(/\$?[A-Za-z_]\w*|\.\.\./g)) {
    const from = line.from + m.index
    const to = from + m[0].length
    if (from <= pos && pos <= to) return { from, to, text: m[0] }
  }
  return null
}

// --- what the editor tells the reader ---------------------------------------------------

function element(tag: string, text: string, className?: string): HTMLElement {
  const node = document.createElement(tag)
  node.textContent = text
  if (className) node.className = className
  return node
}

function doc(parts: (HTMLElement | null)[]): HTMLElement {
  const box = document.createElement('div')
  box.className = 'cm-fx-doc'
  for (const part of parts) if (part) box.append(part)
  return box
}

function operatorDoc(op: OperatorDoc): HTMLElement {
  return doc([
    element('code', op.definition.split(/\r?\n/)[0] ?? op.name),
    op.category ? element('span', op.category, 'cm-fx-kind') : null,
    op.description ? element('p', op.description) : null,
  ])
}

function describe(name: string, live: Live): string {
  const def = live.variables[name]
  const info = live.infos.get(name)
  if (!def) return 'Not defined yet: choose its fields or type its values in Variables.'
  if (def.kind === 'values') {
    const count = info?.kind === 'values' ? ` (${fmt.int(info.values)})` : ''
    return `Values${count}: ${def.values}`
  }
  const ids = def.dataset_ids
  const from =
    ids.length > 3 ? `${ids.slice(0, 3).join(', ')} and ${ids.length - 3} more` : ids.join(', ')
  const count = info?.fields ? `, ${fmt.int(info.fields.total)} fields` : ''
  return `Fields from ${from || 'no dataset yet'}${count}`
}

/** Fields looked up by hovering, per market: each name is asked about once. */
const looked = new Map<string, Promise<DataFieldDetail | null>>()

function lookUp(scope: Scope, name: string): Promise<DataFieldDetail | null> {
  const key = `${scope.region}|${scope.delay}|${scope.universe}|${name}`
  let found = looked.get(key)
  if (!found) {
    found = catalog.field(scope, name).catch(() => {
      // A failure is not remembered, so a name that was briefly unreachable is asked again.
      looked.delete(key)
      return null
    })
    looked.set(key, found)
  }
  return found
}

async function hover(view: EditorView, pos: number, live: Live): Promise<Tooltip | null> {
  const word = wordAt(view, pos)
  // A word inside a comment or a string is prose, not code.
  if (!word || !code(view.state.doc.toString()).slice(word.from, word.to).trim()) return null
  const tip = (dom: HTMLElement): Tooltip => ({
    pos: word.from,
    end: word.to,
    above: true,
    create: () => ({ dom }),
  })
  const after = view.state.doc.sliceString(word.to, word.to + 40)
  if (word.text === '...') {
    return tip(doc([element('p', 'A signal goes here. Write it before the template can run.')]))
  }
  if (word.text.startsWith('$')) {
    const name = word.text.slice(1)
    const preset = live.presets[name]
    return tip(
      doc([
        element('code', word.text),
        element('span', 'Variable: the search chooses it for each Alpha', 'cm-fx-kind'),
        element('p', describe(name, live)),
        preset !== undefined ? element('p', `Preset: ${preset}`, 'cm-fx-kind') : null,
      ]),
    )
  }
  if (/^\s*\(/.test(after)) {
    const op = live.reference.find((o) => o.name === word.text)
    return tip(
      op ? operatorDoc(op) : doc([element('p', `${word.text} is not one of your operators.`)]),
    )
  }
  if (GROUPS.has(word.text)) {
    return tip(
      doc([
        element('code', word.text),
        element(
          'p',
          'Grouping field: groups stocks for group operators, and is never counted as data.',
        ),
      ]),
    )
  }
  if (locals(code(view.state.doc.toString())).has(word.text)) {
    return tip(
      doc([element('code', word.text), element('p', 'Defined by a line of this template.')]),
    )
  }
  if (WORDS.includes(word.text.toLowerCase()) || !live.scope) return null
  const field = await lookUp(live.scope, word.text)
  if (!field) return null
  return tip(
    doc([
      element('code', field.field_id),
      element(
        'span',
        [field.field_type, field.dataset_id, field.category_name].filter(Boolean).join(' · '),
        'cm-fx-kind',
      ),
      field.description ? element('p', field.description) : null,
      field.coverage != null
        ? element('span', `Coverage ${fmt.pct(field.coverage, 0)}`, 'cm-fx-kind')
        : null,
    ]),
  )
}

async function complete(context: CompletionContext, live: Live): Promise<CompletionResult | null> {
  // A bare `$` already asks for the variables, as VS Code suggests on a trigger character.
  const word = context.matchBefore(/\$?[A-Za-z_]\w*|\$/)
  if (!word && !context.explicit) return null
  const from = word?.from ?? context.pos
  const typed = word?.text ?? ''
  const text = context.state.doc.toString()

  if (typed.startsWith('$')) {
    const names = new Set([
      ...Object.keys(live.presets),
      ...namesIn(text),
      ...Object.keys(live.variables),
    ])
    return {
      from,
      options: [...names].map((name): Completion => {
        const detail = live.presets[name] ?? (live.variables[name] ? describe(name, live) : null)
        return { label: `$${name}`, type: 'variable', ...(detail ? { detail } : {}) }
      }),
      validFor: /^\$\w*$/,
    }
  }

  const options: Completion[] = [
    ...live.reference.map((op) =>
      snippetCompletion(snippetOf(op), {
        label: op.name,
        type: 'function',
        detail: op.category,
        info: () => operatorDoc(op),
      }),
    ),
    ...[...GROUPS].map((name) => ({ label: name, type: 'constant', detail: 'grouping field' })),
    ...[...locals(code(text))].map((name) => ({
      label: name,
      type: 'variable',
      detail: 'this template',
    })),
    ...WORDS.map((name) => ({ label: name, type: 'keyword' })),
  ]
  // Data fields from the catalog, once there is enough typed to search on.
  if (live.scope && typed.length >= 2) {
    try {
      const page = await catalog.fields(live.scope, {
        search: typed,
        search_mode: 'text',
        sort_by: 'alpha_count',
        sort_desc: true,
        limit: 40,
      })
      if (context.aborted) return null
      for (const field of page.results)
        options.push({
          label: field.field_id,
          type: 'property',
          ...(field.dataset_id ? { detail: field.dataset_id } : {}),
          ...(field.description ? { info: field.description } : {}),
        })
    } catch {
      // Completions without fields are still completions.
    }
  }
  return { from, options }
}

/**
 * The preview's problems that name something in the text, by the exact words it writes them in:
 * a variable's own as `$name: …`, the rest as a sentence about a named operator or field. Any
 * other sentence has no place and stays below the editor.
 */
const SHAPES: { pattern: RegExp; call?: boolean }[] = [
  { pattern: /^(\$[A-Za-z_]\w*): (.+)$/ },
  { pattern: /^(\$[A-Za-z_]\w*) is chosen by the search/ },
  { pattern: /^([A-Za-z_]\w*) is not one of your operators\.$/, call: true },
  { pattern: /^([A-Za-z_]\w*) does not take \d+ inputs?\.$/, call: true },
  { pattern: /^([A-Za-z_]\w*) is not a data field in /, call: false },
]

/** Problems the preview found, drawn on the text they name; ones with no place stay below. */
function diagnose(view: EditorView, live: Live): Diagnostic[] {
  const text = view.state.doc.toString()
  const blank = code(text)
  const found: Diagnostic[] = []
  for (const m of blank.matchAll(/\.\.\./g))
    found.push({
      from: m.index,
      to: m.index + 3,
      severity: 'warning',
      message: 'Write a signal here.',
    })
  const open: number[] = []
  for (const m of blank.matchAll(/[()]/g)) {
    if (m[0] === '(') open.push(m.index)
    else if (open.pop() === undefined)
      found.push({
        from: m.index,
        to: m.index + 1,
        severity: 'error',
        message: 'Nothing opens this bracket.',
      })
  }
  for (const at of open)
    found.push({
      from: at,
      to: at + 1,
      severity: 'error',
      message: 'This bracket is never closed.',
    })
  if (live.reference.length) {
    const known = new Set(live.reference.map((o) => o.name))
    for (const m of blank.matchAll(/(?<![$\w.])([A-Za-z_]\w*)(?=\s*\()/g)) {
      const name = m[1] ?? ''
      if (!known.has(name))
        found.push({
          from: m.index,
          to: m.index + name.length,
          severity: 'error',
          message: `${name} is not one of your operators.`,
        })
    }
  }

  for (const problem of live.problems) {
    const parsed = / at (\d+)/.exec(problem)
    if (problem.startsWith("The template can't be read") && parsed) {
      const at = Math.min(Number(parsed[1]), Math.max(0, text.length - 1))
      found.push({
        from: at,
        to: Math.min(text.length, at + 1),
        severity: 'error',
        message: problem,
      })
      continue
    }
    for (const shape of SHAPES) {
      const named = shape.pattern.exec(problem)
      const name = named?.[1]
      if (!name) continue
      const message = named[2] ?? problem
      const escaped = name.replace('$', '\\$')
      const where = name.startsWith('$')
        ? `${escaped}(?!\\w)`
        : `(?<![$\\w])${escaped}(?!\\w)${shape.call ? '(?=\\s*\\()' : '(?!\\s*\\()'}`
      for (const m of blank.matchAll(new RegExp(where, 'g')))
        found.push({ from: m.index, to: m.index + name.length, severity: 'error', message })
      break
    }
  }

  const seen = new Set<string>()
  return found.filter((d) => {
    const key = `${d.from}:${d.to}:${d.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Marks a change made from outside the editor, which is not the reader's typing. */
const outside = Annotation.define<boolean>()

/**
 * Asks the linter to look again though the text is unchanged: new problems arrived. Forcing it
 * is not enough, since CodeMirror only forces a lint that is already pending.
 */
const relint = StateEffect.define<null>()

function extensions(live: { current: Live }) {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    fastExpression,
    syntaxHighlighting(darkPlus),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ override: [(context) => complete(context, live.current)] }),
    rectangularSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    localNames,
    hoverTooltip((view, pos) => hover(view, pos, live.current), { hoverTime: 300 }),
    linter((view) => diagnose(view, live.current), {
      delay: 250,
      needsRefresh: (update) =>
        update.transactions.some((tr) => tr.effects.some((e) => e.is(relint))),
    }),
    keymap.of([
      { key: 'Tab', run: acceptCompletion },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...completionKeymap,
      ...lintKeymap,
    ]),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ 'aria-label': 'Template', spellcheck: 'false' }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !update.transactions.some((tr) => tr.annotation(outside)))
        live.current.onChange(update.state.doc.toString())
    }),
    theme,
  ]
}

export function TemplateEditor({ value, ...rest }: Live & { value: string }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const live = useRef<Live>(rest)
  live.current = rest
  const first = useRef(value)

  useEffect(() => {
    if (!host.current) return
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: first.current,
        extensions: extensions(live),
      }),
    })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [])

  // Opening a template or Reset replaces the text from outside.
  useEffect(() => {
    const editor = view.current
    if (editor && editor.state.doc.toString() !== value)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
        annotations: outside.of(true),
      })
  }, [value])

  // The preview's problems and the operator list change what is drawn without touching the text,
  // so the linter is asked again when they arrive rather than waiting for the next keystroke.
  const { problems, reference } = rest
  // biome-ignore lint/correctness/useExhaustiveDependencies: the linter reads both through `live`
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    editor.dispatch({ effects: relint.of(null) })
    forceLinting(editor)
  }, [problems, reference])

  return <div ref={host} className="overflow-hidden rounded-md border border-hairline-strong" />
}
