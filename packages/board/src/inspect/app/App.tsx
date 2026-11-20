import { ListTodo, PanelLeftOpen, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { MessageView, SyncedView } from '../../api/routes.ts'
import * as board from './board.ts'
import { setEditing } from './chrome.ts'
import { Composer } from './composer.tsx'
import { Feed, Toasts } from './feed.tsx'
import { Messages, Pendings, type RowOptions } from './message.tsx'
import { here, Link, navigate, route, useLocation, useNow, useTypeToFocus } from './nav.tsx'
import { Settings } from './settings.tsx'
import { Sidebar } from './sidebar.tsx'
import { actorFor, TaskCard, taskIds } from './task.tsx'
import { Tasks } from './tasks.tsx'
import { FilterButton, FilterChips } from './filters.tsx'
import { byWritten, channelRows, channelThreads, filtering, isTask, knownLabels, listingOf, matches, profilesOf, recent, thread as threadOf, threadSchedules, type Filter, type State, type Viewer } from './store.ts'
import { Ask, Header, nativeMenu, ResizeHandle, type KnownLabels } from './ui.tsx'
import { boardWords, cadence, firstLine, until } from './words.ts'

const count = (n: number, noun: string) => `${n} ${noun}`

/** 标签页标题里的视图名（路径与 URL 保持原文）。 */
const VIEW_TITLES = { activity: '动态', tasks: '任务' } as const

// --- sizes you drag, remembered -------------------------------------------------------

function stored(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key))
    return Number.isFinite(value) && value > 0 ? value : fallback
  } catch {
    return fallback
  }
}
function remember(key: string, value: number | string) {
  try {
    localStorage.setItem(key, String(value))
  } catch {}
}

const SIDEBAR = { min: 180, max: 400, collapse: 150, key: 'board.sidebar-width', collapsedKey: 'board.sidebar-collapsed' }
const PANE = { min: 320, key: 'board.pane-width' }

function useSidebar() {
  const [width, setWidth] = useState(() => Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, stored(SIDEBAR.key, 224))))
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR.collapsedKey) === '1'
    } catch {
      return false
    }
  })
  // The release reads the latest position, which may not have rendered yet.
  const [dragging, setDragging] = useState<number | null>(null)
  const latest = useRef<number | null>(null)
  const collapse = (value: boolean) => {
    setCollapsed(value)
    remember(SIDEBAR.collapsedKey, value ? '1' : '0')
  }
  const commit = (next: number) => {
    setWidth(next)
    remember(SIDEBAR.key, next)
  }
  return {
    width: dragging ?? width,
    collapsed,
    collapse,
    /** Dragged under the minimum it fades; let go below the threshold and it collapses. */
    fade: dragging !== null && dragging < SIDEBAR.min ? Math.max(0.25, (dragging - 60) / (SIDEBAR.min - 60)) : 1,
    drag: (x: number) => {
      latest.current = Math.min(SIDEBAR.max, Math.max(60, x))
      setDragging(latest.current)
    },
    done: () => {
      const at = latest.current
      latest.current = null
      setDragging(null)
      if (at === null) return
      if (at < SIDEBAR.collapse) collapse(true)
      else commit(Math.max(SIDEBAR.min, at))
    },
    step: (delta: number) => commit(Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, width + delta))),
  }
}

function usePane() {
  const clamp = (value: number) => Math.min(Math.max(PANE.min, innerWidth * 0.7), Math.max(PANE.min, value))
  const [width, setWidth] = useState(() => stored(PANE.key, 440))
  const [dragging, setDragging] = useState<number | null>(null)
  const latest = useRef<number | null>(null)
  const commit = (next: number) => {
    setWidth(next)
    remember(PANE.key, next)
  }
  return {
    width: clamp(dragging ?? width),
    drag: (x: number) => {
      latest.current = clamp(innerWidth - x)
      setDragging(latest.current)
    },
    done: () => {
      const at = latest.current
      latest.current = null
      setDragging(null)
      if (at !== null) commit(at)
    },
    step: (delta: number) => commit(clamp(width - delta)),
  }
}

