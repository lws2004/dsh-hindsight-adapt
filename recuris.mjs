// ═══════════════════════════════════════════════════════════════════
// recuris-adapt — Recuris 式记忆进化闭环(DSH 插件)
//
// 理念(见 RECURIS.md): 借鉴 Recuris(Recursive Experiential–Working Memory
// Evolution, arXiv:2608.24876)的机制原则, 不搬 benchmark 代码:
//   Skill Memory M = (E, W, ρ, C)
//   - E 经验/技能记忆: 技能卡(卡片式文件, 结构化字段, 可单卡替换)
//   - W 工作记忆: "已验证的任务状态"(goal 视图 + 轨迹摘要), 未用对活历史
//   - ρ 路由: 检索由工作记忆状态驱动(W 注入 + 失败时按域召回)
//   - C 检查: 验证门控 —— 确定性成对留出口径, 模型不给自己 patch 投票
// 三个闭环:
//   使用循环   turn-stopping 写轨迹+WM 卡; pre-step 注入 WM(状态接地)
//   进化循环   recuris_evolve: 并行诊断 workers(meta 模型) → 合并 →
//              单组件 patch(reg-cap) → 门控准入 → 记 ledger
//   TTA 循环   失败后下次任务复用已准入技能卡(原型以卡片可召回为准)
//
// 存储布局(默认 ~/.dsh/storages/recuris/):
//   trajectories/<sessionId>.jsonl   逐 turn 结构化轨迹 (w, skill, a, o)
//   wm/<sessionId>.json              工作记忆卡(目标/阶段/进度/阻塞)
//   skills/<cardId>.json             技能卡(唯一可进化组件)
//   evolutions/<runId>.jsonl         进化闭环 ledger(证据/诊断/门控算术/落卡)
//
// 该文件独立于 hindsight-adapt(plugin.mjs), 自包含; 经 cordis.patch.yml
// 单独挂载(recuris-adapt 行), 可独立开关。所有钩子静默降级, 绝不阻断对话。
// ═══════════════════════════════════════════════════════════════════
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, appendFileSync } from "node:fs";

export const name = "recuris";
export const inject = [];

const HS_MEMORY = join(homedir(), ".hindsight", "harness-memory.sh"); // 共享 CLI(召回证据用)
const HS_ENV = { ...process.env, HINDSIGHT_OWN_BANK: "dsh" };

// ── 默认配置(cordis.patch.yml 的 config 键可覆盖) ──
const DEFAULTS = {
  enabled: true,
  root: join(homedir(), ".dsh", "storages", "recuris"),
  traceEnabled: true,            // P0 轨迹记录
  wmEnabled: true,               // P1 工作记忆卡
  injectWmEnabled: true,         // pre-step 注入 WM(状态接地)
  toolsEnabled: true,            // recuris_* 工具
  metaProvider: "opencode-go",   // 上游 meta 模型(≠ 下游 worker)
  metaModel: "deepseek-v4-pro",
  metaFallbackProvider: "qwen-token-plan-cn", // 降级路由(可选)
  metaFallbackModel: "deepseek-v4-pro-0813",
  diagnosisWorkers: 3,           // 并行诊断角度数
  regCap: 1,                     // 每轮最多准入组件数(防震荡)
  gateStrict: false,             // true=覆盖度留出不过软放行
  evolveTimeoutMs: 180000,       // 单次 LLM 调用超时
  autoEvolveOnError: false,      // agent/error 自动触发(原型默认手动)
  autoEvolveMinTurns: 3,         // 自动触发的最小轮次
  autoEvolveCoolDownMs: 600000,  // 同会话自动触发冷却
  evidenceTrajectoryTurns: 24,   // 诊断证据: 轨迹尾部轮次
  evidenceFailures: 3,           // 证据: 最近失败任务数
  evidenceRelatedMemories: true, // 用 hs-memory 召回相关经验
  evidenceSkills: 3,             // 证据: 域内已有技能卡数
  // P6: 持久模式知识层(Wiki Layer, 借鉴 arXiv:2608.27454 WikiSkill)
  //   patterns/ 介于"原始轨迹"与"可回滚技能卡"之间: 失败模式+规避 = 持久知识,
  //   永不回滚、跨进化迭代累积, 供技能提案复用(卡 ↔ 模式双向追溯)。
  wikiEnabled: true,             // patterns 知识层开关
  patternsMax: 4,                // 单次演化最多提炼模式数
  auditEnabled: true,            // ledger 提案审计(diff+接受/拒绝+门控)
  // P3a: 卡 → Hindsight 同步(type=skill, 与 skill-crystallize 同构)
  hindsightSync: true,           // 准入卡后写 Hindsight(供 recall --types skill 召回)
  hindsightApiBase: "http://localhost:8888", // Hindsight REST 入口(与共享 CLI 同端口)
  hindsightSyncBank: "repo",     // repo=当前项目库(自动解析) | global
  // P3b: 回放式门控(成对留出: 在历史失败轨迹上确定性回放, 不做模型自评)
  replayGateEnabled: true,       // 准入前对留出失败任务回放候选卡
  replayHeldOutTasks: 2,         // 取多少条留出失败任务
  // P4a: TTA 携带卡 —— 会话内有失败标记时, pre-step 注入命中卡(重试携带教训)
  ttaInjectEnabled: true,        // 失败经验卡自动注入(重试即有卡可用)
  // P5: 卡 → SKILL.md 全局技能(本机所有 agent 会话按需可加载的最终固化形态)
  exportRoot: join(homedir(), ".agents", "skills"),
  // P7: 工具归属(dsh-context 面板为何显示"未知插件"的可选缓解)
  //   dsh-context 的 ownerOf 对"其 hook 安装前注册"的工具标 unknown。
  //   原理: 它 inject sessionProjections(服务就绪后 apply 装 hook), 我们的插件
  //   尽早注册, 落入它的 boot 快照。toolsDeferMs>0 时把工具注册延后到微任务+
  //   超时之后, 让 dsh-context 有机会先装 attribution hook(live 归因 → 面板
  //   显示插件名)。默认 50ms 有超时兜底必注册; 设 0 = 立即(面板仍显"未知插件")。
  toolsDeferMs: 50,
};

function resolveConfig(cfg) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  for (const k of ["diagnosisWorkers", "regCap", "evolveTimeoutMs", "autoEvolveMinTurns", "autoEvolveCoolDownMs", "evidenceTrajectoryTurns", "evidenceFailures", "evidenceSkills", "replayHeldOutTasks", "patternsMax", "toolsDeferMs"]) {
    const n = Number(c[k]);
    c[k] = Number.isFinite(n) && n >= 0 ? n : DEFAULTS[k];
  }
  for (const k of ["enabled", "traceEnabled", "wmEnabled", "injectWmEnabled", "toolsEnabled", "gateStrict", "autoEvolveOnError", "hindsightSync", "replayGateEnabled", "ttaInjectEnabled", "wikiEnabled", "auditEnabled"]) c[k] = c[k] !== false;
  return c;
}

// ── 小工具 ──
const str = (v) => (v == null ? "" : typeof v === "string" ? v : safeString(v));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
function safeString(v, max = 2000) {
  try {
    let s = typeof v === "string" ? v : JSON.stringify(v ?? null);
    if (s === undefined) s = String(v);
    return max > 0 && s.length > max ? s.slice(0, max) + "…" : s;
  } catch {
    return "<不可渲染值>";
  }
}
function trimText(s, max) {
  s = String(s ?? "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}
function slugify(s, fallback = "card") {
  const slug = String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}
function nowIso() {
  return new Date().toISOString();
}

// ── 存储 IO ──
function pathsOf(cfg) {
  return {
    root: cfg.root,
    traces: join(cfg.root, "trajectories"),
    wm: join(cfg.root, "wm"),
    skills: join(cfg.root, "skills"),
    patterns: join(cfg.root, "patterns"),
    evolutions: join(cfg.root, "evolutions"),
  };
}
function ensureDirs(p) {
  for (const d of [p.root, p.traces, p.wm, p.skills, p.patterns, p.evolutions]) {
    try {
      mkdirSync(d, { recursive: true });
    } catch {
      /* 只读/已存在均容忍 */
    }
  }
}
function safeName(id) {
  // 仅允许安全字符, 防路径穿越
  return String(id ?? "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "unknown";
}
function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, obj) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}
function appendJsonl(file, obj) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}
function readJsonl(file, max = 500) {
  try {
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const out = [];
    for (const line of lines.slice(-max)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 跳过坏行 */
      }
    }
    return out;
  } catch {
    return [];
  }
}
function listFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json") || f.endsWith(".jsonl"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// ── hs-memory 召回(进化证据) ──
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
function recallRelated(query, max = 6) {
  const r = hsMemory(["recall", query, "--types", "world,experience", "--prefer-obs", "false"], 45000);
  if (!r.ok) return "(Hindsight 不可用: " + trimText(r.err || r.out, 120) + ")";
  const lines = r.out.split("\n").filter(Boolean);
  return lines.slice(0, max).join("\n") || "(无相关记忆)";
}

// ── 轨迹提取(从 agent.session.events, 剔除注入块) ──
const MEMORY_TAG_RE = /<(hook_prompt|task-notification|system-reminder|hindsight_memory|hindsight_memories|hindsight_bank|relevant_memories|user_feedback|hindsight_knowledge|hindsight_knowledge_refresh|working_memory)\b[\s\S]*?<\/\1>/g;
function stripInjected(s) {
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
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
/** 把会话事件流压缩成逐轮可读文本(与 hindsight-adapt 同构的轻量版) */
function compactTurns(events, maxTurn = 600, maxAction = 200) {
  const turns = [];
  let user = "";
  let actions = [];
  for (const event of events || []) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "user/message") {
      const message = event.data;
      if (!message || message.source?.kind !== "user") continue;
      const text = stripInjected(textOf(message)).trim();
      if (text) {
        if (user) turns.push({ user, actions });
        user = trimText(text, maxTurn);
        actions = [];
      }
    } else if (event.type === "tool/call") {
      const call = event.data;
      if (call?.name) actions.push(trimText(actionLine(call.name, parseArgs(call.arguments)), maxAction));
    } else if (event.type === "assistant/message") {
      const message = event.data?.message;
      const text = stripInjected(textOf(message)).trim();
      if (text && user) {
        turns.push({ user, actions, assistant: trimText(text, maxTurn) });
        user = "";
        actions = [];
      }
    }
  }
  if (user) turns.push({ user, actions });
  return turns;
}

// ── P1 工作记忆: goal 快照(防御式取字段) ──
function goalSnapshot(goals, agent) {
  try {
    const g = goals?.get?.(agent);
    if (!g) return null;
    return {
      objective: trimText(str(g.objective), 300),
      phase: str(g.phase),
      revision: num(g.revision),
      maxRounds: num(g.roundLimit) ?? num(g.maxRounds) ?? num(g.max_goal_rounds),
      completedRounds: num(g.completedRounds) ?? num(g.completed_rounds),
      blockedReason: str(g.blockedReason) ?? str(g.blockerReason),
      armed: typeof g.armed === "boolean" ? g.armed : undefined,
    };
  } catch {
    return null;
  }
}
function wmNoteFile(p, sessionId) {
  return join(p.wm, safeName(sessionId) + ".note.json");
}
function readWmNote(p, sessionId) {
  return readJson(wmNoteFile(p, sessionId), {});
}
function snapshotWorkingMemory(ctx, cfg, agent, sessionId, events) {
  const goals = ctx.get("goals");
  const goal = goalSnapshot(goals, agent);
  const note = readWmNote(pathsOf(cfg), sessionId);
  const turns = compactTurns(events);
  const last = turns.slice(-3);
  const w = {
    sessionId,
    ts: nowIso(),
    goal,
    note: trimText(str(note.note || note.objective), 300) || undefined,
    phase: str(note.phase) || goal?.phase || undefined,
    recent: last.map((t) => ({
      user: trimText(t.user, 120),
      actions: (t.actions || []).slice(-2),
      assistant: trimText(t.assistant || "", 120),
    })),
    turnCount: turns.length,
  };
  return w;
}
function persistWm(p, sessionId, w, actions) {
  const file = join(p.wm, safeName(sessionId) + ".json");
  return writeJson(file, { ...w, lastActions: (actions || []).slice(-4) });
}

