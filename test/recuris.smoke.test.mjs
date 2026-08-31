// recuris.mjs 独立冒烟测试(mock LLM, 不依赖 harness)
// 运行: node test/recuris.smoke.test.mjs
// 覆盖: 轨迹落盘 / WM 卡 / 门控(确定性) / extractJson / 诊断→合并→落卡→ledger 全管线
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SCRIPT = join(import.meta.dirname, "..", "recuris.mjs");
const TMP = join(tmpdir(), "recuris-smoke-" + Date.now());

function runScript(payload) {
  // 以 node 子进程加载插件模块, 拿到纯函数导出
  const code = `
    import * as m from ${JSON.stringify(SCRIPT)};
    const payload = ${JSON.stringify(payload)};
    const out = await payload();
    process.stdout.write(JSON.stringify(out));
  `;
  return execFileSync("node", ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 60000 });
}

function fakeLlm(scripted) {
  let queue = [];
  return {
    script(answers) {
      queue = answers.map((a) => (typeof a === "string" ? a : JSON.stringify(a)));
    },
    async *stream(opts) {
      const text = queue.shift() ?? '{"component":"other","diagnosis":"mock","confidence":0}';
      if (typeof text === "object") yield { type: "text-delta", text: JSON.stringify(text) };
      else yield { type: "text-delta", text };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
}

// 直接 import 一次,构造最小 ctx 跑全管线
const mod = await import(SCRIPT);

const events = [
  { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "帮我修一个内存泄漏 bug" }] } },
  { type: "tool/call", data: { name: "bash", arguments: JSON.stringify({ command: "rg GC" }) } },
  { type: "assistant/message", data: { message: { content: [{ type: "text", text: "先看引用计数" }] } } },
  { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "还是崩了, 之前的补丁没生效" }] } },
  { type: "tool/call", data: { name: "edit", arguments: JSON.stringify({ file_path: "src/x.ts" }) } },
  { type: "assistant/message", data: { message: { content: [{ type: "text", text: "改完了再看日志" }] } } },
];
const agent = { session: { header: { id: "smoke-task" }, events } };

const cfg = {
  root: TMP,
  toolsEnabled: false,
  traceEnabled: true,
  wmEnabled: true,
  injectWmEnabled: true,
  metaProvider: "mock",
  metaModel: "mock",
  diagnosisWorkers: 3,
  regCap: 1,
  gateStrict: false,
  evolveTimeoutMs: 30000,
  evidenceTrajectoryTurns: 24,
  evidenceFailures: 2,
  evidenceRelatedMemories: false,
  evidenceSkills: 3,
  hindsightSync: false, // 主管线测试关闭真实同步(防污染 Hindsight); P3a 单独 mock 测
  hindsightApiBase: "http://fake-hindsight",
  hindsightSyncBank: "global",
  replayGateEnabled: true,
  replayHeldOutTasks: 2,
  wikiEnabled: true,     // P6: 持久模式知识层(测试开启)
  patternsMax: 4,
  auditEnabled: true,
};

