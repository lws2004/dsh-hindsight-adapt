// ═══════════════════════════════════════════════════════════════════
// DSH(DeepSeek Harness) Hindsight 薄适配层 — 本机统一约定
// 任务书: ~/.hindsight/AGENT-ADAPT-PROMPT.md | 约定: ~/.hindsight/README.md
//
// 分工原则(见 README): 全部共享逻辑(路由/感知/deny/来源标注/密钥过滤/
// 策展抽取/注入生成/整合/会话收尾)只存在于共享 CLI hs-memory 一份。
// 本插件只做三件事(DSH 独有部分), 高级语义参考 dsh-memos-remote 的工程处理:
//   1. 环境设置: 声明 OWN_BANK=dsh(harness 独占库, self 落点);
//      不设 DEFAULT_BANK —— 写路由默认走位置快速路径(git→项目库, 非 git→global)
//   2. 会话钩子: pre-step 调 hs-memory inject(自动模式) / turn 攒批调 curate
//      (批次确认队列: 失败回滚重试、超限应急抽取、结束兜底合并, 杜绝转录丢失)
//      每 N 次 curate 成功后节流触发 consolidate 与 skill-crystallize
//   3. 工具层: retain/recall/reflect/status 全部转调 hs-memory
//
// v0.2.0 可靠性改进(2026-08-30, 参考 dsh-memos-remote):
//   - P0: curate 批次不再 splice 即弃 —— 移入 pending 待确认队列; 失败回滚
//     回缓冲头部重试(同转录上限 2 次, 超过放弃并 warn); 超 MAX_BUFFER_CHARS
//     时最老批次应急 curate(同 turn 一次)而非直接丢弃; disposed 时 leftover +
//     pending 转录合并进 session-end, 杜绝"尝试抽取但未确认"的丢失窗口
//   - P1: 工具调用链(action 行, readDshEvents 已收集)拼入 curate 转录,
//     让策展模型看到 用户→工具→结果, procedure 抽取更准
//   - P2: 全量行为 Config 化(无需 schemastery 依赖, apply 第二参合并默认值);
//     失败/成功日志节流(60s 窗口内同名只打一次); curate 成功后按
//     consolidateEveryNCurate 节流触发 consolidate; preStep 仅 step===1 且
//     WeakMap 按 turn 去重注入(对齐 memos-remote, 避免递归/子步骤重复注入)
//   - P3: 每 crystallizeEveryNCurate 次 curate 成功后异步触发 hs-memory
//     skill-crystallize(procedure→指令块结晶, 共享 CLI 新增能力)
//
// 独立于 @vectorize-io/hindsight-coding-agents(dist 会被插件更新覆盖,
// 本文件自维护, 更新插件不影响本适配层)。
// ═══════════════════════════════════════════════════════════════════
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "hindsight";
export const inject = ["agents"];

const HS_MEMORY = join(homedir(), ".hindsight", "harness-memory.sh"); // 共享 CLI(约定唯一事实源)
// DSH: 独占库为 dsh(self 落点: 会话产物/个人化偏好); 不设 DEFAULT_BANK ——
// 写路由仍走位置快速路径(git→项目库, 非 git→global), self→dsh
// 自动注入(light 档)默认只查 OWN_BANK(dsh 仅 10 条技术杂记, 对日常任务不相关):
// 改查 当前项目库+global(真正的相关知识); HINDSIGHT_INJECT_MIN_SCORE=0.35 过滤
// 低相似度条(宁缺毋滥)。意图词命中(intent 档)仍全查 当前库+global+dsh。
const HS_ENV = {
  ...process.env,
  HINDSIGHT_OWN_BANK: "dsh",
  HINDSIGHT_INJECT_LIGHT_BANKS: "current,global",
  HINDSIGHT_INJECT_MIN_SCORE: "0.35",
};