// ── 元智能体 LLM 调用(上游模型, 经宿主 llm 路由, 并行/可中止) ──
async function metaCall(ctx, cfg, system, userText, timeoutMs = 120000) {
  const llm = ctx.get("llm");
  if (!llm) throw new Error("llm 服务不可用");
  const routes = [
    { provider: cfg.metaProvider, model: cfg.metaModel },
  ];
  if (cfg.metaFallbackProvider && cfg.metaFallbackProvider !== cfg.metaProvider) {
    routes.push({ provider: cfg.metaFallbackProvider, model: cfg.metaFallbackModel || cfg.metaModel });
  }
  let lastErr = null;
  for (const route of routes) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let text = "";
      let aborted = false;
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
        system,
        temperature: 0,
        signal: ac.signal,
      })) {
        if (chunk?.type === "text-delta") text += chunk.text;
        else if (chunk?.type === "finish" && chunk.reason?.kind === "aborted") aborted = true;
      }
      clearTimeout(timer);
      if (aborted && !text.trim()) throw new Error("meta 调用被中止(超时)");
      if (!text.trim()) throw new Error("meta 调用返回空");
      return text.trim();
    } catch (e) {
      lastErr = e;
      if (route === routes[routes.length - 1]) break;
    }
  }
  throw lastErr || new Error("meta 调用失败");
}