const ctx = {
  get(k) {
    if (k === "llm") return llm;
    if (k === "goals") return { get: () => ({ objective: "修内存泄漏", phase: "active", revision: 1, completedRounds: 0, maxRounds: 5, armed: true }) };
    return undefined;
  },
  logger: { info() {}, warn() {} },
};
const llm = fakeLlm();
llm.script([
  // 3 个诊断 worker
  { component: "missing-knowledge", diagnosis: "缺少性能分析技能卡", observed_failures: ["补丁未生效", "内存持续增长"], confidence: 0.9 },
  { component: "missing-knowledge", diagnosis: "缺少性能分析技能卡", observed_failures: ["补丁未生效"], confidence: 0.8 },
  {
    card: {
      name: "内存泄漏定位与补丁验证",
      applicability: { domains: ["node"], when: "内存持续增长且补丁未生效时", when_not: "无泄漏迹象时" },
      steps: ["抓 heap snapshot 对比两次运行时对象增长", "用顶级调用方定位保留路径", "补丁后验证 RSS 稳定"],
      failure_modes: ["补丁未生效", "内存持续增长", "泄漏定位停留在猜测"],
    },
    rationale: "缺一张可复用卡",
    observed_failures: ["补丁未生效"],
  },
  // 合并器
  { patches: [{ kind: "new-card", targetCardId: null, card: { id: "memory-leak-debug", name: "内存泄漏定位与补丁验证", applicability: { domains: ["node"], when: "内存持续增长且补丁未生效时", when_not: "无泄漏迹象时" }, steps: ["抓 heap snapshot 对比两次运行时对象增长", "用顶级调用方定位保留路径", "补丁后验证 RSS 稳定"], failure_modes: ["补丁未生效", "内存持续增长", "泄漏定位停留在猜测"] }, rationale: "缺一张可复用卡" }] },
]);

// 1) 门控: 结构 + 覆盖度(确定性)
const goodCard = {
  id: "c1",
  name: "网络超时处理卡",
  applicability: { when: "调用远程服务出现超时限流时" },
  steps: ["第一步重试退避", "第二步降级缓存"],
  failure_modes: ["网络超时重试", "凭证过期"],
};
let gate = mod.__test?.gateChecks ? mod.__test.gateChecks(goodCard, { observed: ["网络超时重试"] }, false) : null;
assert.ok(gate === null || gate.passed, "goodCard 应过门控");

// 2) extractJson 容忍围栏
const fence = '```json\n{"patches":[]}\n```';
const parsed = mod.__test?.extractJson ? mod.__test.extractJson(fence) : null;
assert.ok(parsed === null || Array.isArray(parsed.patches), "extractJson 应剥围栏");

// 3) 全管线(约等于 recuris_evolve 工具体内逻辑)
// 先模拟钩子落盘轨迹(turnStopping 产物)
import { writeFileSync } from "node:fs";
mkdirSync(join(TMP, "trajectories"), { recursive: true });
writeFileSync(
  join(TMP, "trajectories", "smoke-task.jsonl"),
  [
    JSON.stringify({ t: 1, ts: new Date().toISOString(), user: "帮我修内存泄漏 bug", actions: ["bash rg GC"], assistant: "先看引用计数", fail: false }),
    JSON.stringify({ t: 2, ts: new Date().toISOString(), user: "还是崩了, 补丁没生效", actions: ["edit src/x.ts"], assistant: "改完再看日志", fail: true, error: "补丁未生效" }),
  ].join("\n") + "\n",
  "utf8",
);

const llm2 = fakeLlm();
llm2.script([
  // P6: Wiki Maintainer(先于诊断, 提炼持久模式: 失败模式 + 成功策略)
  { patterns: [
    { name: "性能问题先抓基线", failure_mode: "补丁未生效", workaround: "先抓基线指标再归因, 避免猜测定位", strategy: "补丁前先跑基准, 补丁后同口径对比验证", evidence: "smoke-task 失败轨迹" },
  ] },
  { component: "missing-knowledge", diagnosis: "缺性能分析技能卡", observed_failures: ["补丁未生效"], confidence: 0.9 },
  { component: "missing-knowledge", diagnosis: "缺性能分析技能卡", observed_failures: ["补丁未生效"], confidence: 0.8 },
  { card: null, rationale: "无", observed_failures: [] },
  { patches: [{ kind: "new-card", targetCardId: null, card: { id: "perf-triage", name: "性能问题快速定位", applicability: { domains: ["node"], when: "遇到性能/内存问题时", when_not: "正常时" }, steps: ["先抓基线指标", "再对比变化", "最后定根因补丁"], failure_modes: ["补丁未生效", "无法复现"] }, rationale: "缺卡" }] },
]);
const ctx2 = { ...ctx, get: (k) => (k === "llm" ? llm2 : ctx.get(k)) };
const result = await mod.__test.runEvolve(ctx2, cfg, agent, "smoke-task", { failure: "内存泄漏补丁未生效" });

