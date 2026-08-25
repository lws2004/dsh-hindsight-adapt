// ═══════════════════════════════════════════════════════════════════
// DSH(DeepSeek Harness) Hindsight 薄适配层 — 本机统一约定
// 任务书: ~/.hindsight/AGENT-ADAPT-PROMPT.md | 约定: ~/.hindsight/README.md
//
// 分工原则(见 README): 全部共享逻辑(路由/感知/deny/来源标注/密钥过滤/
// 策展抽取/注入生成/整合/会话收尾)只存在于共享 CLI hs-memory 一份。
// 本插件只做三件事(DSH 独有部分):
//   1. 环境设置: 不声明 OWN_BANK(harness 无独占库, global 即共享区);
//      不设 DEFAULT_BANK —— 写路由默认走位置快速路径(git→项目库, 非 git→global)
//   2. 会话钩子: pre-step 调 hs-memory inject(自动模式) / turn-stopping 攒批
//      调 curate / 会话结束调 session-end
//   3. 工具层: retain/recall/reflect/status 全部转调 hs-memory
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
// DSH: 不声明 OWN_BANK、不设 DEFAULT_BANK —— hs-memory 默认即约定路由
const HS_ENV = { ...process.env };

// ── 会话行为配置(DSH 独有) ──
const CURATE_EVERY_N = 3; // 每 N 轮攒批调一次 curate; 设 0 关闭
const MAX_BUFFER_CHARS = 12000;

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

// ── 异步版: 注入/curate/收尾用(非阻塞, 绝不卡会话) ──
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

// ── 会话内状态 ──
const liveAgents = new Map(); // sessionId -> agent
const buffers = new Map(); // sessionId -> { turns: [{user,assistant}], processed: number }

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

function workspaceRoot(agent) {
  return agent?.session?.header?.cwd || process.cwd();
}

function renderTranscript(buffer) {
  return buffer.turns
    .map((t, i) => `[第${i + 1}轮]\n用户: ${t.user || "(空)"}\n助手: ${t.assistant || "(空)"}`)
    .join("\n\n");
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
    "语义搜索 Hindsight 记忆(经共享 CLI hs-memory, 自动多库合并并标注来源 [库名])。默认: 当前解析库 + coding-agent::global 合并(非 git 时即 global)。bankId: repo(仅项目库)/global(仅全局库)/all(全合并含感知到的其他 agent 库,只读)/显式库名。适合: 用户提到以前聊过的事、需要历史经验/踩坑记录。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "自然语言查询" },
      bankId: { type: "string", description: "检索范围: 默认合并; repo=项目库; global=全局库; all=全合并; 或显式库名(如 hermes)" },
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

// ── 会话钩子 ──
function createHooks() {
  return {
    sessionStart({ agent }) {
      const sessionId = agent?.session?.header?.id;
      if (sessionId) liveAgents.set(sessionId, agent);
    },
    async preStep({ agent, signal }, next) {
      const decision = await next();
      if (decision?.kind !== "enter" || signal?.aborted) return decision;
      const sessionId = agent?.session?.header?.id;
      if (!sessionId) return decision;
      liveAgents.set(sessionId, agent);
      const prompt = promptOf(decision.messages);
      if (!prompt) return decision;
      try {
        const r = await hsMemoryAsync(["inject", prompt], 20000); // 自动模式: 意图词→intent, 短消息不注入
        if (!r.ok || !r.out) return decision;
        const block = r.out
          .split("\n")
          .filter(Boolean)
          .slice(0, 8)
          .map((t, i) => `[记忆${i + 1}] ${t}`)
          .join("\n");
        const text = "## 相关长期记忆(Hindsight, 仅供参考, 若与当前事实冲突以当前为准)\n" + block;
        return { kind: "enter", messages: [...decision.messages, injectionMessage(text)] };
      } catch {
        return decision; // 静默失败, 绝不阻断对话
      }
    },
    turnStopping({ agent }) {
      const sessionId = agent?.session?.header?.id;
      if (!sessionId) return;
      try {
        const allTurns = readDshEvents(agent?.session?.events);
        const st = buffers.get(sessionId) ?? { turns: [], processed: 0 };
        // 本轮新增轮次(按 processed 游标)
        const fresh = allTurns.slice(st.processed);
        st.processed = allTurns.length;
        // 配对 user+assistant 追加到缓冲
        let user = "";
        for (const t of fresh) {
          if (t.role === "user") user = t.content;
          else if (t.role === "assistant" && user) {
            st.turns.push({ user, assistant: t.content });
            user = "";
          }
        }
        let total = st.turns.reduce((s, t) => s + t.user.length + t.assistant.length, 0);
        while (st.turns.length && total > MAX_BUFFER_CHARS) {
          total -= st.turns.shift().user.length + st.turns.shift().assistant.length; // shift 丢弃最早
        }
        buffers.set(sessionId, st);
        if (CURATE_EVERY_N <= 0 || st.turns.length < CURATE_EVERY_N) return;
        const batch = st.turns.splice(0, st.turns.length);
        const transcript = renderTranscript({ turns: batch });
        void hsMemoryAsync(["curate", transcript], 90000); // 静默失败(共享层已兜底过滤)
      } catch {
        /* 静默失败 */
      }
    },
    disposed({ agent }) {
      const sessionId = agent?.session?.header?.id;
      if (!sessionId) return;
      liveAgents.delete(sessionId);
      const st = buffers.get(sessionId);
      buffers.delete(sessionId);
      try {
        if (st && st.turns.length) {
          const transcript = renderTranscript(st);
          void hsMemoryAsync(["session-end", transcript], 90000);
        } else {
          void hsMemoryAsync(["session-end"], 60000);
        }
      } catch {
        /* 静默失败 */
      }
    },
  };
}

function toDshParameters(spec) {
  return spec.parameters;
}

export function apply(ctx) {
  const hooks = createHooks();
  ctx.on("agent/session-start", hooks.sessionStart);
  ctx.on("agent/pre-step", hooks.preStep, { prepend: true });
  ctx.on("agent/turn-stopping", hooks.turnStopping);
  ctx.on("agent/disposed", hooks.disposed);
  ctx.inject(["tools"], (toolCtx) => {
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
  });
}

export default { name, inject, apply };

