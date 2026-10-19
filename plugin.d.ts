import type { Context } from "@deepseek-ai/cordis";

/** 插件配置(字段由 plugin.mjs 的 resolveConfig 收敛; 未列出的键保留索引签名兜底)。 */
export interface HindsightConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

export declare const name: "hindsight";

/** 依赖的宿主服务。 */
export declare const inject: readonly ["agents"];

export declare function apply(ctx: Context, config?: HindsightConfig): void;

/** 纯函数测试面(不依赖 DSH 运行时); 具体成员名单见 plugin.mjs 的导出对象。 */
export declare const __testing: Record<string, (...args: unknown[]) => unknown>;

declare const plugin: { name: typeof name; inject: typeof inject; apply: typeof apply };
export default plugin;