assert.deepEqual(result.applied.length, 1, "应准入 1 张卡(regCap)");
const cardFile = join(TMP, "skills", "perf-triage.json");
assert.ok(existsSync(cardFile), "技能卡应落盘");
const card = JSON.parse(readFileSync(cardFile, "utf8"));
assert.equal(card.steps.length, 3, "卡步骤应完整");
assert.ok(card.gate?.checks?.length > 0, "卡应记录门控检查");
assert.equal(card.failure_modes.includes("补丁未生效"), true, "失败模式应含观察到的失败");

// 4) 轨迹与 ledger 已生成, 证据确实读到了轨迹
assert.ok(existsSync(join(TMP, "trajectories", "smoke-task.jsonl")), "轨迹文件存在(钩子产物)");
assert.ok(existsSync(join(TMP, "evolutions", result.runId + ".jsonl")), "ledger 存在");
assert.ok(result.ledger.evidence.turnCount > 0, "进化证据应包含轨迹");
assert.equal(result.ev.observed.includes("补丁未生效"), true, "失败观察应进入证据");

// 5) leder 内容抽查
const ledger = JSON.parse(readFileSync(join(TMP, "evolutions", result.runId + ".jsonl"), "utf8"));
assert.equal(ledger.trigger, "manual");
assert.equal(ledger.applied.length, 1);
assert.equal(ledger.patches.length, 1);
assert.equal(ledger.syncs.length, 1, "同步记录应有一条(skipped, 可审计)");
assert.equal(ledger.syncs[0].skipped, true, "hindsightSync 关闭时应标记 skipped");
assert.ok(card.gate.checks.some((c) => c.name === "replay"), "无留出时 replay check 应并入门控(no-held-out)");

// 6) P3b: 回放式门控三态(确定性)
const rel = mod.__test;
// 构造留出失败任务(动作含 bash/edit)
mkdirSync(join(TMP, "trajectories"), { recursive: true });
writeFileSync(
  join(TMP, "trajectories", "heldout-a.jsonl"),
  [
    JSON.stringify({ t: 1, user: "加载卡", actions: ["bash npm i"], assistant: "安装中", fail: false }),
    JSON.stringify({ t: 2, user: "还是失败", actions: ["edit pkg.json"], assistant: "改依赖", fail: true, error: "补丁未生效 启动崩溃 依赖缺失" }),
  ].join("\n") + "\n",
  "utf8",
);
const heldOut = rel.loadHeldOutTraces(mod.__test.pathsOf(cfg), "smoke-task", 2);
assert.ok(heldOut.length >= 1, "应发现留出失败轨迹");
const rpOk = rel.replayGate(card, heldOut, { gateStrict: false });
assert.equal(rpOk.ok, true, "卡覆盖留出失败模式(动作/词重叠)应放行");
assert.equal(rpOk.checks[0].name, "replay");
const rpEmptyLoose = rel.replayGate(card, [], { gateStrict: false });
assert.equal(rpEmptyLoose.ok, true, "无留出样本非严格档放行");
const rpEmptyStrict = rel.replayGate(card, [], { gateStrict: true });
assert.equal(rpEmptyStrict.ok, false, "无留出样本严格档拒绝");

