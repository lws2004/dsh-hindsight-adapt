import test from "node:test";
import assert from "node:assert/strict";
import { name, inject, apply, __testing } from "../plugin.mjs";

const { resolveConfig, stripInjectedMemory, isGenericQuery, renderTranscript, parseArgs } = __testing;

test("导出形状符合 cordis 插件规范", () => {
  assert.equal(name, "hindsight");
  assert.deepEqual(inject, ["agents"]);
  assert.equal(typeof apply, "function");
});

test("__testing 暴露纯函数测试面", () => {
  for (const fn of [resolveConfig, stripInjectedMemory, isGenericQuery, renderTranscript, parseArgs]) {
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
