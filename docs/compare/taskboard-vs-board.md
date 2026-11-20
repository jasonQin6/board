# Taskboard 与 vercel/board：差异评估与改进方向

- **日期**：2026-11-20（评估会话当日整理）
- **评估基线**：vercel/board `main` @ `b9ae9eac`；taskboard `main` @ `8c48b9a`（640 tests）
- **结论的性质**：①②两步已实测验证（见 §6），③已落地最小原型（join 协议固化 + feeder，见 §6.4）

## 0. TL;DR

两者共享的只有「任务看板 for agents」这层浅表面，核心大部分**不相交**：board 的核心是**沟通介质**（thread + 消息 + 租约式任务），taskboard 的核心是**观察面**（读 harness 会话 + gh 镜像 + 静止判定），且 taskboard 的调度面是被自己刻意砍掉的（issue-worker 退役、ADR-0025）。「开发了这么久还达不到」的主因是 scope 不同，不是慢。

**方向决策：以 board 为协调底座，把 taskboard 独占的观察层收缩为 board 的喂料器（feeder）**；不在 taskboard 里重造 board。分三步走，前两步已全绿。

## 1. 一句话定性

- **vercel/board**（Apache-2.0，Vercel 团队，279KB SPEC）：给人 + agent 用的消息板。核心原语是 thread——任务 = 带状态的 thread（claim = 租约 + epoch 栅栏、`--needs` 依赖、`wait` = 等某 ID 后的新事件、watchers、Slack/GH/Linear sync、`vb serve` 本地 127.0.0.1:4100 无需云）。swarm 模板即 Human/Lead/Worker/Review 骨架。卖的是**沟通介质**。
- **taskboard**（PolyForm Noncommercial，个人仓）：本地 daemon。SQLite 五列看板 + `wait` 静止判定 + 多 harness thread 观察（Codex app-server / ZCode，Inbox/绑定/摘要/证据/Jev 提案）+ gh 原生镜像（`issue-<N>` 分支 + `held:<harness-id>` 领取协议、漂移检测）。刻意不做介质。卖的是**监控与对账**。

ELI5：board 是工地的**白板 + 对讲机**（所有人都通过它说话）；taskboard 是工地的**监控室**（看谁在干活、和 GitHub 对账，工人之间怎么沟通它不管）。

## 2. 差异全景

### 2.1 board 有、taskboard 没有（本次差距感的主要来源）

| 能力 | board 的做法 | taskboard 现状 |
| --- | --- | --- |
| agent 间沟通介质 | post/reply/read，工作日志就是 task 的 replies | 无消息层，协作走 GitHub issue + 分支 |
| claim = 租约 | TTL + epoch 栅栏，过期自动可再领，僵死 agent 写不进旧任务 | `held:` label + 分支名，纯 advisory，无过期无栅栏 |
| 任务依赖 | `--needs`，waiting→ready 自动流转 | 五列看板无依赖图 |
| `wait` 语义 | 阻塞到「某 ID 之后有新事件」——跨 agent 同步原语 | 阻塞到「静止」（无活跃 Run）——语义不同、互补 |
| 事件驱动代码 | watchers：消息一到就唤醒你的代码 | 无（SSE 只喂 UI） |
| Slack/GitHub/Linear 同步 | 双向进同一 thread，PR 状态变 label | 只有 gh→本地只读镜像（单向） |
| Swarm 编排骨架 | 模板：plan→work+review（`--needs`）、认领、reconcile、live 页 | 被刻意移出 daemon，由 issue-router + worker workflow 在用户层扮演 |
| 多 actor 身份 | 每条消息记录谁写的（`codex via jason`） | 单人本机，harness-id 字符串 |

### 2.2 taskboard 有、board 没有（这部分工作没有白做）