// 7) P3a: 准入卡 → Hindsight 同步(mock fetch 断言写入口同构)
let captured = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  captured = { url: String(url), body: JSON.parse(String(init?.body)) };
  return { ok: true, status: 200 };
};
try {
  const sync = await rel.syncCardToHindsight({ ...cfg, hindsightSync: true }, undefined /* 非 git cwd → 回落 global */, card, "evo-test");
  assert.equal(sync.ok, true);
  assert.equal(sync.bankId, "coding-agent::global", "非 git cwd 回落全局库");
  assert.ok(captured.url.includes("/v1/default/banks/coding-agent%3A%3Aglobal/memories"), "REST 写入口与 skill-crystallize 同构");
  const item = captured.body.items[0];
  assert.ok(item.context.includes("type:skill"), "context 标记 type=skill(供 recall --types skill 召回)");
  assert.equal(item.document_id, "card-" + card.id, "doc_id=card-<id> 同主题覆盖");
  assert.ok(item.tags.includes("recuris"));
  assert.ok(item.content.includes(card.name) && item.content.includes(card.steps[0]), "content 为卡全文");
} finally {
  globalThis.fetch = realFetch;
}

// 8) patch-card: 只改目标卡, version+1, history 追加
const m = mod.__test;
const p2 = m.pathsOf(cfg);
const pNew = { kind: "new-card", targetCardId: null, card: { id: "patch-me", name: "初始卡", applicability: { when: "某场景出现时" }, steps: ["先做一步验证"], failure_modes: ["旧问题复现"] } };
const rNew = m.applyPatch(p2, "r1", "t1", "补丁未生效", pNew, false, null);
assert.ok(rNew.applied, "new-card 应准入: " + rNew.reason);
const pPatch = { kind: "patch-card", targetCardId: "patch-me", card: { failure_modes: ["旧问题复现", "新边界条件"], steps: ["先做一步验证", "补丁后回归测试"] } };
const rPatch = m.applyPatch(p2, "r2", "t1", "回归不过", pPatch, false, null);
assert.ok(rPatch.applied, "patch-card 应准入: " + rPatch.reason);
assert.equal(rPatch.applied.card.version, 2, "版本应 +1");
assert.equal(rPatch.applied.card.history.length, 2, "history 应追加一条");
const pMiss = { kind: "patch-card", targetCardId: "no-such", card: { failure_modes: ["x"] } };
const rMiss = m.applyPatch(p2, "r3", "t1", "x", pMiss, false, null);
assert.equal(rMiss.applied, null, "目标卡不存在应跳过");

// 9) P4a: TTA 携带卡 —— 失败文本命中卡 + 注入块形状
const rel4 = mod.__test;
const failTextC = "补丁未生效 启动崩溃 依赖缺失";
const ttaCards = rel4.matchCardsForFailure([card], failTextC, 2);
assert.equal(ttaCards.length, 1, "中文失败文本应命中卡(全串包含)");
assert.equal(rel4.cardHitsFailure(card, "PATCH didn't apply, memory keeps growing").hit, false, "不相关文本不应命中");
const inj = rel4.renderTtaInjection(ttaCards, [{ error: failTextC }]);
assert.ok(inj.includes("## 任务经验卡"), "注入块应含任务经验卡标题");
assert.ok(inj.includes(card.name), "注入块应含卡名");
const ttaFromDir = rel4.ttaBlockFor(mod.__test.pathsOf(cfg), "smoke-task"); // smoke-task 轨迹含 fail
assert.ok(ttaFromDir && ttaFromDir.includes("任务经验卡"), "ttaBlockFor 应从目录命中卡生成注入块");
// 无失败任务 → 无注入
assert.equal(rel4.ttaBlockFor(mod.__test.pathsOf(cfg), "no-such-session"), null, "无轨迹会话不应注入");

