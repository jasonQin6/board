"use client";

import { useEffect, useMemo, useState } from "react";
import { ask, say, stop, thread } from "@/lib/client";
import type { Line, RunView, Snapshot, Task } from "@/lib/swarm";
import { WebMcp } from "@/components/webmcp";

/** What a task shows as: its state, with a claim split by whether its lease still holds. */
type Shown = "working" | "stalled" | "held" | "ready" | "waiting" | "done" | "failed" | "canceled";
const GROUPS: { key: Shown; title: string }[] = [
  { key: "working", title: "进行中" },
  { key: "stalled", title: "已停滞" },
  { key: "held", title: "留给一个人" },
  { key: "ready", title: "就绪" },
  { key: "waiting", title: "等待中" },
  { key: "done", title: "已完成" },
  { key: "failed", title: "失败" },
  { key: "canceled", title: "已取消" },
];

/** 任务呈现状态的说法（data-state 与键名保持原文）。 */
const SHOWN_WORDS: Record<Shown, string> = {
  working: "进行中",
  stalled: "已停滞",
  held: "留置",
  ready: "就绪",
  waiting: "等待中",
  done: "已完成",
  failed: "失败",
  canceled: "已取消",
};

/** 运行阶段的说法（data-phase 与键名保持原文）。 */
const PHASE_WORDS: Record<string, string> = {
  preparing: "准备中",
  running: "运行中",
  done: "已完成",
  stopped: "已停止",
  failed: "失败",
};

/** The states a task has ended in. */
const ENDED = ["completed", "failed", "canceled"];

type History = Awaited<ReturnType<typeof thread>>;

const shown = (task: Task, now: number): Shown =>
  task.state === "claimed"
    ? task.lease && Date.parse(task.lease) < now
      ? "stalled"
      : "working"
    : task.state === "blocked"
      ? "held"
      : task.state === "completed"
        ? "done"
        : task.state;

/** `swarm/perf` is in `swarm/perf`, and in `swarm`'s subtree. */
const within = (channel: string, filter: string | null) => !filter || channel === filter || channel.startsWith(`${filter}/`);

function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  if (s < 86_400) return `${Math.floor(s / 3600)} 小时`;
  return `${Math.floor(s / 86_400)} 天`;
}
const ago = (at: string, now: number) => `${span(now - Date.parse(at))}前`;
const firstLine = (text: string) => text.split("\n", 1)[0] || "（空）";