/** 从 LLM 输出中稳健提取 JSON(容忍围栏与前后缀) */
function extractJson(text) {
  const s = String(text ?? "");
  let t = s.replace(/```(?:json)?/gi, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    return JSON.parse(t);
  } catch {
    try {
      // 容忍单引号/尾逗号(启发式)
      return JSON.parse(t.replace(/,\s*([}\]])/g, "$1").replace(/'/g, '"'));
    } catch {
      return null;
    }
  }
}

// ── P2 进化循环 ──
const WORKER_SYSTEM =
  "你是记忆演化流水线里的诊断工人(meta-agent 之一)。只输出一个 JSON 对象, 不要输出任何其他文字。";
const WORKER_PROMPTS = {
  localization: (ev) =>
    `任务失败后定位组件。阅读"失败轨迹"与"已有技能卡", 判定失败源于记忆的哪个组件:\n` +
    `- skill-card:<id>  某个已有技能卡错误/不完整\n- missing-knowledge 缺少可复用知识\n- wm-discipline     工作记忆使用纪律(状态没跟踪/检索没接状态)\n- other             其他\n\n` +
    `输出 JSON: {"component":"...","diagnosis":"一句话归因","observed_failures":["失败模式1","..."],"confidence":0-1}\n\n` +
    `## 失败轨迹\n${ev.trajectory}\n\n## 已有技能卡\n${ev.skills}`,
  skillAudit: (ev) =>
    `审计已有技能卡与本次失败的关系。逐张给出: 是否适用、错在哪、缺什么字段。若某卡正是失败根源, 给出精确修补(只改这一张):\n` +
    `输出 JSON: {"targetCard":null 或 {"id":"...","name":"...","applicability":{"domains":["..."],"when":"...","when_not":"..."},"steps":["..."],"failure_modes":["..."]},"rationale":"为什么只改这张","observed_failures":["..."]}\n\n` +
    `## 失败轨迹\n${ev.trajectory}\n\n## 已有技能卡\n${ev.skills}`,
  newSkill: (ev) =>
    `设计一张能预防本次失败的可复用技能卡(若已有卡覆盖则输出 null):\n` +
    `输出 JSON: {"card":null 或 {"name":"...","applicability":{"domains":["..."],"when":"...","when_not":"..."},"steps":["..."],"failure_modes":["..."]},"rationale":"...","observed_failures":["..."]}\n\n` +
    `卡片字段纪律: steps 是具体可执行步骤(每条 ≤60 字), failure_modes 明确写出会被该卡防住的失败模式(与轨迹中的失败对应), applicability.when 写明适用场景/前置条件。\n\n` +
    `## 失败轨迹\n${ev.trajectory}\n\n## 已有技能卡\n${ev.skills}`,
};
const WORKER_ANGLES = ["localization", "skillAudit", "newSkill"];

const CONSOLIDATE_SYSTEM =
  "你是记忆演化流水线的合并器。只输出一个 JSON 对象。每轮最多准入 " +
  "regCap 个 patch(reg-cap), 只保留与失败最相关、组件互不重叠的 patch。";
const CONSOLIDATE_PROMPT = (ev, workers, regCap) =>
  `合并以下 ${workers.length} 份诊断结果, 按 regCap 收敛为 ≤${regCap} 个 patch(每个 patch 只动一个组件):\n` +
  `输出 JSON: {"patches":[{"kind":"new-card"|"patch-card","targetCardId":null 或 "id","card":{...完整卡字段...},"rationale":"..."}]}\n\n` +
  `## 持久知识库(可复用模式; 提案应尽量吸收其中 workaround)\n${ev.wiki || "(无)"}\n\n` +
  `## 历史被拒提案(不要重复提出相同/近似干预)\n${ev.rejected || "(无)"}\n\n` +
  `## 失败轨迹\n${ev.trajectory}\n\n## 诊断结果\n${workers}\n\n## regCap\n${regCap}`;

// 验证门控: 确定性检查(结构 + 覆盖度留出), 模型不给自己投票
function gateChecks(card, evidence, strict) {
  const checks = [];
  const need = (cond, name, note) => checks.push({ name, ok: !!cond, note });
  need(card && card.name, "card.name", "卡必须有名字");
  need(card && Array.isArray(card.steps) && card.steps.length >= 1 && card.steps.every((s) => typeof s === "string" && s.trim().length > 4), "card.steps", "必须 ≥1 条可执行步骤");
  need(card && card.applicability && typeof card.applicability.when === "string" && card.applicability.when.length > 4, "card.applicability.when", "必须写清适用场景/前置条件");
  need(card && Array.isArray(card.failure_modes) && card.failure_modes.length >= 1, "card.failure_modes", "必须写明防住的失败模式");
  // 防机密泄漏(确定性)
  const secretRe = /(sk-[a-zA-Z0-9]{8,}|api[_-]?key\s*[:=]\s*["']?[A-Z0-9_-]{8,}|bearer\s+[a-zA-Z0-9._-]{10,})/i;
  const joined = safeString(card).replace(/\s+/g, " ");
  need(!secretRe.test(joined), "no-secrets", "卡内不得含密钥/令牌");
  need(safeString(card).length <= 6000, "card-size", "卡体量受控(≤6k 字符)");
  // 覆盖度留出: 卡的 failure_modes 是否命中本次失败观察(成对留出的工程近似)
  const observed = (evidence.observed || []).map((s) => s.toLowerCase());
  const modes = (card?.failure_modes || []).map((s) => s.toLowerCase());
  let hits = 0;
  for (const m of modes) {
    if (observed.some((o) => o.includes(m.slice(0, 8)) || m.includes(o.slice(0, 8)) || overlap(m, o))) hits += 1;
  }
  const coverage = modes.length > 0 ? hits / modes.length : 0;
  checks.push({ name: "coverage", ok: coverage >= 0.5, note: `失败模式覆盖 ${(coverage * 100).toFixed(0)}%(≥50% 或门控非严格放行)` });
  const structuralPass = checks.filter((c) => c.ok === false && c.name !== "coverage").length === 0;
  const coveragePass = coverage >= 0.5 || !strict;
  return { passed: structuralPass && coveragePass, checks, coverage, strict };
}
function overlap(a, b) {
  const ka = new Set(a.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((w) => w.length > 2));
  let hit = 0;
  for (const w of b.split(/[^a-z0-9\u4e00-\u9fa5]+/)) {
    if (w.length > 2 && ka.has(w)) hit += 1;
  }
  return hit >= 2;
}

/** 卡 failure_modes 是否命中一段失败文本(中英混合鲁棒: 词重叠≥2 / 全串包含 / 8 字前缀包含) */
function cardHitsFailure(card, failText) {
  const modes = (card?.failure_modes || []).map((s) => s.toLowerCase());
  return {
    hit: modes.some((m) => overlap(m, failText) || failText.includes(m) || (m.length >= 8 && failText.includes(m.slice(0, 8)))),
    modes,
  };
}
/** 按失败文本挑出命中的卡(供 TTA 注入与回放) */
function matchCardsForFailure(cards, failText, max = 2) {
  const out = [];
  for (const c of cards || []) {
    if (cardHitsFailure(c, failText).hit) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}
/** 渲染"任务经验卡"注入块(P4a: 重试携带上次教训) */
function renderTtaInjection(cards, fails) {
  const parts = [
    `## 任务经验卡(上次失败教训; 若与当前事实冲突以用户最新指示为准)`,
    `上次失败: ${(fails[0]?.error || fails[0]?.assistant || "").slice(0, 160) || "(无错误文本)"}`,
  ];
  for (const c of cards) {
    parts.push(
      `- [${c.name}] 适用: ${str(c.applicability?.when).slice(0, 80)}` +
        ` | 步骤: ${(c.steps || []).slice(0, 3).join(" → ")}` +
        ` | 防: ${(c.failure_modes || []).slice(0, 2).join("; ")}`,
    );
  }
  return parts.join("\n");
}
/** 工作记忆注入块(P1) */
function buildWmInjection(goal, note, traceTurns) {
  const lines = [
    `## 工作记忆(已验证任务状态, 优先于对话历史)`,
    `目标: ${note?.objective || goal?.objective || "(未声明)"}`,
    `阶段: ${note?.phase || goal?.phase || "(未声明)"}`,
  ];
  if (goal) {
    lines.push(`进度: goal 已完成 ${goal.completedRounds ?? 0}/${goal.maxRounds ?? "∞"} 轮${goal.blockedReason ? `, 阻塞: ${goal.blockedReason}` : ""}${goal.armed ? ", 可续跑" : ""}`);
  }
  if (note?.note) lines.push(`备注: ${note.note}`);
  if (traceTurns?.length) lines.push(`最近动作: ${traceTurns.flatMap((t) => t.actions || []).slice(-3).join(" → ") || "(无)"}`);
  lines.push(`⚠️ 若与当前事实冲突, 以用户最新指示为准`);
  return lines.filter((x) => x !== null && x !== undefined).join("\n");
}
/** TTA 携带卡(P4a): 会话存在失败轨迹且 skills/ 有命中卡时生成注入块 */
function ttaBlockFor(p, sessionId) {
  try {
    const trace = readJsonl(join(p.traces, safeName(sessionId) + ".jsonl"), 120);
    const fails = trace.filter((r) => r.fail);
    if (!fails.length) return null;
    const failText = fails.map((f) => `${f.error || ""} ${f.assistant || ""}`).join(" ").toLowerCase();
    if (!failText.trim()) return null;
    const cards = listSkillCards(p);
    const hits = matchCardsForFailure(cards, failText, 2);
    if (!hits.length) return null;
    return renderTtaInjection(hits, fails);
  } catch {
    return null;
  }
}

// ── P0: 跨会话 WM 注入 —— 读取最近会话的工作记忆, 为新会话提供上下文 ──
function seedRecurisContext(cfg, sessionId) {
  try {
    const p = pathsOf(cfg);
    const result = { wm: null, skills: null };
    // 读取最近 7 天的 WM 文件(排除当前会话)
    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const recentWm = [];
    if (existsSync(p.wm)) {
      for (const f of readdirSync(p.wm)) {
        if (!f.endsWith(".json") || f.includes(safeName(sessionId))) continue;
        const file = join(p.wm, f);
        try {
          const wm = JSON.parse(readFileSync(file, "utf8"));
          const ts = new Date(wm.ts || 0).getTime();
          if (now - ts > weekMs) continue;
          if (wm.turnCount > 0 && (wm.recent?.length || wm.goal)) {
            recentWm.push(wm);
          }
        } catch {
          // 跳过损坏的文件
        }
      }
    }
    // 取最近 5 个会话, 每个取最近 2 轮
    if (recentWm.length) {
      recentWm.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
      const lines = ["## 最近会话上下文(Recuris 工作记忆)"];
      for (const wm of recentWm.slice(0, 5)) {
        const lastTurns = (wm.recent || []).slice(-2);
        const goalStr = wm.goal?.objective || "";
        if (goalStr) lines.push(`目标: ${goalStr}`);
        for (const t of lastTurns) {
          const user = (t.user || "").slice(0, 80);
          if (user) lines.push(`  - ${user}`);
        }
      }
      result.wm = lines.join("\n");
    }
    // P2: 查询技能卡(从 Hindsight 召回)
    try {
      const hsOut = execFileSync("bash", [HS_MEMORY, "recall", "project skill lessons learned", "--scope", "all", "--types", "skill", "--top", "3"], {
        env: HS_ENV, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"],
      });
      if (hsOut && hsOut.trim()) {
        result.skills = "## 相关技能卡(Recuris)\n" + hsOut.trim().split("\n").filter(Boolean).slice(0, 3).map((l, i) => `[技能${i + 1}] ${l}`).join("\n");
      }
    } catch {
      // Hindsight 不可用时静默
    }
    if (result.wm || result.skills) {
      sessionStartContexts.set(sessionId, result);
    }
  } catch {
    // 静默失败
  }
}

// ── P3b 回放式门控: 候选卡在"留出失败任务轨迹"上做确定性回放 ──
const ACTION_KEYWORDS = ["bash", "edit", "read", "write", "rg", "grep", "fd", "find", "fetch", "search", "skill", "git", "gh", "node", "python", "uv", "pnpm", "bun", "npm", "curl", "memory", "recall", "retain", "docker", "kill", "lsof", "ps", "ls", "cat", "mkdir", "test", "node --check"];
function cardActionKeywords(card) {
  const text = ((card?.steps || []).join(" ") + " " + str(card?.applicability?.when)).toLowerCase();
  return ACTION_KEYWORDS.filter((k) => text.includes(k));
}
/** 读取其他失败任务的完整轨迹(留出集): 失败轮 + 前几轮动作 */
function loadHeldOutTraces(p, excludeSessionId, max) {
  const out = [];
  for (const f of listFiles(p.traces)) {
    if (f === safeName(excludeSessionId) + ".jsonl") continue;
    const recs = readJsonl(join(p.traces, f), 300);
    const failIdx = recs.findIndex((r) => r.fail);
    if (failIdx < 0) continue;
    const failures = recs.filter((r) => r.fail).slice(-2).map((r) => ({ error: r.error || "", assistant: r.assistant || "" }));
    const actions = recs.slice(Math.max(0, failIdx - 3), failIdx + 1).flatMap((r) => r.actions || []).slice(-8);
    out.push({ sessionId: basename(f, ".jsonl"), failures, actions });
    if (out.length >= max) break;
  }
  return out;
}
/**
 * 确定性回放: ① 卡 failure_modes 与留出任务失败文本词重叠(≥2 词)
 * ② 卡步骤动作关键词命中留出任务动作序列。命中 ≥1 条且命中率 ≥50% 为 pass;
 * 无留出样本 → no-held-out(非严格档放行, 严格档拒绝)。
 */
function replayGate(card, traces, cfg) {
  const checks = [];
  if (!traces.length) {
    checks.push({ name: "replay", ok: !cfg.gateStrict, note: "无留出失败轨迹(no-held-out); 非严格档放行" });
    return { ok: !cfg.gateStrict, checks, hits: 0, total: 0, note: "no-held-out", per: [] };
  }
  const kws = cardActionKeywords(card);
  let hits = 0;
  const per = [];
  for (const tr of traces) {
    const failText = tr.failures.map((f) => `${f.error} ${f.assistant}`).join(" ").toLowerCase();
    const modeHit = cardHitsFailure(card, failText).hit;
    const actText = tr.actions.join(" ").toLowerCase();
    const actHit = kws.some((k) => actText.includes(k));
    const hit = modeHit || actHit;
    if (hit) hits += 1;
    per.push({
      task: tr.sessionId,
      modeHit,
      actHit,
      hit,
      reason: hit ? "命中" : `失败模式/动作均未覆盖: ${tr.failures.map((f) => f.error).filter(Boolean).join("; ").slice(0, 90) || "(无错误文本)"}`,
    });
  }
  const ratio = hits / traces.length;
  const ok = hits >= 1 && ratio >= 0.5;
  checks.push({ name: "replay", ok, note: `留出回放 ${hits}/${traces.length} 条命中 (${(ratio * 100).toFixed(0)}%)` });
  return { ok, checks, hits, total: traces.length, ratio, per };
}

// ── P6 持久模式知识层(Wiki Layer, 借鉴 WikiSkill arXiv:2608.27454) ──
// 三层: raw(轨迹, 不可变) → patterns(知识, 永不回滚) → skills(技能, 可回滚)。
// 每次 evolve: 先由 Wiki Maintainer 从轨迹+诊断中提炼/合并模式落盘, 再让
// Skill Proposer(合并器)基于 wiki 提案; 卡落盘时写 purpose.patternIds 反向追溯。
const WIKI_SYSTEM =
  "你是记忆演化流水线的 Wiki Maintainer(知识库维护者)。只输出一个 JSON 对象, 不要输出任何其他文字。";
const WIKI_PROMPT = (ev, workers, cap) =>
  `把失败轨迹consolidate成"持久模式"(patterns): 每一条 = 一个失败模式 + 可操作规避(别做什么), ` +
  `和/或 一个可复用成功策略(该做什么), 供后续技能提案复用。轨迹中含"❌失败"标记的是失败轮, 其余为通过轮:\n` +
  `- 从失败轮提炼 failure_mode(根因) + workaround(规避);\n` +
  `- 从通过轮提炼 strategy(成功做法, 何时该走这条路径);\n` +
  `- 同一条模式可同时含 failure_mode 与 strategy(同一主题的教训+正解), strategy 可选.\n` +
  `要求: ① 模式是知识和教训, 不是某张卡; ② 与已有 wiki 模式重复或近似的不要重复产出(去重后最多 ${cap} 条); ` +
  `③ workaround/strategy 要具体可执行; ④ evidence 用 1-2 句描述出处。\n` +
  `输出 JSON: {"patterns":[{"name":"...","failure_mode":"...或省略","workaround":"...或省略","strategy":"...或省略","evidence":"..."}]}\n\n` +
  `## 已有 wiki 模式\n${ev.wiki || "(无)"}\n\n` +
  `## 失败轨迹\n${ev.trajectory}\n\n## 诊断结果\n${workers}`;
async function runWikiMaintainer(ctx, cfg, ev, workers) {
  const cap = Math.max(1, cfg.patternsMax || 4);
  try {
    const raw = await metaCall(ctx, cfg, WIKI_SYSTEM, WIKI_PROMPT(ev, workers, cap), cfg.evolveTimeoutMs);
    const parsed = extractJson(raw);
    const pats = Array.isArray(parsed?.patterns) ? parsed.patterns.slice(0, cap) : [];
    return { patterns: pats };
  } catch (e) {
    return { patterns: [], err: trimText(String(e?.message || e), 160) };
  }
}
function patternFile(p, id) {
  return join(p.patterns, safeName(id) + ".json");
}
function listPatterns(p) {
  return listFiles(p.patterns)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(join(p.patterns, f), null))
    .filter(Boolean);
}
function readPattern(p, id) {
  return readJson(patternFile(p, id), null);
}
/** 模式名 → 稳定 id: ASCII slug + 短 hash, 保证唯一且落盘安全(中文名也不撞文件) */
function patternIdOf(name) {
  const raw = String(name || "pattern");
  const ascii = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "pattern";
  const h = createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return `pat-${ascii}-${h}`;
}
/**
 * 落盘/合并一条模式(Wiki 永不回滚: 只增不删; 同名近似合并, 追加证据)。
 * strategy = 成功策略(从通过轨迹提炼的"该怎么做"), 与 failure_mode/workaround 互补。
 */
function upsertPattern(p, name, failureMode, workaround, strategy, evidence, runId) {
  const id = patternIdOf(name);
  const existing = readPattern(p, id);
  const now = nowIso();
  let next;
  if (existing) {
    next = {
      ...existing,
      name,
      failure_mode: failureMode || existing.failure_mode,
      workaround: workaround || existing.workaround,
      strategy: strategy || existing.strategy,
      evidence: [...new Set([...(existing.evidence || []), evidence].filter(Boolean))].slice(-6),
      updated: now,
      history: [...(existing.history || []), { runId, ts: now, kind: "merge" }].slice(-10),
    };
  } else {
    next = {
      id,
      name,
      failure_mode: failureMode || "",
      workaround: workaround || "",
      strategy: strategy || "",
      evidence: [evidence].filter(Boolean),
      cards: [],
      created: now,
      updated: now,
      history: [{ runId, ts: now, kind: "create" }],
    };
  }
  // 至少要有失败模式或成功策略之一才有意义
  if (!next.failure_mode && !next.strategy) return null;
  if (!writeJson(patternFile(p, id), next)) return null;
  return next;
}
/** 批量落盘增强 1 的 wiki 模式(去重, 返回新建/合并条目数) */
function storePatterns(p, patterns, runId) {
  let created = 0;
  for (const pt of patterns || []) {
    if (!pt || (!pt.failure_mode && !pt.strategy)) continue;
    if (upsertPattern(p, pt.name || pt.failure_mode || pt.strategy, pt.failure_mode, pt.workaround, pt.strategy, pt.evidence, runId)) created += 1;
  }
  return { created, total: listPatterns(p).length };
}
/** 渲染 wiki 摘要(供证据/提示注入) */
function renderWiki(p, max = 6) {
  const pats = listPatterns(p).slice(0, max);
  if (!pats.length) return "(无持久模式)";
  return pats
    .map((t) => {
      const lines = [`[${t.id}] ${t.name}`];
      if (t.failure_mode) lines.push(`  触发: ${trimText(t.failure_mode, 120)}\n  规避: ${trimText(t.workaround, 140) || "(未写)"}`);
      if (t.strategy) lines.push(`  成功策略: ${trimText(t.strategy, 140)}`);
      if (t.cards?.length) lines.push(` | 已被卡引用: ${t.cards.join(",")}`);
      return lines.join("\n");
    })
    .join("\n\n");
}
/**
 * 增强 2 反向追溯(PURPOSE 等价): 按失败模式文本重叠把卡与其催生/相关的
 * 持久模式关联 —— 卡写 purpose.patternIds, 模式写 cards[] 引用索引。
 */
function linkCardToPatterns(p, card) {
  const pats = listPatterns(p);
  if (!pats.length) return { linked: 0, ids: [] };
  const modes = (card.failure_modes || []).map((s) => s.toLowerCase());
  const hits = pats.filter((t) => {
    const tm = String(t.failure_mode || "").toLowerCase();
    return modes.some((m) => (tm && (m.includes(tm.slice(0, 8)) || tm.includes(m.slice(0, 8)))) || overlap(m, tm));
  });
  const ids = hits.map((t) => t.id);
  if (!ids.length) return { linked: 0, ids };
  card.purpose = { ...(card.purpose || {}), patternIds: [...new Set([...(card.purpose?.patternIds || []), ...ids])] };
  // 回写卡(补 purpose), 并给模式补引用卡
  const file = join(p.skills, safeName(card.id) + ".json");
  const cur = readJson(file, card);
  cur.purpose = card.purpose;
  writeJson(file, cur);
  for (const t of hits) {
    const rec = readPattern(p, t.id);
    if (!rec) continue;
    rec.cards = [...new Set([...(rec.cards || []), card.id])];
    writeJson(patternFile(p, t.id), rec);
  }
  return { linked: ids.length, ids };
}
/** 增强 2 审计: 最近被拒提案(供下次演化避免重复提议) */
function recentRejectedRuns(p, max = 3) {
  const out = [];
  for (const f of listFiles(p.evolutions)) {
    const recs = readJsonl(join(p.evolutions, f), 20);
    for (const r of recs) {
      for (const a of r.audit || []) {
        if (a.accepted === false) {
          out.push({ runId: r.runId, kind: a.kind, targetCardId: a.targetCardId, cardName: a.cardName, diff: trimText(a.diff, 120), rejectReason: a.rejectReason });
          if (out.length >= max) return out;
        }
      }
    }
  }
  return out;
}
function renderRejected(rejected) {
  if (!rejected.length) return "(无被拒提案)";
  return rejected
    .map((r, i) => `${i + 1}. [${r.runId}] ${r.kind} ${r.cardName || r.targetCardId || "?"}: ${r.rejectReason || "门控拒绝"} — ${r.diff}`)
    .join("\n");
}

// ── P3a 卡 → Hindsight 同步(type=skill, 与 skill-crystallize 同构) ──
/** 与共享 CLI repo_bank 同构: git 根 basename → coding-agent::<name>; 非 git → global */
function repoBankId(agentCwd) {
  try {
    const out = execFileSync("git", ["-C", agentCwd || ".", "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 10000 }).trim();
    return out ? "coding-agent::" + basename(out) : null;
  } catch {
    return null;
  }
}
function renderSkillCardText(card) {
  const lines = [
    `技能卡 [${card.id}] v${card.version}: ${card.name}`,
    `适用: ${str(card.applicability?.when)}`,
  ];
  if (card.applicability?.when_not) lines.push(`不适: ${str(card.applicability.when_not)}`);
  lines.push("步骤:");
  for (const s of card.steps || []) lines.push(`- ${s}`);
  lines.push("防住的失败模式:");
  for (const m of card.failure_modes || []) lines.push(`- ${m}`);
  if (card.purpose?.patternIds?.length) lines.push(`源自持久模式: ${card.purpose.patternIds.join(", ")}`);
  return lines.join("\n");
}
/** 准入卡镜像进 Hindsight(项目库/global), context 标记 type=skill 供 recall --types skill 召回 */
async function syncCardToHindsight(cfg, agentCwd, card, runId) {
  if (!cfg.hindsightSync) return { ok: false, skipped: true, reason: "hindsightSync 关闭" };
  const bankId =
    cfg.hindsightSyncBank === "global" ? "coding-agent::global" : repoBankId(agentCwd) || "coding-agent::global";
  const body = {
    items: [
      {
        content: renderSkillCardText(card),
        tags: ["recuris", "skill-card", ...(Array.isArray(card.applicability?.domains) ? card.applicability.domains : [])].filter(Boolean),
        context: `provenance:crystallized; type:skill; card:${card.id}; run:${runId}`,
        document_id: "card-" + card.id,
      },
    ],
    async: false,
  };
  try {
    const res = await fetch(cfg.hindsightApiBase + "/v1/default/banks/" + encodeURIComponent(bankId) + "/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return { ok: false, skipped: false, reason: `HTTP ${res.status}` };
    return { ok: true, skipped: false, bankId, doc: "card-" + card.id };
  } catch (e) {
    return { ok: false, skipped: false, reason: trimText(String(e?.message || e), 200) };
  }
}

function listSkillCards(p) {
  return listFiles(p.skills)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(join(p.skills, f), null))
    .filter(Boolean);
}
function renderSkillsForEvidence(cards, max = 3) {
  if (!cards.length) return "(无已有技能卡)";
  return cards
    .slice(0, max)
    .map((c) => `[${c.id}] ${c.name}\n  适用: ${str(c.applicability?.when).slice(0, 120)}\n  失败模式: ${(c.failure_modes || []).slice(0, 3).join("; ")}`)
    .join("\n\n");
}
function otherRecentFailures(p, excludeSessionId, max = 3, windowDays = 7) {
  const out = [];
  const cutoff = Date.now() - windowDays * 86400000;
  for (const f of listFiles(p.traces)) {
    if (f === safeName(excludeSessionId) + ".jsonl") continue;
    const recs = readJsonl(join(p.traces, f), 200);
    const fails = recs.filter((r) => r.fail);
    if (!fails.length) continue;
    const lastTs = fails[fails.length - 1]?.ts;
    if (lastTs && new Date(lastTs).getTime() < cutoff) continue;
    const lastOk = recs.filter((r) => !r.fail).slice(-2);
    out.push({
      sessionId: basename(f, ".jsonl"),
      fail: fails.slice(-2).map((r) => ({ turn: r.t, user: trimText(r.user, 100), assistant: trimText(r.assistant, 100), err: trimText(r.error, 120) })),
      tail: lastOk.map((r) => ({ turn: r.t, actions: (r.actions || []).slice(-3) })),
    });
    if (out.length >= max) break;
  }
  return out;
}

function buildEvidence(ctx, cfg, agent, sessionId, failureText) {
  const p = pathsOf(cfg);
  ensureDirs(p);
  const events = agent?.session?.events;
  const current = readJsonl(join(p.traces, safeName(sessionId) + ".jsonl"), 200);
  const fallbackTurns = compactTurns(events);
  const trace = current.length ? current : fallbackTurns.map((t, i) => ({ t: i + 1, user: t.user, actions: t.actions, assistant: t.assistant }));
  const tail = trace.slice(-cfg.evidenceTrajectoryTurns);
  const head = trace.slice(0, 2);
  const trajectoryText = [...head, ...(tail.length >= cfg.evidenceTrajectoryTurns ? tail : [])]
    .map((r) => {
      const parts = [`[${r.t}] user: ${trimText(r.user, 160)}`];
      for (const a of r.actions || []) parts.push(`  tool: ${trimText(a, 120)}`);
      parts.push(`  asst: ${trimText(r.assistant || "", 160)}` + (r.fail ? `  ❌失败: ${trimText(r.error, 150)}` : ""));
      return parts.join("\n");
    })
    .join("\n");
  const observed = [];
  for (const r of trace.filter((r) => r.fail)) {
    if (r.error) observed.push(r.error);
    if (r.assistant) observed.push(r.assistant);
  }
  for (const r of fallbackTurns) {
    if (r.assistant) observed.push(r.assistant);
  }
  const recentFails = otherRecentFailures(p, sessionId, cfg.evidenceFailures);
  const failsText = recentFails.length
    ? recentFails
        .map((f) => `任务 ${f.sessionId}:\n` + f.fail.map((x) => `  [轮${x.turn}] user: ${x.user}\n    asst: ${x.assistant}\n    err: ${x.err}`).join("\n"))
        .join("\n")
    : "(无近期其他失败任务)";
  const cards = listSkillCards(p);
  const related = cfg.evidenceRelatedMemories
    ? recallRelated(failureText || "任务失败 调试 排错 复盘 " + trimText(tail[tail.length - 1]?.user || "", 120))
    : "(已关闭)";
  return {
    trajectory: trajectoryText,
    observed: observed.filter(Boolean).slice(0, 8),
    recentFailures: failsText,
    relatedMemories: related,
    skills: renderSkillsForEvidence(cards, cfg.evidenceSkills),
    cardCount: cards.length,
  };
}

/** 给证据附上持久知识层: wiki 模式 + 最近被拒提案(增强 1/2 注入) */
function attachPersistentKnowledge(p, cfg, ev) {
  return {
    ...ev,
    wiki: renderWiki(p, 6),
    wikiCount: listPatterns(p).length,
    rejected: renderRejected(recentRejectedRuns(p, 3)),
  };
}

async function runWorkers(ctx, cfg, ev) {
  const workers = [];
  const angles = WORKER_ANGLES.slice(0, Math.max(1, cfg.diagnosisWorkers));
  await Promise.all(
    angles.map(async (angle) => {
      try {
        const raw = await metaCall(ctx, cfg, WORKER_SYSTEM, WORKER_PROMPTS[angle](ev), cfg.evolveTimeoutMs);
        const parsed = extractJson(raw);
        workers.push({ angle, ok: !!parsed, raw: trimText(raw, 400), parsed });
      } catch (e) {
        workers.push({ angle, ok: false, raw: "", err: trimText(String(e?.message || e), 160) });
      }
    }),
  );
  return workers;
}

async function runConsolidate(ctx, cfg, ev, workers) {
  const okWorkers = workers.filter((w) => w.ok && w.parsed);
  if (!okWorkers.length) return { patches: [] };
  const listing = okWorkers.map((w) => `--- 角度 ${w.angle} ---\n` + safeString(w.parsed)).join("\n");
  try {
    const raw = await metaCall(ctx, cfg, CONSOLIDATE_SYSTEM, CONSOLIDATE_PROMPT(ev, listing, cfg.regCap), cfg.evolveTimeoutMs);
    const parsed = extractJson(raw);
    const patches = Array.isArray(parsed?.patches) ? parsed.patches.slice(0, Math.max(1, cfg.regCap)) : [];
    return { patches: patches.filter((p) => p && (p.kind === "new-card" || p.kind === "patch-card")) };
  } catch (e) {
    return { patches: [], err: trimText(String(e?.message || e), 160) };
  }
}

/** 由 patch 构造候选卡(与最终落盘卡同构, 供门控/回放预演) */
function buildCandidate(p, patch) {
  if (patch.kind === "patch-card" && patch.targetCardId) {
    const file = join(p.skills, safeName(patch.targetCardId) + ".json");
    const card = readJson(file, null);
    if (!card) return null;
    return { card: { ...card, ...(patch.card || {}) }, mode: "patch", old: card };
  }
  return {
    card: {
      id: patch.card?.id || slugify(patch.card?.name || "card"),
      name: str(patch.card?.name) || "未命名卡",
      version: 1,
      applicability: patch.card?.applicability || { domains: [], when: "", when_not: "" },
      steps: Array.isArray(patch.card?.steps) ? patch.card.steps.map((s) => str(s)) : [],
      failure_modes: Array.isArray(patch.card?.failure_modes) ? patch.card.failure_modes.map((s) => str(s)) : [],
    },
    mode: "new",
  };
}

/** 门控合并: 结构+覆盖度(baseGate) + 回放(replay); 模型不给自己投票 */
function composeGate(card, failureText, strict, replay) {
  const base = gateChecks(card, { observed: [failureText] }, strict);
  const allChecks = [...base.checks, ...(replay?.checks || [])];
  const passed = base.passed && (replay ? replay.ok : true);
  return {
    passed,
    checks: allChecks,
    coverage: base.coverage,
    strict,
    status: strict ? "strict" : base.coverage >= 0.5 && (replay ? replay.ok : true) ? "passed" : "soft",
  };
}

function applyPatch(p, runId, taskId, failureText, patch, strict, replay) {
  const out = { applied: null, reason: "" };
  const cand = buildCandidate(p, patch);
  if (!cand) {
    out.reason = `目标卡 ${patch.targetCardId} 不存在, 跳过`;
    return out;
  }
  const card = cand.card;
  const gate = composeGate(card, failureText, strict, replay);
  if (!gate.passed) {
    out.reason = "门控拒绝(" + cand.mode + "-card): " + gate.checks.filter((c) => !c.ok).map((c) => c.name).join(",");
    return out;
  }
  if (cand.mode === "patch") {
    const history = cand.old.history || [];
    history.push({ version: cand.old.version || 1, patch: trimText(safeString(patch.card), 1500), ts: nowIso(), runId });
    const next = {
      ...cand.old,
      ...(patch.card || {}),
      version: (cand.old.version || 1) + 1,
      history,
      gate: { status: gate.status, checks: gate.checks, runId },
    };
    if (!writeJson(join(p.skills, safeName(card.id) + ".json"), next)) {
      out.reason = "写入失败(磁盘)";
      return out;
    }
    out.applied = { card: next, kind: "patch-card" };
    return out;
  }
  // new-card
  card.provenance = { runId, taskId, failure: trimText(failureText, 300), ts: nowIso() };
  card.history = [{ version: 0, patch: "created", ts: nowIso(), runId }];
  card.gate = { status: gate.status, checks: gate.checks, runId };
  const file = join(p.skills, safeName(card.id) + ".json");
  if (!writeJson(file, card)) {
    out.reason = "写入失败(磁盘)";
    return out;
  }
  out.applied = { card, kind: "new-card" };
  return out;
}

async function runEvolve(ctx, cfg, agent, sessionId, args) {
  const failureText = trimText(str(args?.failure), 600);
  const taskId = safeName(args?.taskId || sessionId);
  const agentCwd = agent?.session?.header?.cwd;
  const p = pathsOf(cfg);
  ensureDirs(p);
  const runId = "evo-" + Date.now().toString(36) + "-" + randomUUID().slice(0, 6);
  const evBase = buildEvidence(ctx, cfg, agent, sessionId, failureText);
  // P6 增强 1: 先用 Wiki Maintainer 把本次轨迹提炼成持久模式(永不回滚);
  // 在诊断 workers 之前运行(WikiSkill 顺序: 轨迹 → 知识 → 提案)
  let wikiOut = { patterns: [], err: null };
  if (cfg.wikiEnabled) {
    wikiOut = await runWikiMaintainer(ctx, cfg, evBase, "");
    wikiOut = { patterns: wikiOut.patterns, err: wikiOut.err || null };
    const stored = storePatterns(p, wikiOut.patterns, runId);
    wikiOut.stored = stored;
  }
  // 附上持久知识(含刚更新的 wiki + 历史被拒提案)供合并器(技能提案)使用
  const ev = attachPersistentKnowledge(p, cfg, evBase);
  const workers = await runWorkers(ctx, cfg, ev);
  const consolidated = await runConsolidate(ctx, cfg, ev, workers);
  // P3b: 留出失败轨迹 → 逐 patch 回放(确定性)
  const heldOut = cfg.replayGateEnabled ? loadHeldOutTraces(p, sessionId, cfg.replayHeldOutTasks) : [];
  const gateRecords = [];
  const applied = [];
  const audit = []; // 增强 2: 提案审计(每个 patch: diff + 接受/拒绝 + 门控/回放)
  for (const patch of consolidated.patches) {
    const cand = buildCandidate(p, patch);
    const replay = cand && cfg.replayGateEnabled ? replayGate(cand.card, heldOut, cfg) : null;
    const r = applyPatch(p, runId, taskId, failureText, patch, cfg.gateStrict, replay);
    const diff = trimText(safeString({ kind: patch.kind, targetCardId: patch.targetCardId || null, card: patch.card || null }), 1000);
    audit.push({
      i: audit.length,
      kind: patch.kind,
      targetCardId: patch.targetCardId || null,
      cardName: patch.card?.name || null,
      diff,
      accepted: !!r.applied,
      rejectReason: r.reason || null,
      gateStatus: r.applied?.card.gate?.status || null,
      replay: replay ? { ok: replay.ok, hits: replay.hits, total: replay.total } : null,
    });
    if (r.applied) {
      // 增强 2: 卡 ↔ 持久模式反向追溯(PURPOSE)
      if (cfg.wikiEnabled) {
        const link = linkCardToPatterns(p, r.applied.card);
        if (link.linked > 0) r.applied.card.purpose = { ...(r.applied.card.purpose || {}), patternIds: link.ids };
      }
      applied.push(r.applied);
      gateRecords.push({
        cardId: r.applied.card.id,
        version: r.applied.card.version,
        checks: r.applied.card.gate?.checks || [],
        replay: replay ? { ok: replay.ok, hits: replay.hits, total: replay.total, per: replay.per } : null,
      });
    } else if (replay) {
      gateRecords.push({ skipped: r.reason, replay: { hits: replay.hits, total: replay.total } });
    }
  }
  // P3a: 准入卡镜像进 Hindsight(type=skill)
  const syncs = [];
  for (const a of applied) {
    const s = await syncCardToHindsight(cfg, agentCwd, a.card, runId);
    syncs.push({ cardId: a.card.id, ok: s.ok, skipped: !!s.skipped, bankId: s.bankId || null, reason: s.reason || null });
  }
  const ledger = {
    runId,
    taskId,
    trigger: args?.auto ? "auto(agent/error)" : "manual",
    ts: nowIso(),
    failure: failureText,
    evidence: {
      turnCount: ev.trajectory.split("\n").length,
      observed: ev.observed,
      recentFailures: ev.recentFailures.slice(0, 400),
      relatedMemories: ev.relatedMemories.slice(0, 400),
      skillCount: ev.cardCount,
    },
    wiki: cfg.wikiEnabled
      ? { maintained: true, patternsProposed: wikiOut.patterns.length, patternsStored: wikiOut.stored?.created || 0, patternsTotal: listPatterns(p).length, err: wikiOut.err || null }
      : { maintained: false },
    replay: { enabled: cfg.replayGateEnabled, heldOutTasks: heldOut.map((h) => h.sessionId) },
    workers: workers.map((w) => ({ angle: w.angle, ok: w.ok, parsed: w.parsed || null, err: w.err || null })),
    consolidateErr: consolidated.err || null,
    patches: consolidated.patches.map((pp) => ({ kind: pp.kind, targetCardId: pp.targetCardId || null, cardName: pp.card?.name || null })),
    audit,
    gate: gateRecords,
    applied: applied.map((a) => ({ cardId: a.card.id, name: a.card.name, version: a.card.version, steps: a.card.steps.length, purpose: a.card.purpose?.patternIds || [] })),
    syncs,
  };
  appendJsonl(join(p.evolutions, runId + ".jsonl"), ledger);
  return { runId, ev, workers, consolidated, applied, ledger, syncs, gateRecords, wikiOut };
}

// ── P5 卡 → SKILL.md 全局技能(最终固化形态, 遵循 skill-add 模板) ──
function cardToSkillMd(card) {
  const slug = card.id || slugify(card.name, "skill");
  const when = str(card.applicability?.when);
  const whenNot = str(card.applicability?.when_not);
  const domains = (card.applicability?.domains || []).filter(Boolean).join(", ");
  const steps = (card.steps || []).map((s, i) => `${i + 1}. ${s}`).join("\n") || "- (无)";
  const modes = (card.failure_modes || []).map((m) => `- ${m}`).join("\n") || "- (无)";
  const prov = card.provenance || {};
  const gate = card.gate || {};
  const verifs = (card.verifications || []).map(
    (v) => `- ${(v.ts || "").slice(0, 10)} ${v.taskId}: 演练${v.wouldAvoid ? "✅可避免" : "⚠️不可避免"} — ${(v.reasons || []).slice(0, 2).join("; ") || "(无理由)"}`,
  );
  const desc =
    `Recuris 进化技能卡(${card.name}): 当${when || "匹配下列失败模式"}且需防${(card.failure_modes || []).slice(0, 2).join("/") || "相关失败"}时加载。` +
    `操作步骤 ${(card.steps || []).length} 条, 已过确定性门控${gate.status ? "(" + gate.status + ")" : ""}。`;
  const lines = [
    "---",
    `name: ${slug}`,
    "description: >",
    `  ${desc}`,
    "---",
    "",
    `# ${card.name} (${slug})`,
    "",
    `本技能由 recuris-adapt 进化产出(run ${prov.runId || "?"}, task ${prov.taskId || "?"}),`,
    `已通过确定性门控(${gate.status || "?"})${gate.checks?.length ? ", checks: " + gate.checks.map((c) => c.name).join("/") : ""}。`,
    "",
    "## 适用场景",
    `- 适用: ${when || "(未写)"}`,
    whenNot ? `- 不适用: ${whenNot}` : null,
    domains ? `- 领域: ${domains}` : null,
    "",
    "## 操作步骤",
    steps,
    "",
    "## 避坑(防住的失败模式)",
    modes,
    "",
    "## 验证记录",
    verifs.join("\n") || "- (无演练记录)",
    "",
    "## 来源",
    `- runId: ${prov.runId || "?"}`,
    `- 失败: ${trimText(prov.failure || "?", 200)}`,
    `- 时间: ${prov.ts || "?"}`,
    (card.purpose?.patternIds?.length ? `- 源自持久模式: ${card.purpose.patternIds.join(", ")}` : null),
    "",
  ];
  return lines.filter((x) => x !== null && x !== undefined).join("\n");
}
function listSkillDirs(root) {
  try {
    return readdirSync(root).filter((f) => existsSync(join(root, f, "SKILL.md")));
  } catch {
    return [];
  }
}
/**
 * 导出: 只导 gate.status=passed(force 可含 soft); minVerifications=N 要求正向演练记录;
 * 与技能目录同名跳过; dryRun=true 只返回预览不写盘。返回 {planned/written/skipped} 明细。
 */
function runExport(cfg, args) {
  const cards = listSkillCards(pathsOf(cfg));
  if (!cards.length) return { ok: false, reason: "无卡可导出(先经 recuris_evolve 产生已准入卡)" };
  const force = String(args?.force ?? "") === "true";
  const dryRun = String(args?.dryRun ?? "true") !== "false";
  const minVer = Math.max(0, Number(args?.minVerifications) || 0);
  const pick = args?.cardId ? cards.filter((c) => c.id === args.cardId || c.name === args.cardId) : cards;
  const eligible = pick.filter((c) => force || c.gate?.status === "passed");
  const withVer = minVer > 0 ? eligible.filter((c) => (c.verifications || []).filter((v) => v.wouldAvoid).length >= minVer) : eligible;
  const root = cfg.exportRoot || join(homedir(), ".agents", "skills");
  const existing = listSkillDirs(root);
  const out = { ok: true, dryRun, root, total: cards.length, picked: pick.length, eligible: eligible.length, selected: withVer.length, planned: [], written: [], skipped: [] };
  for (const c of withVer) {
    const slug = c.id || slugify(c.name, "skill");
    if (existing.includes(slug)) {
      out.skipped.push({ slug, reason: "技能目录已有同名 SKILL.md(dryRun 预览也会提示)" });
      continue;
    }
    const md = cardToSkillMd(c);
    if (dryRun) {
      out.planned.push({ slug, name: c.name, version: c.version, gate: c.gate?.status, verifications: (c.verifications || []).length, md });
      continue;
    }
    const dir = join(root, slug);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), md, "utf8");
      out.written.push({ slug, path: join(dir, "SKILL.md"), name: c.name, version: c.version });
    } catch (e) {
      out.skipped.push({ slug, reason: "写入失败: " + trimText(String(e?.message || e), 120) });
    }
  }
  return out;
}
// ── P4b 卡演练验证闭环(离线推演, 不执行外部动作) ──
const VERIFY_SYSTEM =
  "你是任务演练器(离线推演, 绝不执行外部动作)。只输出一个 JSON 对象, 不要输出任何其他文字。";
async function runVerify(ctx, cfg, sessionId, args) {
  const p = pathsOf(cfg);
  ensureDirs(p);
  // 解析卡: 显式 cardId, 缺省取最新 ledger 的入境卡
  let card = null;
  if (args?.cardId) {
    card = readJson(join(p.skills, safeName(args.cardId) + ".json"), null);
  } else {
    for (const f of listFiles(p.evolutions)) {
      const recs = readJsonl(join(p.evolutions, f), 5);
      const id = recs[recs.length - 1]?.applied?.[0]?.cardId;
      if (!id) continue;
      card = readJson(join(p.skills, safeName(id) + ".json"), null);
      if (card) break;
    }
  }
  if (!card) return { ok: false, reason: "未找到卡(cardId 缺省=最近 ledger 入境卡); 先用 recuris_skills 查看" };
  const taskId = safeName(args?.taskId || sessionId);
  const trace = readJsonl(join(p.traces, taskId + ".jsonl"), 200);
  const fails = trace.filter((r) => r.fail).slice(-2);
  if (!fails.length) return { ok: false, reason: `任务 ${taskId} 无失败轨迹可演练` };
  const failText = fails.map((f) => `[轮${f.t}] err=${f.error || "(无)"} asst=${f.assistant || "(无)"} actions=${(f.actions || []).join(",")}`).join("\n");
  const prompt =
    `给一张经验卡与某任务的最近失败段, 离线推演"按卡步骤重做"会发生什么(不执行任何真实操作)。\n\n` +
    `## 任务\n${taskId}\n\n## 最近失败段\n${failText}\n\n` +
    `## 经验卡\n${renderSkillCardText(card)}\n\n` +
    `输出 JSON: {"would_avoid":true或false,"replayed_steps":["按卡重做的关键步骤(≤5)","..."],"reasons":["为什么能/不能避免(≤3)","..."],"remaining_risk":"仍存在的风险(一句话)"}`;
  let raw;
  try {
    raw = await metaCall(ctx, cfg, VERIFY_SYSTEM, prompt, cfg.evolveTimeoutMs);
  } catch (e) {
    return { ok: false, reason: "演练 LLM 调用失败: " + trimText(String(e?.message || e), 160) };
  }
  const r = extractJson(raw);
  if (!r) return { ok: false, reason: "演练 LLM 输出无法解析为 JSON" };
  const runId = "verify-" + Date.now().toString(36) + "-" + randomUUID().slice(0, 4);
  const v = {
    runId,
    taskId,
    ts: nowIso(),
    wouldAvoid: r.would_avoid === true,
    steps: Array.isArray(r.replayed_steps) ? r.replayed_steps.map((s) => str(s)) : [],
    reasons: Array.isArray(r.reasons) ? r.reasons.map((s) => str(s)) : [],
    remainingRisk: trimText(str(r.remaining_risk), 300),
  };
  card.verifications = [...(card.verifications || []), v];
  const written = writeJson(join(p.skills, safeName(card.id) + ".json"), card);
  appendJsonl(join(p.evolutions, runId + ".jsonl"), { runId, kind: "verify", cardId: card.id, taskId, ...v });
  return { ok: true, cardId: card.id, runId, v, written };
}

// ── 自动触发: agent/error ──
const autoState = new Map(); // sessionId -> { last: number, runs: number }
function maybeAutoEvolve(ctx, cfg, agent, turn, error) {
  if (!cfg.autoEvolveOnError) return;
  const sessionId = agent?.session?.header?.id;
  if (!sessionId) return;
  const st = autoState.get(sessionId) || { last: 0, runs: 0 };
  const now = Date.now();
  if (now - st.last < cfg.autoEvolveCoolDownMs) return;
  const events = agent?.session?.events;
  const turns = compactTurns(events);
  if (turns.length < cfg.autoEvolveMinTurns) return;
  st.last = now;
  st.runs += 1;
  autoState.set(sessionId, st);
  const failureText = "步骤错误: " + trimText(String(error?.message || safeString(error)), 400);
  void runEvolve(ctx, cfg, agent, sessionId, { failure: failureText, auto: true })
    .then((r) => {
      if (ctx.logger?.info) ctx.logger.info(`recuris: 自动进化 ${r.runId} 完成, 准入 ${r.applied.length} 张卡`);
    })
    .catch(() => {});
}

// ── 工具(execute 第二参 exec 由注册闭包注入: {ctx, cfg, agent, sessionId}) ──
const toolEvolve = {
  name: "recuris_evolve",
  description:
    "Recuris 式记忆进化: 读取本任务的失败轨迹 + 近期其他失败 + Hindsight 相关经验 + 已有技能卡, 用上游 meta 模型并行诊断(定位失败组件), 合并为 ≤regCap 个单组件 patch, 过确定性验证门控(结构 + 覆盖度留出, 模型不给自己投票)后落盘技能卡, 并记入 evolutions ledger。用于长任务失败/踩坑后的复盘固化。taskId 缺省=当前会话。",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "目标任务/会话 id(缺省当前会话)" },
      failure: { type: "string", description: "失败描述或失败原因(必填, 诊断依据)" },
    },
    required: ["failure"],
  },
  async execute(args, exec) {
    const { ctx, cfg, agent, sessionId } = exec;
    if (!sessionId) return "❌ 无法解析当前会话。";
    const r = await runEvolve(ctx, cfg, agent, sessionId, args ?? {});
    const lines = [
      `✅ 进化完成 runId=${r.runId}`,
      `任务: ${r.taskId} | 触发: ${r.ledger.trigger} | 轨迹轮次: ${r.ledger.evidence.turnCount}`,
      `诊断: ${r.workers.map((w) => `${w.angle}${w.ok ? "✓" : "✗"}`).join(" ")} | 合并 patch: ${r.consolidated.patches.length}`,
    ];
    for (const w of r.workers) {
      if (w.ok && w.parsed) lines.push(`  [${w.angle}] ${safeString(w.parsed.diagnosis || w.parsed.rationale || "", 200)}`);
      else if (w.err) lines.push(`  [${w.angle}] 失败: ${w.err}`);
    }
    if (r.applied.length) {
      for (const a of r.applied) lines.push(`  ⛁ 准入卡片 ${a.card.id} v${a.card.version}(${a.card.steps.length} 步, 门控 ${a.card.gate?.status})`);
    } else {
      lines.push("  (本轮无准入卡片: 诊断不足/门控拒绝/regCap 归零)");
    }
    if (r.wikiOut) {
      const w = r.wikiOut;
      lines.push(`  wiki 知识层: 提炼 ${w.patterns.length} 模式, 新建/合并 ${w.stored?.created || 0} 条(总 ${w.stored?.total || 0}, 永不回滚)${w.err ? ", err: " + w.err : ""}`);
    }
    if (r.ledger.audit?.length) {
      lines.push(`  提案审计: ${r.ledger.audit.map((a) => `${a.kind === "new-card" ? "新卡" : "改卡"}:${a.cardName || a.targetCardId || "?"}${a.accepted ? "✓接受" : "✗拒绝(" + (a.rejectReason || "门控") + ")"}`).join(" | ")}`);
    }
    const rep = r.gateRecords[0]?.replay;
    if (rep) lines.push(`  回放门控: 留出 ${rep.hits}/${rep.total} 条命中${rep.per?.length ? " (" + rep.per.map((x) => `${x.task}${x.hit ? "✓" : "✗"}`).join(" ") + ")" : ""}`);
    else if (r.ledger.replay.enabled) lines.push("  回放门控: 无留出失败任务(no-held-out, 非严格档放行)");
    if (r.syncs.length) lines.push(`  Hindsight 同步: ${r.syncs.map((s) => `${s.cardId} ${s.ok ? "✓" : "✗ " + (s.reason || "")}`).join(" | ")}`);
    lines.push(`ledger: ~/.dsh/storages/recuris/evolutions/${r.runId}.jsonl`);
    return lines.join("\n");
  },
};