// ── 默认配置(cordis.patch.yml 的 config 键可覆盖, 不引入 schemastery 依赖) ──
const DEFAULTS = {
  enabled: true,
  injectEnabled: true,          // pre-step 自动注入
  curateEnabled: true,          // turn 攒批自动策展
  curateEveryN: 3,              // 每 N 轮触发一次 curate(0=关闭, 仅会话结束兜底)
  maxBufferChars: 12000,        // 转录缓冲上限, 超限时最老批次应急 curate
  curateTimeoutMs: 90000,       // curate 超时(共享 CLI 上限 120s)
  injectTimeoutMs: 20000,
  consolidateEveryNCurate: 5,   // 每 N 次 curate 成功后触发 consolidate(0=关闭)
  crystallizeEveryNCurate: 3,   // 每 N 次 curate 成功后触发 skill-crystallize(0=关闭)
  toolsEnabled: true,           // 注册 hindsight_* 工具
  // P7: 工具归属缓解(dsh-context 面板"未知插件")——注册延后给 attribution hook 让路
  toolsDeferMs: 50,             // tools 就绪后再等 N ms 注册(0=立即)
  // Layer 1: 会话启动广谱召回(动态查询: 用首条用户消息做 recall query)
  sessionStartRecall: false,    // 是否启用 session-start 广谱召回
  sessionStartRecallMax: 3,     // 最多注入条数(降噪, 宁缺毋滥)
  sessionStartRecallTimeoutMs: 15000, // 召回超时
  sessionStartRecallScope: "current", // 检索范围: current|global|all(默认 current 减少跨项目噪声)
  sessionStartRecallMinScore: 0.5, // 最低相似度阈值(2026-09-04 由 0.35 上调): 宁缺毋滥, 允许空——
  // 原则: 无相关记忆时召回空是正常结果, 不为凑数兜底抬出弱相关条目(0.35 实测混入主题错配噪声)
  // P8: 泛化首条消息(无明确领域/疑问, 如"推荐一部好看的科幻电影")召回噪声大且价值低:
  //   实测 min-score 提高到 0.5 仍拦不住主题错配(服务端阈值语义宽松), 仅减量降噪有限;
  //   skip(默认): 泛化直接不召回(最彻底); tighten: 保留高阈值+减量(仍可能混入噪声)
  sessionStartRecallGenericMode: "skip",
  sessionStartRecallGenericMax: 2,      // 泛化时最多注入条数(tighten 模式用)
  sessionStartRecallGenericMinScore: 0.5, // 泛化时最低相似度(tighten 模式用)
  // P9/P9a: 并行召回 —— inboxClaimed(消息 claim)即 fire recall, 与上下文组装/模型 TTFT 并行;
  // pre-step 只读结果(兜底从 payload.messages 取消息); next() 后最多等 graceMs,
  // 超时放弃注入(宁缺毋滥, 阻塞预算 = grace, 用户无感优先; 需要稳定注入可调大 grace)
  sessionStartRecallGraceMs: 1500,
};

function resolveConfig(cfg) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  for (const k of ["curateEveryN", "maxBufferChars", "curateTimeoutMs", "injectTimeoutMs", "consolidateEveryNCurate", "crystallizeEveryNCurate", "toolsDeferMs", "sessionStartRecallMax", "sessionStartRecallTimeoutMs", "sessionStartRecallMinScore", "sessionStartRecallGenericMax", "sessionStartRecallGenericMinScore", "sessionStartRecallGraceMs"]) {
    const n = Number(c[k]);
    c[k] = Number.isFinite(n) && n >= 0 ? n : DEFAULTS[k];
  }
  for (const k of ["enabled", "injectEnabled", "curateEnabled", "toolsEnabled", "sessionStartRecall"]) c[k] = c[k] !== false;
  c.sessionStartRecallScope = String(c.sessionStartRecallScope || DEFAULTS.sessionStartRecallScope);
  c.sessionStartRecallGenericMode = ["tighten", "skip"].includes(c.sessionStartRecallGenericMode) ? c.sessionStartRecallGenericMode : DEFAULTS.sessionStartRecallGenericMode;
  return c;
}

// ── 共享 CLI 封装(同步: 工具用) ──
function hsMemory(args, timeoutMs = 90000) {
  try {
    const out = execFileSync("bash", [HS_MEMORY, ...args], {
      env: HS_ENV,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: out.trim(), err: "" };
  } catch (e) {
    return { ok: false, out: (e?.stdout ?? "").trim(), err: (e?.stderr ?? String(e?.message ?? e)).trim() };
  }
}

// ── 异步版: 注入/curate/consolidate/crystallize/收尾用(非阻塞, 绝不卡会话) ──
function hsMemoryAsync(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(
      "bash",
      [HS_MEMORY, ...args],
      { env: HS_ENV, encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) resolve({ ok: false, out: (stdout ?? "").trim(), err: (stderr ?? String(error.message ?? error)).trim() });
        else resolve({ ok: true, out: (stdout ?? "").trim(), err: "" });
      },
    );
  });
}

