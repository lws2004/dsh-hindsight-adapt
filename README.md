# DSH Hindsight 薄适配层(dsh-adapt)

DSH(DeepSeek Harness) 的 Hindsight 记忆集成,遵守本机统一约定
(见 `~/.hindsight/README.md` 与任务书 `~/.hindsight/AGENT-ADAPT-PROMPT.md`)。

## 为什么存在

原集成是 `@vectorize-io/hindsight-coding-agents` 的 `dist/dsh.js` bundle(经
`~/.dsh/cordis.patch.yml` 加载)。它的问题是:

1. **非 git 目录用目录名建库**: `gitProjectName` 在非 git 目录 fallback 到目录名,
   违反约定"非 git → `coding-agent::global`(禁止目录名建库)",产生过
   `coding-agent::soft` 等碎片库。
2. **更新覆盖**: 直接改 `dist/dsh.js` 会在下次插件安装时被覆盖。

## 方案(薄封装,与 pi 的 hindsight.ts 同构)

- **保留** dsh.js 加载条目(installer 更新会重写它,不能删),但用
  `coding-agent.json` 的 `"harnesses": {"dsh": {"disabled": true}}` 禁用它
  (不注入、不注册工具、不写回,全部 no-op)。
- **新增** 本插件 `plugin.mjs`(id: `hindsight-adapt`,独立标记区块,installer
  的 DSH_BLOCK_RE 不会动它),只做三件事:
  1. 环境设置: 声明 `HINDSIGHT_OWN_BANK=dsh`(harness 独占库,`--scope self`
     的落点: 会话产物/个人化偏好)、不设 DEFAULT_BANK(写路由默认位置快速
     路径: git→项目库, 非 git→global, self→dsh)
  2. 会话钩子: pre-step 调 `hs-memory inject`(自动模式) / turn-stopping 攒批
     调 `curate` / 会话结束调 `session-end`
  3. 工具: `hindsight_retain` / `hindsight_recall` / `hindsight_reflect` /
     `hindsight_status`,全部转调 `~/.hindsight/harness-memory.sh`
     (v0.3.0 另加只读知识页三件套: `hindsight_list_knowledge_pages` /
     `hindsight_search_knowledge_pages` / `hindsight_read_knowledge_page`,见下文)

全部记忆逻辑(路由/感知/deny/密钥过滤/来源标注/策展/整合)由共享 CLI
hs-memory 承担,本插件不重复实现。

### 自动注入相关性(2026-08-30)

`hs-memory inject` 自动模式的 light 档(普通消息)原来只查 `HINDSIGHT_OWN_BANK=dsh`
独占库(仅 10 条技术杂记),导致每次注入的内容对日常任务经常不相关;而真正的
工作知识在项目库(数百条)与 global,light 档根本不会碰。

修复(共享 CLI 新增两个环境变量,默认行为不变、pi 不受影响):

| 环境变量 | dsh 插件设置 | 效果 |
|---|---|---|
| `HINDSIGHT_INJECT_LIGHT_BANKS` | `current,global` | light 档改查 当前项目库+global; 意图词命中(intent 档)仍全查 含 dsh |
| `HINDSIGHT_INJECT_MIN_SCORE` | `0.35` | 按召回 `scores.final` 过滤低相似度条, 宁缺毋滥(无相关记忆则不注入) |

### 召回类型选择(2026-08-30)

`hindsight_recall` 支持 `factTypes` 参数,给 agent 三档选择(默认 `observation`):

| factTypes | 行为 | 实现 |
|---|---|---|
| `observation`(默认) | 只取整合观察,自动去重不重复 | 不传 `--types` → 全类型召回 + 共享层 `prefer_observations=True` |
| `world` | 只要原始事实(world/experience),便于溯源 | `--types world,experience --prefer-obs false` |
| `both` | 原始事实 + observation 并列全取(可重复) | `--types world,experience,observation --prefer-obs false` |
| `skill` | 只要结晶指令块(skill-crystallize 产物) | `--types skill`(结果侧按 context/document_id 过滤,不依赖 tags) |

共享 CLI 侧同步扩展: `hs-memory recall` 新增 `--types` 与 `--prefer-obs`(默认 true)参数,
其他 agent(pi/ga) 也可直接使用。

### 自动抽取可靠性(v0.2.0, 2026-08-30, 参考 dsh-memos-remote 工程处理)

`turn-stopping` 攒批 `curate` 原有三个转录丢失点,本轮全部修复:

| 丢失点 | 修复 |
|---|---|
| curate 批次 splice 即弃,失败/超时整批丢失 | **待确认批次队列**: 批次移入 `pending` 并异步执行;成功才确认,失败回滚到缓冲头部重试(同转录上限 2 次,超过放弃并 warn) |
| 会话在 curate 在途时结束 → 批次不被 session-end 兜底 | `disposed` 把 leftover + 全部 pending 未确认转录**合并进 session-end**,杜绝"尝试抽取但未确认"窗口 |
| 缓冲超 `maxBufferChars` 直接丢最老轮次 | **超限应急抽取**: 最老超出批次**先应急 curate**(每 turn 一次),失败才丢弃并留 warn 日志 |

另有:

- **工具链入转录**: 配对轮次时保留 `tool/call` 的 action 行,转录变为
  `用户 → 工具: … → 助手`,策展模型能看见操作链,procedure 抽取更准
- **Config 化**(cordis.patch.yml 的 config 键覆盖,无需改代码): `enabled / injectEnabled /
  curateEnabled / curateEveryN(默认3) / maxBufferChars(12000) / curateTimeoutMs /
  injectTimeoutMs / consolidateEveryNCurate(5) / crystallizeEveryNCurate(3) / toolsEnabled`
