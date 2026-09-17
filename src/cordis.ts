/** cordis.ts —— dsh-plugin-wwrs-comfyui 挂载适配层（W0 空壳；官方插件形：default={name,inject,apply} 对象）。
 *
 * 注册面（W1 落地）：comfy_submit / comfy_status / comfy_wait / comfy_cancel / comfy_templates → ctx.tools.register；写保护守卫 → ctx.tools.guard（谓词真源见 lib/guard-predicate.ts）。
 * 行名与包名对齐（dsh-plugin-wwrs-comfyui）；改名必同步 package.json 与 cordis.patch.yml。
 */

import { registerComfyuiGuard } from "./guard.ts";
import type { HostContext } from "./lib/host.ts";

export const name = "dsh-plugin-wwrs-comfyui";
export const inject: string[] = ["tools"];

export type CordisConfig = {
  /** 工作区根（profile patch 行 config.workspace=<绝对路径>；缺省 env WWRS_WORKSPACE，再缺省中性锚探测）。 */
  workspace?: string;
  /** 远端 ComfyUI 基地址（缺省 env COMFYUI_BASE_URL，缺失即 fail-loud）。 */
  comfyuiBaseUrl?: string;
};

export function apply(ctx: HostContext, config?: CordisConfig) {
  const unregister = registerComfyuiGuard(ctx);
  ctx.logger?.info?.(
    `[dsh-plugin-wwrs-comfyui] shell on（workspace=${config?.workspace ?? "(env WWRS_WORKSPACE/中性锚探测)"} guard=${typeof unregister === "function" ? "on" : "no-hook"}；工具在 W1 落地）`,
  );
  return { unregister };
}

export default { name, inject, apply };