// ── 日志节流(60s 窗口内同名事件只打一次; 对齐 memos-remote 的 noteServerError 节流) ──
const logTimes = new Map();
function shouldLog(key, ms = 60000) {
  const now = Date.now();
  const last = logTimes.get(key) || 0;
  if (now - last < ms) return false;
  logTimes.set(key, now);
  return true;
}

// ── 转录解析(从 DSH agent.session.events 提取 turns, 剔除注入的记忆块) ──
const MEMORY_TAG_RE = /<(hook_prompt|task-notification|system-reminder|hindsight_memory|hindsight_memories|hindsight_bank|relevant_memories|user_feedback|hindsight_knowledge|hindsight_knowledge_refresh)\b[\s\S]*?<\/\1>/g;
function stripInjectedMemory(s) {
  return String(s ?? "").replace(MEMORY_TAG_RE, "");
}
function textOf(message) {
  return (message?.content || [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
const TARGET_KEYS = ["file_path", "path", "notebook_path", "command", "pattern", "query", "url", "name", "id"];
function actionLine(tool, input) {
  let target = "";
  if (input && typeof input === "object") {
    for (const k of TARGET_KEYS) {
      const v = input[k];
      if (typeof v === "string" && v.trim()) {
        target = v.trim().split("\n")[0];
        break;
      }
    }
  } else if (typeof input === "string") {
    target = input.trim().split("\n")[0];
  }
  if (target.length > 100) target = target.slice(0, 100) + "…";
  return target ? tool + " " + target : tool;
}
function parseArgs(raw) {
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}
function readDshEvents(events) {
  const turns = [];
  for (const event of events || []) {
    if (!event || typeof event !== "object") continue;
    const stamp = typeof event.time === "number" ? { timestamp: new Date(event.time).toISOString() } : {};
    if (event.type === "user/message") {
      const message = event.data;
      if (!message || message.source?.kind !== "user") continue;
      const text = stripInjectedMemory(textOf(message)).trim();
      if (text) turns.push({ role: "user", content: text, ...stamp });
    } else if (event.type === "assistant/message") {
      const message = event.data?.message;
      if (!message) continue;
      const text = stripInjectedMemory(textOf(message)).trim();
      if (text) turns.push({ role: "assistant", content: text, ...stamp });
    } else if (event.type === "tool/call") {
      const call = event.data;
      if (!call?.name) continue;
      turns.push({ role: "action", content: actionLine(call.name, parseArgs(call.arguments)), ...stamp });
    }
  }
  return turns;
}

// 从 agent session events 取首条用户消息(P9: 并行召回用, 不等模型调用)
function firstUserMessageOf(agent) {
  const turns = readDshEvents(agent?.session?.events);
  for (const t of turns) if (t.role === "user") return t.content;
  return null;
}

// ── 会话内状态 ──
// buffers: sessionId -> { turns: [{user, assistant, actions[]}], processed, pending[], curateCount }
// pending item: { turns, transcript, retries, kind: 'regular'|'evict' }
const liveAgents = new Map(); // sessionId -> agent
const buffers = new Map();
const retryCounts = new Map(); // transcript -> 连续失败次数(批次重建后仍延续)
const injectedTurns = new WeakMap(); // agent -> turn(同 turn 只注入一次)
const sessionStartRecalls = new Map(); // sessionId -> 广谱召回结果(待 preStep 注入)

// ── 注入消息(与 dsh.js 同形, 插件来源标记 form=recall) ──
function injectionMessage(text) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: name, form: "recall" },
  };
}

