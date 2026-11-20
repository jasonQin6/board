#!/usr/bin/env node
// feeder：最小观察原型。证明 taskboard 的观察层（看 harness 会话、报状态）可以搬到
// vercel/board：pgrep 本机 harness 存活 → observe 频道每个 harness 一个 thread（tb.* labels，
// 状态变化回复）；尽力解析 ~/.codex/sessions 最新 rollout 的新增行，投递 [insight] reply。
// 零第三方依赖；所有 board 写操作经 vb 子进程（profile tb），不直连 HTTP。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const STATE_FILE = path.join(SCRIPT_DIR, '.feeder-state.json');
const INSIGHT_MAX = 200;
const LABEL_VALUE_MAX_BYTES = 256;
const SKIP_LINE_BYTES = 1024 * 1024; // 超长行不进 JSON.parse，防内存放大

// 内置名的默认 pgrep 模式：pi 用精确匹配，避免 ^pi 误中 ping 这类同前缀进程
const DEFAULT_ALIASES = { zcode: '^zcode', codex: '^codex', pi: '^pi$' };

function usage() {
  console.log(`feeder: harness 存活观察 + codex 会话增量 → board observe 频道

usage: node observe.mjs [options]

  --interval <sec>      轮询间隔（默认 15）
  --duration <sec>      跑固定时长后退出；不设则一直跑，Ctrl-C 退出
  --once                只跑一轮
  --channel <name>      目标频道（默认 observe；板不接受尾斜杠）
  --url <board-url>     板地址；默认 env BOARD_URL，都没有则退出
  --profile <name>      vb 署名 profile（默认 tb，即 env BOARD_PROFILE）
  --harness <a,b,c>     观察哪些 harness（默认 zcode,codex,pi；env FEEDER_HARNESSES）
  --alias <n>=<ERE>     harness n 的 pgrep -li 模式，可重复；内置名有默认
                        （zcode=^zcode codex=^codex pi=^pi$），其余 ^<n>
  --sessions <dir>      codex 会话根目录（默认 ~/.codex/sessions）
  --no-codex            关掉 codex 会话增量
  --max-insights <n>    每轮最多投递的 insight 数（默认 5）
  --vb <path>           vb 可执行文件；默认 env VB，否则找仓内 templates/swarm 的
`);
}

function parseArgs(argv) {
  const o = {
    interval: 15,
    duration: null,
    once: false,
    channel: 'observe',
    url: process.env.BOARD_URL || null,
    profile: process.env.BOARD_PROFILE || 'tb',
    harnesses: process.env.FEEDER_HARNESSES || 'zcode,codex,pi',
    aliases: {},
    sessions: path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'sessions'),
    codex: true,
    maxInsights: 5,
    vb: process.env.VB || path.join(REPO_ROOT, 'templates', 'swarm', 'node_modules', '.bin', 'vb'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`--${a.replace(/^--/, '')} 需要一个值`);
      return argv[++i];
    };
    if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (a === '--interval') o.interval = Number(next());
    else if (a === '--duration') o.duration = Number(next());
    else if (a === '--once') o.once = true;
    else if (a === '--channel') o.channel = next();
    else if (a === '--url') o.url = next();
    else if (a === '--profile') o.profile = next();
    else if (a === '--harness') o.harnesses = next();
    else if (a === '--alias') {
      const kv = next();
      const eq = kv.indexOf('=');
      if (eq <= 0) fail(`--alias 需要 name=ERE 形式，得到 ${kv}`);
      o.aliases[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    else if (a === '--sessions') o.sessions = next();
    else if (a === '--no-codex') o.codex = false;
    else if (a === '--max-insights') o.maxInsights = Number(next());
    else if (a === '--vb') o.vb = next();
    else fail(`未知参数 ${a}（--help 看用法）`);
  }
  if (!Number.isFinite(o.interval) || o.interval < 1) fail('--interval 需要 >=1 的秒数');
  if (o.duration != null && (!Number.isFinite(o.duration) || o.duration < 1)) fail('--duration 需要 >=1 的秒数');
  if (!Number.isFinite(o.maxInsights) || o.maxInsights < 1) fail('--max-insights 需要 >=1');
  if (!o.url) fail('没有板地址：设 BOARD_URL 或 --url');
  return o;
}

function fail(msg, code = 2) {
  console.error(`feeder: ${msg}`);
  process.exit(code);
}

function harnessNameOk(name) {
  return /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(name);
}

// ---------- vb 子进程 ----------

function vbRun(o, args, timeoutMs = 30000) {
  let r;
  try {
    r = spawnSync(o.vb, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, BOARD_URL: o.url, BOARD_PROFILE: o.profile },
    });
  } catch (e) {
    return { ok: false, err: `vb 启动失败: ${e.message}` };
  }
  if (r.error) return { ok: false, err: `vb 启动失败: ${r.error.message}` };
  if (r.status !== 0) {
    return { ok: false, err: (r.stderr || r.stdout || `exit ${r.status}`).trim() };
  }
  return { ok: true, out: (r.stdout || '').trim() };
}

