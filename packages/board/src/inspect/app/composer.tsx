import { Clock, CloudOff, FileText, ListTodo, Paperclip, Tag, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ATTACHMENT_BYTES_MAX, ATTACHMENTS_PER_MESSAGE_MAX } from '../../contract/schemas.ts'
import type { ScheduleTiming } from '../../server/index.default.ts'
import { toast } from './chrome.ts'
import { profilesOf, type State } from './store.ts'
import { actorFor, taskIds } from './task.tsx'
import { fieldMenu, LabelEditor, Panel, Suggest, type KnownLabels } from './ui.tsx'
import { fileSize, laterFields, timingWords } from './words.ts'

// Just Chat's composer: one outlined box, the textarea, a quiet toolbar.
// Enter sends, Shift+Enter breaks a line, ⌘B / ⌘I / ⌘E format, lists continue,
// ↑ in an empty box edits your last message, and every place keeps its draft.

const MAX_HEIGHT = 160

const draftKey = (scope: string) => `board.draft:${scope}`
function readDraft(scope: string): string {
  try {
    return sessionStorage.getItem(draftKey(scope)) ?? ''
  } catch {
    return ''
  }
}
function writeDraft(scope: string, text: string) {
  try {
    if (text) sessionStorage.setItem(draftKey(scope), text)
    else sessionStorage.removeItem(draftKey(scope))
  } catch {}
}