const toolWm = {
  name: "recuris_wm",
  description:
    "读取/写入工作记忆卡(Recuris 的 W): 记录当前任务的目标、阶段、已验证进度与阻塞(状态接地, 供 pre-step 自动注入与进化证据)。无 goal 时手动维护。",
  parameters: {
    type: "object",
    properties: {
      objective: { type: "string", description: "任务目标(一句话)" },
      phase: { type: "string", description: "当前阶段/进度" },
      note: { type: "string", description: "已验证状态备注(做到哪一步、已排除什么)" },
      clear: { type: "string", description: "true=清空手动备注" },
    },
  },
  execute(args, exec) {
    const { cfg, agent, sessionId } = exec;
    if (!sessionId) return "❌ 无法解析当前会话。";
    const p = pathsOf(cfg);
    ensureDirs(p);
    const file = wmNoteFile(p, sessionId);
    if (String(args?.clear ?? "") === "true") {
      writeJson(file, {});
      return "工作记忆备注已清空。";
    }
    const note = readWmNote(p, sessionId);
    if (args?.objective) note.objective = trimText(str(args.objective), 300);
    if (args?.phase) note.phase = trimText(str(args.phase), 200);
    if (args?.note) note.note = trimText(str(args.note), 600);
    writeJson(file, note);
    const goals = exec.ctx.get("goals");
    const goal = goalSnapshot(goals, agent);
    return (
      "工作记忆卡已更新。当前内容:" +
      `\n目标: ${note.objective || goal?.objective || "(无)"}` +
      `\n阶段: ${note.phase || goal?.phase || "(无)"}` +
      `\n备注: ${note.note || "(空)"}` +
      `\ngoal 视图: ${goal ? `${goal.phase} 已完成 ${goal.completedRounds}/${goal.maxRounds ?? "∞"} 轮${goal.blockedReason ? ", 阻塞: " + goal.blockedReason : ""}` : "(无 goal)"}`
    );
  },
};