| 能力 | 说明 |
| --- | --- |
| Harness 会话深观察 | 读 Codex app-server / ZCode 会话内部：Inbox 绑定、turns、摘要、证据、Jev 提案。board 只看得见 agent **主动发帖**的内容，从不往会话里看 |
| 静止判定 `wait` | board 不知道 agent 进程是否真的在干活，只看消息 |
| gh 原生工作镜像 | 真实 gh 对象上的领取协议 + 漂移检测；board 的 github sync 是入向渲染、默认不回写 |
| 本地极简主义 | 零运行时依赖、SQLite 文件归你、单实例锁、损坏隔离 |

### 2.3 都有但形状不同

看板 UI（board：inspector + task view + swarm live 页；taskboard：React 五列）；本地运行（board `vb serve` 不需要任何 Vercel 云服务，但是 npm 包有依赖；taskboard 零依赖、Node 内置模块）。

## 3. 为什么 taskboard 开发这么久仍「达不到」

1. **核心大部分不相交。** 重叠只是「任务+看板」浅表面；taskboard 的力气花在观察、锁、契约、漂移、gh 镜像，board 的力气花在消息、身份、租约、watchers、sync。做的是两个产品，不是同一产品的两个进度。
2. **调度面是被自己砍掉的，不是没做出来。** issue-worker 退役（2026-10-30）、ADR-0025 收窄到 gh-native 观察切片——当时的决策就是「daemon 不当介质，编排去用户层」。board 恰好把「介质」做成了产品。
3. **对面对是一个团队的产品。** 279KB SPEC、几十个测试文件、活跃 changeset。个人仓与其比进度本身就不公平。

## 4. 方向决策：以 board 为底座，观察层做喂料器

**不在 taskboard 里重造 board**（等于把「封装不重implement」的祖训反着用，造出来还要一个人永远维护通用件）；**以 board 为协调底座，taskboard 的独占价值收缩为 feeder**：读 harness 会话 → 以 profile（如 `tb via jason`）把摘要/发现/证据投进对应 task thread。

目标架构：

```
Codex/ZCode 会话 ──观察 feeder（读会话）──▶ board threads（post/label/upload）
                                              ▲ events()/tasks.list()
                                              ▼
                                   自建 UI 或 inspector
GitHub ◀── sync function（出向，自写）── board ◀── github sync（入向）
```

gh 关系形态反转：从「gh 为真相源」变成「board 为协调真相源、gh 只是代码落点」。

三步走：

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| ① 本地试跑 | `vb serve` + swarm 模板 + 3 假 worker | ✅ 全绿（§6.1） |
| ② 合缝验证 | 真 CLI agent（codex）走 JOIN 协议完成真任务 | ✅ 成功（§6.2） |
| ③ 收编 | join 协议固化 + 最小 feeder 原型 → taskboard 收缩为观察器 | ✅ 原型落地（`docs/join-local.md` + `tools/feeder/observe.mjs`，2026-11-20）；taskboard 退役排期待定 |

## 5. 自建 UI 接口面与覆盖判定

依据 `packages/board/docs/03-guides/07-build-a-ui.md` + `04-reference/02-board.md`（inspector 源码即官方参考实现）。handle 六路接口：

| 面 | 接口 | 要点 |
| --- | --- | --- |
| 读 | `channel(n).messages({limit})`、`threads`、`thread(id)`、`channels({prefix})`、`actors()` | 全带游标（`cursor`/`older`），回复靠 `re` 归组 |
| 写 | `post`/`reply`（自选 `id` 幂等）、`edit`/`delete`、`react`、`label`、`upload`/`download` | 断线重发安全；乐观更新 + newest-merge 模式 |
| 订阅 | `events()`（25s long-poll 异步迭代器、自动退避、`onState`）、`wait`、`poll({last})` | 事件自带事后 message 视图；`MessageView.version` 单调防乱序 |
| 任务 | `tasks.list`（按 state/label 切列 = 看板）、`claim`→`{epoch,token}`、`held()`→renew/release/complete/fail/block、`createMany` | 租约到期可客户端推导（`stateNow` 模式） |
| 同步原语 | `sync`/`linked`/`inbox`/`readSource`/`syncImport`/`inboxPush` | **feeder 的正门**：可把自己伪装成外部平台源 |
| 兜底 | `request()`（带凭据裸 HTTP API）、`schedule`、watchers `register/matches/ack` | 无天花板 |

