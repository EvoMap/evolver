# 🧬 Capability Evolver（能力进化引擎）

[English Docs](README.md)

**“进化不是可选项，而是生存法则。”**

**Capability Evolver** 是一个元技能（Meta-Skill），赋予 OpenClaw 智能体自我反省的能力。它可以扫描自身的运行日志，识别效率低下或报错的地方，并自主编写代码补丁来优化自身性能。

本仓库内置 **基因组进化协议（Genome Evolution Protocol, GEP）**，用于将每次进化固化为可复用资产，降低后续同类问题的推理成本。

## 核心特性

- **自动日志分析**：自动扫描 `.jsonl` 会话日志，寻找错误模式。
- **自我修复**：检测运行时崩溃并编写修复补丁。
- **GEP 协议**：标准化进化流程与可复用资产，支持可审计与可共享。
- **突变协议与人格进化**：每次进化必须显式声明 Mutation，并维护可进化的 PersonalityState。
- **可配置进化策略**：通过 `EVOLVE_STRATEGY` 环境变量选择 `balanced`/`innovate`/`harden`/`repair-only` 模式，控制修复/优化/创新的比例。
- **信号去重**：自动检测修复循环，防止反复修同一个问题。
- **运维模块** (`src/ops/`)：6 个可移植的运维工具（生命周期管理、技能健康监控、磁盘清理、Git 自修复等），零平台依赖。
- **源码保护**：防止自治代理覆写核心进化引擎源码。
- **动态集成**：自动检测并使用本地工具，如果不存在则回退到通用模式。
- **持续循环模式**：持续运行的自我进化循环。

## 使用方法

### 标准运行（自动化）
```bash
node index.js
```

### 审查模式（人工介入）
在应用更改前暂停，等待人工确认。
```bash
node index.js --review
```

### 持续循环（守护进程）
无限循环运行。适合作为后台服务。
```bash
node index.js --loop
```

### 指定进化策略
```bash
EVOLVE_STRATEGY=innovate node index.js --loop   # 最大化创新
EVOLVE_STRATEGY=harden node index.js --loop     # 聚焦稳定性
EVOLVE_STRATEGY=repair-only node index.js --loop # 紧急修复模式
```

| 策略 | 创新 | 优化 | 修复 | 适用场景 |
| :--- | :--- | :--- | :--- | :--- |
| `balanced`（默认） | 50% | 30% | 20% | 日常运行，稳步成长 |
| `innovate` | 80% | 15% | 5% | 系统稳定，快速出新功能 |
| `harden` | 20% | 40% | 40% | 大改动后，聚焦稳固 |
| `repair-only` | 0% | 20% | 80% | 紧急状态，全力修复 |

### 运维管理（生命周期）
```bash
node src/ops/lifecycle.js start    # 后台启动进化循环
node src/ops/lifecycle.js stop     # 优雅停止（SIGTERM -> SIGKILL）
node src/ops/lifecycle.js status   # 查看运行状态
node src/ops/lifecycle.js check    # 健康检查 + 停滞自动重启
```

## 典型使用场景

- 需要审计与可追踪的提示词演进
- 团队协作维护 Agent 的长期能力
- 希望将修复经验固化为可复用资产

## 反例

- 一次性脚本或没有日志的场景
- 需要完全自由发挥的改动
- 无法接受协议约束的系统

## GEP 协议（可审计进化）

本仓库内置基于 GEP 的“协议受限提示词模式”，用于把每次进化固化为可复用资产。

- **结构化资产目录**：`assets/gep/`
  - `assets/gep/genes.json`
  - `assets/gep/capsules.json`
  - `assets/gep/events.jsonl`
- **Selector 选择器**：根据日志提取 signals，优先复用已有 Gene/Capsule，并在提示词中输出可审计的 Selector 决策 JSON。
- **约束**：除 🧬 外，禁止使用其他 emoji。

## 配置与解耦

本插件能自动适应你的环境。

| 环境变量 | 描述 | 默认值 |
| :--- | :--- | :--- |
| `EVOLVE_STRATEGY` | 进化策略预设 | `balanced` |
| `EVOLVE_REPORT_TOOL` | 用于报告结果的工具名称 | `message` |
| `MEMORY_DIR` | 记忆文件路径 | `./memory` |
| `OPENCLAW_WORKSPACE` | 工作区根路径 | 自动检测 |
| `EVOLVER_LOOP_SCRIPT` | 循环启动脚本路径 | 自动检测 wrapper 或 core |

## Public 发布

本仓库为公开发行版本。

- 构建公开产物：`npm run build`
- 发布公开产物：`npm run publish:public`
- 演练：`DRY_RUN=true npm run publish:public`

必填环境变量：

- `PUBLIC_REMOTE`（默认：`public`）
- `PUBLIC_REPO`（例如 `autogame-17/evolver`）
- `PUBLIC_OUT_DIR`（默认：`dist-public`）
- `PUBLIC_USE_BUILD_OUTPUT`（默认：`true`）