const toolSkills = {
  name: "recuris_skills",
  description:
    "列出已进化的技能卡(Recuris 的 E): id/名称/适用条件/失败模式/准入门控, 可加 id 查看单卡全文。",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "卡片 id(缺省列出全部)" },
    },
  },
  execute(args, exec) {
    const { cfg, agent, sessionId } = exec;
    if (!sessionId) return "❌ 无法解析当前会话。";
    const p = pathsOf(cfg);
    ensureDirs(p);
    const cards = listSkillCards(p);
    if (!cards.length) return "(尚无技能卡。长任务失败后调用 recuris_evolve 生成。)\n技能根目录: " + p.skills;
    const want = args?.id;
    const pick = want ? cards.filter((c) => c.id === want || c.name === want) : cards;
    if (want && !pick.length) return `未找到卡片: ${want}`;
    return pick
      .map((c) =>
        want
          ? `# ${c.name} [${c.id}] v${c.version}\n适用: ${str(c.applicability?.when)}\n不适: ${str(c.applicability?.when_not) || "(未写)"}\n步骤:\n${(c.steps || []).map((s, i) => `  ${i + 1}. ${s}`).join("\n")}\n防住的失败模式: ${(c.failure_modes || []).map((m) => `- ${m}`).join("\n")}\n来源: ${str(c.provenance?.failure)}`
          : `[${c.id}] ${c.name} v${c.version} | ${(c.steps || []).length} 步 | 门控: ${c.gate?.status || "?"} | when: ${trimText(str(c.applicability?.when), 80)}`,
      )
      .join(want ? "\n\n" : "\n");
  },
};