覆盖判定（taskboard 独占功能 × board 接口）：

| taskboard 独占功能 | 覆盖？ | 判定 |
| --- | --- | --- |
| 看板投影 | `tasks.list` + 事件流 | ✅ 完整 |
| 证据/附件呈现 | `upload/download` + attachments | ✅ 完整 |
| SSE 实时 | `events()` + `onState` | ✅ 等价 |
| Jev 摘要呈现 | 摘要 = reply/label | ✅ 呈现侧 |
| Jev 摘要**生成** | 无此概念 | ❌ feeder 进程逻辑（可用 schedule/watchers 驱动） |
| 会话观察 | board 看不见会话内部 | ❌ 必须外部 feeder（读 app-server / thread journal） |
| 静止判定 | 消息级 ≠ 进程级 | ❌ `claim.until` 只是代理信号，仍需 feeder |
| gh 镜像/领取/漂移 | 入向 sync + 原生 claim 替代 + 出向自写 sync function | ⚠️ 有替代件，形态反转 |

**结论**：UI 层覆盖 taskboard 减 board 的「呈现+协调」子集；三个灵魂功能（会话观察、摘要生成、静止判定）不属 UI 层也不该属——正确落点是 feeder，而 board 给 feeder 留的门比 UI 还全（直接 post/label/upload、`syncImport`/`inboxPush`、watchers/schedule）。

本地板缩水点：>4MB direct upload 报 501；频道计数 local 有、Vercel 板无。本机场景无碍。

## 6. 已实测验证的结论

### 6.1 本地试跑（步骤①）

`vb serve`（127.0.0.1:4100，身份 `local:user:jason`，日志落 `.board/` 文件可重启续）+ swarm 模板 + 3 假 worker：7 任务零冲突认领、依赖流转真实发生（review 任务 waiting→前置完成→ready→completed）、工作日志 = thread（每步署名）、`claim.renew` 租约在位。

### 6.2 合缝验证（步骤②）

codex 0.170 以 `BOARD_PROFILE=codex` 走本地适配 JOIN 协议完成真实任务 #78（只读调研）：claim → 5 条带前缀回复（`[progress]/[insight]/[done]`）→ complete，全程 14 分钟、exit 0、`git status` 零改动、无 claim_lost。

- **沙箱**：第一档 `workspace-write + sandbox_workspace_write.network_access=true` 够用（localhost 通，无需 full-access）。
- **唯一坑**：沙箱不可写 `~/.config` → vb claim 文件 EPERM，正规解法是 `XDG_CONFIG_HOME` 指到可写目录（SPEC.md:3743 文档化约定）；未预置的代价是 ~10 分钟等租约到期重 claim。**join 文件应预置 `XDG_CONFIG_HOME`。**
- codex 的调研结论与主线程独立分析交叉一致（§5），并补充缺口：presence/已读、类型化标签、跨频道搜索——均属 feeder 端约定。

### 6.3 多 Harness

手动 JOIN 路径**原生支持任意能跑 shell 的 CLI agent**（codex/pi/zcode/dsh 一视同仁）：board 全 docs 无 "harness" 一词，agent `--as` 自报身份（CLI 不读 `CLAUDECODE`/`CODEX_THREAD_ID` 等环境变量），claim 文件按 (board, task, profile) 隔离，同 principal 多 profile 并行是文档化特性——已由 codex 实测闭环。托管 sandbox 路径与 pi-coding-agent 硬耦合（`sandbox/runner.ts` 进程内 pi SDK、沙箱网络只放行 board + ai-gateway、产出归属校验 `agent-<n>`、预算靠 pi 事件流），换 CLI 要改 runner/镜像/网络策略，判定不值得。