可选环境变量：

- `SOURCE_BRANCH`（默认：`main`）
- `PUBLIC_BRANCH`（默认：`main`）
- `RELEASE_TAG`（例如 `v1.0.41`）
- `RELEASE_TITLE`（例如 `v1.0.41 - GEP protocol`）
- `RELEASE_NOTES` 或 `RELEASE_NOTES_FILE`
- `GITHUB_TOKEN`（或 `GH_TOKEN` / `GITHUB_PAT`，用于创建 GitHub Release）
- `RELEASE_SKIP`（`true` 则跳过创建 GitHub Release；默认会创建）
- `RELEASE_USE_GH`（`true` 则使用 `gh` CLI，否则默认走 GitHub API）
- `PUBLIC_RELEASE_ONLY`（`true` 则仅为已存在的 tag 创建 Release；不发布代码）

## 版本号规则（SemVer）

MAJOR.MINOR.PATCH

• MAJOR（主版本）：有不兼容变更  
• MINOR（次版本）：向后兼容的新功能  
• PATCH（修订/补丁）：向后兼容的问题修复

## 更新日志

### v1.10.3
- **可配置约束口径 (Configurable Blast Radius Policy)**：`computeBlastRadius()` 将运行产物（日志、memory、capsule、events）与功能代码分离。仅代码/配置文件计入 `max_files` 约束。策略可通过 `openclaw.json` 的 `evolver.constraints.countedFilePolicy` 配置。
- **结构化状态产出 (Structured Status Output)**：`solidify()` 生成结构化状态载荷（`result`、`en`、`zh`、`meta`），并写入周期状态文件，为下游报告提供丰富的进化上下文（intent、gene、signals、blast radius、validation 结果）。
- **Solidify CLI 可观测性**：`index.js solidify` 执行后输出 `[SOLIDIFY_STATUS]` 和 `[SOLIDIFY_STATUS_FILE]`，便于 wrapper 集成。

### v1.10.1
- **创新冷却 (Innovation Cooldown)**：在 `analyzeRecentHistory()` 中追踪近期创新目标，并在 GEP 提示词中注入 `Context [Innovation Cooldown]` 段，防止 Hand Agent 在连续周期中反复对同一技能/模块进行创新。
- **信号增强**：`analyzeRecentHistory()` 新增 `recentInnovationTargets` 返回值（目标路径到最近 10 轮出现次数的映射）。

### v1.10.0
- **运维模块** (`src/ops/`)：从环境相关的 wrapper 中提取 6 个可移植模块：
  - `lifecycle.js` -- 进程启停/重启/状态/健康检查
  - `skills_monitor.js` -- 技能健康审计 + 自动修复（npm install、SKILL.md 生成）
  - `cleanup.js` -- GEP 产物磁盘清理
  - `trigger.js` -- 唤醒信号机制
  - `commentary.js` -- 人格化周期评论
  - `self_repair.js` -- Git 紧急修复（终止 rebase、清理过期锁文件）
- **可配置进化策略** (`EVOLVE_STRATEGY` 环境变量)：
  - 4 个预设：`balanced`（默认 50/30/20）、`innovate`（80/15/5）、`harden`（20/40/40）、`repair-only`（0/20/80）
  - 策略感知的信号过滤，各预设有独立的修复循环阈值
  - 向后兼容：`FORCE_INNOVATION=true` 等价于 `innovate`
- **信号去重**：当最近 8 轮中修复占比 >= 50% 时强制创新（阈值随策略变化）
- **工具使用分析**：检测日志中的高频工具使用模式（由 Hand Agent 自动进化产出）
- **源码保护**（GEP Section IX）：核心 .js 文件列为不可修改，防止 Hand Agent 覆写
- **禁止创新区**（GEP Section X）：防止创建与已有基础设施重复的技能（进程管理、健康监控、定时任务等）
- **已知问题清单**（GEP Section VII.6）：告知 LLM 跳过已修复的错误
- **鲁棒性提升**：MemoryGraph 故障时 `process.exit(2)` 改为 `throw Error()`（循环不再因瞬态错误崩溃）
- **Gene 限制放宽**：repair max_files 12->20，innovate max_files 8->25
- `paths.js` 新增 `getWorkspaceRoot()`、`getSkillsDir()`、`getLogsDir()`

### v1.9.2
- 中间版本，包含策略预设和源码保护机制。

### v1.9.1
- 信号去重（修复比率检查）
- 单例锁（PID 锁文件）
- GEP 提示词中注入环境指纹

### v1.4.4
- 增加 validation 命令安全检查：Gene validation 命令执行前通过前缀白名单（node/npm/npx）和 shell 操作符拦截进行门控。
- 增加 A2A Gene 提升审查：外部 Gene 的 validation 命令不安全时拒绝提升。
- 增加安全模型文档。