/** Replaces the selection through the browser, so ⌘Z undoes it. */
function insert(el: HTMLTextAreaElement, start: number, end: number, text: string, caret: [number, number]) {
  el.focus()
  el.setSelectionRange(start, end)
  if (!document.execCommand('insertText', false, text)) el.setRangeText(text, start, end, 'end')
  el.setSelectionRange(caret[0], caret[1])
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s(.*)$/

export type Send = {
  text: string
  noSync: boolean
  channel: string
  labels: Record<string, string>
  files: File[]
  /** Set when the thread starts as a task: what it waits for, and the actor it's for. */
  task?: { needs: string[]; for: string | null }
  /** Set to post it later: when, and how often. */
  later?: ScheduleTiming
}

export function Composer(props: {
  scope: string
  /** `data-composer`, for typing anywhere to land here. */
  role: string
  placeholder: string
  known: KnownLabels
  channels?: string[]
  /** The channel it starts on, where it picks one. */
  channel?: string
  /** Where a new thread can start as a task: the page's state, for who you are and what's open; `always` for a view that only starts tasks. */
  tasks?: { state: State; always?: boolean }
  onSend: (send: Send) => void
  onEditLast?: () => void
}) {
  const [text, setText] = useState(() => readDraft(props.scope))
  const [channel, setChannel] = useState(props.channel ?? '')
  const [task, setTask] = useState(props.tasks?.always ?? false)
  const [needs, setNeeds] = useState('')
  // What a task waits for and who it's for: there when wanted, out of the way until then.
  const [detail, setDetail] = useState(false)
  const [later, setLater] = useState<ScheduleTiming | null>(null)
  const [laterOpen, setLaterOpen] = useState(false)
  const [assignee, setAssignee] = useState('')
  const tasking = props.tasks
  const asTask = tasking !== undefined && task
  const [noSync, setNoSync] = useState(false)
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [labelsOpen, setLabelsOpen] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const area = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  /** Adds files from the picker or a paste, up to what a message can carry. */
  const attach = (added: File[]) => {
    const fitting = added.filter((file) => {
      if (file.size <= ATTACHMENT_BYTES_MAX) return true
      toast(`${file.name} 超过 ${ATTACHMENT_BYTES_MAX / 1024 / 1024} MB`)
      return false
    })
    setFiles((current) => {
      const next = [...current, ...fitting]
      if (next.length > ATTACHMENTS_PER_MESSAGE_MAX) toast(`一条消息最多带 ${ATTACHMENTS_PER_MESSAGE_MAX} 个文件`)
      return next.slice(0, ATTACHMENTS_PER_MESSAGE_MAX)
    })
    area.current?.focus()
  }

  useEffect(() => {
    setText(readDraft(props.scope))
    if (!matchMedia('(max-width: 900px)').matches && !props.channels) area.current?.focus({ preventScroll: true })
  }, [props.scope])

  useLayoutEffect(() => {
    const el = area.current!
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  const change = (value: string) => {
    setText(value)
    writeDraft(props.scope, value)
  }

  const target = channel.trim().replace(/^#/, '')
  const canSend = (text.trim().length > 0 || files.length > 0) && (!props.channels || target.length > 0)

  const send = () => {
    if (!text.trim() && files.length === 0) return
    if (props.channels && !target) return toast('选一个频道再发')
    const me = tasking?.state.me
    props.onSend({
      text: text.trim(),
      noSync,
      channel: target,
      labels,
      files,
      ...(asTask && me ? { task: { needs: taskIds(needs), for: assignee.trim() ? actorFor(me.principal, assignee) : null } } : {}),
      ...(later && !asTask ? { later } : {}),
    })
    setLater(null)
    change('')
    setLabels({})
    setFiles([])
    setNeeds('')
    setAssignee('')
    setDetail(false)
    setTask(props.tasks?.always ?? false)
  }

  const wrap = (el: HTMLTextAreaElement, marker: string) => {
    const { selectionStart: start, selectionEnd: end, value } = el
    const selected = value.slice(start, end)
    insert(el, start, end, `${marker}${selected}${marker}`, [start + marker.length, end + marker.length])
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = event.currentTarget
    const mod = event.metaKey || event.ctrlKey
    if (event.key === 'Escape') return el.blur()
    if (mod && !event.shiftKey && ['b', 'i', 'e'].includes(event.key.toLowerCase())) {
      event.preventDefault()
      return wrap(el, { b: '**', i: '_', e: '`' }[event.key.toLowerCase()]!)
    }
    if (event.key === 'ArrowUp' && !el.value && props.onEditLast) {
      event.preventDefault()
      return props.onEditLast()
    }
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    if (mod) {
      event.preventDefault()
      return send()
    }
    if (event.shiftKey) return
    const caret = el.selectionStart
    if (caret === el.selectionEnd) {
      const lineStart = el.value.lastIndexOf('\n', caret - 1) + 1
      const line = el.value.slice(lineStart, caret)
      const item = LIST_ITEM.exec(line)
      if (item) {
        event.preventDefault()
        // An empty item ends the list; otherwise the next one starts.
        if (!item[3]!.trim()) return insert(el, lineStart, caret, '', [lineStart, lineStart])
        const marker = /^\d+\.$/.test(item[2]!) ? `${Number.parseInt(item[2]!, 10) + 1}.` : item[2]!
        const next = `\n${item[1]}${marker} `
        return insert(el, caret, caret, next, [caret + next.length, caret + next.length])
      }
    }
    event.preventDefault()
    send()
  }

  const labelEntries = Object.entries(labels)
  return (
    <div className="composer">
      <div
        className="composer-box"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('button, input, [role="dialog"]')) return
          area.current?.focus()
        }}
      >
        {props.channels && (
          <Suggest
            className="composer-channel"
            prefix="#"
            value={channel}
            onChange={setChannel}
            items={props.channels}
            placeholder="频道"
            label={(item) => (
              <>
                <span className="faint">#</span>
                {item}
              </>
            )}
            onEnter={() => area.current?.focus()}
          />
        )}
        {asTask && (detail || needs.trim() !== '' || assignee.trim() !== '') && (
          <div className="composer-task">
            <label className="suggest grow" title="这个任务在等待的任务，按 ID">
              <span className="prefix">等待</span>
              <input value={needs} onChange={(event) => setNeeds(event.target.value)} placeholder="它等待的任务 ID" spellCheck={false} />
            </label>
            <Suggest className="grow" prefix="负责" value={assignee} onChange={setAssignee} items={profilesOf(tasking.state, tasking.state.me?.principal ?? '')} placeholder="任何人，或你的一个身份" onEnter={() => area.current?.focus()} />
          </div>
        )}
        {labelEntries.length > 0 && (
          <div className="chips composer-labels">
            {labelEntries.map(([key, value]) => (
              <span key={key} className="label">
                {key}={value}
                <button
                  title={`移除 ${key}`}
                  onClick={() =>
                    setLabels((current) => {
                      const next = { ...current }
                      delete next[key]
                      return next
                    })
                  }
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          data-composer={props.role}
          rows={2}
          maxLength={10_000}
          value={text}
          placeholder={props.placeholder}
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const pasted = [...event.clipboardData.files]
            if (pasted.length === 0) return
            event.preventDefault()
            attach(pasted)
          }}
        />
        {files.length > 0 && (
          <div className="chips composer-files">
            {files.map((file, i) => (
              <span key={i} className="file">
                <FileText size={14} strokeWidth={1.75} />
                <span className="file-name">{file.name}</span>
                <span className="faint">{fileSize(file.size)}</span>
                <button title={`移除 ${file.name}`} onClick={() => setFiles((current) => current.filter((_, j) => j !== i))}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-footer">
          <button className="tool" title="附上文件（或直接粘贴）" onClick={() => picker.current?.click()}>
            <Paperclip size={14} />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              attach([...(event.target.files ?? [])])
              event.target.value = ''
            }}
          />
          <Panel
            title="标签"
            trigger={
              <>
                <Tag size={14} />
                {labelEntries.length > 0 && <span className="count">{labelEntries.length}</span>}
              </>
            }
            triggerTitle="这条消息的标签"
            align="start"
            open={labelsOpen}
            onOpenChange={setLabelsOpen}
          >
            <LabelEditor
              labels={labels}
              known={props.known}
              onSet={(key, value) => setLabels((current) => ({ ...current, [key]: value }))}
              onUnset={(key) =>
                setLabels((current) => {
                  const next = { ...current }
                  delete next[key]
                  return next
                })
              }
            />
          </Panel>
          <button
            className={`tool${noSync ? ' on' : ''}`}
            aria-pressed={noSync}
            title={noSync ? '仅本板：这条消息不进 Slack 和 GitHub' : '同步到 Slack 和 GitHub（点击改为仅留在本板）'}
            onClick={() => setNoSync(!noSync)}
          >
            <CloudOff size={14} />
            {noSync && <span className="tool-label">仅本板</span>}
          </button>
          {tasking && !tasking.always && (
            <button
              className={`tool${task ? ' on' : ''}`}
              aria-pressed={task}
              title={task ? '作为任务发起：带状态的线程，代理可认领（点击改为普通线程）' : '作为任务发起'}
              onClick={() => {
                setTask(!task)
              }}
            >
              <ListTodo size={14} />
              {task && <span className="tool-label">任务</span>}
            </button>
          )}
          {asTask && (
            <button className={`tool${detail ? ' on' : ''}`} aria-pressed={detail} title="它在等什么，以及给谁" onClick={() => setDetail(!detail)}>
              <span className="tool-label">等待 / 负责</span>
            </button>
          )}
          {!asTask && (
            <Panel
              title="定时发送"
              trigger={
                <>
                  <Clock size={14} />
                  {later && <span className="tool-label">{timingWords(later)}</span>}
                </>
              }
              triggerClass={`tool${later ? ' on' : ''}`}
              align="start"
              open={laterOpen}
              onOpenChange={setLaterOpen}
            >
              <Later
                value={later}
                onSet={(next) => {
                  setLater(next)
                  setLaterOpen(false)
                  area.current?.focus()
                }}
              />
            </Panel>
          )}
          <span className="hint">Enter 发送 · Shift+Enter 换行</span>
          <button className="send" disabled={!canSend} onMouseDown={(event) => event.preventDefault()} onClick={send}>
            {asTask ? '发起任务' : later ? '定时' : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** When a message goes out: in a while or at a time, and again every so often. The board checks it. */
function Later({ value, onSet }: { value: ScheduleTiming | null; onSet: (timing: ScheduleTiming | null) => void }) {
  const start = laterFields(value)
  const [after, setAfter] = useState(start.after)
  const [at, setAt] = useState(start.at)
  const [every, setEvery] = useState(start.every)
  const [times, setTimes] = useState(start.times)
  const set = () =>
    onSet({
      ...(after.trim() ? { in: after.trim() } : at ? { at: new Date(at).toISOString() } : {}),
      ...(every.trim() ? { every: every.trim() } : {}),
      ...(every.trim() && Number(times) > 0 ? { times: Number(times) } : {}),
    })
  const ready = after.trim() !== '' || at !== '' || every.trim() !== ''
  return (
    <form
      className="ask"
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) set()
      }}
      {...fieldMenu}
    >
      <div className="label-add">
        <Suggest className="grow" prefix="延时" value={after} onChange={setAfter} items={['10m', '1h', '3h', '1d']} placeholder="2h" autoFocus onEnter={() => ready && set()} />
        <span className="faint">或定时于</span>
        <label className="suggest grow">
          <input type="datetime-local" value={at} disabled={after.trim() !== ''} onChange={(event) => setAt(event.target.value)} />
        </label>
      </div>
      <div className="label-add">
        <Suggest className="grow" prefix="重复" value={every} onChange={setEvery} items={['1h', '1d', '7d']} placeholder="不重复" onEnter={() => ready && set()} />
        <label className="suggest grow" title="发送这么多次后停止">
          <span className="prefix">次数</span>
          <input value={times} disabled={!every.trim()} onChange={(event) => setTimes(event.target.value.replace(/\D/g, ''))} placeholder="不限" inputMode="numeric" />
        </label>
      </div>
      <div className="label-add end">
        {value && (
          <button type="button" className="clear" onClick={() => onSet(null)}>
            改为立即发送
          </button>
        )}
        <button type="submit" className="send small" disabled={!ready}>
          设置
        </button>
      </div>
    </form>
  )
}