export function Swarm({ first, channel: firstChannel, task: firstTask }: { first: Snapshot; channel: string | null; task: string | null }) {
  const [snap, setSnap] = useState(first);
  const [live, setLive] = useState<"live" | "reconnecting" | { problem: string }>("live");
  const [channel, setChannel] = useState(firstChannel);
  const [open, setOpen] = useState(firstTask);
  // The server's clock until the page is mounted, so the first render matches the server's.
  const [now, setNow] = useState(() => Date.parse(first.at));

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  // The live feed. EventSource reconnects on its own, and each connection starts with a snapshot,
  // so a dropped one costs nothing but the wait.
  useEffect(() => {
    const source = new EventSource("/api/live");
    source.addEventListener("snapshot", (event) => {
      setSnap(JSON.parse((event as MessageEvent<string>).data) as Snapshot);
      setLive("live");
      setNow(Date.now());
    });
    source.addEventListener("ping", () => setLive("live"));
    source.addEventListener("problem", (event) => setLive({ problem: (JSON.parse((event as MessageEvent<string>).data) as { message: string }).message }));
    source.onerror = () => setLive((state) => (state === "live" ? "reconnecting" : state));
    return () => source.close();
  }, []);

  // The view lives in the link, so a copied one reopens it: ?ch=swarm/perf&task=<id>
  useEffect(() => {
    const query = [channel && `ch=${encodeURIComponent(channel).replaceAll("%2F", "/")}`, open && `task=${encodeURIComponent(open)}`].filter(Boolean);
    window.history.replaceState(null, "", query.length ? `?${query.join("&")}` : window.location.pathname);
  }, [channel, open]);

  // A run is shown by its goal, with its own log (its thread in the runs channel) beside its tasks.
  const run = useMemo(() => snap.runs.find((entry) => entry.channel === channel) ?? null, [snap, channel]);
  const ofRun = (line: Line, of: RunView) => line.channel === snap.runsChannel && (line.id === of.thread || line.re === of.thread);
  const tasks = useMemo(() => snap.tasks.filter((task) => within(task.channel, channel)), [snap, channel]);
  const flow = useMemo(() => snap.flow.filter((line) => within(line.channel, channel) || (run !== null && ofRun(line, run))), [snap, channel, run]);
  const where = (line: Line) => {
    if (line.channel === snap.runsChannel) return snap.runs.find((entry) => entry.thread === (line.re ?? line.id))?.slug ?? "runs";
    return line.channel.slice(snap.swarm.length) || line.channel;
  };

  const groups = useMemo(() => {
    const by = new Map<Shown, Task[]>();
    for (const task of tasks) {
      const key = shown(task, now);
      by.set(key, [...(by.get(key) ?? []), task]);
    }
    return GROUPS.map((group) => ({ ...group, tasks: by.get(group.key) ?? [] })).filter((group) => group.tasks.length > 0);
  }, [tasks, now]);

  const channels = useMemo(() => {
    const open = new Map<string, number>();
    for (const line of snap.flow) open.set(line.channel, open.get(line.channel) ?? 0);
    for (const task of snap.tasks) open.set(task.channel, (open.get(task.channel) ?? 0) + (ENDED.includes(task.state) ? 0 : 1));
    // Runs are listed by their goal, above: what's left are channels agents joined from JOIN.md.
    const runChannels = new Set([snap.runsChannel, ...snap.runs.map((entry) => entry.channel)]);
    return [...open].filter(([path]) => !runChannels.has(path)).sort(([a], [b]) => a.localeCompare(b));
  }, [snap]);

  // Choosing another run or channel closes a task of another one: the panel shows what's selected.
  const pick = (next: string | null) => {
    setChannel(next);
    const shownTask = open ? snap.tasks.find((task) => task.id === open) : null;
    if (shownTask && !within(shownTask.channel, next)) setOpen(null);
  };

  const openIn = (path: string) => snap.tasks.filter((task) => task.channel === path && !ENDED.includes(task.state)).length;

  // Who's here: everyone holding a task, and everyone who wrote lately.
  const agents = useMemo(() => {
    const seen = new Map<string, { holding: number; last: string | null }>();
    for (const line of [...flow].reverse()) seen.set(line.author, { holding: 0, last: line.at });
    for (const task of tasks) {
      if (task.state !== "claimed" || !task.holder) continue;
      const agent = seen.get(task.holder) ?? { holding: 0, last: null };
      seen.set(task.holder, { ...agent, holding: agent.holding + 1 });
    }
    return [...seen].sort(([, a], [, b]) => b.holding - a.holding || (b.last ?? "").localeCompare(a.last ?? ""));
  }, [flow, tasks]);

  // The counts and the agents follow what's selected: one run's, or the whole swarm's.
  const count = (key: Shown) => tasks.filter((task) => shown(task, now) === key).length;
  const selected = open ? snap.tasks.find((task) => task.id === open) ?? null : null;

  return (
    <div className="shell">
      <WebMcp snap={snap} show={setOpen} />
      <header>
        <h1>{snap.name} Board</h1>
        <span className="state" data-live={typeof live === "string" ? live : "down"}>
          <i aria-hidden />
          {typeof live === "string" ? (live === "live" ? "实时" : "重连中") : `掉线：${live.problem}`}
        </span>
        <span className="counts">
          进行中 <b>{count("working")}</b> · 就绪 <b>{count("ready")}</b> · 留置 <b>{count("held")}</b> · 已完成{" "}
          <b>
            {count("done")}
            {snap.finishedCapped ? "+" : ""}
          </b>
          {count("stalled") > 0 && (
            <>
              {" · "}
              停滞 <b className="bad">{count("stalled")}</b>
            </>
          )}
        </span>
      </header>

      <nav className="pane" aria-label="频道与代理">
        {snap.runs.length > 0 && (
          <>
            <h2>运行</h2>
            <ul>
              {snap.runs.map((entry) => (
                <li key={entry.slug}>
                  <button type="button" className="run" aria-pressed={channel === entry.channel} onClick={() => pick(entry.channel)} title={entry.goal}>
                    <span className="text">{entry.title}</span>
                    <span className="faint run-meta">
                      <i data-phase={entry.phase} aria-hidden />
                      {PHASE_WORDS[entry.phase] ?? entry.phase} · {openIn(entry.channel)} 个打开 · ${entry.cost.toFixed(2)} · {ago(entry.createdAt, now)}</span>
                    <span className="faint run-meta">
                      {entry.slug}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <h2>频道</h2>
        <ul>
          <li>
            <button type="button" aria-pressed={!channel} onClick={() => pick(null)}>
              <span>{snap.swarm}</span>
              <span className="faint">全部</span>
            </button>
          </li>
          {channels.map(([path, open]) => (
            <li key={path}>
              <button type="button" aria-pressed={channel === path} onClick={() => pick(path)}>
                <span>{path.slice(snap.swarm.length) || path}</span>
                <span className="faint">{open || ""}</span>
              </button>
            </li>
          ))}
        </ul>
        <h2>代理</h2>
        <ul>
          {agents.length === 0 && <li className="faint pad">还没有</li>}
          {agents.map(([handle, agent]) => (
            <li key={handle} className="agent">
              <span className="who" title={handle}>
                {handle}
              </span>
              <span className="faint">{agent.holding > 0 ? `持有 ${agent.holding} 个` : agent.last ? ago(agent.last, now) : ""}</span>
            </li>
          ))}
        </ul>
      </nav>

      <section className="pane" aria-label="动态流">
        {run ? <RunBar run={run} tasks={tasks} now={now} show={setOpen} /> : null}
        <h2>动态流</h2>
        {flow.length === 0 ? (
          <p className="faint pad">
            {run ? "还没有内容：运行在克隆仓库并做规划时，日志会显示在这里。" : "这里还没有内容。从启动器发起一次运行，或让代理按 JOIN.md 加入。"}
          </p>
        ) : (
          <ul className="rows">
            {flow.map((line) => (
              <li key={line.id}>
                <button type="button" onClick={() => setOpen(line.re ?? line.id)} title={line.text}>
                  <time>{ago(line.at, now)}</time>
                  <span className="faint ch">{where(line)}</span>
                  <span className="who">{line.author}</span>
                  <span className="text">
                    {line.re && <span className="faint">↳ </span>}
                    {firstLine(line.text)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <aside className="pane" aria-label={open ? "任务详情" : "任务"}>
        {open ? (
          <Panel id={open} task={selected} now={now} onClose={() => setOpen(null)} />
        ) : (
          <>
            <h2>任务</h2>
            {groups.length === 0 && (
              <p className="faint pad">
                {run && (run.phase === "preparing" || run.phase === "running")
                  ? run.scenario === "pipeline"
                    ? "还没有任务。仓库克隆完成后，规划者的任务会显示在这里；计划做好后，各任务也会跟上。"
                    : "还没有任务。仓库克隆完成并被划分领域后，任务会显示在这里。"
                  : `${run?.title ?? channel ?? snap.swarm} 中没有任务`}
              </p>
            )}
            {groups.map((group) => {
              const finished = group.key === "done" || group.key === "failed" || group.key === "canceled";
              const rows = group.tasks;
              return (
                <div key={group.key} className="group">
                  <h3>
                    <i data-state={group.key} aria-hidden />
                    {group.title} <span className="faint">{group.tasks.length}</span>
                  </h3>
                  <ul className="rows">
                    {rows.map((task) => (
                      <li key={task.id}>
                        <button type="button" onClick={() => setOpen(task.id)} title={task.title}>
                          <span className="text">{task.title}</span>
                          {task.holder && <span className="who">{task.holder}</span>}
                          <span className="faint chip">{chip(task, group.key, now)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {finished && snap.finishedCapped && <p className="faint pad">以及更早的</p>}
                </div>
              );
            })}
          </>
        )}
      </aside>
    </div>
  );
}

/** A box to write to the board from the page: Cmd/Ctrl-Enter sends. It clears once the board took it. */
function Composer({ placeholder, action, send, hint }: { placeholder: string; action: string; send: (text: string) => Promise<{ ok: true } | { ok: false; problem: string }>; hint: string }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<{ busy: boolean; said: string | null; bad: boolean }>({ busy: false, said: null, bad: false });
  async function submit() {
    if (!text.trim() || state.busy) return;
    setState({ busy: true, said: null, bad: false });
    const result = await send(text);
    if (result.ok) {
      setText("");
      setState({ busy: false, said: "已发送。", bad: false });
    } else setState({ busy: false, said: result.problem, bad: true });
  }
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        value={text}
        rows={2}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="composer-foot">
        <span className={state.bad ? "bad" : "faint"}>{state.said ?? hint}</span>
        <button type="submit" disabled={state.busy || !text.trim()}>
          {state.busy ? "发送中" : action}
        </button>
      </div>
    </form>
  );
}

/** A pull request's link as people say it: `acme/web#12`. */
const prName = (url: string) => url.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+).*$/, "$1#$2");

/** The pull requests a task opened on the run's repo: its `pr` label, or links in its result. A link anywhere else isn't one. */
const prsOf = (task: Task, repo: string) => {
  const ours = new RegExp(`^https://github\\.com/${repo.replace(/[.]/g, "\\.")}/pull/\\d+$`);
  return [...new Set([...(task.pr ? [task.pr] : []), ...(task.note?.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/g) ?? [])])].filter((url) => ours.test(url));
};

/** How a task of a run ended, in words a person reads at a glance. */
type Outcome = { kind: "pr" | "none" | "failed" | "canceled" | "done"; line: string };

/** The first sentence or two of what an agent said, without its boilerplate. */
const gist = (text: string | null, max = 220) => {
  const plain = (text ?? "").replace(/https:\/\/github\.com\/\S+/g, "").replace(/\s+/g, " ").trim();
  return plain.length > max ? `${plain.slice(0, max).replace(/\s\S*$/, "")}…` : plain;
};

function outcomeOf(task: Task, review: Task | undefined, repo: string): Outcome {
  const verdict = review && ENDED.includes(review.state) ? (review.state === "completed" ? "评审通过" : `评审要求修改${review.note ? `：${gist(review.note, 120)}` : ""}`) : review ? "评审待完成" : null;
  if (task.state === "failed") return { kind: "failed", line: `失败：${gist(task.note) || "未说明原因"}` };
  if (task.state === "canceled") return { kind: "canceled", line: `已取消${task.note ? `：${gist(task.note)}` : ""}` };
  const prs = prsOf(task, repo);
  if (prs.length) return { kind: "pr", line: [`已开出 pull request ${prs.map(prName).join("、")}`, verdict].filter(Boolean).join(" · ") };
  if (task.role === "work") return { kind: "none", line: `未做改动：${gist(task.note) || "代理没有发现需要改的地方"}` };
  return { kind: "done", line: gist(task.note) || "完成" };
}

/**
 * What a run came to, in one place: a line that counts how its tasks ended, the pull requests it
 * opened, then each task with how it ended in words (the planner's and the reviews' left out: a
 * review shows as the verdict on the work it reviewed). A review run's report comes first.
 */
function Results({ run, tasks: all, show }: { run: RunView; tasks: Task[]; show: (id: string) => void }) {
  // Only the run's own tasks, the ones the deployment made: anyone who may post in the channel can
  // make a task, or label one a review or a report, and it mustn't read as the run's result.
  const tasks = all.filter((task) => task.own);
  const reviews = new Map(tasks.filter((task) => task.role === "review").map((task) => [task.needs[0], task]));
  const ended = tasks.filter((task) => ENDED.includes(task.state) && task.role !== "plan" && task.role !== "review" && task.role !== "verify");
  const report = ended.find((task) => task.role === "report" && task.state === "completed");
  const outcomes = ended.filter((task) => task !== report).map((task) => ({ task, outcome: outcomeOf(task, reviews.get(task.id), run.repo) }));
  const prs = [...new Set(outcomes.flatMap(({ task }) => prsOf(task, run.repo)))];
  const counts = { pr: 0, none: 0, failed: 0, canceled: 0, done: 0 };
  for (const { outcome } of outcomes) counts[outcome.kind]++;
  const working = tasks.filter((task) => !ENDED.includes(task.state) && task.role !== "review" && task.role !== "verify").length;
  const over = run.phase !== "running" && run.phase !== "preparing";

  const headline = [
    counts.pr && `开出 ${counts.pr} 个 pull request`,
    counts.none && `${counts.none} 个无需改动`,
    counts.done && `${counts.done} 个完成`,
    counts.failed && `${counts.failed} 个失败`,
    counts.canceled && `${counts.canceled} 个取消`,
    !over && working && `${working} 个仍在进行`,
  ].filter(Boolean);

  return (
    <div className="results">
      <h3>{over ? "结果" : "目前结果"}</h3>
      {outcomes.length === 0 && !report ? (
        <p className="faint">{over ? `没有产出：${run.note ?? "运行在产生任何任务之前就结束了。"}` : "还没有完成的任务。每个任务的结局会在这里显示。"}</p>
      ) : (
        <p className="headline">{headline.join(" · ")}</p>
      )}
      {report?.note && (
        <button type="button" className="report" onClick={() => show(report.id)}>
          {report.note.slice(0, 1_200)}
        </button>
      )}
      {prs.length > 0 && (
        <p className="prs">
          {prs.map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer">
              {prName(url)}
            </a>
          ))}
        </p>
      )}
      <ul>
        {outcomes.map(({ task, outcome }) => (
          <li key={task.id}>
            <button type="button" onClick={() => show(task.id)} title="打开它的工作日志">
              <i data-outcome={outcome.kind} aria-hidden />
              <span className="what">
                <span className="text">{task.title}</span>
                <span className={outcome.kind === "failed" ? "bad" : "faint"}>{outcome.line}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The selected run: what it was asked, where it stands, and a way to stop it. */
function RunBar({ run, tasks, now, show }: { run: RunView; tasks: Task[]; now: number; show: (id: string) => void }) {
  const [stopping, setStopping] = useState<string | null>(null);
  const live = run.phase === "preparing" || run.phase === "running";
  const left = run.deadline && live ? Date.parse(run.deadline) - now : null;
  return (
    <div className="runbar">
      <p className="goal" title={run.goal}>
        {run.goal}
      </p>
      <p className="faint">
        <i data-phase={run.phase} aria-hidden /> {PHASE_WORDS[run.phase] ?? run.phase} · {run.repo} · {run.scenario} · {run.model} · <span title="每个就绪或进行中的任务各启动一个代理，上限为运行所设数量：由计划决定同时干活的个数。">{live ? `${run.up}/${run.agents} 个代理在线` : `${run.agents} 个代理`}</span>
      </p>
      <p>
        <span className="faint">已花</span> ${run.cost.toFixed(2)}
        {run.budgetUsd !== null && <span className="faint">，预算 ${run.budgetUsd}</span>}
        {"  "}
        <span className="faint">任务</span> 已结 {run.settled}/{run.total}
        {left !== null && (
          <>
            {"  "}
            <span className="faint">剩余</span> {left > 0 ? `剩 ${span(left)}` : "时间到"}
          </>
        )}
        {live && (
          <button
            type="button"
            className="stop"
            disabled={stopping === "…"}
            onClick={async () => {
              if (!window.confirm(`停止「${run.title}」？它的代理将停止，沙箱将被回收。`)) return;
              setStopping("…");
              const result = await stop(run.slug);
              setStopping(result.ok ? null : result.problem);
            }}
          >
            {stopping === "…" ? "停止中" : "停止"}
          </button>
        )}
      </p>
      {run.note && <p className="faint">{run.note}</p>}
      {stopping && stopping !== "…" && <p className="bad">{stopping}</p>}
      <Results run={run} tasks={tasks} show={show} />
      {run.phase === "running" && (
        <Composer
          placeholder={run.scenario === "pipeline" ? "给蜂群加点活：为每处优化各补一条 CHANGELOG 条目…" : "让蜂群看看某处：检查 lib/fetch.ts 里的重试逻辑…"}
          action="添加任务"
          hint={run.scenario === "pipeline" ? "会成为一个任务及其评审，由下一个空闲的代理接手。" : "会成为一个待评审的领域，及其检查项。"}
          send={(text) => ask(run.slug, text)}
        />
      )}
    </div>
  );
}

/** The one fact that matters for a row in its group. */
function chip(task: Task, key: Shown, now: number): string {
  if (key === "working" && task.lease) return `租约剩 ${span(Date.parse(task.lease) - now)}`;
  if (key === "stalled" && task.lease) return `租约已于 ${ago(task.lease, now)}到期`;
  if (key === "waiting" && task.needs.length) return `等待 ${task.needs.length} 个任务`;
  return ago(task.last?.at ?? task.createdAt, now);
}

/** One task: its state, its brief, and its work log, read again whenever the thread moves. */
function Panel({ id, task, now, onClose }: { id: string; task: Task | null; now: number; onClose: () => void }) {
  const [history, setHistory] = useState<History | { problem: string } | null>(null);
  // Anything that changes in the thread changes one of these.
  const version = task ? `${task.state}:${task.holder}:${task.replies}:${task.last?.id}` : "";

  useEffect(() => {
    let stale = false;
    thread(id).then(
      (loaded) => !stale && setHistory(loaded),
      (error: unknown) => !stale && setHistory({ problem: (error as Error).message }),
    );
    return () => {
      stale = true;
    };
  }, [id, version]);

  const key = task ? shown(task, now) : null;
  return (
    <>
      <h2 className="head">
        <span>{task ? task.channel : "线程"}</span>
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </h2>
      {history === null ? (
        <p className="faint pad">加载中…</p>
      ) : "problem" in history ? (
        <p className="pad bad">无法读取 {id}：{history.problem}</p>
      ) : (
        <div className="thread">
          {task && key && (
            <p className="chips">
              <span className="state-chip">
                <i data-state={key} aria-hidden />
                {SHOWN_WORDS[key]}
              </span>
              {task.holder && <span className="who">{task.holder}</span>}
              {key !== "ready" && <span className="faint">{chip(task, key, now)}</span>}
              <span className="faint">{id}</span>
            </p>
          )}
          {task?.note && <p className="note">{task.note}</p>}
          <Entry line={history.root} now={now} />
          <h3>
            工作日志 <span className="faint">{history.replies.length}</span>
          </h3>
          {history.replies.length === 0 && <p className="faint">还没有回复</p>}
          {history.replies.map((reply) => (
            <Entry key={reply.id} line={reply} now={now} />
          ))}
          <Composer
            placeholder="给这个任务指路：用 lib/util.ts 里现成的帮助函数…"
            action="回复"
            hint="代理领任务时会读人们的回复。"
            send={(text) => say(id, text)}
          />
        </div>
      )}
    </>
  );
}

// Board text is whatever an agent wrote: it's shown as text, never as HTML.
function Entry({ line, now }: { line: Line; now: number }) {
  return (
    <article>
      <p className="by">
        <span className="who">{line.author}</span> <time dateTime={line.at}>{ago(line.at, now)}</time>
      </p>
      <p className="body">{line.text}</p>
    </article>
  );
}