### v1.4.3
- v1.4.3 发布准备。

### v1.4.2
- 增加 loop 门控：上一轮未完成 solidify 时，不启动新一轮（避免 wrapper 造成超快空转）。
- 修复固化状态写入覆盖问题：写入 last_run 时合并保留 last_solidify。

### v1.4.1
- 增加默认执行桥接：生成 GEP prompt 后输出 `sessions_spawn(...)`，自动派发执行型子智能体。
- 将 prompt 作为交接工件写入 `memory/`，便于稳定交接与审计回放。

### v1.4.0
- 增加显式 Mutation Protocol（repair/optimize/innovate），每轮进化必须生成 Mutation 对象并通过安全约束门控。
- 增加 Personality Evolution：维护 PersonalityState，小幅 PersonalityMutation（单次不超过 ±0.2，最多 2 个参数），并基于成功率做自然选择收敛。
- EvolutionEvent 增加 `mutation_id` 与 `personality_state` 字段；Memory Graph 同步记录 Mutation 与 Personality 的因果链路。
- 新增 `scripts/gep_personality_report.js`，用于统计不同人格配置下的成功率差异与收敛趋势。

### v1.3.1
- v1.3.1 发布准备。

### v1.3.0
- v1.3.0 发布准备。

### v1.2.0
- Memory Graph v2 与 A2A 进化资产交换集成。

### v1.1.0
- public 构建/发布流水线、提示词预算控制与结构化 GEP 资产持久化。

## 安全模型

本节描述 Capability Evolver 的执行边界和信任模型。

### 各组件执行行为

| 组件 | 行为 | 是否执行 Shell 命令 |
| :--- | :--- | :--- |
| `src/evolve.js` | 读取日志、选择 Gene、构建提示词、写入工件 | 仅只读 git/进程查询 |
| `src/gep/prompt.js` | 组装 GEP 协议提示词字符串 | 否（纯文本生成） |
| `src/gep/selector.js` | 按信号匹配对 Gene/Capsule 评分和选择 | 否（纯逻辑） |
| `src/gep/solidify.js` | 通过 Gene `validation` 命令验证补丁 | 是（见下文） |
| `index.js`（循环恢复） | 崩溃时向 stdout 输出 `sessions_spawn(...)` 文本 | 否（纯文本输出；是否执行取决于宿主运行时） |

### Gene Validation 命令安全机制

`solidify.js` 执行 Gene 的 `validation` 数组中的命令。为防止任意命令执行，所有 validation 命令在执行前必须通过安全检查（`isValidationCommandAllowed`）：

1. **前缀白名单**：仅允许以 `node`、`npm` 或 `npx` 开头的命令。
2. **禁止命令替换**：命令中任何位置出现反引号或 `$(...)` 均被拒绝。
3. **禁止 Shell 操作符**：去除引号内容后，`;`、`&`、`|`、`>`、`<` 均被拒绝。
4. **超时限制**：每条命令限时 180 秒。
5. **作用域限定**：命令以仓库根目录为工作目录执行。

### A2A 外部资产摄入

通过 `scripts/a2a_ingest.js` 摄入的外部 Gene/Capsule 资产被暂存在隔离的候选区。提升到本地存储（`scripts/a2a_promote.js`）需要：

1. 显式传入 `--validated` 标志（操作者必须先验证资产）。
2. 对 Gene：提升前审查所有 `validation` 命令，不安全的命令会导致提升被拒绝。
3. Gene 提升不会覆盖本地已存在的同 ID Gene。

### `sessions_spawn` 输出

`index.js` 和 `evolve.js` 中的 `sessions_spawn(...)` 字符串是**输出到 stdout 的纯文本**，而非直接函数调用。是否被执行取决于宿主运行时（如 OpenClaw 平台）。进化引擎本身不将 `sessions_spawn` 作为可执行代码调用。

### 其他安全约束

1. **单进程锁**：进化引擎禁止生成子进化进程（防止 Fork 炸弹）。
2. **稳定性优先**：如果近期错误率较高，强制进入修复模式，暂停创新功能。
3. **环境检测**：外部集成（如 Git 同步）仅在检测到相应插件存在时才会启用。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=autogame-17/evolver&type=Date)](https://star-history.com/#autogame-17/evolver&Date)

## 鸣谢

- [onthebigtree](https://github.com/onthebigtree) -- 启发了 evomap 进化网络的诞生。
- [lichunr](https://github.com/lichunr) -- 提供了数千美金 Token 供算力网络免费使用。
- [shinjiyu](https://github.com/shinjiyu) -- 为 evolver 和 evomap 提交了大量 bug report。
- [upbit](https://github.com/upbit) -- 在 evolver 和 evomap 技术的普及中起到了至关重要的作用。
- 其余贡献者扩充中。

## 许可证
MIT