function promptOf(messages) {
  return (messages || [])
    .filter((m) => m?.source?.kind === "user")
    .flatMap((m) => m.content || [])
    .filter((b) => b?.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// ── 转录渲染(P1: 含工具调用链 user→action→assistant) ──
function renderTranscript(buffer) {
  const parts = [];
  for (let i = 0; i < buffer.turns.length; i++) {
    const t = buffer.turns[i];
    const lines = [`[第${i + 1}轮]`, `用户: ${t.user || "(空)"}`];
    for (const a of t.actions || []) lines.push("工具: " + a);
    lines.push(`助手: ${t.assistant || "(空)"}`);
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

// ── 异步 curate 执行器: 成功→确认+节流触发 consolidate/crystallize; 失败→回滚重试 ──
async function runCurate(ctx, cfg, sessionId, st, item) {
  const r = await hsMemoryAsync(["curate", item.transcript], cfg.curateTimeoutMs);
  const idx = st.pending.indexOf(item);
  if (idx >= 0) st.pending.splice(idx, 1);
  if (r.ok) {
    retryCounts.delete(item.transcript);
    st.curateCount += 1;
    const summary = (r.out || "").split("\n")[0].slice(0, 120);
    if (shouldLog("curate-ok-" + sessionId)) ctx.logger.info(`hindsight: curate 已确认(${item.turns.length} 轮): ${summary || "OK"}`);
    maybeConsolidate(ctx, cfg, sessionId, st);
    void maybeCrystallize(ctx, cfg, sessionId, st); // 非阻塞: 异步探测+触发, 不延长 curate 确认
    return;
  }
  const why = (r.err || r.out || "未知错误").split("\n")[0].slice(0, 160);
  const fails = (retryCounts.get(item.transcript) || 0) + 1;
  retryCounts.set(item.transcript, fails);
  if (item.kind === "evict" || fails >= 3) {
    if (shouldLog("curate-fail-" + sessionId)) ctx.logger.warn(`hindsight: curate 放弃(${item.turns.length} 轮, 第 ${fails} 次失败): ${why}`);
    return;
  }
  if (shouldLog("curate-fail-" + sessionId)) ctx.logger.warn(`hindsight: curate 失败将回滚重试(${item.turns.length} 轮, 第 ${fails} 次): ${why}`);
  st.turns.unshift(...item.turns); // 批次回滚到缓冲头部, 等下一轮次再次切批
}

function maybeConsolidate(ctx, cfg, sessionId, st) {
  if (cfg.consolidateEveryNCurate <= 0 || st.curateCount % cfg.consolidateEveryNCurate !== 0) return;
  void hsMemoryAsync(["consolidate"], 90000); // 位置快速路径解析目标库
  if (shouldLog("consolidate-" + sessionId)) ctx.logger.info("hindsight: 触发 consolidate(整合去重/矛盾)");
}

async function maybeCrystallize(ctx, cfg, sessionId, st) {
  if (cfg.crystallizeEveryNCurate <= 0 || st.curateCount % cfg.crystallizeEveryNCurate !== 0) return;
  const probe = await hsMemoryAsync(["list-banks"], 30000); // 轻量健康探测: 服务器不可用则跳过, 避免无效 LLM 调用
  if (!probe.ok) {
    if (shouldLog("crystallize-skip-" + sessionId)) ctx.logger.warn(`hindsight: 跳过 skill-crystallize(Hindsight 不可用): ${(probe.err || "").slice(0, 120)}`);
    return;
  }
  void hsMemoryAsync(["skill-crystallize", "--bank", "repo", "--min", "3"], 120000);
  if (shouldLog("crystallize-" + sessionId)) ctx.logger.info("hindsight: 触发 skill-crystallize(procedure→指令块结晶)");
}

// ── 工具: 存记忆(转调 hs-memory; 归属域路由; 无 self=DSH 无独占库) ──
const toolRetain = {
  name: "hindsight_retain",
  description:
    "把一条持久信息存入 Hindsight(经共享 CLI hs-memory, 归属域路由)。默认: git 仓库内→项目库, 非 git→coding-agent::global(位置快速路径)。repo=true→项目知识(项目库); global=true→全局知识(coding-agent::global)。DSH 无独占库, 不支持 self。绝不写入其他 agent 独占库(会被拒绝)。纪律: 一次会话 retain 尽量少而精(合并为一条)。",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "记忆内容(自然语言)" },
      tags: { type: "string", description: "标签,逗号分隔(可选)" },
      repo: { type: "string", description: "true=项目知识→项目库(非 git 自动降级 global); 与 global 互斥" },
      global: { type: "string", description: "true=全局知识→coding-agent::global(运维/通用偏好/跨项目经验)" },
    },
  },
  execute(args) {
    const content = String(args?.content ?? "").trim();
    if (!content) return "内容为空,未存储。";
    const argv = ["retain", content];
    if (args?.tags) argv.push("--tags", String(args.tags));
    if (String(args?.global ?? "") === "true") argv.push("--scope", "global");
    else if (String(args?.repo ?? "") === "true") argv.push("--scope", "project");
    const r = hsMemory(argv);
    if (!r.ok) return "❌ 存储失败: " + (r.err || r.out);
    return r.out;
  },
};

// ── 工具: 检索(转调 hs-memory; 来源标注 [库名] 在共享层) ──
const toolRecall = {
  name: "hindsight_recall",
  description:
    "语义搜索 Hindsight 记忆(经共享 CLI hs-memory, 自动多库合并并标注来源 [库名])。默认: 当前解析库 + coding-agent::global 合并(非 git 时即 global)。bankId: repo(仅项目库)/global(仅全局库)/all(全合并含感知到的其他 agent 库,只读)/显式库名。factTypes: observation(默认,整合观察优先,自动去重不重复)/world(只要原始事实)/both(原始事实+observation 并列全取)/skill(只要结晶指令块)。适合: 用户提到以前聊过的事、需要历史经验/踩坑记录。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "自然语言查询" },
      bankId: { type: "string", description: "检索范围: 默认合并; repo=项目库; global=全局库; all=全合并; 或显式库名(如 hermes)" },
      factTypes: { type: "string", enum: ["observation", "world", "both", "skill"], description: "记忆类型选择(默认 observation): observation=只取整合观察(去重); world=只要原始事实; both=原始事实与 observation 并列全取; skill=只要结晶指令块。" },
    },
  },
  execute(args) {
    const q = String(args?.query ?? "").trim();
    if (!q) return "缺少 query。";
    const argv = ["recall", q];
    const want = String(args?.bankId ?? "");
    if (want === "repo") argv.push("--scope", "project");
    else if (want === "global") argv.push("--scope", "global");
    else if (want === "all") argv.push("--scope", "all");
    else if (want) argv.push("--bank", want);
    const ft = String(args?.factTypes ?? "observation").toLowerCase();
    if (ft === "world") argv.push("--types", "world,experience", "--prefer-obs", "false");
    else if (ft === "both") argv.push("--types", "world,experience,observation", "--prefer-obs", "false");
    else if (ft === "skill") argv.push("--types", "skill");
    // observation(默认): 不传 --types → 全类型召回 + 共享层 prefer_observations=True → observation 优先且去重
    const r = hsMemory(argv);
    if (!r.ok) return "❌ 检索失败: " + (r.err || r.out);
    return r.out;
  },
};

