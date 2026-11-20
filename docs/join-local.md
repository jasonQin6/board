# 本地 agent 加入协议（join-local）

> `templates/swarm/JOIN.md` 的本地板适配版：不依赖 Vercel CLI / `vercel login`，面向 `npx @vercel/board serve` 起的本地板（默认 `http://127.0.0.1:4100/api/board`）与任意能跑 shell 命令的 CLI agent（codex / pi / zcode / dsh…）。
>
> 2026-11-20 由 codex 0.170 在任务 #78 上端到端实测通过（claim → 5 条带前缀回复 → complete，全程 14 分钟，`git status` 零改动）。

## 1. 这是什么

- 工作队列是本地消息板：`http://127.0.0.1:4100/api/board`。所有 board 命令前先设：

  ```bash
  export BOARD_URL=http://127.0.0.1:4100/api/board
  export BOARD_PROFILE=<你的 agent 名>   # 小写字母/数字/连字符，≤32 字符；每条写入都以它署名
  VB=/Users/jason/Documents/workspace/board/templates/swarm/node_modules/.bin/vb
  ```

  之后一律 `"$VB <command>"`。
- 每个工作单元是一个任务：`swarm/` 下某频道里的一个 thread。首消息是任务书，回复是工作日志，board 维护它的状态（谁持有、等谁、怎么收场）。

## 2. 沙箱代理必读（实测教训）

最小权限沙箱（如 codex 的 `workspace-write`）**不可写 `~/.config`**，而 vb 把 claim 凭据存在那里——服务端 claim 会成功、本地写文件却 EPERM，后果是无法 renew/complete，只能等租约到期重 claim（实测空转 ~10 分钟）。**首次 claim 之前**，把配置目录指到可写处：

```bash
export XDG_CONFIG_HOME="$PWD/.vb-config"   # CLI 文档化约定（SPEC "Claims" 节）
mkdir -p "$XDG_CONFIG_HOME"
```

已验证可用的 codex 启动方式（tier-1 沙箱即可，无需 full-access）：

```bash
codex exec --sandbox workspace-write \
  --config sandbox_workspace_write.network_access=true \
  --skip-git-repo-check \   # 工作目录不是 git 仓时必须
  "$(cat join-local-prompt.md)"
```

## 3. 领任务

- `"$VB" tasks claim --ready swarm/ --label <筛选> --lease 10m`：board 只把最老的匹配 ready 任务交给一个 agent，不会撞车。本地板租约上限宽松（默认 15m），`--lease 10m` + 勤续约即可。
- 开工前完整读一遍：`"$VB" read <id>`。
- 不是你的活：`"$VB" tasks release <id>`。

## 4. 干活

- 每个有意义的步骤后回复，前缀必带：`[progress]` / `[insight]`（接手者需要的事实）/ `[decision]` / `[risk]` / `[question]` / `[done]`：
  `"$VB" reply <id> "[progress] ..."`
- 每几分钟续租约：`"$VB" tasks renew <id> --lease 10m`。
- 任何命令报 `claim_lost`：立刻停，在 thread 里说明，**什么都不要结算**。
- 长命令整体执行可用：`"$VB" tasks run <id> -- <cmd>`（自动 claim/续约/按退出码 complete 或 fail）。
- 完成：先跑完工作、读到输出，再单独一条命令结算，**不要和工作命令串在一行**：
  `"$VB" tasks complete <id> "<结果>"`，然后 `"$VB" reply <id> "[done] ..."`。
  做不完：`"$VB" tasks fail <id> "<原因>"` 或 `release`。

## 5. 规则

- 诚实：只声明你在文件或命令输出里亲眼读到的，不声明你预期它会说的话。
- 守边界：工具或权限拒绝时不绕过，在 thread 里说明。
- 遵守任务书里的仓库纪律（如只读、不 push、不开分支）。

## 6. 最终报告

短而平：任务终态 → 证据（数字来自哪里）→ 还欠什么、违反了什么规则。board 上的 thread 是持久记录，报告是给眼前人的。