// ---------- 本机进程观察 ----------

function pgrepCount(pattern) {
  const r = spawnSync('pgrep', ['-li', pattern], { encoding: 'utf8', timeout: 5000 });
  if (r.status === 0) return { count: (r.stdout || '').split('\n').filter(Boolean).length, err: null };
  if (r.status === 1) return { count: 0, err: null }; // 1 = 无匹配，是正常答案
  return { count: 0, err: (r.stderr || `pgrep exit ${r.status}`).trim() };
}

// ---------- board 侧 ----------

function labelValue(s) {
  s = String(s).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  while (Buffer.byteLength(s, 'utf8') > LABEL_VALUE_MAX_BYTES) s = s.slice(0, -1);
  return s;
}

function scanRoots(o) {
  const r = vbRun(o, ['read', o.channel, '--json']);
  if (!r.ok) return { ok: false, err: r.err };
  let doc;
  try {
    doc = JSON.parse(r.out);
  } catch {
    return { ok: false, err: 'read --json 输出不是 JSON' };
  }
  const map = {};
  for (const t of doc.threads || []) {
    const m = t.message;
    if (!m || m.deleted) continue;
    const h = m.labels && m.labels['tb.harness'];
    if (h && !map[h]) map[h] = m.id;
  }
  return { ok: true, map };
}

function postRoot(o, harness, state, alias) {
  const text =
    `feeder 观察：harness ${harness}（pgrep '${alias}'）。` +
    `tb.state=running|idle 随进程存活切换，tb.last-seen 每轮刷新；状态变化会在本 thread 回复。`;
  const r = vbRun(o, [
    'post', o.channel, text,
    '--label', labelValue(`tb.harness=${harness}`),
    '--label', labelValue(`tb.state=${state}`),
    '--idempotency-key', `observe-${harness}`,
  ]);
  if (!r.ok) return { ok: false, err: r.err };
  const id = /^\d+$/.test(r.out) ? r.out : null; // post 成功输出消息 id；幂等重放时兜底走 rescan
  return { ok: true, id };
}

function setLabels(o, id, kvs) {
  return vbRun(o, ['label', id, ...kvs.map((kv) => labelValue(kv))]);
}

function reply(o, id, text) {
  return vbRun(o, ['reply', id, text]);
}

function truncateChars(s, max) {
  const pts = Array.from(s);
  return pts.length > max ? pts.slice(0, max - 1).join('') + '…' : s;
}

// ---------- codex rollout 增量 ----------

// 只认前缀式密钥/长随机串；先脱敏后截断，避免截断把串切成半截而漏检。
function redact(s) {
  s = s.replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
  s = s.replace(/\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}\b/g, '[redacted]');
  s = s.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted]');
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]');
  s = s.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi, '[redacted]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, 'Bearer [redacted]');
  s = s.replace(/\b[0-9a-f]{32,}\b/gi, '[redacted]');
  s = s.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[redacted]');
  s = s.replace(
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization)["'：:\s=]+)[^\s"',;`]{6,}/gi,
    '$1[redacted]',
  );
  return s;
}

function latestRollout(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  let unreadable = 0;
  for (const e of entries) {
    // 不信 dirent 的 isFile（macOS/沙箱下 d_type 可能 UNKNOWN），按文件名筛出候选再 statSync 定夺
    if (!/^rollout-.*\.jsonl$/.test(e.name)) continue;
    const full = path.join(e.parentPath || dir, e.name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      unreadable++; // 刚被删/权限变了：计数并在 note 里露出
    }
  }
  if (best) best.unreadable = unreadable;
  return best;
}

// 从一行 rollout JSON 里提取轻量事件文本；读不懂返回 null（调用方跳过）。
function extractInsight(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  if (o.type === 'response_item' && o.payload && o.payload.type === 'message') {
    const role = o.payload.role;
    if (role !== 'user' && role !== 'assistant') return null; // developer/system 注入不外发
    let text = '';
    const c = o.payload.content;
    if (Array.isArray(c)) {
      for (const item of c) {
        if (item && typeof item.text === 'string' && typeof item.type === 'string' && item.type.endsWith('text')) {
          text += (text ? ' ' : '') + item.text;
        }
      }
    }
    text = redact(text.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim());
    if (!text) return null;
    return `codex ${role}: ${text}`;
  }
  if (o.type === 'session_meta' && o.payload && typeof o.payload.cwd === 'string') {
    return `codex: 新会话 cwd=${o.payload.cwd}`;
  }
  return null;
}