// ── 工具: 自省(转调 hs-memory reflect; 单库深度综合) ──
const toolReflect = {
  name: "hindsight_reflect",
  description:
    "基于 Hindsight 记忆库深度综合回答一个问题(先检索记忆, 再由 LLM 综合; 单库执行, 较慢 10-30s)。默认当前解析库(git→项目库, 非 git→global)。bankId: repo(项目库)/global(共享全局库)/显式感知库名。用于 '基于我们以前的对话, 你如何看待 X'。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "问题" },
      bankId: { type: "string", description: "记忆库: 默认当前解析库; repo=项目库; global=全局库; 或显式感知库名" },
    },
  },
  execute(args) {
    const q = String(args?.query ?? "").trim();
    if (!q) return "缺少 query。";
    const argv = ["reflect", q];
    const want = String(args?.bankId ?? "");
    if (want === "repo") argv.push("--scope", "project");
    else if (want === "global") argv.push("--scope", "global");
    else if (want) argv.push("--bank", want);
    const r = hsMemory(argv, 120000);
    if (!r.ok) return "❌ 综合失败: " + (r.err || r.out);
    return r.out;
  },
};

// ── 工具: 状态(库清单 + 模型配置) ──
const toolStatus = {
  name: "hindsight_status",
  description:
    "检查本地 Hindsight 服务状态: 列出记忆库归属(共享库可读写 / 其他 agent 独占库感知只读 / 屏蔽列表)与模型配置(配置源: hindsight 容器 env, agent 零模型认知)。",
  parameters: { type: "object", properties: {} },
  execute() {
    const banks = hsMemory(["list-banks"], 30000);
    const cfg = hsMemory(["config"], 30000);
    const parts = [];
    parts.push(banks.ok ? banks.out : "❌ Hindsight 不可用: " + (banks.err || "daemon 未运行\n  docker start hindsight"));
    parts.push(cfg.ok ? cfg.out : "(模型配置读取失败: " + cfg.err + ")");
    return parts.join("\n");
  },
};

const TOOLS = [toolRetain, toolRecall, toolReflect, toolStatus];

// ── Layer 1: 会话启动广谱召回(动态查询版) ──
// P0 优化: 不再用固定 prompt "recent project work decisions progress context",
// 改为在 preStep 中用用户首条消息作为 recall query, 大幅提升精度。
// seedSessionContext 改为 no-op(保留函数签名兼容, 实际召回逻辑移至 doSessionStartRecall)。
function seedSessionContext(_cfg, _sessionId) {
  // no-op: 召回延迟到 preStep, 用用户首条消息做动态查询
}