/** Who you post as, asked before anything loads: the page acts as its app, so you write as a profile of it, `ada via factory`. */
function NameGate({ done }: { done: () => void }) {
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="boot">
      <form
        className="name-gate"
        onSubmit={(event) => {
          event.preventDefault()
          const name = new FormData(event.currentTarget).get('profile')?.toString().trim()
          if (!name) return
          void board.setProfile({ name }).then((took) => (took ? done() : setError(`无法以 ${name} 发言`)))
        }}
      >
        <label htmlFor="profile">谁在发言？</label>
        <p>你将以本应用的一个身份发言，显示为「你的名字 经本应用」。</p>
        <input id="profile" name="profile" autoFocus placeholder="你的名字，如 ada" pattern="[A-Za-z][A-Za-z0-9\-]{0,31}" title="字母开头，其后最多 31 个字母、数字或连字符" required />
        {error && <p className="error">{error}</p>}
        <button type="submit" className="send">
          继续
        </button>
      </form>
    </div>
  )
}

// --- the app -----------------------------------------------------------------------

export function App() {
  const state = board.useBoard()
  const where = useLocation()
  const now = useNow()
  const [failed, setFailed] = useState<string | null>(null)
  const sidebar = useSidebar()
  const pane = usePane()
  // On a narrow page the sidebar is out of the way until it's asked for, and goes again once you've picked.
  const [nav, setNav] = useState(false)
  useEffect(() => setNav(false), [where.path])

  // Served from an app, the page reads nothing until you've named who you post as.
  const [naming, setNaming] = useState(board.needsName)
  useEffect(() => {
    if (!naming) board.boot().catch((error: Error) => setFailed(error.message))
  }, [naming])

  // Old links: /t/12 is the thread pane over the activity view, and a sync entry's inbox is in settings.
  useEffect(() => {
    const old = /^\/t\/(\d+)$/.exec(where.path)
    if (old) navigate(`/?thread=${old[1]}`, true)
    const inbox = /^\/inbox\/(.+)$/.exec(where.path)
    if (inbox) navigate(`/settings/sync/${inbox[1]}`, true)
    if (where.path === '/settings') navigate('/settings/access', true)
  }, [where.path])

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || where.thread === null) return
      if ((event.target as HTMLElement).closest('textarea, input, [role="menu"], [role="dialog"]')) return
      navigate(here({ thread: null }))
    }
    addEventListener('keydown', close)
    return () => removeEventListener('keydown', close)
  }, [where])

  const current = route(where.path)
  // The tab says which board too, so two inspectors side by side tell apart.
  const named = boardWords(state.discovery).name
  useEffect(() => {
    document.title = `${current.view === 'channel' ? `#${current.channel}` : current.view === 'settings' ? '设置' : current.view === 'missing' ? '无此页面' : VIEW_TITLES[current.view]} · ${named}`
  }, [where.path, named])

  const known = useMemo(() => knownLabels(state), [state.messages])
  const viewer = useMemo(() => (state.me ? board.viewerOf(state.me) : null), [state.me])

  if (naming) return <NameGate done={() => setNaming(false)} />
  if (failed) return <div className="boot error">错误：{failed}</div>
  if (!state.me || !viewer) return <div className="boot">连接中…</div>

  const platforms = Object.fromEntries((state.discovery?.sync ?? []).map((entry) => [entry.key, entry.platform]))
  const names = namesOf(state)
  const options: RowOptions = { me: state.me.actor, now, known, platforms, board: state, schemas: state.schemas, names, openThread: (id) => navigate(here({ thread: id })) }
  const filter = where.filter
  const setFilter = (next: Filter) => navigate(here({ filter: next }), true)
  const sources = (state.discovery?.sync ?? []).map((entry) => entry.key)
  const filters = { filter, setFilter, sources, known }
  const expand = (
    <button
      className={`tool${sidebar.collapsed ? '' : ' only-narrow'}`}
      title="显示侧栏"
      onClick={() => {
        sidebar.collapse(false)
        setNav(true)
      }}
    >
      <PanelLeftOpen size={15} strokeWidth={1.75} />
    </button>
  )
  return (
    <div className={`shell${nav ? ' nav' : ''}`}>
      {nav && <div className="scrim" onClick={() => setNav(false)} />}
      {!sidebar.collapsed && (
        <nav className="sidebar" style={{ width: sidebar.width, opacity: sidebar.fade }}>
          <Sidebar
            state={state}
            current={current}
            onCollapse={() => {
              if (nav) setNav(false)
              else sidebar.collapse(true)
            }}
          />
          <ResizeHandle side="right" label="拖动调整侧栏宽度" onDrag={sidebar.drag} onDone={sidebar.done} onStep={sidebar.step} />
        </nav>
      )}
      <main className="main">
        {current.view === 'activity' && <Activity state={state} options={options} known={known} lead={expand} filters={filters} />}
        {current.view === 'channel' && (
          <Channel key={current.channel} channel={current.channel} state={state} options={options} known={known} lead={expand} filters={filters} />
        )}
        {current.view === 'tasks' && <Tasks state={state} now={now} lead={expand} where={where} known={known} />}
        {current.view === 'settings' && <Settings state={state} viewer={viewer} now={now} lead={expand} where={where} section={current.section} open={current.open} />}
        {current.view === 'missing' && (
          <>
            <Header title="无此页面" lead={expand} />
            <p className="empty">没有这个页面</p>
          </>
        )}
      </main>
      {where.thread !== null && (
        <aside className="pane" style={{ width: pane.width }}>
          <ResizeHandle side="left" label="拖动调整线程面板宽度" onDrag={pane.drag} onDone={pane.done} onStep={pane.step} />
          <ThreadPane key={where.thread} id={where.thread} state={state} viewer={viewer} now={now} known={known} />
        </aside>
      )}
      <Toasts />
    </div>
  )
}