// 返回本轮要投递的 insight 文本数组；副作用是推进 ctx.codex 的 path/offset。
function watchCodex(ctx) {
  const o = ctx.opts;
  const st = ctx.codex;
  const out = { insights: [], newLines: 0, skippedLines: 0, note: '' };
  const latest = latestRollout(o.sessions);
  if (!latest) {
    if (st.path) out.note = `找不到 rollout 文件（原锁定 ${path.basename(st.path)}）`;
    st.path = null;
    st.offset = 0;
    return out;
  }
  if (st.path !== latest.path) {
    // 锁定即取当前大小：不回放历史，只报运行期间的增量（安全优先于新鲜度）
    st.path = latest.path;
    st.offset = latest.size;
    out.note = `锁定 ${path.basename(latest.path)} @ ${latest.size}B` + (latest.unreadable ? `（${latest.unreadable} 个候选读不了）` : '');
  }
  let fh;
  try {
    fh = fs.openSync(st.path, 'r');
  } catch {
    st.path = null;
    st.offset = 0;
    out.note = '会话文件打不开，下轮重新锁定';
    return out;
  }
  let size = 0;
  try {
    size = fs.fstatSync(fh).size;
  } catch {
    fs.closeSync(fh);
    st.path = null;
    st.offset = 0;
    return out;
  }
  if (size < st.offset) st.offset = 0; // 被截断/重写：从头来
  if (size === st.offset) {
    fs.closeSync(fh);
    return out;
  }
  const buf = Buffer.alloc(size - st.offset);
  let got = 0;
  try {
    got = fs.readSync(fh, buf, 0, buf.length, st.offset);
  } finally {
    fs.closeSync(fh);
  }
  const text = buf.toString('utf8').slice(0, Math.max(0, got));
  const parts = text.split('\n');
  let consumed = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    consumed += Buffer.byteLength(parts[i], 'utf8') + 1;
    const line = parts[i];
    if (!line.trim()) continue;
    out.newLines++;
    if (Buffer.byteLength(line, 'utf8') > SKIP_LINE_BYTES) {
      out.skippedLines++;
      continue;
    }
    const body = extractInsight(line);
    if (body) out.insights.push(body);
  }
  st.offset += consumed;
  if (out.insights.length === 0 && out.newLines > 0) {
    // 降级路径：结构没读懂，但确实有新增——报行数（任务书允许）
    out.insights.push(`codex 会话 +${out.newLines} 行新增（未解析出 user/assistant 消息）`);
  }
  return out;
}

// ---------- 状态持久化（本机缓存，可随时删） ----------

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s && s.version === 1) return s;
  } catch { /* 没有/坏了就从零开始 */ }
  return { version: 1, roots: {}, discovered: {}, last: {}, codex: { path: null, offset: 0 } };
}