const toolTrace = {
  name: "recuris_trace",
  description:
    "查看某任务的 Recuris 结构化轨迹(逐轮 user/tool/assistant/失败标记)。taskId 缺省=当前会话。",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "任务/会话 id" },
      max: { type: "string", description: "显示最近 N 轮(默认 12)" },
    },
  },
  execute(args, exec) {
    const { cfg, sessionId } = exec;
    const taskId = args?.taskId || sessionId;
    if (!taskId) return "❌ 无法解析任务。";
    const p = pathsOf(cfg);
    ensureDirs(p);
    const file = join(p.traces, safeName(taskId) + ".jsonl");
    const recs = readJsonl(file, 200);
    if (!recs.length) return `(无轨迹: ${file})`;
    const max = Math.max(1, Number(args?.max) || 12);
    return recs
      .slice(-max)
      .map((r) => {
        const parts = [`[${r.t}] user: ${trimText(r.user, 120)}`];
        for (const a of r.actions || []) parts.push(`  tool: ${trimText(a, 100)}`);
        parts.push(`  asst: ${trimText(r.assistant || "", 120)}` + (r.fail ? ` ❌(${trimText(r.error, 100)})` : ""));
        return parts.join("\n");
      })
      .join("\n");
  },
};

const toolVerify = {
  name: "recuris_verify",
  description:
    "卡演练(P4 验证闭环): 给一张技能卡在某任务的失败段上做离线推演(按卡步骤重做会怎样), 结果记入卡 verifications 与 ledger。cardId 缺省=最新准入卡, taskId 缺省=当前会话。推演用 meta 模型, 不执行外部动作。",
  parameters: {
    type: "object",
    properties: {
      cardId: { type: "string", description: "技能卡 id(缺省=最近 ledger 入境卡; 用 recuris_skills 查看)" },
      taskId: { type: "string", description: "目标任务/会话 id(缺省当前会话, 需该任务存在失败轨迹)" },
    },
  },
  async execute(args, exec) {
    const { ctx, cfg, sessionId } = exec;
    if (!sessionId) return "❌ 无法解析当前会话。";
    const r = await runVerify(ctx, cfg, sessionId, args ?? {});
    if (!r.ok) return "❌ " + (r.reason || "演练失败");
    return (
      `✅ 演练完成 runId=${r.runId} | 卡=${r.cardId} | 任务=${r.taskId}\n` +
      `能否避免失败: ${r.v.wouldAvoid ? "是" : "否"}\n` +
      `重做步骤:\n${r.v.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n") || "  (无)"}\n` +
      `理由:\n${r.v.reasons.map((x) => `  - ${x}`).join("\n") || "  (无)"}\n` +
      `剩余风险: ${r.v.remainingRisk || "(无)"}\n` +
      `(已记入卡 verifications 与 ledger${r.written ? "" : "; 卡写入失败仅留 ledger"})`
    );
  },
};

