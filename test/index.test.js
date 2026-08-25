import test from "node:test";
import assert from "node:assert/strict";
import { name, inject } from "../plugin.mjs";

test("导出形状符合 cordis 插件规范", () => {
  assert.equal(name, "hindsight");
  assert.deepEqual(inject, ["agents"]);
});
