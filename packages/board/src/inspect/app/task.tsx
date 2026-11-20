import { Circle, CircleCheck, CircleDashed, CircleDot, CirclePause, CircleSlash, CircleX, Ellipsis } from 'lucide-react'
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import * as board from './board.ts'
import { here, Link } from './nav.tsx'
import { isTask, moves, nameOf, profilesOf, stateNow, type State, type TaskRoot, type TaskState, type Viewer } from './store.ts'
import { AskForm, Menu, MenuItem, MenuSeparator, nativeMenu, Panel, type AskProps } from './ui.tsx'
import { clock, firstLine, STATE_WORDS } from './words.ts'

// A task is a thread with a state, so it shows as one more line on its root: the state, who holds
// it and for how long, who it's for, what it waits for, and how it ended. The thread pane shows the
// same in full, with what you can do to it.

const MARKS: Record<TaskState, typeof Circle> = {
  waiting: CircleDashed,
  ready: Circle,
  claimed: CircleDot,
  blocked: CirclePause,
  completed: CircleCheck,
  failed: CircleX,
  canceled: CircleSlash,
}

export function StateMark({ state }: { state: TaskState }) {
  const Icon = MARKS[state]
  return (
    <span className={`task-state ${state}`}>
      <Icon size={13} strokeWidth={2} />
      {STATE_WORDS[state] ?? state}
    </span>
  )
}

/** The time now, read again the moment a lease ends, so a claim that lapses shows as over without a reload. */
export function useLapse(until: string | undefined): number {
  const [, again] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (until === undefined) return
    const left = Date.parse(until) - Date.now()
    if (left <= 0) return
    // A timer takes at most 2^31 ms; no lease is that long.
    const timer = setTimeout(again, Math.min(left + 50, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [until])
  return Date.now()
}

/** What's left of a lease, counted down a second at a time. */
export function Lease({ until }: { until: string }) {
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [])
  const left = Date.parse(until) - Date.now()
  return (
    <span className="lease" title={`至 ${new Date(until).toLocaleString()}`}>
      {left > 0 ? `剩 ${clock(left)}` : '租约已到期'}
    </span>
  )
}

/** The tasks one waits for, each a link to its thread, with its state where the page has it. */
export function Needs({ ids, state }: { ids: string[]; state: State }) {
  return (
    <span className="needs">
      {ids.map((id) => {
        const need = state.messages[id]
        return (
          <Link key={id} to={here({ thread: id })} className="need" title={need ? firstLine(need.text) : `#${id}`}>
            #{id}
            {isTask(need) && <span className={`need-state ${stateNow(need.task, Date.now())}`}>{STATE_WORDS[stateNow(need.task, Date.now())] ?? stateNow(need.task, Date.now())}</span>}
          </Link>
        )
      })}
    </span>
  )
}

/** A task in a line, under its root. */
export function TaskLine({ root, state }: { root: TaskRoot; state: State }) {
  const { task } = root
  const now = useLapse(task.claim?.until)
  const current = stateNow(task, now)
  const lapsed = task.state === 'claimed' && current !== 'claimed'
  const finished = current === 'completed' || current === 'failed' || current === 'canceled'
  return (
    <div className="task-line" {...nativeMenu}>
      <StateMark state={current} />
      {current === 'claimed' && task.claim && (
        <>
          <span>{nameOf(state, task.claim.actor)} 认领</span>
          <Lease until={task.claim.until} />
        </>
      )}
      {lapsed && <span>租约已到期</span>}
      {task.for && !finished && <span>给 {nameOf(state, task.for)}</span>}
      {task.needs.length > 0 && !finished && (
        <span>
          等待 <Needs ids={task.needs} state={state} />
        </span>
      )}
      {current === 'blocked' && task.blocked && (
        <span className="task-note">
          {task.blocked.kind ? `${task.blocked.kind}: ` : ''}
          {task.blocked.reason}
        </span>
      )}
      {current === 'completed' && task.result && <span className="task-note">{task.result}</span>}
      {(current === 'failed' || current === 'canceled') && task.reason && <span className="task-note">{task.reason}</span>}
    </div>
  )
}

