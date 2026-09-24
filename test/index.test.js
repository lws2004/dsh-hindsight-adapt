import test from "node:test";
import assert from "node:assert/strict";
import { name, inject, apply, __testing } from "../plugin.mjs";

const { resolveConfig, stripInjectedMemory, isGenericQuery, renderTranscript, parseArgs, knowledgeRosterBlock, selectTools } = __testing;

test("导出形状符合 cordis 插件规范", () => {
  assert.equal(name, "hindsight");
  assert.deepEqual(inject, ["agents"]);
  assert.equal(typeof apply, "function");
});

test("__testing 暴露纯函数测试面", () => {
  for (const fn of [resolveConfig, stripInjectedMemory, isGenericQuery, renderTranscript, parseArgs, knowledgeRosterBlock, selectTools]) {
    assert.equal(typeof fn, "function");
  }
});

test("resolveConfig:空配置落到文档化的默认值", () => {
  const c = resolveConfig({});
  assert.equal(c.enabled, true);
  assert.equal(c.injectEnabled, true);
  assert.equal(c.curateEveryN, 3);
  assert.equal(c.sessionStartRecall, false);
  assert.equal(c.sessionStartRecallScope, "current");
  assert.equal(c.sessionStartRecallGenericMode, "skip");
  assert.equal(c.sessionStartRecallGraceMs, 800);
});

test("resolveConfig:数字型配置非法值回落默认(不产生 NaN 超时)", () => {
  assert.equal(resolveConfig({ curateEveryN: "5" }).curateEveryN, 5);
  assert.equal(resolveConfig({ curateEveryN: "abc" }).curateEveryN, 3);
  assert.equal(resolveConfig({ curateEveryN: -1 }).curateEveryN, 3);
  assert.equal(resolveConfig({ curateEveryN: NaN }).curateEveryN, 3);
});

test("resolveConfig:布尔开关只在显式 false 时关闭", () => {
  assert.equal(resolveConfig({ enabled: false }).enabled, false);
  assert.equal(resolveConfig({ enabled: 0 }).enabled, true, "非 false 值按开启处理");
  assert.equal(resolveConfig({ sessionStartRecall: false }).sessionStartRecall, false);
});

test("resolveConfig:枚举型配置非法值回落默认", () => {
  assert.equal(resolveConfig({ sessionStartRecallScope: "global" }).sessionStartRecallScope, "global");
  assert.equal(resolveConfig({ sessionStartRecallScope: "all" }).sessionStartRecallScope, "all", "all 由调用侧降级为 project,此处不拦");
  assert.equal(resolveConfig({ sessionStartRecallGenericMode: "bogus" }).sessionStartRecallGenericMode, "skip");
  assert.equal(resolveConfig({ sessionStartRecallGenericMode: "tighten" }).sessionStartRecallGenericMode, "tighten");
});

test("stripInjectedMemory:剔除历史注入块,保留真实内容", () => {
  const raw = "问题正文\n<hindsight_memory>注入的旧记忆</hindsight_memory>\n<system-reminder>提醒</system-reminder>\n结论";
  const cleaned = stripInjectedMemory(raw);
  assert.ok(cleaned.includes("问题正文"));
  assert.ok(cleaned.includes("结论"));
  assert.ok(!cleaned.includes("注入的旧记忆"));
  assert.ok(!cleaned.includes("提醒"));
  assert.equal(stripInjectedMemory(undefined), "");
});

test("isGenericQuery:疑问句/领域实体判为具体", () => {
  assert.equal(isGenericQuery("帮我看看插件召回为什么慢"), false);
  assert.equal(isGenericQuery("优化 dsh plugin 的召回延迟"), false);
  assert.equal(isGenericQuery("hindsight 的 bank 怎么配"), false);
});

test("isGenericQuery:剥壳后信息量不足判为泛化", () => {
  assert.equal(isGenericQuery(""), true);
  assert.equal(isGenericQuery("推荐一部好看的科幻电影"), true);
  assert.equal(isGenericQuery("帮我写一个脚本"), true);
  assert.equal(isGenericQuery("介绍下这个项目的记忆机制设计取舍"), false, "剥壳后仍有足够信息量");
});