// --- views ---------------------------------------------------------------------------

/** Your newest message among `messages`, for ↑ to edit. */
const lastOwn = (messages: MessageView[], me: string) => [...messages].reverse().find((m) => m.by.actor === me && !m.deleted)

type Filters = { filter: Filter; setFilter: (filter: Filter) => void; sources: string[]; known: KnownLabels }

function FilterControls({ filters }: { filters: Filters }) {
  return <FilterButton filter={filters.filter} onChange={filters.setFilter} sources={filters.sources} known={filters.known} />
}

const NAMES = new WeakMap<State['actors'], Record<string, string>>()
/**
 * Every actor the page knows, by ID, by their own name, which a mention of them reads as: the same
 * record until one of them changes, so a row's text renders once. Not a hook: it's read after the
 * views' early returns.
 */
function namesOf(state: State): Record<string, string> {
  let names = NAMES.get(state.actors)
  if (!names) NAMES.set(state.actors, (names = Object.fromEntries(Object.entries(state.actors).map(([id, actor]) => [id, actor.name]))))
  return names
}

function Activity(props: { state: State; options: RowOptions; known: KnownLabels; lead: ReactNode; filters: Filters }) {
  const { state, options, known, lead } = props
  const { filter } = props.filters
  useTypeToFocus('main')
  const key = JSON.stringify(filter)
  useEffect(() => {
    if (filtering(filter)) void board.loadFiltered(undefined, filter)
  }, [key])
  const messages = useMemo(
    () => recent(state, 200, filtering(filter) ? (m) => matches(state, m, filter) : undefined),
    [state.messages, state.ops, state.actors, key],
  )
  const pending = filtering(filter) ? [] : state.pending.filter((post) => post.re === null)
  return (
    <>
      <Header title="动态" meta={state.activityRefused === null ? '所有频道的最新消息' : '本页已加载内容的最新消息'} live={state.live} lead={lead}>
        <FilterControls filters={props.filters} />
      </Header>
      <FilterChips filter={filter} onChange={props.filters.setFilter} />
      <Feed scope="activity" first={messages[0]?.id ?? ''} last={`${messages.at(-1)?.id ?? ''}+${pending.length}`}>
        {/* A board that can't read its feed's newest events across channels: its own words, where they would be. */}
        {state.activityRefused !== null && <p className="empty error">{state.activityRefused}</p>}
        {state.activityRefused === null && messages.length === 0 && pending.length === 0 && (
          <p className="empty">{filtering(filter) ? '没有符合筛选条件的内容' : state.cursor === null ? '加载中…' : '还没有内容：在下方发起一个线程'}</p>
        )}
        <Messages
          messages={messages}
          now={options.now}
          options={{
            ...options,
            context: (m) => (
              <span className="where">
                {m.re === null ? '在 ' : '回复于 '}
                <Link to={`/c/${m.channel}${m.re === null ? '' : `?thread=${m.re}`}`}>#{m.channel}</Link>
              </span>
            ),
          }}
        />
        <Pendings posts={pending} me={state.me!} after={messages.at(-1)} />
      </Feed>
      <Composer
        scope="activity"
        role="main"
        placeholder="发起线程…"
        known={known}
        channels={Object.keys(state.channels).sort()}
        tasks={{ state }}
        onSend={({ text, noSync, channel, labels, files, task, later }) => void board.send({ channel, re: null, text, noSync, labels, files, ...(task ? { task } : {}), ...(later ? { later } : {}) })}
        onEditLast={() => {
          const mine = lastOwn(messages, state.me!.actor)
          if (mine) setEditing(mine.id)
        }}
      />
    </>
  )
}