### 6.4 feeder 原型（步骤③）

`tools/feeder/observe.mjs`（零依赖 Node，分支 `feeder-mvp` @ `29de5956`，已合入 main）：pgrep 观察 harness 存活（zcode/codex/pi，`--alias` 可收紧）→ `observe/` 频道每 harness 一个 thread（profile `tb`；`tb.state` / `tb.last-seen` 标签随轮刷新，状态变化附回复）；Codex 会话 rollout 增量 → 脱敏（密钥前缀/长随机串/Bearer/键值对模式，**先脱敏后截断**）后以 ≤200 字符 `[insight]` 投递，锁定即当前文件大小、不回放历史。实测：zcode=running（14 进程）；40 秒生命期的 demo 进程完整走完 running→idle 翻转并留回复；fixture 驱动的 codex 增量含密钥脱敏验证（`sk-FAKE…`/64-hex/`api_key=` 均呈 `[redacted]`）。

## 7. 缺口与风险

- **board 年轻、API 会漂**；本地模式是二等公民（canonical 后端是 Vercel 云）。锁定 fork 自用 + 少依赖边缘行为。
- **观察三件套仍是自留地**：会话观察、摘要生成、进程静止判定——board 永远不会做，是 taskboard 存在的最后理由，也是 feeder 的全部工作内容。
- **纪律代价**：放弃 taskboard 零依赖/本地唯一洁癖；board 是带依赖的 npm 包。

## 8. WebUI 中文化（进行中）

三面全硬编码英文、零 i18n 框架。本 fork 范围决策：只做浏览器可见面（inspector + swarm 模板全部页面，直接替换中文、不做双语切换），CLI/docs/协议串（`[progress]` 前缀、label 键名）不动。**已交付**（`zh-webui` @ `34c8dd98`，32 文件 +564/-515，含 2 个测试文件同步改断言；两面 typecheck、vitest 47 项、swarm test 34 项全绿）并合入 main、push 到 fork。有意残留：swarm `config.ts` 报错串（测试正则断言锁死）、MCP 工具 description（面向代理）、inspector 透出的服务端错误文本。

## 9. 附：对 taskboard spec 纪律的诊断（可移植补丁）

board 的 SPEC 是「全景快照（开头 model+principles）+ 追加式 Decisions log」双层，配合「同一 PR 原子性改 SPEC+代码+conformance 测试+文档」；conformance 套件故意跑坏板子，让测试与实现「想漂都漂不掉」。

taskboard「需求反复被覆盖」的病根：ADR 栈 = 事件日志只存增量（没错），但 REQUIREMENTS 号称只读派生、**却没有消费者负责从日志重建投影**——投影无人重建必漂移，漂移的表现就是后续票据不断改写前面已定的需求。可移植三补丁：

1. **薄 SPEC 只写外部契约**（tool-contract 快照的人读版），铁律「改功能需求 = 同一 commit 改 SPEC + 改测试」；issue 永远只住切片和验收。
2. **Non-goals / Not-in-this-version / Open 三段式闸门**：后续票据想改写需求，必须先显式编辑 Non-goals 或写新 ADR——把隐形改写变成可见 diff。成本几乎为零，收益最大。
3. **决策分级**：changeset（单行为）< Decisions log Q→A 一行表（单问题）< ADR（单权衡）；别拿最重的 ADR 承载所有粒度。

不照搬：28 万字全景 SPEC（靠团队分工维持）；「code wins」（单人仓没第二双眼，应**测试赢**）；changeset + PR 四问仪式（无外部用户，纯开销）。

## 10. 仓库纪律

- 本 clone 的 remotes：`origin` = `jasonQin6/board`（fork，推送目标）；`upstream` = `vercel/board` 且 `pushurl = no-push`（物理禁推，误推直接 fatal）。
- 所有实验/测试/文档只进 fork，不提交原仓库；`.board/`（本地板数据）已在 gitignore。
