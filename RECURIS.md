# recuris-adapt — Recuris 式记忆进化闭环(DSH)

> 经 `~/.dsh/cordis.patch.yml` 的 `recuris-adapt` 行以 `file://` 加载(独立于
> `hindsight-adapt`)。理念借鉴 Recuris(Recursive Experiential–Working Memory
> Evolution, [Gen-Verse/Recuris](https://github.com/Gen-Verse/Recuris),
> arXiv:2608.24876), 借其**机制原则**, 不搬其 benchmark 代码。

## 是什么: 一套"复盘 → 产出 skill"的套件(被动与主动两半场, 各自独立成立)

一句话定位: **两半场, 各有所值; 合起来是"录 → 用 → 学 → 教"的闭环**:

| 半场 | 成本 | 独立价值(不依赖另一半) |
|---|---|---|
| **被动**(记录+注入, 默认自动) | 近零 LLM | **状态接地注入**(长任务按已验证状态决策, 少走回头路)、失败自动留痕、结构化轨迹可复盘(`recuris_trace`)、跨会话连续 —— **即使从不主动复盘, 日常长任务质量也在提升** |
| **主动**(复盘+产出, 手动触发) | 按次付费 | 在被动积累的轨迹上**复盘失败 → 过验证门控产出技能卡 → 分发**(重试注入 / Hindsight 记忆面 / 全局 SKILL.md) |

关系: 被动是"录与配"(数据源 + 日常收益), 主动是"学与教"(把被动积累变现);
主动产出的卡**反哺被动**(TTA 重试自动携带)。学的是高频踩坑, 产的是有质量保障的 skill。

## 与 Recuris 的对应

| Recuris 组件 | 本插件实现 |
|---|---|
| Skill Memory `M = (E, W, ρ, C)` | `skills/` 卡文件(E) + `wm/` 卡(W) + 状态驱动注入/失败域召回(ρ) + 门控(C) |
| E 技能记忆 | 卡片式 JSON(`name/applicability/steps/failure_modes/provenance/gate/purpose`), 单卡替换 |
| W 工作记忆 | goal 视图 + 轨迹摘要的**已验证状态**, 非对话历史; pre-step 注入 |
| ρ 路由 | 检索由工作记忆驱动(`injectWmEnabled` 注入; 进化时按失败域召回 hs-memory) |
| C 验证门控 | 确定性检查(结构 + 失败模式覆盖度留出), **meta 模型不给自己 patch 投票** |
| 使用循环 | `agent/turn-stopping` 写轨迹+WM; `agent/pre-step` step1 注入 WM + 命中经验卡 |
| 进化循环 | `recuris_evolve`: **Wiki Maintainer 提炼持久模式(P6)** → 并行诊断 workers → 合并 → 单组件 patch(regCap) → 门控(含回放) → 卡落盘+追溯+同步 → ledger(含审计) |
| TTA 循环 | **失败后重试自动携带命中卡**(pre-step 注入); `recuris_verify` 离线推演验证|
| 知识层(P6, WikiSkill) | `patterns/` 持久模式(失败模式+规避), **永不回滚**; 卡 `purpose.patternIds` ↔ 模式 `cards[]` 双向追溯; ledger `audit` 提案审计(防重复提议) |

## 存储布局(默认 `~/.dsh/storages/recuris/`)

> 原则: **插件只有这一个存储根**(`root` 配置可整体搬移), 所有产物均为其子目录,
> 无任何独立存储目录, 便于整体备份/清理/迁移。

```
trajectories/<sessionId>.jsonl   逐 turn: {t, ts, w(goal摘要), user, actions[], assistant, fail, error}
wm/<sessionId>.json              工作记忆卡(目标/阶段/进度/阻塞/最近动作)
wm/<sessionId>.note.json         recuris_wm 手动备注
skills/<cardId>.json             技能卡(唯一可回滚的进化组件, 含 version/history/gate/purpose)
patterns/<patId>.json            持久模式知识层(Wiki, 永不回滚: 失败模式+规避+引用卡+history)
evolutions/<runId>.jsonl         进化 ledger: 证据 / 诊断 / 合并 / 门控算术 / 审计 / 落卡 / 同步
```

## 工具

| 工具 | 作用 |
|---|---|
| `recuris_evolve` | 复盘: `{taskId?, failure}` → **Wiki Maintainer 提炼持久模式** → 诊断 → 合并 → 门控 → 落卡(+PURPOSE 追溯) → ledger(含提案审计) |
| `recuris_wm` | 读写工作记忆备注(无 goal 时手动维护状态) |
| `recuris_skills` | 列出/查看技能卡(加 `id` 看全文, 含源自模式) |
| `recuris_patterns` | **查看持久模式知识库(P6/Wiki 层)**: 失败模式+规避, 永不回滚; 加 `id` 看单模式全文(含引用卡) |
| `recuris_trace` | 查看某任务的结构化轨迹 |
| `recuris_verify` | **卡演练(P4b)**: 卡在某任务失败段上离线推演"按卡重做会怎样", 记入卡 verifications 与 ledger |
| `recuris_export` | **卡→SKILL.md 全局技能(P5)**: 只导 `gate=passed` 卡为 `~/.agents/skills/<id>/SKILL.md`(全机 agent 会话按需可加载); 默认 dryRun 预览 |
| `recuris_status` | 插件状态: 存储根/卡数/wiki 模式数/ledger/meta 模型/自动触发开关 |

## 主动触发与操作流

主动工具都是**会话内工具调用**(注册在 agent 工具表), 共三条触发路径:

| 路径 | 谁触发 | 条件 | 默认 |
|---|---|---|---|
| 模型自主判断 | agent | 任务失败/纠错/重试时, 判断该域值得复盘 → 调 `recuris_evolve` | 随时可用 |
| 用户显式指令 | 用户 | 一条消息说"复盘"/"导出技能"/"跑 verify" | 随时可用 |
| 事件驱动 | 插件 | `agent/error` 发生 → 自动 evolve | `autoEvolveOnError: false`(默认关, 防后台烧钱) |

**完整一次主动操作流**:

```
任务失败/反复踩坑
  → recuris_evolve { failure: "..." }          # 复盘: 4 次 pro, 2–6 分钟
  → recuris_skills                             # 看卡: 门控/步骤/失败模式
  → recuris_verify { cardId: "..." }           # 导出前演练: 1 次 pro
  → recuris_export                             # dryRun 预览(0 成本)
  → recuris_export { dryRun: "false" }         # 落盘全局 SKILL.md
```

历史任务复盘: `recuris_trace taskId=<会话id>` 看轨迹 →
`recuris_evolve taskId=<会话id> failure="当时问题"`(轨迹持久在磁盘, 跨会话可用)。

- **模型自主**是常态形态: description 写明用途, agent 看到失败信号按触发词判断调不调;
  判断权在语义, 适合灵活决定"这次值不值得花 2–6 分钟"。
- **用户显式**给你完全控制权, 一条消息即可。
- **事件驱动**是真正自动: 仅建议临时开(如盯某个高频域几天), 常开会一天几十万 tokens。

## 进化闭环(一次 `recuris_evolve` 的内部)

1. **证据收集**: 本任务轨迹尾部(`evidenceTrajectoryTurns`) + 头 2 轮; 近期其他失败任务
   (`evidenceFailures`); Hindsight 相关经验(`hs-memory recall`, 可关); 域内已有技能卡;
   **持久模式知识层概要 + 最近被拒提案(仅注入给演化器)**, 可关。
2. **Wiki Maintainer(P6, 借鉴 WikiSkill)**: 用 meta 模型把本次轨迹+观察提炼为
   **持久模式**(`失败模式 + 可操作规避 + 证据`), 落盘 `patterns/` —— **永不回滚**,
   跨进化迭代持续累积; 后续技能提案直接吸收其中的 workaround。
3. **并行诊断**(`diagnosisWorkers`=3): 三个角度(localization / skill-audit / new-skill),
   每个由**上游 meta 模型**(默认 `opencode-go/deepseek-v4-pro`, 配置 `metaProvider/metaModel`,
   失败自动降级 `metaFallback*`)独立输出结构化诊断(仅 JSON)。
4. **合并**(一次 consolidate 调用, 提示含持久模式 + 被拒提案, 防重复提议):
   按 `regCap`(默认 1)收敛为**单个组件的 patch**, `new-card`(新卡)或 `patch-card`(只改目标卡), 防震荡。
5. **门控**(确定性, 无模型自评):
   - 结构检查: name / steps(≥1 且非空) / applicability.when(具体) / failure_modes(≥1);
   - 防泄漏: 卡内容不得含密钥/令牌形态;
   - 体量: ≤6k 字符;
   - **覆盖度留出**: 卡 `failure_modes` 对本次观察的失败词重叠 ≥50%(非严格档软放行);
   - **回放留出(P3b)**: 候选卡在**其他失败任务的完整轨迹**上确定性回放——
     ① 卡 failure_modes 与留出任务失败文本词重叠(中英混合: 词重叠≥2 / 全串包含 / 8 字前缀包含)
     ② 卡步骤动作关键词命中留出任务动作序列。命中 ≥1 条且 ≥50% 为 pass;
     无留出样本 → no-held-out(非严格档放行, `gateStrict: true` 拒绝)。
6. **落盘 + 追溯 + 同步**: 卡写入 `skills/`(version/history/gate.checks 全记录);
   **P6 卡↔模式双向追溯**: 卡按 failure_modes 关联持久模式, 卡写 `purpose.patternIds`,
   模式写 `cards[]` 反向索引;
   **P3a** 准入卡镜像进 Hindsight——与 `skill-crystallize` 同构的 REST 写入口
   (`POST /v1/default/banks/<bank>/memories`), `context: provenance:crystallized; type:skill; card:<id>`,
   `document_id: card-<id>`(同主题覆盖), 此后 `hindsight_recall --types skill` 可精确召回。
7. 全证据+算术+回放明细+**提案审计(diff+接受/拒绝+门控)**+同步结果写入 ledger(`evolutions/<runId>.jsonl`)。

## 配置(全部有默认; 覆盖时整块写进 yml 的 config)

```yaml
config:
  traceEnabled: true          # P0 轨迹记录
  wmEnabled: true             # P1 工作记忆卡
  injectWmEnabled: true       # pre-step 注入 WM(状态接地)
  toolsEnabled: true          # recuris_* 工具
  metaProvider: opencode-go   # 上游 meta 模型
  metaModel: deepseek-v4-pro
  metaFallbackProvider: qwen-token-plan-cn
  diagnosisWorkers: 3
  regCap: 1
  gateStrict: false
  autoEvolveOnError: false    # agent/error 自动触发(原型默认手动)
  autoEvolveMinTurns: 3
  autoEvolveCoolDownMs: 600000
  # P3a: 卡 → Hindsight 同步(type=skill, recall --types skill 可召回)
  hindsightSync: true
  hindsightApiBase: http://localhost:8888
  hindsightSyncBank: repo    # repo=当前项目库(自动解析 git 根) | global
  # P3b: 回放式门控(留出失败轨迹上确定性回放)
  replayGateEnabled: true
  replayHeldOutTasks: 2
  # P6: 持久模式知识层(Wiki Layer, 借鉴 WikiSkill arXiv:2608.27454)
  wikiEnabled: true          # patterns/ 知识层(失败模式+规避), 永不回滚
  patternsMax: 4             # 单次演化最多提炼模式数
  auditEnabled: true         # ledger 提案审计(diff+接受/拒绝+门控, 防重复提议)
  # P4a: TTA 携带卡 —— 会话内有失败标记时 pre-step 注入命中卡(重试携带教训)
  ttaInjectEnabled: true
  root: /Users/lanws/.dsh/storages/recuris
```

## 使用与验证

1. `node --check recuris.mjs` 通过; 重启 `dsh web`(或确认 HMR 已热载)后,
   新会话工具表应出现 `recuris_*` 8 个工具(evolve/wm/skills/patterns/trace/verify/export/status)。
2. 冒烟测试(不依赖 harness, mock LLM): `node test/recuris.smoke.test.mjs`
3. 长任务会话中: 失败后对当前会话直接调 `recuris_evolve`(failure 必填),
   或对任意历史会话 `recuris_trace` → `recuris_evolve taskId=<会话id>`。
4. 检查产物: `recuris_status` / `recuris_skills`, 或直接看
   `~/.dsh/storages/recuris/{skills,evolutions}`。

## P4(TTA + 验证闭环)

- **P4a TTA 携带卡**(`ttaInjectEnabled`, 默认开): pre-step 检测到本会话轨迹有**失败标记**
  (`fail=true`, 来源 `agent/error`/手动失败轮)时, 用 `failure_modes` 匹配 `skills/` 中已准入卡
  (词重叠/全串包含/8 字前缀包含, 中英混合鲁棒), 命中则随 WM 一起注入"任务经验卡"块——
  **重试天然携带上次进化的教训**, 无需求助或重翻历史。
- **P4b 卡演练验证**(`recuris_verify`, 手动): 对一张卡在某任务的失败段上, 用 meta 模型
  **离线推演**"按卡步骤重做会怎样"(明确不执行外部动作), 输出能否避免/重做步骤/理由/
  剩余风险, 记入卡的 `verifications[]` 与 verify ledger。这是"回放"的模型侧增强,
  但**不作为准入条件**(门控仍是确定性), 只作经验证据积累, 供下次 evolve 参考。

## P5(卡 → SKILL.md 全局技能)

`recuris_export` 把**已准入**(`gate.status=passed`)的技能卡转成 `~/.agents/skills/<id>/SKILL.md`,
这是知识从"插件内中间态(JSON 卡)"到"全机 agent 主动可加载的最终固化形态"的最后一跳:

- **受益范围**: 本机所有 agent(pi/claude/codex/… )的每个会话都能经 `skill` 工具按触发词加载,
  不依赖 recuris 插件运行时; 停插件/换 dsh/同步 `~/.agents/skills` 后依然在。
- **模板**: 遵循 skill-add —— frontmatter(`name`/`description` 由卡生成触发词) +
  正文(适用场景/操作步骤/避坑=失败模式/验证记录/来源 runId)。
- **噪音控制(默认)**: 只导 passed 卡(soft 需 `force=true`); `minVerifications=N` 可要求正向演练
  记录; 与技能目录同名跳过; 不自动改 `.skill-lock.json`, 不自动扩散其余 agent 摘要行
  (那一步留给人工决定, 符合 skill-add 纪律)。
- **流程**: `recuris_export`(dryRun 预览) → 确认 → `recuris_export dryRun=false` 落盘 →
  技能目录扫描即时可见(新会话 available_skills / `skill <id>` 验证)。

## P6(持久模式知识层 + 提案审计, 借鉴 WikiSkill arXiv:2608.27454)

把 Recuris 从"轨迹 → 卡"的直筒结构升级为三层: **raw(轨迹, 不可变) → patterns(知识,
永不回滚) → skills(卡, 可回滚)**, 与 WikiSkill 的结论对齐——持久知识累积是演化质量的胜负手。

- **Wiki Maintainer**(`runWikiMaintainer`, evolve 第一步): 用 meta 模型从本次轨迹+观察中
  提炼 `失败模式 + 可操作规避 + 证据` 的持久模式, 落盘 `patterns/<patId>.json`。
  **永不回滚**: 无论后续门控是否拒绝提案, 模式都保留并在跨迭代中持续累积(同模式名合并,
  证据追加, history 记录每次演化); 因此后续技能提案能"站在已积累知识上"而非重头再来。
- **卡↔模式双向追溯(PURPOSE 等价)**: 准入卡按 failure_modes 文本重叠自动关联持久模式——
  卡写 `purpose.patternIds`(它源自哪些知识), 模式写 `cards[]`(哪些卡引用它)。`recuris_skills
  <id>` 与 SKILL.md 导出都会带"源自持久模式"; `recuris_patterns` 可按 `id` 看单模式全文。
- **提案审计(防重复提议)**: ledger 增加 `audit[]`——每个提案记 `{kind, targetCardId, cardName,
  diff, accepted, rejectReason, gateStatus, replay}`。被拒提案进入下次演化的 evidence
  (`attachPersistentKnowledge` 注入), 合并器明确被告知"历史被拒提案, 不要重复提出相同干预"。
- **人工可查**: `recuris_patterns`(知识层) / ledger 的 `wiki` 与 `audit` 字段 / `recuris_status`
  显示 wiki 模式总数。
- **反直觉经验(已固化全局)**: 知识库只给"演化器"读, 不注入"执行器"上下文——执行时直接抄知识
  会让轨迹失去信息量(论文消融: 注入反而降质); 技能可跨模型/agent 迁移, 小 agent 带技能可超越
  大 agent 无技能。

## 成本—收益总览(2026-08-31)

> 一图流: **被动 = 录与配(近零成本)** —— 状态仪表盘 + 失败黑匣子 + 数据资产;
> **主动 = 学与教(按次付费)** —— 把一次失败变成可复用的资产。

### 被动收益(零成本层)

| 类型 | 收益 | 机制 | 日常体感 |
|---|---|---|---|
| A·独立成立 | 状态接地决策 | pre-step 注入 goal 快照+进度 | 长任务按"已验证状态"决策, 少翻历史/少走回头路 |
| A·独立成立 | 失败自动留痕 | `agent/error` 落盘失败轮 | 出错瞬间的 action 链+错误文本永久可查, 重启不丢 |
| A·独立成立 | 任务可复盘 | `recuris_trace` | 结构化回溯(w/actions/assistant/fail 四维) |
| A·独立成立 | 跨会话连续 | 轨迹+WM 卡按 session 持久 | 重开会话接上"上次做到哪" |
| B·为进化铺路 | 轨迹=证据源 | evolve 靠轨迹定位失败 | 每一次记录都是将来复盘的低成本素材 |
| B·为进化铺路 | 留出失败库 | 回放门控(P3b)吃其他失败轨迹 | 门控有样本可回放, 不空转 |
| B·为进化铺路 | 失败标记喂 TTA | 自动检测失败+匹配卡 | 与 evolve 衔接成完整闭环 |

**诚实声明**: 纯被动不产卡(卡是 evolve 产物); 没跑过 evolve 时 TTA/同步/导出空转——零成本, 无害。

### 主动收益(按次付费层)

| 动作 | 花销 | 买到什么 |
|---|---|---|
| `recuris_evolve` | 4 次 pro / 2–6 分钟 | 组件级归因 + 过门控/回放的卡 + 自动进被动管线 + 可审计 ledger |
| `recuris_verify` | 1 次 pro / 30–90s | 导出前离线演练, 避免扩散"有毒"卡 |
| `recuris_export` | 0 | 一次生成全机 agent 可加载的 SKILL.md(最便宜的杠杆) |

- **复利/收敛**: 卡库越厚 → 重试命中率越高 → 同类失败越少 → evolve 次数递减。
  主动成本随使用递减, 被动收益随卡库递增。
- **可靠性**: 组件级归因(改一处不坏别处) + 门控全确定性(模型不自我评分) +
  verify 只积累证据不参与准入 + ledger 逐环可审计。
- **诚实边界**: 论文 +17.8pp 等数字来自可重放基准(τ²-Bench), 本机无此标尺不可平移;
  本机验证靠自证证据: `recuris_status` evolve 次数 / `recuris_skills` 门控 checks /
  TTA 注入命中数 / verify 通过数 / 导出后 `skill <id>` 加载场合。
- **回本视角**: 一次 evolve 的卡被重试命中 1 次或导出后被他 agent 复用 1 次即回本。
  建议档位: 默认全手动; 只对"踩坑 ≥2 次"的域 evolve; 导出前必 verify。
- **适用判据(什么时候值得复盘)**: 复盘 ROI = **未来复现频率 × 单次损失 × 卡命中率 ÷ 单次复盘成本**。
  成本(分母)固定, 分子第一因子"这件事还会不会再来"决定一切 —— **只有不断做的事才有复盘价值**:
  - 高频垂直域(会反复出现在会话/跨会话): 卡被反复命中 → 快速回本, 值得 evolve + verify + export;
  - 一次性/低频任务: 卡无人复用, 复盘是沉没成本, 跳过(门控 no-held-out 也会如实显示证据不足);
  - 卡/技能知识的"复用面"还决定扩散价值: 会传导到其他 agent 的知识(如工具链排错)才值得导出 SKILL.md。
  被动记录在这里的隐藏价值: 让你基于**真实轨迹频率**(`recuris_status` 观察哪些域反复失败),
  而不是感觉, 判断"该不该为这个域花一次复盘成本"。

### 成本(明细见下节)

一句话: **被动(记录/注入/回放/同步/导出)≈0 LLM 成本; 主动唯一花钱点 = 每次
`recuris_evolve` ≈4 次 pro / 2–6 分钟, 完全由手动触发决定。**

## 成本核算(2026-08-31 实测口径)

> 估算口径: 上游 meta=deepseek-v4-pro(opencode-go), 中文 ≈0.6–1 token/字;
> 数字为数量级估计, 实际随模型/上下文浮动。分三层, 只有一层真实"贵"。

### 总览: 三层成本

| 层 | 机制 | LLM 调用 | 默认状态 |
|---|---|---|---|
| **零成本** | P0 轨迹 / P1 WM 写盘 / P3b 回放 / P5 导出 / P3a 同步 | 0 次 | 自动 |
| **小增量** | pre-step 注入 / 证据侧 `hs-memory recall` | 0 次(仅向量检索) | 自动 |
| **按次付费** | `recuris_evolve`(3+1 次 pro)、`recuris_verify`(1 次 pro) | 4/1 次 | **手动触发** |

### 被动开销(默认部署, 每会话自动, 几乎免费)

| 项目 | 增量 | 说明 |
|---|---|---|
| pre-step 注入 | 每 turn 第 1 步一次; WM ≈0.2–0.3k, TTA ≈0.15–0.25k tokens | per-turn 去重; **无 goal/无失败命中则不注入**(普通会话可能零注入) |
| 轨迹/WM 落盘 | 0 token, 纯本地 JSONL | 每任务几十 KB, 可忽略 |
| 典型 10 轮会话 | ≈3–6k tokens 输入 | 相对会话总量 ≈ **1–3%**, 且仅输入侧 |

> hindsight-adapt 既有的 curate/consolidate/crystallize 是**既有成本**, recuris-adapt 不新增后台 LLM 循环。

### 主动开销(手动调用, 真实成本所在)

| 动作 | 调用 | 输入量(估算) | 输出 | 耗时 |
|---|---|---|---|---|
| `recuris_evolve` | 3 诊断并行 + 1 合并 = **4 次 pro** | 每 worker ≈15–25k(轨迹尾 24 轮 ≈7–15k + 相关记忆 + 近期失败 + 卡); 合计 ≈**55–90k** | ≈1.5–2k | **2–6 分钟**(单次 180s 超时保护) |
| `recuris_verify` | 1 次 pro | ≈2–6k | ≈0.5k | 30–90s |
| `recuris_export` | 0 次 | — | — | 瞬时 |
| `recuris_skills/trace/status/wm` | 0 次 | — | — | 瞬时 |

**一次 evolve 的意义化**: ≈55–90k 输入 ≈ 主会话**多聊 1–3 轮**; 由上游 pro 承担(次数少、单价高、频率极低)。

### 两种模式账单

- **默认(推荐)**: `autoEvolveOnError=false` + 手动工具 → 后台 **0 次额外 LLM 调用**,
  会话增量仅注入 1–3% 输入。**日常几乎零增量**。
- **全自动**(`autoEvolveOnError=true`): 每个 `agent/error` 自动 evolve(10 分钟冷却 + ≥3 轮门槛);
  常失败会话一天可达 5–10 次 evolve ≈ 30–90 万 tokens 输入。**不建议长期开**, 仅 debug 期观察。

### 省钱调优(均已有开关)

| 手段 | 效果 |
|---|---|
| `diagnosisWorkers: 3→1` | evolve 输入 −2/3(只留 localization 角度) |
| `evidenceTrajectoryTurns: 24→10` | 每 worker 输入减半 |
| `evidenceRelatedMemories: false` | 省一次 recall(本来便宜) |
| `metaModel → deepseek-v4-flash` | 单价大降, 诊断质量略降 |
| verify 只在"卡要导出前"跑一次 | 不必每卡都积累验证 |
| P3a/P3b/P5 全为 0 LLM | 随便用 |

### 一句话结论

**被动使用(记录+注入+回放+同步+导出)几乎零成本; 唯一的钱花在"复盘"上 ——
每次 `recuris_evolve` ≈ 4 次 pro / 2–6 分钟, 由手动触发决定。建议保持默认手动,
把 evolve 当"任务收尾的复盘动作", 而非每次失败自动跑。**

## 设计取舍与已知限制(原型)

- **回放门控是确定性近似**: 论文在 τ²-Bench 上以可重放基准做门控; 本机回放=在留出失败
  轨迹上做词/动作匹配(中英混合鲁棒), 仍确定性、可审计、无模型自评。verify 推演(P4b)
  是模型侧的经验积累, 不参与准入 — 保持"模型不自己投票"。
- **meta 模型调用有真实成本**: 一次 evolve ≈ 3(诊断)+1(合并)次 pro 级调用 +
  1 次 Hindsight 同步(REST, 便宜); `diagnosisWorkers` 可调小。工具调用前建议先对用户说明。
- **同步写入口与 skill-crystallize 同构但独立**: 未改共享 CLI(那是 pi/ga 共同契约);
  若未来共享 CLI 提供"单卡 store"子命令, 应改经它。同步失败不影响卡文件(卡仍是权威)。
- **per-agent 演化**: Recuris 的结论是"为一模型演化的包迁移到别的模型会负收益",
  本机下游固定(deepseek-v4-flash 预设), 卡按当前 agent 组合演化, 勿跨模型套用。
- **轨迹只在主机进程内**: 重启 dsh 后旧会话轨迹仍在磁盘(JSONL 持久), 可跨会话复盘。