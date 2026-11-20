import { ListFilter, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Filter } from './store.ts'
import { Panel, Suggest, type KnownLabels } from './ui.tsx'

// A view's filters, the board's own: where messages came from, labels (on the
// message or its thread's root; `a|b` for either value), and words in the text.

export function describe(label: string): string {
  return label.includes('=') ? label.replace('|', ' 或 ') : `含 ${label}`
}

export function FilterButton(props: {
  filter: Filter
  onChange: (filter: Filter) => void
  sources: string[]
  known: KnownLabels
}) {
  const { filter, onChange } = props
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [text, setText] = useState(filter.text ?? '')
  const valueRef = useRef<HTMLDivElement>(null)
  const count = (filter.from ? 1 : 0) + filter.label.length + (filter.text ? 1 : 0)

  // Typing filters as you go, without a history entry per keystroke.
  useEffect(() => setText(filter.text ?? ''), [filter.text])
  useEffect(() => {
    if (text === (filter.text ?? '')) return
    const timer = setTimeout(() => onChange({ ...filter, ...(text ? { text } : { text: undefined }) }), 250)
    return () => clearTimeout(timer)
  }, [text])

  const addLabel = () => {
    const k = key.trim()
    if (!k) return
    const label = value.trim() ? `${k}=${value.trim()}` : k
    if (!filter.label.includes(label)) onChange({ ...filter, label: [...filter.label, label] })
    setKey('')
    setValue('')
  }

  return (
    <Panel
      title="筛选"
      triggerTitle="筛选消息"
      trigger={
        <>
          <ListFilter size={15} strokeWidth={1.75} />
          {count > 0 && <span className="count">{count}</span>}
        </>
      }
      open={open}
      onOpenChange={setOpen}
    >
      <div className="filter-form">
        <div className="filter-row">
          <span className="filter-name">来源</span>
          <div className="segments">
            {['', 'board', ...props.sources].map((source) => (
              <button
                key={source || 'any'}
                className={`segment${(filter.from ?? '') === source ? ' on' : ''}`}
                onClick={() => onChange({ ...filter, ...(source ? { from: source } : { from: undefined }) })}
              >
                {source || '任意'}
              </button>
            ))}
          </div>
        </div>
        <div className="filter-row">
          <span className="filter-name">标签</span>
          <div className="grow">
            {filter.label.length > 0 && (
              <div className="chips">
                {filter.label.map((label) => (
                  <span key={label} className="label">
                    {describe(label)}
                    <button title="移除" onClick={() => onChange({ ...filter, label: filter.label.filter((l) => l !== label) })}>
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="label-add">
              <Suggest
                value={key}
                onChange={setKey}
                items={[...props.known.keys()]}
                placeholder="键"
                onEnter={() => (value ? addLabel() : valueRef.current?.querySelector('input')?.focus())}
              />
              <span className="faint">=</span>
              <div ref={valueRef} className="grow">
                <Suggest value={value} onChange={setValue} items={[...(props.known.get(key.trim()) ?? [])]} placeholder="任意（或 a|b）" onEnter={addLabel} />
              </div>
              <button className="send small" disabled={!key.trim()} onClick={addLabel}>
                添加
              </button>
            </div>
          </div>
        </div>
        <div className="filter-row">
          <span className="filter-name">文本</span>
          <label className="suggest grow">
            <input value={text} onChange={(event) => setText(event.target.value)} placeholder="包含…" spellCheck={false} />
          </label>
        </div>
        {count > 0 && (
          <button className="clear" onClick={() => onChange({ label: [] })}>
            清除筛选
          </button>
        )}
      </div>
    </Panel>
  )
}

/** The active filters, each removable, under the view's header. */
export function FilterChips({ filter, onChange }: { filter: Filter; onChange: (filter: Filter) => void }) {
  const chips: { key: string; text: string; remove: Filter }[] = [
    ...(filter.from ? [{ key: 'from', text: `来源 ${filter.from}`, remove: { ...filter, from: undefined } }] : []),
    ...filter.label.map((label) => ({ key: `label:${label}`, text: describe(label), remove: { ...filter, label: filter.label.filter((l) => l !== label) } })),
    ...(filter.text ? [{ key: 'text', text: `“${filter.text}”`, remove: { ...filter, text: undefined } }] : []),
  ]
  if (chips.length === 0) return null
  return (
    <div className="filter-bar">
      {chips.map((chip) => (
        <span key={chip.key} className="label">
          {chip.text}
          <button title="移除" onClick={() => onChange(chip.remove)}>
            <X size={11} />
          </button>
        </span>
      ))}
      <button className="clear" onClick={() => onChange({ label: [] })}>
        清除
      </button>
    </div>
  )
}
