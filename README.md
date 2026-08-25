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
  1. 环境设置: 不声明 OWN_BANK(harness 无独占库,global 即共享区)、不设
     DEFAULT_BANK(写路由默认位置快速路径: git→项目库, 非 git→global)
  2. 会话钩子: pre-step 调 `hs-memory inject`(自动模式) / turn-stopping 攒批
     调 `curate` / 会话结束调 `session-end`
  3. 工具: `hindsight_retain` / `hindsight_recall` / `hindsight_reflect` /
     `hindsight_status`,全部转调 `~/.hindsight/harness-memory.sh`

全部记忆逻辑(路由/感知/deny/密钥过滤/来源标注/策展/整合)由共享 CLI
hs-memory 承担,本插件不重复实现。

## 相关文件

- `<repo-root>/plugins/dsh-hindsight-adapt/plugin.mjs` — 本插件权威源码(统一仓库管理;`~/.hindsight/dsh-hindsight-adapt` 为符号链接指向此处)
- `~/.dsh/cordis.patch.yml` — `hindsight-adapt` 条目(独立标记区块)
- `~/.hindsight/coding-agent.json` — `harnesses.dsh.disabled: true`

## 生效时机

DSH 下次启动生效(插件在启动时加载)。

## 已知存量

`coding-agent::soft`(376 facts / 4 文档: 1 会话转录 + 2 correction + 1 笔记)
是历史碎片库,已不再写入;如要迁移其知识文档到 `coding-agent::global`,见
汇报中的迁移选项。
## 官方规范参考

- [打包与安装插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md) — Bundle/Profile 机制
- [插件配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md) — Config schema 定义
- [Cordis 入门](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.zh.md) — 核心概念与事件模式