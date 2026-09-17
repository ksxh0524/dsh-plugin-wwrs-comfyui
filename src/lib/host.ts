/** host.ts —— 宿主上下文最小结构类型（随工具落地扩展）。
 *
 * 只声明本包实际触达的面（tools 注册 + logger），不复述宿主全量类型；
 * 服务端零依赖铁律：此处不得 import 任何宿主协议包。
 * 工具形状与官方 defineTool 注册产物同形（name/description/parameters/output.render/execute）——
 * 本包零运行时依赖，不引 dsh-tools 包，字面量自构同形对象（写法照抄官方用法，只读不改）。
 */

export type GuardFn = (execution: { name: string; arguments: unknown }) => string | undefined;

/** 工具执行上下文（DSH 运行时实传；子集声明，按需窄化）。 */
export type ToolExec = {
  signal?: AbortSignal;
  onProgress?: (update: unknown) => void;
  agent?: unknown;
};

export type ToolRenderItem = { type: string; text: string };

/** 注册就绪的工具定义（官方 defineTool 产物同形：output 必带 render，缺则宿主 boot 期报）。 */
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
    additionalProperties?: boolean;
  };
  output: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => ToolRenderItem[];
  };
  execute: (args: unknown, exec: ToolExec) => Promise<unknown>;
};

export type ToolRecord = {
  name: string;
  [key: string]: unknown;
};

export type HostContext = {
  tools?: {
    register: (tool: ToolRecord) => unknown;
    guard?: (fn: GuardFn) => () => void;
  };
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
};