const toolExport = {
  name: "recuris_export",
  description:
    "把已准入技能卡导出为全局技能 ~/.agents/skills/<id>/SKILL.md(本机所有 agent 会话按需可加载的最终固化形态, 遵循 skill-add 模板)。默认 dryRun=true 只预览每个将创建的技能(含生成内容); dryRun=false 才真正写盘。只导 gate.status=passed 的卡(force=true 可含 soft); minVerifications=N 要求至少 N 条 wouldAvoid 演练记录; 与技能目录同名跳过; 不自动改 .skill-lock.json 且不扩散其余 agent 摘要行。",
  parameters: {
    type: "object",
    properties: {
      dryRun: { type: "string", description: "false=真正写盘到 ~/.agents/skills/(默认 true=只预览)" },
      cardId: { type: "string", description: "只导出指定卡 id/名称" },
      force: { type: "string", description: "true=允许导出 gate 非 passed 的卡(soft)" },
      minVerifications: { type: "string", description: "至少 N 条 wouldAvoid 演练记录才导出(默认 0=不要求)" },
    },
  },
  execute(args, exec) {
    const { cfg } = exec;
    const r = runExport(cfg, args ?? {});
    if (!r.ok) return "❌ " + r.reason;
    const lines = [
      `📤 技能导出 ${r.dryRun ? "(dryRun 预览, 未写盘)" : "(已写盘)"}`,
      `  库: 共 ${r.total} 张卡 | 选中 ${r.picked} | 可导(门控 passed) ${r.eligible} | 最终 ${r.selected}`,
      `  目标: ${r.root}`,
    ];
    for (const p of r.planned) {
      lines.push(`  ⏳ [预览] ${p.slug}(${p.name} v${p.version}, 门控 ${p.gate}, 演练 ${p.verifications} 条)`);
    }
    for (const w of r.written) lines.push(`  ✅ [已写] ${w.path} (${w.name} v${w.version})`);
    for (const s of r.skipped) lines.push(`  ⏭️ [跳过] ${s.slug}: ${s.reason}`);
    if (!r.planned.length && !r.written.length && r.selected > 0) lines.push("  (全部与技能目录同名, 已跳过)");
    if (r.dryRun && r.planned.length) {
      lines.push(`  确认后以 dryRun=false 重跑即写盘; 单卡预览可看第 1 张示例:`);
      lines.push("  --- 示例(第 1 张) ---");
      lines.push(r.planned[0].md.split("\n").slice(0, 22).join("\n"));
    }
    return lines.join("\n");
  },
};

const toolStatus = {
  name: "recuris_status",
  description: "Recuris 插件状态: 存储根、技能卡数、ledger 数、最近进化记录摘要、自动触发开关。",
  parameters: { type: "object", properties: {} },
  execute(_args, exec) {
    const { cfg } = exec;
    const p = pathsOf(cfg);
    ensureDirs(p);
    const evos = listFiles(p.evolutions);
    const latest = evos.length ? readJsonl(join(p.evolutions, evos[0]), 3) : [];
    const lines = [
      `Recuris 状态: ${cfg.enabled ? "启用" : "关闭"}`,
      `存储根: ${p.root}`,
      `技能卡: ${listSkillCards(p).length} 张 | wiki 模式: ${cfg.wikiEnabled ? listPatterns(p).length : "关"} | ledger: ${evos.length} 次进化`,
      `meta 模型: ${cfg.metaProvider}/${cfg.metaModel} | 诊断 workers: ${cfg.diagnosisWorkers} | regCap: ${cfg.regCap}`,
      `自动触发(agent/error): ${cfg.autoEvolveOnError ? "开" : "关"}`,
    ];
    if (latest.length) {
      lines.push("最近进化:");
      for (const l of latest.slice(0, 3)) {
        lines.push(`  ${l.runId} ${l.trigger} 准入 ${(l.applied || []).length} 张 (${l.ts})`);
      }
    }
    return lines.join("\n");
  },
};

const toolPatterns = {
  name: "recuris_patterns",
  description:
    "查看持久模式知识库(Recuris 的 Wiki 层, 借鉴 WikiSkill arXiv:2608.27454): 从失败与成功轨迹提炼的『失败模式+规避(别做什么) / 成功策略(该做什么)』, 永不回滚、跨进化迭代累积, 供技能提案复用并与卡双向追溯。可加 id 查看单模式全文(含引用卡)。",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "模式 id(缺省列出全部; 前缀可选 pat-)" },
    },
  },
  execute(args, exec) {
    const { cfg } = exec;
    const p = pathsOf(cfg);
    ensureDirs(p);
    if (!cfg.wikiEnabled) return "wiki 知识层已关闭(wikiEnabled: false)。";
    const pats = listPatterns(p);
    if (!pats.length) return "(尚无持久模式。每次 recuris_evolve 会由 Wiki Maintainer 自动提炼落盘。)\n模式目录: " + p.patterns;
    const want = args?.id ? String(args.id).replace(/^pat-/, "pat-") : null;
    const pick = want ? pats.filter((t) => t.id === want || t.id === "pat-" + want || t.name === want) : pats;
    if (want && !pick.length) return `未找到模式: ${want}(用 recuris_patterns 无参列出)`;
    return pick
      .map((t) =>
        want
          ? `# ${t.name} [${t.id}]` +
            (t.failure_mode ? `\n失败模式: ${t.failure_mode}\n规避: ${t.workaround || "(未写)"}` : "") +
            (t.strategy ? `\n成功策略: ${t.strategy}` : "") +
            `\n证据: ${(t.evidence || []).join("; ") || "(无)"}\n引用卡: ${t.cards?.join(", ") || "(无)"}\n创建: ${t.created} | 更新: ${t.updated}\n历史: ${(t.history || []).map((h) => `${h.runId}(${h.kind})`).join(" → ")}`
          : `[${t.id}] ${t.name} | ${t.failure_mode ? "触发: " + trimText(t.failure_mode, 60) : "策略: " + trimText(t.strategy, 60)} | 被 ${t.cards?.length || 0} 卡引用`,
      )
      .join(want ? "\n\n" : "\n");
  },
};

/**
 * 增强 2b: 演化统计视图 —— 汇总 ledger 回答"演化是否在收敛/变好"
 * (论文表 4 的工程近似: 模式数/卡增长/提案接受率/被拒分布)。
 */
function runStats(cfg) {
  const p = pathsOf(cfg);
  ensureDirs(p);
  const evos = listFiles(p.evolutions).filter((f) => f.endsWith(".jsonl"));
  const cards = listSkillCards(p);
  const pats = listPatterns(p);
  const stats = {
    evolutions: 0,
    manual: 0,
    auto: 0,
    verifyRuns: 0,
    proposals: 0,
    accepted: 0,
    rejected: 0,
    cardsTotal: cards.length,
    patternsTotal: pats.length,
    patternsWithStrategy: pats.filter((t) => t.strategy).length,
    recent: [],
  };
  const byRun = [];
  for (const f of evos) {
    const recs = readJsonl(join(p.evolutions, f), 100);
    for (const r of recs) {
      if (!r || !r.runId) continue;
      if (r.kind === "verify") {
        stats.verifyRuns += 1;
        continue;
      }
      stats.evolutions += 1;
      if (r.trigger?.includes("auto")) stats.auto += 1;
      else stats.manual += 1;
      const audit = Array.isArray(r.audit) ? r.audit : [];
      stats.proposals += audit.length;
      for (const a of audit) {
        if (a.accepted) stats.accepted += 1;
        else stats.rejected += 1;
      }
      byRun.push({
        runId: r.runId,
        ts: r.ts,
        trigger: r.trigger,
        proposed: audit.length,
        accepted: audit.filter((a) => a.accepted).length,
        rejected: audit.filter((a) => !a.accepted).length,
        cards: (r.applied || []).length,
      });
    }
  }
  byRun.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  stats.recent = byRun.slice(-5).reverse();
  const totalDecisions = stats.accepted + stats.rejected;
  stats.acceptRate = totalDecisions > 0 ? Math.round((stats.accepted / totalDecisions) * 100) : null;
  return stats;
}