function saveState(ctx) {
  const data = JSON.stringify({
    version: 1,
    roots: ctx.roots,
    discovered: ctx.discovered,
    last: ctx.state,
    codex: ctx.codex,
  });
  const tmp = `${STATE_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error(`feeder: 状态文件写不进去（${e.message}），只影响跨轮记忆，不影响本轮`);
  }
}

// ---------- 主流程 ----------

function codexAlias(ctx) {
  const h = ctx.harnesses.find((x) => x.name === 'codex');
  return h ? h.alias : '^codex';
}

function runRound(ctx, roundNo) {
  const o = ctx.opts;
  const iso = new Date().toISOString();
  const summary = [];
  for (const h of ctx.harnesses) {
    const { count: n, err } = pgrepCount(h.alias);
    if (err) summary.push(`${h.name}: pgrep 出错（${err}），按无进程处理`);
    const alive = n > 0;
    const known = ctx.discovered[h.name] || ctx.roots[h.name];
    if (!alive && !known) continue; // 从未见过且现在不在：不开 thread

    let rootId = ctx.roots[h.name];
    if (!rootId) {
      const p = postRoot(o, h.name, alive ? 'running' : 'idle', h.alias);
      if (!p.ok) {
        summary.push(`${h.name}: 建 root 失败（${p.err}）`);
        continue;
      }
      rootId = p.id;
      if (!rootId) {
        const scan = scanRoots(o);
        rootId = scan.ok ? scan.map[h.name] : null;
      }
      if (!rootId) {
        summary.push(`${h.name}: root 已发但读不到 id，下轮再认领`);
        continue;
      }
      ctx.roots[h.name] = rootId;
      ctx.state[h.name] = alive ? 'running' : 'idle';
      summary.push(`${h.name}: 新 thread #${rootId}（${ctx.state[h.name]}，pgrep → ${n}）`);
    }

    const cur = alive ? 'running' : 'idle';
    const prev = ctx.state[h.name];
    if (prev && prev !== cur) {
      const r1 = setLabels(o, rootId, [`tb.state=${cur}`, `tb.last-seen=${iso}`]);
      const r2 = reply(o, rootId, `state: ${prev} → ${cur}（pgrep '${h.alias}' → ${n}）@ ${iso}`);
      summary.push(`${h.name}: #${rootId} ${prev} → ${cur}${r1.ok && r2.ok ? '' : '（label/reply 失败）'}`);
    } else {
      const r = setLabels(o, rootId, [`tb.last-seen=${iso}`]);
      if (!r.ok) summary.push(`${h.name}: last-seen 刷新失败（${r.err}）`);
    }
    ctx.state[h.name] = cur;
    ctx.discovered[h.name] = true;
  }

  if (o.codex) {
    const w = watchCodex(ctx);
    if (w.note) summary.push(`codex: ${w.note}`);
    if (w.insights.length > 0) {
      let rootId = ctx.roots.codex;
      if (!rootId) {
        // 会话在写但 pgrep 没认到 codex 进程（如经 node 启动）：以当前真实状态建 thread
        const alias = codexAlias(ctx);
        const { count: n } = pgrepCount(alias);
        const p = postRoot(o, 'codex', n > 0 ? 'running' : 'idle', alias);
        if (p.ok) {
          rootId = p.id || (scanRoots(o).map || {}).codex || null;
          ctx.roots.codex = rootId;
          ctx.state.codex = n > 0 ? 'running' : 'idle';
          ctx.discovered.codex = true;
          summary.push(`codex: 由会话增量建 thread #${rootId}`);
        } else {
          summary.push(`codex: 有增量但建 thread 失败（${p.err}）`);
        }
      }
      if (rootId) {
        let sent = 0;
        for (const body of w.insights) {
          if (sent >= o.maxInsights) break;
          const r = reply(o, rootId, truncateChars(`[insight] ${body}`, INSIGHT_MAX));
          if (r.ok) sent++;
          else summary.push(`codex: insight 投递失败（${r.err}）`);
        }
        summary.push(`codex: ${sent}/${w.insights.length} 条 insight → #${rootId}（新增 ${w.newLines} 行，跳过超长 ${w.skippedLines} 行）`);
      }
    } else if (w.newLines === 0 && !w.note) {
      summary.push(`codex: 无新增（offset ${ctx.codex.offset}B）`);
    }
  }

  console.log(`[feeder ${iso}] round ${roundNo}: ${summary.join(' · ') || '无变化'}`);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(o.vb)) fail(`vb 不存在：${o.vb}（用 --VB 或 --vb 指定，或先 pnpm install）`);
  const names = o.harnesses.split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) fail('--harness 列表为空');
  const harnesses = names.map((name) => {
    if (!harnessNameOk(name)) fail(`harness 名不合法：${name}（字母数字._-，≤32）`);
    return { name, alias: o.aliases[name] || DEFAULT_ALIASES[name] || `^${name}` };
  });

  const saved = loadState();
  const ctx = {
    opts: o,
    harnesses,
    roots: {},
    discovered: saved.discovered || {},
    state: saved.last || {},
    codex: saved.codex && typeof saved.codex.offset === 'number' ? saved.codex : { path: null, offset: 0 },
  };
  // 服务端是真相源：启动时认领频道里已有的 tb.harness thread（幂等键是第二道保险）
  const scan = scanRoots(o);
  if (scan.ok) Object.assign(ctx.roots, scan.map);
  else console.error(`feeder: 频道扫描失败（${scan.err}），靠幂等键防重复 root`);
  // codex 锁定的文件已不在：丢弃旧 offset
  if (ctx.codex.path) {
    try { fs.statSync(ctx.codex.path); } catch { ctx.codex = { path: null, offset: 0 }; }
  }

  console.log(
    `feeder: url=${o.url} profile=${o.profile} channel=${o.channel} ` +
    `harnesses=${harnesses.map((h) => h.name).join(',')} interval=${o.interval}s ` +
    `codex=${o.codex ? o.sessions : 'off'} duration=${o.duration ?? '∞'}`,
  );

  const start = Date.now();
  let roundNo = 0;
  let lastAt = 0;
  let stopped = false;

  const finish = () => {
    saveState(ctx);
    console.log(`[feeder done] rounds=${roundNo} elapsed=${Math.round((Date.now() - start) / 1000)}s`);
    process.exit(0);
  };
  process.on('SIGINT', () => {
    stopped = true;
    finish();
  });
  process.on('SIGTERM', () => {
    stopped = true;
    finish();
  });

  const step = () => {
    if (stopped) return;
    if (o.duration != null && Date.now() - start >= o.duration * 1000) return finish();
    roundNo++;
    runRound(ctx, roundNo);
    lastAt = Date.now();
    saveState(ctx);
    if (o.once) return finish();
    setTimeout(step, Math.max(0, o.interval * 1000 - (Date.now() - lastAt)));
  };
  step();
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e), 1));
