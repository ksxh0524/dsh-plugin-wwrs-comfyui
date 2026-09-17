/** guard.ts —— dsh-plugin-wwrs-comfyui 写保护守卫注册薄壳（W0 空壳）。
 *
 * 真源在 ./lib/guard-predicate.ts（独立零依赖，见其头注）；本文件只做 ctx.tools.guard 挂载。
 * 注意：DSH Service 方法依赖 this，裸传会丢绑定——包一层闭包保绑定。
 */
import { comfyuiGuardPredicate } from "./lib/guard-predicate.ts";
import type { GuardFn, HostContext } from "./lib/host.ts";

export function registerComfyuiGuard(ctx: HostContext): () => void {
  const rawGuard = ctx.tools?.guard;
  if (typeof rawGuard !== "function") return () => {};
  const fn: GuardFn = (execution) => comfyuiGuardPredicate(execution);
  return rawGuard.call(ctx.tools, fn);
}