const toolStats = {
  name: "recuris_stats",
  description:
    "演化统计视图(Recuris 趋势可见性): 汇总 evolutions ledger 与技能卡/模式库 —— 进化次数(手动/自动)、提案接受率、被拒数、卡/模式增长、模式中成功策略占比、最近 5 次演化。回答『这套进化是否在收敛/变好』。",
  parameters: { type: "object", properties: {} },
  execute(_args, exec) {
    const { cfg } = exec;
    const s = runStats(cfg);
    const lines = [
      `📊 Recuris 演化统计`,
      `进化运行: ${s.evolutions} 次 (手动 ${s.manual} / 自动 ${s.auto}) | verify 演练: ${s.verifyRuns}`,
      `提案: 共 ${s.proposals} | 接受 ${s.accepted} / 拒绝 ${s.rejected}` + (s.acceptRate !== null ? ` | 接受率 ${s.acceptRate}%` : ""),
      `技能卡: ${s.cardsTotal} 张 | 持久模式: ${s.patternsTotal} 条 (含成功策略 ${s.patternsWithStrategy} 条)`,
    ];
    if (s.recent.length) {
      lines.push("最近演化:");
      for (const r of s.recent) {
        lines.push(`  ${r.runId} ${r.ts?.slice(0, 16) || "?"} ${r.trigger} 提案 ${r.proposed} (✓${r.accepted}/✗${r.rejected}) 准入卡 ${r.cards}`);
      }
    } else {
      lines.push("(尚无演化记录; 长任务失败后调用 recuris_evolve 生成)");
    }
    if (s.rejected > 0) lines.push("提示: 被拒提案会注入下次演化证据, 避免重复提议(见 ledger audit)");
    return lines.join("\n");
  },
};

const TOOLS = [toolEvolve, toolWm, toolSkills, toolTrace, toolVerify, toolExport, toolPatterns, toolStats, toolStatus];

// ── 会话状态 ──
// liveAgents: sessionId -> agent; traces: sessionId -> { processed, failThisTurn }
const liveAgents = new Map();
const traceState = new Map();
const wmInjected = new WeakMap(); // agent -> turn
const sessionStartContexts = new Map(); // sessionId -> { wm, skills }

// ── 钩子 ──
function createHooks(ctx, cfg) {
  const p = pathsOf(cfg);
  ensureDirs(p);

  function sessionOf(agent) {
    return agent?.session?.header?.id;
  }

  function recordTurn(agent, turn) {
    const sessionId = sessionOf(agent);
    if (!sessionId) return;
    const events = agent?.session?.events;
    const st = traceState.get(sessionId) ?? { processed: 0, failTurn: null };
    const allTurns = compactTurns(events);
    const fresh = allTurns.slice(st.processed);
    st.processed = allTurns.length;
    const goals = ctx.get("goals");
    const goal = goalSnapshot(goals, agent);
    for (const t of fresh) {
      appendJsonl(join(p.traces, safeName(sessionId) + ".jsonl"), {
        t: turn,
        ts: nowIso(),
        w: { goal, note: readWmNote(p, sessionId).note || undefined },
        user: t.user,
        actions: t.actions || [],
        assistant: t.assistant || "",
        fail: st.failTurn === turn,
        error: st.failTurn === turn ? st.failError : undefined,
      });
    }
    if (cfg.wmEnabled) {
      const w = snapshotWorkingMemory(ctx, cfg, agent, sessionId, events);
      persistWm(p, sessionId, w, (fresh.flatMap((f) => f.actions || [])));
    }
    traceState.set(sessionId, st);
  }

  return {
    sessionStart({ agent }) {
      const sessionId = sessionOf(agent);
      if (sessionId) {
        liveAgents.set(sessionId, agent);
        seedRecurisContext(cfg, sessionId);
      }
    },
    async preStep({ agent, signal, step, turn }, next) {
      try {
        const decision = await next();
        if (decision?.kind !== "enter" || signal?.aborted) return decision;
        if (typeof step === "number" && step !== 1) return decision;
        const sessionId = sessionOf(agent);
        if (!sessionId) return decision;
        const blocks = [];
        // P0: 跨会话 WM + 技能卡(仅 step 1 注入, 独立于 wmInjected)
        const startCtx = sessionStartContexts.get(sessionId);
        if (startCtx) {
          sessionStartContexts.delete(sessionId);
          if (startCtx.wm) blocks.push(startCtx.wm);
          if (startCtx.skills) blocks.push(startCtx.skills);
        }
        // P1: 工作记忆(goal 快照 + manual note + 最近动作)
        if (cfg.injectWmEnabled) {
          if (wmInjected.get(agent) === turn) {
            // WM 已注入过, 但可能还有 session-start 内容要注入
            if (blocks.length) {
              return {
                kind: "enter",
                messages: [...decision.messages, {
                  id: randomUUID(),
                  role: "user",
                  content: [{ type: "text", text: blocks.join("\n\n") }],
                  source: { kind: "plugin", plugin: name, form: "session-start" },
                }],
              };
            }
            return decision;
          }
          wmInjected.set(agent, turn);
          const goals = ctx.get("goals");
          const goal = goalSnapshot(goals, agent);
          const note = readWmNote(p, sessionId);
          if (goal || note.objective || note.phase || note.note) {
            const traceTurns = compactTurns(agent?.session?.events).slice(-2);
            blocks.push(buildWmInjection(goal, note, traceTurns));
          }
        }
        // P4a: TTA 携带卡 —— 会话有失败标记且命中已有卡时注入教训
        if (cfg.ttaInjectEnabled) {
          const tta = ttaBlockFor(p, sessionId);
          if (tta) blocks.push(tta);
        }
        if (!blocks.length) return decision;
        return {
          kind: "enter",
          messages: [
            ...decision.messages,
            {
              id: randomUUID(),
              role: "user",
              content: [{ type: "text", text: blocks.join("\n\n") }],
              source: { kind: "plugin", plugin: name, form: "working-memory" },
            },
          ],
        };
      } catch (e) {
        return decision ?? { kind: "skip" };
      }
    },
    turnStopping({ agent, turn }) {
      try {
        const sessionId = sessionOf(agent);
        if (!sessionId) return;
        liveAgents.set(sessionId, agent);
        const st = traceState.get(sessionId) ?? { processed: 0, failTurn: null };
        if (st.failTurn !== turn) st.failTurn = null; // 新的正常轮次清除失败标记
        traceState.set(sessionId, st);
        if (cfg.traceEnabled) recordTurn(agent, turn);
      } catch {
        /* 静默 */
      }
    },
    agentError({ agent, turn, step, error }) {
      try {
        const sessionId = sessionOf(agent);
        if (!sessionId) return;
        const st = traceState.get(sessionId) ?? { processed: 0, failTurn: null };
        st.failTurn = turn;
        st.failError = trimText(String(error?.message || safeString(error)), 400);
        traceState.set(sessionId, st);
        // 失败轮轨迹在下一 turnStopping 落盘; 无下轮则由 disposed 兜底
        if (cfg.traceEnabled) recordTurn(agent, turn);
        maybeAutoEvolve(ctx, cfg, agent, turn, error);
      } catch {
        /* 静默 */
      }
    },
    disposed({ agent }) {
      const sessionId = sessionOf(agent);
      if (!sessionId) return;
      try {
        const st = traceState.get(sessionId);
        if (st?.failTurn != null) recordTurn(agent, st.failTurn); // 兜底落盘失败轮
      } catch {
        /* 静默 */
      }
      liveAgents.delete(sessionId);
      traceState.delete(sessionId);
      sessionStartContexts.delete(sessionId);
    },
  };
}

// ── 工具上下文: execute 收到 exec={ctx,cfg,agent,sessionId}(注册时闭包注入) ──

export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) return () => undefined;
  const pluginCtx = ctx;
  const hooks = createHooks(ctx, cfg);
  ctx.on("agent/session-start", hooks.sessionStart);
  ctx.on("agent/pre-step", hooks.preStep, { prepend: false });
  ctx.on("agent/turn-stopping", hooks.turnStopping);
  ctx.on("agent/error", hooks.agentError);
  ctx.on("agent/disposed", hooks.disposed);
  if (cfg.toolsEnabled) {
    // 注册同时走两条路径(Set 防重): ① ctx.inject 延迟注入(启动时 tools 未就绪)
    // ② ctx.get 立即注册(热载重组合时 tools 已在 ctx 上), 两种生命周期都不漏。
    const registered = new Set();
    const registerTools = (tc) => {
      for (const spec of TOOLS) {
        if (registered.has(spec.name)) continue;
        registered.add(spec.name);
        tc.tools.register({
          name: spec.name,
          description: spec.description,
          parameters: spec.parameters,
          output: {
            schema: { type: "string" },
            render: (_args, value) => [{ type: "text", text: value }],
          },
          execute(args, exec) {
            const agent = exec?.agent;
            return spec.execute(args ?? {}, {
              ctx: pluginCtx,
              cfg,
              agent,
              sessionId: agent?.session?.header?.id,
            });
          },
        });
      }
    };
    // P7 归属缓解(可选): tools 就绪后仍延迟 deferMs 再注册, 给 dsh-context
    // (inject sessionProjections) 先装 attribution hook 的机会; 超时兜底必注册。
    const defer = Math.max(0, Number(cfg.toolsDeferMs) || 0);
    ctx.inject(["tools"], (tc) => {
      if (defer <= 0) return registerTools(tc);
      const timer = setTimeout(() => {
        try {
          registerTools(tc);
        } catch (e) {
          if (ctx.logger?.warn) ctx.logger.warn(`recuris: 延迟注册工具失败: ${trimText(String(e?.message || e), 120)}`);
        }
      }, defer);
      timer.unref?.();
    });
    const existingTools = ctx.get("tools");
    if (existingTools) registerTools({ tools: existingTools });
  }
}

export default { name, inject: [], apply };

// ── 测试面(独立冒烟测试用; 生产加载不受影响) ──
export const __test = {
  gateChecks,
  extractJson,
  runEvolve,
  buildEvidence,
  pathsOf,
  resolveConfig,
  replayGate,
  buildCandidate,
  loadHeldOutTraces,
  applyPatch,
  repoBankId,
  renderSkillCardText,
  syncCardToHindsight,
  cardHitsFailure,
  matchCardsForFailure,
  renderTtaInjection,
  buildWmInjection,
  ttaBlockFor,
  runVerify,
  cardToSkillMd,
  runExport,
  runWikiMaintainer,
  listPatterns,
  readPattern,
  patternIdOf,
  upsertPattern,
  storePatterns,
  renderWiki,
  linkCardToPatterns,
  recentRejectedRuns,
  renderRejected,
  attachPersistentKnowledge,
  runStats,
};