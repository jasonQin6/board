# feeder — 最小观察原型

一句话设计：每 N 秒用 `pgrep` 看本机 harness 进程（codex / zcode / pi …），在 board 的
`observe` 频道为每个见过的 harness 维护一个 thread（`tb.state` / `tb.last-seen` labels，
状态变化回一条简短说明）；同时尽力解析 `~/.codex/sessions` 最新 rollout 的新增行，
把新完成的 user/assistant 消息以 ≤200 字符的 `[insight]` reply 投进对应 thread
（先脱敏、后截断；读不懂就降级报「+N 行新增」）。

证明的是一件事：taskboard 的观察层（看 harness 会话、报状态）可以搬到 vercel/board 上。

## 怎么跑

Node ≥22，零第三方依赖。所有写操作经 `vb` 子进程（profile `tb`），不直连 HTTP。

```bash
cd /Users/jason/Documents/workspace/board   # 仓库根（vb 路径默认从这里找）
export BOARD_URL=http://127.0.0.1:4100/api/board

node tools/feeder/observe.mjs --once            # 单轮
node tools/feeder/observe.mjs --duration 90     # 跑 90 秒
node tools/feeder/observe.mjs                   # 一直跑，Ctrl-C 退出
node tools/feeder/observe.mjs --interval 5 --harness zcode,codex --alias 'zcode=^zcode'
```

验证观察结果（注意板不接受尾斜杠，频道名是 `observe`）：

```bash
VB=templates/swarm/node_modules/.bin/vb
$VB read observe
$VB read observe --json
BOARD_URL=$BOARD_URL $VB tail observe --json
```

## 行为口径

- **状态语义**：`pgrep -li <alias>` 命中 ≥1 个进程 = `running`；曾见过、之后归零 =
  `idle` 并回一条 `state: running → idle（…）`。从未见过的 harness 不建 thread。
  默认 alias：`zcode=^zcode`、`codex=^codex`、`pi=^pi$`（pi 用精确匹配，`^pi` 会误中
  ping 这类同前缀进程——本轮验证真实踩过）；自定义名默认 `^<名>`。
- **幂等**：root 用固定幂等键 `observe-<harness>`，且启动时扫描频道认领已有 thread；
  重复运行、删掉本机状态文件 `.feeder-state.json`（脚本同目录）都不会产生重复 root。
- **线程命名**：root 文本固定为「feeder 观察：harness …」，labels 全在 `tb.` 命名空间。
- **codex 增量**（尽力而为）：锁定 `--sessions` 下 mtime 最新的 `rollout-*.jsonl`，
  首次锁定取当前文件大小作 offset（**不回放历史**），之后只读新增的完整行；
  只提取 `response_item` 里 role 为 user/assistant 的消息文本（developer/system 不外发），
  一行超过 1MB 直接跳过；每轮最多投 `--max-insights`（默认 5）条。
- **安全红线**：先脱敏再截断（截断可能把密钥切成半截而漏检）。脱敏覆盖
  `sk-` / `ghp_` / `github_pat_` / `AKIA` / `xox*-` / `Bearer …` / ≥32 位十六进制 /
  ≥40 位 base64 / `token|secret|password|authorization …` 赋值；另剥离控制字符。
  insight 整条 ≤200 字符；label 值 ≤256 字节且无控制字符。

## 已知限制

- pgrep 按进程名（comm，16 字符截断）匹配、大小写不敏感：zcode/codex 用前缀模式会连带
  观察同名家族（如 ZCode Helper）；短前缀（如 `^pi`）可能误中同前缀无关进程（ping），
  内置名已给默认（pi=^pi$），其余用 `--alias` 收紧。
- 只观察本机；codex 增量只盯「mtime 最新」一个文件，并行多会话时会漏。
- offset 首次锁定即跳过历史，所以 feeder 启动前滚动的会话内容不会出现。
- 无重试 / 退避：vb 或网络失败只记一行 stderr，下轮重来。
- 状态文件是本机缓存，只为了翻状态时能认得「上次」；删掉可自愈。