// ── 泛化首条消息判定(P8: 实测"推荐一部科幻电影"等泛化查询召回全噪声) ──
// 命中任一 → 具体: 疑问词(有明确关心点) / 领域实体(技术词/专名/文件扩展名)
// 否则剥壳(通用引导词+不定量词)后剩余信息量不足(中文 <8 字符) → 泛化
const GENERIC_PREFIX_RE = /^(?:请|麻烦|帮我|帮忙|给我|帮我写|帮我做|帮我弄|帮我找|帮我查|帮我看看|搜索|搜一下|找一下|查一下|看一下|看看|推荐|介绍|解释|写个?|做个?|建个?|创建|新建|生成|弄个?|搞定|tell\s+me|help(?:\s+me)?|please\b|write\b|create\b|make\b|search\b|find\b|recommend\b|explain\b|show\s+me\b|how\s+(?:do|to)\b|what\s+(?:is|are)\b|i\s+(?:want|need)(?:\s+to)?\b)[\s:：,，]*/i;
const GENERIC_QUANT_RE = /^(?:一个|一部|一些|一份|几个|个|点|一下)[\s:：,，]*/;
const DOMAIN_TOKEN_RE = /(?:[A-Za-z][A-Za-z0-9_.-]*\.(?:py|ts|js|mjs|cjs|json|jsonl|sh|bash|zsh|md|mdx|yml|yaml|csv|tsv|txt|html?|css|sql|toml|ini|env|lock|log|pdf|docx?|xlsx?|pptx?))\b|(?:hindsight|recuris|feishu|lark|git(?:hub)?|docker|k8s|kubernetes|uv|python|nodejs?|bun|npm|pnpm|yarn|dsh|plugin|skill|agent|prompt|api|http|web|cli|shell|curl|paraformer|qwen|mlx|memory|session|recall|retain|curate|inject|consolidate|bank|飞书|妙搭|记忆库|技能卡|插件|召回)/i;
const QUESTION_TOKEN_RE = /(?:怎样|如何|为什么|怎么|哪些|哪[一种个]|什么|是否|啥|吗$|呢$|why|how|what|where|which|when|is\b|are\b|does\b)/i;
function isGenericQuery(msg) {
  const s = String(msg ?? "").trim();
  if (!s) return true;
  if (QUESTION_TOKEN_RE.test(s)) return false; // 疑问 → 有明确关心点
  if (DOMAIN_TOKEN_RE.test(s)) return false;   // 领域实体 → 具体
  const stripped = s.replace(GENERIC_PREFIX_RE, "").replace(GENERIC_QUANT_RE, "").trim();
  return stripped.length < 8;                  // 剥壳后信息量不足 → 泛化
}

// 动态查询: 用用户首条消息做 recall query + 分数阈值过滤
// P8: 泛化查询收紧/跳过(泛化消息对广谱召回价值低, 噪声大)
async function doSessionStartRecall(cfg, sessionId, userMessage) {
  if (!cfg.sessionStartRecall) return null;
  if (!userMessage || userMessage.trim().length < 4) return null; // 太短的消息不查
  const q = userMessage.trim();
  const generic = isGenericQuery(q);
  if (generic && cfg.sessionStartRecallGenericMode === "skip") return null; // 泛化意义不大: 不召回
  const argv = ["recall", q];
  const scope = cfg.sessionStartRecallScope;
  if (scope === "current") argv.push("--scope", "project");
  else if (scope === "global") argv.push("--scope", "global");
  else argv.push("--scope", "all");
  argv.push("--types", "observation");
  argv.push("--top", String(generic ? cfg.sessionStartRecallGenericMax : cfg.sessionStartRecallMax));
  argv.push("--min-score", String(generic ? cfg.sessionStartRecallGenericMinScore : cfg.sessionStartRecallMinScore));
  const r = await hsMemoryAsync(argv, cfg.sessionStartRecallTimeoutMs);
  if (r.ok && r.out && r.out.trim()) return r.out.trim();
  return null;
}