// 10) P4b: runVerify 演练闭环(mock llm → 卡 verifications + verify ledger)
const llm3 = fakeLlm();
llm3.script([
  { would_avoid: true, replayed_steps: ["先抓基线指标", "按卡定位保留路径", "补丁后验证"], reasons: ["按卡步骤能先确认根因", "验证步骤防回归"], remaining_risk: "数据规模更大的场景未覆盖" },
]);
const ctx3 = { ...ctx, get: (k) => (k === "llm" ? llm3 : ctx.get(k)) };
const vr = await rel4.runVerify(ctx3, cfg, "smoke-task", { taskId: "smoke-task" });
assert.equal(vr.ok, true, "演练应成功");
assert.equal(vr.cardId, card.id);
assert.equal(vr.v.wouldAvoid, true);
assert.ok(vr.v.steps.length >= 1 && vr.v.reasons.length >= 1, "演练应有步骤与理由");
const cardAfter = JSON.parse(readFileSync(cardFile, "utf8"));
assert.ok(Array.isArray(cardAfter.verifications) && cardAfter.verifications.length === 1, "卡 verifications 应追加一条");
assert.equal(cardAfter.verifications[0].runId, vr.runId);
assert.ok(existsSync(join(TMP, "evolutions", vr.runId + ".jsonl")), "verify ledger 应存在");
const vrLedger = JSON.parse(readFileSync(join(TMP, "evolutions", vr.runId + ".jsonl"), "utf8"));
assert.equal(vrLedger.kind, "verify");
// 无失败轨迹任务 → 报错不崩
const vrBad = await rel4.runVerify(ctx3, cfg, "no-fail-task", { taskId: "no-fail-task" });
assert.equal(vrBad.ok, false, "无失败轨迹应拒绝");

// 11) P5: 卡 → SKILL.md 全局技能导出
const rel5 = mod.__test;
const EXPORT_ROOT = join(TMP, "export-skills");
const expCfg = { ...cfg, exportRoot: EXPORT_ROOT };
const md = rel5.cardToSkillMd(card);
assert.ok(md.startsWith("---\nname: " + card.id), "应生成 frontmatter name");
assert.ok(md.includes("description: >"), "应有折叠块 description");
assert.ok(md.includes("## 操作步骤") && md.includes(card.steps[0]), "正文应含步骤");
assert.ok(md.includes("## 避坑") && md.includes(card.failure_modes[0]), "正文应含失败模式");
assert.ok(md.includes("runId:") && md.includes("## 来源"), "正文应含来源");
// dryRun 预览: 不写盘
const dry = rel5.runExport(expCfg, { dryRun: "true" });
assert.equal(dry.ok, true);
assert.equal(dry.dryRun, true);
assert.ok(dry.planned.some((p) => p.slug === card.id), "dryRun 应列出将导出的卡");
assert.ok(!existsSync(join(EXPORT_ROOT, card.id, "SKILL.md")), "dryRun 不应写盘");
// 真正写盘
const real = rel5.runExport(expCfg, { dryRun: "false" });
assert.ok(real.written.some((w) => w.slug === card.id), "应写盘 " + card.id);
assert.ok(existsSync(join(EXPORT_ROOT, card.id, "SKILL.md")), "SKILL.md 文件应存在");
// 同名跳过(重跑)
const again = rel5.runExport(expCfg, { dryRun: "false" });
assert.ok(again.skipped.some((s) => s.slug === card.id), "同名再次导出应跳过");
// 准入过滤: soft 卡默认不导, force 导
const softCard = { ...card, id: "soft-card", gate: { status: "soft", checks: [] }, verifications: [] };
writeFileSync(join(TMP, "skills", "soft-card.json"), JSON.stringify(softCard), "utf8");
const noForce = rel5.runExport(expCfg, { dryRun: "true", cardId: "soft-card" });
assert.ok(noForce.eligible === 0, "soft 卡默认不应可导");
const withForce = rel5.runExport(expCfg, { dryRun: "true", cardId: "soft-card", force: "true" });
assert.ok(withForce.eligible === 1, "force=true 应允许 soft 卡");
// minVerifications 过滤: 卡(1 条正向)满足 N=1; soft 卡(0 条)不满足
const minV = rel5.runExport(expCfg, { dryRun: "true", minVerifications: "1" });
assert.ok(minV.selected >= 1, "有正向演练的卡应通过 minVerifications=1");
const softMinV = rel5.runExport(expCfg, { dryRun: "true", cardId: "soft-card", force: "true", minVerifications: "1" });
assert.equal(softMinV.selected, 0, "无正向演练的 soft 卡不应通过 minVerifications=1");