function Channel(props: { channel: string; state: State; options: RowOptions; known: KnownLabels; lead: ReactNode; filters: Filters }) {
  const { channel, state, options } = props
  const { filter } = props.filters
  useTypeToFocus('main')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    void board.loadChannel(channel).finally(() => setLoading(false))
  }, [channel])
  const key = JSON.stringify(filter)
  useEffect(() => {
    if (filtering(filter)) void board.loadFiltered(channel, filter)
  }, [channel, key])
  // The board's thread list, by latest activity; a filter, or a board from before `older`, the messages loaded.
  const listed = !!listingOf(state, channel) && !filtering(filter)
  const { threads: all, pending: posts } = useMemo(
    () => (listed ? channelRows(state, channel) : channelThreads(state, channel)),
    [state.messages, state.ops, state.pending, state.actors, state.listings, listed, channel],
  )
  // A filtered channel shows the threads where anything matches.
  const threads = filtering(filter) ? all.filter((t) => matches(state, t.root, filter) || t.replies.some((r) => matches(state, r, filter))) : all
  const pending = filtering(filter) ? [] : posts
  const roots = threads.map((t) => t.root)
  const summaries = new Map(threads.map((t) => [t.root.id, t.summary]))
  const info = state.channels[channel]
  const newest = listed
    ? (threads.at(-1)?.summary.last ?? threads.at(-1)?.root)?.id ?? ''
    : [...roots, ...threads.flatMap((t) => t.replies)].sort(byWritten).at(-1)?.id ?? ''
  const activeAt = (m: MessageView) => summaries.get(m.id)?.last?.createdAt ?? m.createdAt
  return (
    <>
      <Header
        title={`#${channel}`}
        meta={info?.threads !== undefined && info.messages !== undefined ? `${count(info.threads, '个线程')} · ${count(info.messages, '条消息')}` : undefined}
        live={state.live}
        lead={props.lead}
      >
        <FilterControls filters={props.filters} />
      </Header>
      <FilterChips filter={filter} onChange={props.filters.setFilter} />
      <Feed scope={channel} first={roots[0]?.id ?? ''} last={`${newest}+${pending.length}`} older={() => board.loadOlder(channel)}>
        {roots.length === 0 && pending.length === 0 && (
          <p className="empty">{loading ? '加载中…' : filtering(filter) ? '没有符合筛选条件的内容' : '还没有消息：说点什么吧'}</p>
        )}
        <Messages messages={roots} now={options.now} options={{ ...options, summary: (m) => summaries.get(m.id) }} {...(listed ? { at: activeAt } : {})} />
        <Pendings posts={pending} me={state.me!} after={roots.at(-1)} afterHasReplies={(summaries.get(roots.at(-1)?.id ?? '')?.count ?? 0) > 0} />
      </Feed>
      <Composer
        scope={`channel:${channel}`}
        role="main"
        placeholder={`发消息到 #${channel}…`}
        known={props.known}
        tasks={{ state }}
        onSend={({ text, noSync, labels, files, task, later }) => void board.send({ channel, re: null, text, noSync, labels, files, ...(task ? { task } : {}), ...(later ? { later } : {}) })}
        onEditLast={() => {
          const mine = lastOwn(roots, state.me!.actor)
          if (mine) setEditing(mine.id)
        }}
      />
    </>
  )
}