- **节流日志**: curate 成功/失败/回滚/丢弃均打日志,同 session 同名事件 60s 窗口只打一次
- **recall 去重对齐**: pre-step 注入仅 `step===1` 且 WeakMap 按 turn 去重,递归/子代理步骤不再重复注入

### 技能结晶(skill-crystallize, P3 下沉共享 CLI)

每 `crystallizeEveryNCurate` 次 curate 成功后,异步触发 `hs-memory skill-crystallize`:
检索目标库 procedure 类记忆 → LLM 归纳为可执行指令块(适用场景/前置条件/步骤)→
存回 `type:skill`(同主题 doc_id 覆盖),`hindsight_recall --types skill` 可精确召回。
共享 CLI 新增子命令(`hs-memory skill-crystallize [--bank B|--scope S] [--topic 主题] [--min N] [--dry-run]`),
**所有 agent 共用**(pi/ga 等直接调用即可),服务端仅认 world/experience/observation 三态类型,
`skill`/`procedure` 等自定义类型在共享 CLI 结果侧按 context/document_id 过滤(不依赖 tags,避免 SKILL.md 语义标签误报)。
procedure 不足阈值时自动跳过,不产生噪音。

### 知识页接入(v0.3.0, 2026-09-15, 方案 B)

Hindsight 0.9.0 起服务端会为项目库产出 **Knowledge Pages** —— 记忆的"投影视图"
(架构与组件 / 约定与模式 / 核心概念 / 关键决策 / 进行中倡议),由服务端 mental model
随 `consolidate` 自动重建,是"当下成立的结论"而非原始事实的堆叠。此前 DSH 侧零消费:
页在服务端空转(3 个库共 16 页),会话永远看不到。本版补上**只读**读取链路,而不回到
官方 bundle(保住按需 recall 等本机调优):

| 层 | 新增 | 说明 |
|---|---|---|
| 共享 CLI | `hs-memory pages list\|search <query>\|read <page_id>` | 复用 `resolve_bank` 归属路由;其他 agent(pi/ga)同样可用 |
| 插件工具 | `hindsight_list_knowledge_pages` / `hindsight_search_knowledge_pages` / `hindsight_read_knowledge_page` | 与官方 A 面(hermes/codex 面)同名同义,全部转调 CLI |
| 会话注入 | 首轮与召回**并行**预取页目录,就绪才注入 `<hindsight_knowledge>` 块 | 未就绪即放弃(不阻塞首条);注入块由 `stripInjectedMemory` 剔除,不进 curate 转录 |

开关(`cordis.patch.yml` 的 config 键,均有默认值、无需显式配置):
`knowledgePagesEnabled`(默认 true;false 时不下发三个工具也不注入)、
`knowledgePagesInject`(默认 true;false 时只保留工具按需调)、`knowledgePagesRosterMax`(8)、
`knowledgePagesTimeoutMs`(15000)、`knowledgePagesGraceMs`(800)。

服务端低于 0.9.0(接口 404/405/501)时 CLI 返回明确提示,插件静默跳过注入,不影响记忆主链路;
页由服务端维护,插件全程只读、不发写请求。

## 相关文件

- `<repo-root>/plugins/dsh-hindsight-adapt/plugin.mjs` — 本插件权威源码(统一仓库管理;`~/.hindsight/dsh-hindsight-adapt` 为符号链接指向此处)
- `~/.dsh/cordis.patch.yml` — `hindsight-adapt` 条目(独立标记区块)
- `~/.hindsight/coding-agent.json` — `harnesses.dsh.disabled: true`

## Recuris 式记忆进化闭环(同仓附加模块)

`recuris.mjs`(经 `cordis.patch.yml` 的 `recuris-adapt` 行独立挂载)在薄适配层之上增加
**记忆进化闭环**: 逐轮结构化轨迹 + 工作记忆状态接地 + 失败后并行诊断/组件级 patch/
确定性验证门控 + **持久模式知识层(patterns/, 失败模式+成功策略两面, 借鉴 WikiSkill
arXiv:2608.27454)** + 提案审计 + 演化统计 + 卡→SKILL.md 全局技能导出。详见
[RECURIS.md](RECURIS.md)。
**成本要点**: 被动使用(记录/注入/回放/同步/导出)几乎零 LLM 成本; 仅 `recuris_evolve`
(≈4 次 pro, 2–6 分钟)与 `recuris_verify`(1 次)按次付费且默认手动触发, 完整核算见
[RECURIS.md 成本核算](RECURIS.md)。

## 生效时机

DSH 下次启动生效(插件在启动时加载)。

## 存量迁移(2026-08-29)

历史碎片库 `coding-agent::soft`(640 facts)已迁移:

- 452 条 world/experience 原始事实 → 项目库 `coding-agent::deepseek-harness-plugins`
  (批量 retain,含原始 text/context/document_id/timestamp;派生 observation 自动重建)
- 3 条真重复(1 global + 2 soft)已软退役(state=invalidated,可逆)
- 全量原始数据备份: `soft-backup-20260829.json`(本目录)
- 独占库 `dsh` 已创建并经 `HINDSIGHT_OWN_BANK=dsh` 声明,`--scope self` 可写可读
## 官方规范参考

- [打包与安装插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md) — Bundle/Profile 机制
- [插件配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md) — Config schema 定义
- [Cordis 入门](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.zh.md) — 核心概念与事件模式

## Model Experience

None, as this plugin is disabled (the memory backend moved to OpenViking on 2026-09-16); when enabled it injected recall entries.

#### KV Cache effect

Independent while disabled.

## Known Limitations and Deferred Work

- **已停用** — 后端切至 OpenViking(:1933)；恢复步骤见本包 README 与 `~/.hindsight/README.md`。