// 12) P6: 持久模式知识层(Wiki Layer) + 提案审计 + 卡↔模式追溯
const rel6 = mod.__test;
// 12a. 主管线已自动落盘模式(由 mock Wiki Maintainer 返回)
const pats = rel6.listPatterns(m.pathsOf(cfg));
assert.ok(pats.length >= 1, "Wiki Maintainer 应落盘持久模式, 实得 " + pats.length);
assert.equal(pats[0].workaround.includes("先抓基线"), true, "模式应含可操作 workaround");
assert.ok(existsSync(join(TMP, "patterns")), "patterns 目录应存在");
// 12b. 卡应带 purpose.patternIds 反向追溯
const cardAfterEvolve = JSON.parse(readFileSync(cardFile, "utf8"));
assert.ok(Array.isArray(cardAfterEvolve.purpose?.patternIds) && cardAfterEvolve.purpose.patternIds.length >= 1, "卡应通过 failure_modes 关联持久模式(PURPOSE 追溯)");
assert.ok(pats[0].cards?.includes(card.id), "模式应反向索引引用卡");
// 12c. ledger 完整审计(diff + 接受/拒绝 + 门控)
const evoLedger = JSON.parse(readFileSync(join(TMP, "evolutions", result.runId + ".jsonl"), "utf8"));
assert.ok(Array.isArray(evoLedger.audit) && evoLedger.audit.length >= 1, "ledger 应有提案审计");
const audit0 = evoLedger.audit[0];
assert.equal(audit0.kind, "new-card");
assert.equal(audit0.accepted, true, "mock 卡应被接受");
assert.ok(audit0.diff.includes("perf-triage"), "审计应记录提案 diff");
assert.equal(audit0.gateStatus, "passed");
assert.ok(evoLedger.wiki?.maintained === true, "ledger 应记录 wiki 维护");
assert.equal(evoLedger.wiki.patternsStored >= 1, true, "ledger 应记录模式落盘数");
assert.ok(evoLedger.applied[0].purpose?.length >= 1, "applied 摘要应含 purpose 追溯");
// 12d. upsertPattern 合并: 同 id 二次落盘应合并而非覆盖(永不回滚)
const p6 = m.pathsOf(cfg);
const first = rel6.upsertPattern(p6, "超时重试", "网络超时", "退避重试", "超时后切换到降级路径", "证据1", "r-a");
assert.equal(first.cards.length, 0);
assert.equal(first.evidence.length, 1);
assert.equal(first.strategy, "超时后切换到降级路径", "模式应含成功策略字段");
const second = rel6.upsertPattern(p6, "超时重试", "网络超时", "退避重试+降级", "超时后切换降级并记录日志", "证据2", "r-b");
assert.equal(second.id, first.id, "同模式名应合并同一 id");
assert.equal(second.workaround, "退避重试+降级", "workaround 应被新值更新");
assert.equal(second.strategy, "超时后切换降级并记录日志", "strategy 应被新值更新");
assert.deepEqual(second.evidence, ["证据1", "证据2"], "证据应追加保留(不丢失历史)");
assert.equal(second.history.length, 2, "history 应记录两次演化");
// 12e. 被拒提案审计: 构造一条 rejected ledger, next 演化应能看到
writeFileSync(
  join(TMP, "evolutions", "evo-rejected.jsonl"),
  JSON.stringify({ runId: "evo-rejected", audit: [{ i: 0, kind: "patch-card", targetCardId: "x", cardName: "错误方案", diff: "steps: [强杀进程]", accepted: false, rejectReason: "门控拒绝(coverage)", gateStatus: null }] }) + "\n",
  "utf8",
);
const rejected = rel6.recentRejectedRuns(m.pathsOf(cfg), 3);
assert.ok(rejected.length >= 1, "应能从 ledger 提取被拒提案");
assert.equal(rejected[0].runId, "evo-rejected");
const rejectedText = rel6.renderRejected(rejected);
assert.ok(rejectedText.includes("错误方案") && rejectedText.includes("门控拒绝"), "被拒提案摘要应含卡名与原因");
const attached = rel6.attachPersistentKnowledge(m.pathsOf(cfg), cfg, {});
assert.ok(attached.wiki.includes("超时重试"), "attachPersistentKnowledge 应注入 wiki 摘要");
assert.ok(attached.rejected.includes("错误方案"), "attachPersistentKnowledge 应注入被拒提案");
// 12f. skills 详情视图应展示 purpose; status 应展示 wiki 计数
const p6dir = mod.__test.pathsOf(cfg);
const cardDetailView = mod.__test?.renderSkillCardText ? mod.__test.renderSkillCardText(cardAfterEvolve) : "";
assert.ok(cardDetailView.includes("源自持久模式"), "卡文本应含 PURPOSE 追溯");
// 12g. 模式 id 为 ASCII+hash(安全落盘, 中文名不撞文件)且同一名字跨迭代稳定
const idA = rel6.patternIdOf("补丁验证先看基线");
assert.ok(/^pat-[a-z0-9-]+-[0-9a-f]{8}$/.test(idA), "id 应 ASCII 安全: " + idA);
assert.equal(rel6.patternIdOf("补丁验证先看基线"), idA, "同模式名应生成稳定 id");
assert.notEqual(rel6.patternIdOf("网络超时重试策略"), idA, "不同模式名应生成不同 id");
assert.ok(!idA.includes("_"), "id 不应含下划线(直接可作文件名)");
// 12h. 成功策略(增强 1b): 主管线模式应含 strategy, 且 renderWiki/视图呈现
const patAfter = rel6.listPatterns(m.pathsOf(cfg))[0];
assert.ok(patAfter.strategy?.includes("基准"), "Wiki Maintainer 应提炼成功策略(strategy)");
const wikiView = rel6.renderWiki(m.pathsOf(cfg));
assert.ok(wikiView.includes("成功策略") && wikiView.includes("基准"), "renderWiki 应呈现成功策略");
// 12i. 演化统计视图(增强 2b): 汇总 ledger 的提案/接受/模式统计
// 注意: 12e 已构造 evo-rejected.jsonl(1 条被拒提案), 统计应反映两者
const stats = rel6.runStats(cfg);
assert.equal(stats.evolutions, 2, "应统计到 2 次进化(本轮 + evo-rejected)");
assert.equal(stats.proposals, 2, "提案总数=2");
assert.equal(stats.accepted, 1, "接受=1");
assert.equal(stats.rejected, 1, "拒绝=1(来自 12e 构造的 evo-rejected)");
assert.equal(stats.acceptRate, 50, "接受率=50%");
assert.equal(stats.cardsTotal, 3, "技能卡统计=3(perf-triage + patch-me + soft-card)");
assert.equal(stats.patternsTotal, rel6.listPatterns(m.pathsOf(cfg)).length, "模式统计与库一致");
assert.ok(stats.patternsWithStrategy >= 1, "含成功策略的模式应被统计");
assert.ok(stats.recent.some((r) => r.runId === result.runId), "最近演化列表应包含本轮 runId");

console.log("✅ 冒烟测试全部通过");
console.log("   runId:", result.runId);
console.log("   卡:", card.id, "v" + card.version, "门控:", card.gate.status);
console.log("   回放:", rpOk.hits + "/" + rpOk.total, "| 同步写入口: mock 验证通过");
console.log("   TTA 携带卡:", ttaCards.map((c) => c.id).join(","), "| 演练:", vr.v.wouldAvoid ? "可避免" : "不可避免");
console.log("   SKILL.md 导出: dryRun ✓ 落盘 ✓ 同名跳过 ✓ soft 过滤 ✓ minVerifications ✓");

rmSync(TMP, { recursive: true, force: true });