function ThreadPane(props: { id: string; state: State; viewer: Viewer; now: number; known: KnownLabels }) {
  const { id, state, viewer } = props
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    void board.loadThread(id).then(() => setMissing(!board.getState().messages[id]))
  }, [id])
  const t = useMemo(() => threadOf(state, id), [state.messages, state.ops, state.pending, state.actors, id])
  // Where the thread's copies are, on the platforms it syncs with.
  const [synced, setSynced] = useState<SyncedView['targets']>([])
  useEffect(() => {
    void board.loadSynced(id).then(setSynced)
  }, [id])
  const scheduled = threadSchedules(state, id)
  const platforms = Object.fromEntries((state.discovery?.sync ?? []).map((entry) => [entry.key, entry.platform]))
  const names = namesOf(state)
  const options: RowOptions = { me: state.me!.actor, now: props.now, known: props.known, platforms, schemas: state.schemas, names }
  return (
    <>
      <Header title={isTask(t?.root) ? '任务' : '线程'} meta={t ? `在 #${t.root.channel}` : undefined}>
        {t && !isTask(t.root) && !t.root.deleted && viewer.may('label', t.root.channel) && (
          <Ask
            label={<ListTodo size={15} strokeWidth={1.75} />}
            className="tool"
            title="把这个线程变成任务"
            submit="设为任务"
            note="你拥有它，代理来认领它。"
            fields={[
              { name: 'needs', placeholder: 'needs：它等待的任务 ID（可选）' },
              { name: 'for', placeholder: 'for：你的某个身份（可选）', items: profilesOf(state, viewer.principal) },
            ]}
            onSubmit={(values) => void board.makeTask(id, { needs: taskIds(values.needs ?? ''), for: values.for ? actorFor(viewer.principal, values.for) : null })}
          />
        )}
        <button className="tool" title="关闭（Esc）" onClick={() => navigate(here({ thread: null }))}>
          <X size={15} strokeWidth={1.75} />
        </button>
      </Header>
      {t && isTask(t.root) && <TaskCard root={t.root} state={state} viewer={viewer} />}
      {(synced.length > 0 || scheduled.length > 0) && (
        <dl className="facts thread-facts" {...nativeMenu}>
          {synced.length > 0 && (
            <>
              <dt>已同步</dt>
              <dd className="copies">
                {synced.map((copy) => (
                  <span key={copy.target}>
                    {copy.url ? (
                      <a href={copy.url} target="_blank" rel="noreferrer" className="text-link">
                        {copy.target}
                      </a>
                    ) : (
                      copy.target
                    )}
                    {copy.undelivered && <span className="error-text"> 未送达：{copy.undelivered}</span>}
                  </span>
                ))}
              </dd>
            </>
          )}
          {scheduled.map((schedule) => (
            <div key={schedule.id} className="fact">
              <dt>定时</dt>
              <dd>
                {schedule.next ? until(schedule.next, props.now) : ''} · {cadence(schedule)} · {firstLine(schedule.text)}{' '}
                {(schedule.by.principal === viewer.principal || viewer.may('manage', schedule.channel)) && (
                  <button className="clear" onClick={() => void board.cancelSchedule(schedule.id)}>
                    取消
                  </button>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <Feed scope={`thread:${id}`} first={id} last={`${t?.replies.at(-1)?.id ?? id}+${t?.pending.length ?? 0}`}>
        {!t ? (
          <p className="empty">{missing ? '没有这个线程' : '加载中…'}</p>
        ) : (
          <>
            <Messages messages={[t.root]} now={props.now} options={options} />
            <div className="divider">{t.replies.length} 条回复</div>
            <Messages messages={t.replies} now={props.now} options={options} after={t.root} />
            <Pendings posts={t.pending} me={state.me!} after={t.replies.at(-1)} />
          </>
        )}
      </Feed>
      {t && (
        <Composer
          scope={`thread:${id}`}
          role="thread"
          placeholder="回复线程…"
          known={props.known}
          onSend={({ text, noSync, labels, files, later }) => void board.send({ channel: t.root.channel, re: id, text, noSync, labels, files, ...(later ? { later } : {}) })}
          onEditLast={() => {
            const mine = lastOwn([t.root, ...t.replies], state.me!.actor)
            if (mine) setEditing(mine.id)
          }}
        />
      )}
    </>
  )
}
