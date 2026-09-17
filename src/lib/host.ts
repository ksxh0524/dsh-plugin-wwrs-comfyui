/** host.ts —— 宿主上下文最小结构类型（W0 空壳；随工具落地扩展）。
 *
 * 只声明本包实际触达的面（tools 注册 + logger），不复述宿主全量类型；
 * 服务端零依赖铁律：此处不得 import 任何宿主协议包。
 */

export type ToolRecord = {
  name: string;
  [key: string]: unknown;
};

export type GuardFn = (execution: { name: string; arguments: unknown }) => string | undefined;

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