/** A profile's actor under a principal, as the board writes one: the profile in lowercase. */
export const actorFor = (principal: string, profile: string) => `${principal}+${profile.trim().toLowerCase()}`

/** `#17 19, 21` as task IDs. */
export const taskIds = (text: string): string[] => [...new Set(text.split(/[\s,]+/).map((id) => id.replace(/^#/, '')).filter(Boolean))]

const HOLD_KINDS = ['needs_input', 'awaiting_approval']

/** What a task's card asks about before it acts. */
type Asked = 'complete' | 'fail' | 'block' | 'assign' | 'cancel'

/** A task in full, at the top of its thread: its facts, and what you can do to it now. */
export function TaskCard({ root, state, viewer }: { root: TaskRoot; state: State; viewer: Viewer }) {
  const { task } = root
  const now = useLapse(task.claim?.until)
  const current = stateNow(task, now)
  const lapsed = task.state === 'claimed' && current !== 'claimed'
  const can = moves(state, root, viewer, now)
  const [busy, setBusy] = useState(false)
  const run = (write: Promise<unknown>) => {
    setBusy(true)
    void write.finally(() => setBusy(false))
  }
  // What it waits for may be anywhere on the board: each need's thread says its state.
  const needs = task.needs.join(' ')
  useEffect(() => {
    for (const id of task.needs) if (!board.getState().messages[id]) void board.loadThread(id)
  }, [needs])

  // What you'd most likely do next is a button; everything else is in one menu, and asks in the same place.
  const [asking, setAsking] = useState<Asked | null>(null)
  const acts = useRef<HTMLDivElement>(null)
  const next: ReactNode[] = []
  if (can.claim)
    next.push(
      <button key="claim" className="act primary" disabled={busy} onClick={() => run(board.claimTask(root.id))}>
        认领
      </button>,
    )
  if (can.held)
    next.push(
      <button key="complete" className="act primary" disabled={busy} onClick={() => setAsking('complete')}>
        完成…
      </button>,
      <button key="release" className="act" disabled={busy} title="交还：它回到就绪" onClick={() => run(board.releaseTask(root.id))}>
        释放
      </button>,
    )
  if (can.unblock)
    next.push(
      <button key="unblock" className="act primary" disabled={busy} onClick={() => run(board.unblockTask(root.id))}>
        解除受阻
      </button>,
    )
  if (can.reopen)
    next.push(
      <button key="reopen" className="act primary" disabled={busy} title="原地恢复为就绪" onClick={() => run(board.reopenTask(root.id))}>
        重新打开
      </button>,
    )
  const more: ReactNode[] = []
  if (can.held)
    more.push(
      <MenuItem key="renew" onClick={() => run(board.renewTask(root.id))}>
        续租
      </MenuItem>,
      <MenuItem key="fail" onClick={() => setAsking('fail')}>
        标记失败…
      </MenuItem>,
    )
  if (can.held || can.hold)
    more.push(
      <MenuItem key="block" onClick={() => setAsking('block')}>
        留给一个人处理…
      </MenuItem>,
    )
  if (can.assign)
    more.push(
      <MenuItem key="assign" onClick={() => setAsking('assign')}>
        指派…
      </MenuItem>,
    )
  if (can.assign && task.for !== null)
    more.push(
      <MenuItem key="pool" onClick={() => run(board.assignTask(root.id, null))}>
        退回池子
      </MenuItem>,
    )
  if (can.cancel)
    more.push(
      <MenuSeparator key="separator" />,
      <MenuItem key="cancel" danger onClick={() => setAsking('cancel')}>
        取消任务…
      </MenuItem>,
    )
  const asks: Record<Asked, { title: string } & AskProps> = {
    complete: {
      title: '完成任务',
      submit: '完成',
      fields: [{ name: 'result', placeholder: '结果如何，一两句话（可选）', long: true }],
      onSubmit: ({ result }) => run(board.completeTask(root.id, result || undefined)),
    },
    fail: {
      title: '说明失败原因',
      submit: '失败',
      fields: [{ name: 'reason', placeholder: '它为什么失败', required: true, long: true }],
      onSubmit: ({ reason }) => run(board.failTask(root.id, reason!)),
    },
    block: {
      title: '把任务留给一个人',
      submit: '留下',
      note: can.held ? '这会结束你的认领。' : undefined,
      fields: [
        { name: 'kind', placeholder: '类型，如 needs_input（可选）', items: HOLD_KINDS },
        { name: 'reason', placeholder: '需要一个人来回答的问题', required: true, long: true },
      ],
      onSubmit: ({ kind, reason }) => run(board.blockTask(root.id, reason!, kind || undefined)),
    },
    assign: {
      title: `指派给 ${nameOf(state, task.owner)} 的一个身份`,
      submit: '指派',
      note: '之后只有那个身份能认领它。',
      fields: [{ name: 'profile', placeholder: '身份，如 fixer', required: true, items: profilesOf(state, task.owner) }],
      onSubmit: ({ profile }) => run(board.assignTask(root.id, actorFor(task.owner, profile!))),
    },
    cancel: {
      title: '取消任务',
      submit: '取消任务',
      note: current === 'claimed' ? '这会结束当前持有者的认领。' : undefined,
      fields: [{ name: 'reason', placeholder: '为什么不再需要它', required: true, long: true }],
      onSubmit: ({ reason }) => run(board.cancelTask(root.id, reason!)),
    },
  }

  return (
    <section className="task-card">
      <div className="task-head" {...nativeMenu}>
        <StateMark state={current} />
        {current === 'claimed' && task.claim && (
          <>
            <span>{nameOf(state, task.claim.actor)} 认领</span>
            <Lease until={task.claim.until} />
          </>
        )}
        {lapsed && task.claim && <span>{nameOf(state, task.claim.actor)} 的租约已到期</span>}
      </div>
      <dl className="facts" {...nativeMenu}>
        <dt>创建者</dt>
        <dd>{nameOf(state, task.owner)}</dd>
        {task.for && (
          <>
            <dt>负责</dt>
            <dd>{nameOf(state, task.for)}</dd>
          </>
        )}
        {task.needs.length > 0 && (
          <>
            <dt>等待</dt>
            <dd>
              <Needs ids={task.needs} state={state} />
            </dd>
          </>
        )}
        {task.blocked && (
          <>
            <dt>留置</dt>
            <dd>
              {task.blocked.kind && <span className="badge">{task.blocked.kind}</span>} {task.blocked.reason}
            </dd>
          </>
        )}
        {task.result && (
          <>
            <dt>结果</dt>
            <dd>{task.result}</dd>
          </>
        )}
        {task.reason && (
          <>
            <dt>原因</dt>
            <dd>{task.reason}</dd>
          </>
        )}
      </dl>
      {(next.length > 0 || more.length > 0) && (
        <div className="acts" ref={acts}>
          {next}
          {more.length > 0 && (
            <Menu className="act" title="更多" trigger={<Ellipsis size={14} strokeWidth={1.75} />}>
              {more}
            </Menu>
          )}
        </div>
      )}
      {asking && (
        <Panel title={asks[asking].title} open onOpenChange={(open) => !open && setAsking(null)} anchor={acts}>
          <AskForm {...asks[asking]} disabled={busy} onDone={() => setAsking(null)} />
        </Panel>
      )}
      {can.held && <p className="hint">由本标签页持有：刷新会丢失认领。</p>}
      {can.elsewhere && <p className="hint">是你的，但不在本标签页：租约到期前一直由别处持有。</p>}
    </section>
  )
}
