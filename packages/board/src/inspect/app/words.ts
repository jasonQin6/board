import type { Discovery, MessageView, PrincipalView, ScheduleView } from '../../api/routes.ts'
import type { ScheduleTiming } from '../../server/index.default.ts'

// How the page says things: names, times, and sizes. Each is a few lines any UI on a board writes
// for itself, so the page keeps its own rather than reaching into the package for the CLI's.

type Named = { name: string; via?: { name: string; environment: string | null } | undefined }

/** 任务状态的说法。键是板面的状态值（URL 与 CSS 类保持原文），值是页面显示的词。 */
export const STATE_WORDS: Record<string, string> = {
  open: '打开',
  waiting: '等待中',
  ready: '就绪',
  claimed: '已认领',
  blocked: '受阻',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
  all: '全部',
}

/** An actor as people see it: `claude 经 julian`, `Malte 经 www（preview）`, or just a name. */
export function shownName(actor: Named): string {
  if (!actor.via) return actor.name
  const { name, environment } = actor.via
  return `${actor.name} 经 ${name}${environment !== null && environment !== 'production' ? `（${environment}）` : ''}`
}

/** A message's author as people see them, or their ID when the board says nothing more. */
export const authorName = (message: Pick<MessageView, 'author' | 'by'>): string => (message.author ? shownName(message.author) : message.by.actor)

/** `12 秒前`, `4 分钟前`, `3 小时前`, `2 天前`: how long ago. */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86_400)} 天前`
}

/** `120 KB`, `3.4 MB`: a file's size the way people read it. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** What went wrong, as the board or the handle said it. */
export const said = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A message's first line, for a row that shows one. */
export const firstLine = (text: string): string => text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''

/** `58:12`, or `1 小时 02 分` past an hour: how long is left. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const two = (n: number) => String(n).padStart(2, '0')
  return hours > 0 ? `${hours} 小时 ${two(minutes)} 分` : `${minutes}:${two(seconds % 60)}`
}

const REFUSALS: Record<string, string> = {
  claim_lost: '本标签页的认领已失效：它已被释放、被接管，或租约已到期。重新认领该任务才能继续。',
  task_claimed: '已有人持有这个任务，直到其租约到期',
  task_assigned: '它已指派给别人，只有那个人能认领',
  task_waiting: '它还在等待所依赖的任务',
  task_blocked: '它留给一个人处理：请先解除受阻',
  task_finished: '它已经结束了',
  task_not_owned: '这是别人的任务：由其创建者修改，或其频道里拥有 manage 权限的任何人',
  already_a_task: '这个线程已经是任务了',
  not_a_task: '这个线程不是任务',
  reserved_label: 'board. 下的标签是板面自留的：任务的相应操作会改动它们',
}

/** What a refusal means, in the page's words, or the board's own where the page has none. */
export function refusal(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return (typeof code === 'string' && REFUSALS[code]) || said(error)
}

/** Who a grant names, the way people say it. */
export function principalName(principal: PrincipalView): string {
  switch (principal.kind) {
    case 'user':
      return principal.email ?? principal.userId
    case 'project':
      return `${principal.name ?? principal.projectId} (${principal.environments.join(', ')})`
    case 'github':
      return [principal.repository, principal.workflow, principal.branch, principal.event].filter(Boolean).join(' · ')
    case 'oidc':
      return `${principal.issuer} ${Object.entries(principal.claims).map(([name, value]) => `${name}=${[value].flat().join('|')}`).join(' ')}`.trim()
    case 'app':
      return principal.name ?? principal.clientId
    case 'all-users':
      return '所有用户'
    case 'all-projects':
      return `所有项目（${principal.environments.join('、')}）`
    case 'all-apps':
      return '所有应用'
    case 'everyone':
      return '所有人'
  }
}

const SPANS: [string, number][] = [
  ['天', 86_400_000],
  ['小时', 3_600_000],
  ['分钟', 60_000],
  ['秒', 1000],
]

/** `21 小时后`, `5 分钟后`, `现在`: how long until a time, by its largest whole unit. */
export function until(iso: string, now = Date.now()): string {
  const left = Date.parse(iso) - now
  if (left < 1000) return '现在'
  const [unit, size] = SPANS.find(([, size]) => left >= size)!
  return `${Math.floor(left / size)} ${unit}后`
}

/** `1 天`, `90 分钟`, `36 小时`: a span of milliseconds in the largest unit that divides it. */
export function span(ms: number): string {
  const [unit, size] = SPANS.find(([, size]) => ms >= size && ms % size === 0) ?? ['秒', 1000]
  return `${Math.round(ms / size)} ${unit}`
}

/** How often a schedule sends, and how far along it is: `每 1 天 · 已发 2/4`. */
export function cadence(schedule: Pick<ScheduleView, 'every' | 'times' | 'sent' | 'until'>): string {
  const parts = [schedule.every === null ? '仅一次' : `每 ${span(schedule.every)}`]
  if (schedule.times !== null) parts.push(`已发 ${schedule.sent}/${schedule.times}`)
  else if (schedule.sent > 0) parts.push(`已发 ${schedule.sent} 条`)
  if (schedule.until !== null) parts.push(`至 ${new Date(schedule.until).toLocaleDateString()}`)
  return parts.join(' · ')
}

/** A time as `<input type="datetime-local">` takes one: local, to the minute. Nothing, for what isn't a time. */
export function localInput(at: string | Date): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const two = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`
}

/** A timing as the send-later form's fields start out, so reopening it to change one keeps the rest. */
export function laterFields(timing: ScheduleTiming | null): { after: string; at: string; every: string; times: string } {
  return {
    after: timing?.in ?? '',
    at: timing?.at !== undefined && timing.in === undefined ? localInput(timing.at) : '',
    every: timing?.every ?? '',
    times: timing?.times ? String(timing.times) : '',
  }
}

/** A timing in a few words: `2h 后`, `定在 11 月 12 日 9:00，每 1d`. */
export const timingWords = (later: ScheduleTiming): string =>
  [later.in ? `${later.in} 后` : later.at ? `定在 ${new Date(later.at).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '', later.every ? `每 ${later.every}` : '']
    .filter(Boolean)
    .join('，')

/**
 * Which board a page is on, in two lines: its name and its host where it has a name (a team's
 * board in Vercel's API), else its host and where on it. Before its discovery answers, just `board`.
 */
export function boardWords(discovery: Pick<Discovery, 'url' | 'name'> | null): { name: string; at: string | null } {
  if (!discovery) return { name: 'board', at: null }
  let url: URL
  try {
    url = new URL(discovery.url)
  } catch {
    return { name: discovery.name ?? discovery.url, at: null }
  }
  if (discovery.name) return { name: discovery.name, at: url.host }
  const path = url.pathname.replace(/\/+$/, '')
  return { name: url.host, at: path || null }
}