test("renderTranscript:轮次/用户/工具/助手成段落", () => {
  const text = renderTranscript({ turns: [{ user: "问题", actions: ["read a.ts"], assistant: "回答" }] });
  assert.ok(text.includes("[第1轮]"));
  assert.ok(text.includes("用户: 问题"));
  assert.ok(text.includes("工具: read a.ts"));
  assert.ok(text.includes("助手: 回答"));
});

test("renderTranscript:空轮次字段用占位符而不是 undefined", () => {
  const text = renderTranscript({ turns: [{ user: "", actions: [], assistant: "" }] });
  assert.ok(text.includes("用户: (空)"));
  assert.ok(text.includes("助手: (空)"));
  assert.ok(!text.includes("undefined"));
});

test("parseArgs:合法 JSON 解析成对象,非法原样返回", () => {
  assert.deepEqual(parseArgs('{"a":1}'), { a: 1 });
  assert.equal(parseArgs("not json"), "not json");
});
test("resolveConfig:知识页开关与数值默认值", () => {
  const c = resolveConfig({});
  assert.equal(c.knowledgePagesEnabled, true);
  assert.equal(c.knowledgePagesInject, true);
  assert.equal(c.knowledgePagesRosterMax, 8);
  assert.equal(c.knowledgePagesTimeoutMs, 15000);
  assert.equal(c.knowledgePagesGraceMs, 800);
  assert.equal(resolveConfig({ knowledgePagesInject: false }).knowledgePagesInject, false);
  assert.equal(resolveConfig({ knowledgePagesRosterMax: "abc" }).knowledgePagesRosterMax, 8);
  assert.equal(resolveConfig({ knowledgePagesRosterMax: "3" }).knowledgePagesRosterMax, 3);
});

test("knowledgeRosterBlock:解析页目录并附读取指引", () => {
  const out = [
    "[coding-agent::dsh-harness] 知识页 2 个(读整页: hs-memory pages read <id>):",
    "- Component map (kp-1) [待重建] — 组件与职责",
    "- Conventions and patterns (kp-2) — 约定与模式",
  ].join("\n");
  const block = knowledgeRosterBlock(out, 8);
  assert.ok(block.includes("<hindsight_knowledge>"));
  assert.ok(block.includes("Component map (kp-1)"));
  assert.ok(block.includes("hindsight_read_knowledge_page"));
  assert.ok(block.endsWith("</hindsight_knowledge>"));
});

test("knowledgeRosterBlock:空目录/缺失输入不注入", () => {
  assert.equal(knowledgeRosterBlock("[coding-agent::global] 暂无知识页(Hindsight 仍在学习本仓库, 处理后会自行出现)"), null);
  assert.equal(knowledgeRosterBlock(""), null);
  assert.equal(knowledgeRosterBlock(undefined), null);
});

test("knowledgeRosterBlock:超出上限截断并提示剩余页数", () => {
  const lines = ["[bank] 知识页 3 个(读整页: hs-memory pages read <id>):"];
  for (let i = 1; i <= 3; i++) lines.push("- Page " + i + " (kp-" + i + ") — d");
  const block = knowledgeRosterBlock(lines.join("\n"), 2);
  assert.ok(block.includes("Page 1"));
  assert.ok(block.includes("Page 2"));
  assert.ok(!block.includes("Page 3 (kp-3)"));
  assert.ok(block.includes("另有 1 页"));
});

test("selectTools:知识页开关关闭时不下发知识页工具", () => {
  const on = selectTools({ knowledgePagesEnabled: true }).map((t) => t.name);
  const off = selectTools({ knowledgePagesEnabled: false }).map((t) => t.name);
  assert.deepEqual(on, ["hindsight_retain", "hindsight_recall", "hindsight_reflect", "hindsight_status", "hindsight_list_knowledge_pages", "hindsight_search_knowledge_pages", "hindsight_read_knowledge_page"]);
  assert.deepEqual(off, ["hindsight_retain", "hindsight_recall", "hindsight_reflect", "hindsight_status"]);
});

test("stripInjectedMemory:知识页注入块不进转录", () => {
  const raw = "问题\n<hindsight_knowledge>\n## 项目知识页\n- x\n</hindsight_knowledge>\n回答";
  const cleaned = stripInjectedMemory(raw);
  assert.ok(cleaned.includes("问题") && cleaned.includes("回答"));
  assert.ok(!cleaned.includes("项目知识页"));
});