// ── 会话钩子 ──
function createHooks(ctx, cfg) {
  return {
    sessionStart({ agent }) {
      const sessionId = agent?.session?.header?.id;
      if (sessionId) {
        liveAgents.set(sessionId, agent);
        seedSessionContext(cfg, sessionId);
      }
    },
    // P9a: 最早 fire 点 —— inbox claim(用户消息进入 turn)时即启动广谱召回, 与
    // 上下文组装/模型 TTFT 并行; pre-step 只读结果(窗口最大化, 零阻塞)。
    inboxClaimed({ agent, message, turn }) {
      const sessionId = agent?.session?.header?.id;
      if (!sessionId || turn !== 1 || sessionStartRecalls.has(sessionId)) return;
      const text = stripInjectedMemory(textOf(message)).trim();
      if (!text || text.length < 4) return;
      // 存 promise; 泛化/空结果(null)也标记, 避免 pre-step 兜底重试
      sessionStartRecalls.set(sessionId, doSessionStartRecall(cfg, sessionId, text) ?? true);
    },
    async preStep({ agent, signal, step, turn, messages }, next) {
      const sessionId = agent?.session?.header?.id;
      // P9: 读取召回结果: 优先用 inboxClaimed 预取的 promise; 若未触发(事件缺失/非 turn1),
      // 从 payload.messages 兜底 fire(真实并行于 next 的组装)。
      let recallPromise = null;
      if (sessionId) {
        const held = sessionStartRecalls.get(sessionId);
        if (held instanceof Promise) recallPromise = held;
        else if (!held && (step === undefined || step === 1)) {
          sessionStartRecalls.set(sessionId, true); // 兜底: 每 session 只尝试一次
          const q = promptOf(messages);
          if (q && q.trim().length >= 4) recallPromise = doSessionStartRecall(cfg, sessionId, q.trim());
        }
      }
      const decision = await next();
      if (decision?.kind !== "enter" || signal?.aborted) return decision;
      // 仅主步骤注入, 递归/子代理步骤不重复检索(对齐 memos-remote)
      if (typeof step === "number" && step !== 1) return decision;
      if (!sessionId) return decision;
      liveAgents.set(sessionId, agent);
      const blocks = [];
      // Layer 1: 会话启动广谱召回(并行结果): 已就绪才注入, 超时放弃(空是正常结果)
      if (recallPromise) {
        const graceful = new Promise((r) => setTimeout(() => r(null), cfg.sessionStartRecallGraceMs));
        const startRecall = await Promise.race([recallPromise, graceful]);
        if (startRecall) {
          blocks.push("## 最近项目上下文(Hindsight, 仅供参考)\n" + startRecall);
        }
      }
      // Layer 2: prompt-based inject(仅 injectEnabled 时)
      if (cfg.injectEnabled) {
        // 同一 turn 只尝试注入一次(WeakMap 按 turn 记录, 新 turn 重新允许)
        if (injectedTurns.get(agent) === turn) return decision;
        const prompt = promptOf(decision.messages);
        if (!prompt) return decision;
        try {
          const r = await hsMemoryAsync(["inject", prompt], cfg.injectTimeoutMs);
          if (r.ok && r.out) {
            injectedTurns.set(agent, turn);
            const block = r.out
              .split("\n")
              .filter(Boolean)
              .slice(0, 8)
              .map((t, i) => `[记忆${i + 1}] ${t}`)
              .join("\n");
            blocks.push("## 相关长期记忆(Hindsight, 仅供参考, 若与当前事实冲突以当前为准)\n" + block);
          }
        } catch {
          // 静默失败
        }
      }
      if (blocks.length) {
        return { kind: "enter", messages: [...decision.messages, injectionMessage(blocks.join("\n\n"))] };
      }
      return decision;
    },
    turnStopping({ agent }) {
      const sessionId = agent?.session?.header?.id;
      if (!sessionId) return;
      try {
        const allTurns = readDshEvents(agent?.session?.events);
        const st = buffers.get(sessionId) ?? { turns: [], processed: 0, pending: [], curateCount: 0, evictedThisTurn: false };
        st.evictedThisTurn = false; // 每 turn 重置: 超限应急抽取每轮最多一次
        // 本轮新增轮次(按 processed 游标)
        const fresh = allTurns.slice(st.processed);
        st.processed = allTurns.length;
        // 配对 user + 工具链(action 归属其后的 assistant 轮) + assistant(P1)
        let user = "";
        let actions = [];
        for (const t of fresh) {
          if (t.role === "user") {
            user = t.content;
            actions = [];
          } else if (t.role === "action") {
            if (user) actions.push(t.content);
          } else if (t.role === "assistant" && user) {
            st.turns.push({ user, actions: [...actions], assistant: t.content });
            user = "";
            actions = [];
          }
        }
        // 缓冲上限: 超限时最老批次应急 curate(同 turn 一次), 失败不回滚直接丢
        const turnLen = (t) => t.user.length + t.assistant.length + (t.actions || []).join("").length;
        let total = st.turns.reduce((s, t) => s + turnLen(t), 0);
        if (total > cfg.maxBufferChars && st.turns.length) {
          const evict = [];
          while (st.turns.length && total > cfg.maxBufferChars) {
            const dropped = st.turns.shift();
            total -= turnLen(dropped);
            evict.push(dropped);
          }
          if (evict.length) {
            if (cfg.curateEnabled && cfg.curateEveryN > 0 && !st.evictedThisTurn) {
              st.evictedThisTurn = true;
              const item = { turns: evict, transcript: renderTranscript({ turns: evict }), retries: 0, kind: "evict" };
              st.pending.push(item);
              void runCurate(ctx, cfg, sessionId, st, item);
            } else if (shouldLog("buffer-drop-" + sessionId)) {
              ctx.logger.warn(`hindsight: 缓冲超限, 丢弃最老 ${evict.length} 轮(curate 关闭或本 turn 已应急)`);
            }
          }
        }
        buffers.set(sessionId, st);
        if (!cfg.curateEnabled || cfg.curateEveryN <= 0 || st.turns.length < cfg.curateEveryN) return;
        // 攒够阈值: 整批移入待确认队列并异步 curate(不再 splice 即弃, P0)
        const batch = st.turns.splice(0, st.turns.length);
        const item = { turns: batch, transcript: renderTranscript({ turns: batch }), retries: 0, kind: "regular" };
        st.pending.push(item);
        void runCurate(ctx, cfg, sessionId, st, item);
      } catch (e) {
        if (shouldLog("turnStopping-" + sessionId)) ctx.logger.warn("hindsight: turnStopping 异常: " + String(e?.message || e));
      }
    },
    disposed({ agent }) {
      const sessionId = agent?.session?.header?.id;
      if (!sessionId) return;
      liveAgents.delete(sessionId);
      sessionStartRecalls.delete(sessionId);
      const st = buffers.get(sessionId);
      buffers.delete(sessionId);
      try {
        // leftover(未攒够批次) + pending(尝试抽取但未确认的批次) 合并进 session-end,
        // 杜绝"curate 在途/失败"导致整批转录丢失的窗口
        const parts = [];
        if (st?.turns?.length) parts.push(renderTranscript({ turns: st.turns }));
        for (const p of st?.pending || []) parts.push(p.transcript);
        const transcript = parts.join("\n\n");
        void hsMemoryAsync(["session-end", transcript], 90000);
      } catch {
        /* 静默失败 */
      }
    },
  };
}

function toDshParameters(spec) {
  return spec.parameters;
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) return () => undefined;
  const hooks = createHooks(ctx, cfg);
  ctx.on("agent/session-start", hooks.sessionStart);
  ctx.on("agent/inbox/claimed", hooks.inboxClaimed, { prepend: true });
  ctx.on("agent/pre-step", hooks.preStep, { prepend: true });
  ctx.on("agent/turn-stopping", hooks.turnStopping);
  ctx.on("agent/disposed", hooks.disposed);
  if (cfg.toolsEnabled) {
    // P7: 归属缓解(可选) —— tools 就绪后延迟 deferMs 注册, 给 dsh-context
    // attribution hook 先装机会(默认 50ms, 超时必注册; 0=立即不延迟)。
    const defer = Math.max(0, Number(cfg.toolsDeferMs) || 0);
    ctx.inject(["tools"], (toolCtx) => {
      const doRegister = () => {
        for (const spec of TOOLS) {
          toolCtx.tools.register({
            name: spec.name,
            description: spec.description,
            parameters: toDshParameters(spec),
            output: {
              schema: { type: "string" },
              render: (_args, value) => [{ type: "text", text: value }],
            },
            execute(args) {
              return spec.execute(args ?? {});
            },
          });
        }
      };
      if (defer <= 0) return doRegister();
      const timer = setTimeout(() => {
        try {
          doRegister();
        } catch (e) {
          const msg = String(e?.message || e);
          if (ctx.logger?.warn) ctx.logger.warn(`hindsight: 延迟注册工具失败: ${msg.length > 120 ? msg.slice(0, 120) + "…" : msg}`);
        }
      }, defer);
      timer.unref?.();
    });
  }
}

export default { name, inject, apply };