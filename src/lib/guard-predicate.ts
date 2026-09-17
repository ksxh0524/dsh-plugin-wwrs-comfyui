/** comfyui-guard.ts —— 写保护守卫谓词真源（W1：产物落点语法门）。
 *
 * 独立零依赖文件：守卫寄居主管线模块会随其加载失败静默消失，故谓词永不 import 业务模块。
 * 单调只拒不放：返回 string = 拒绝并说明理由，undefined = 通过。
 * 本门只做"语法面"判定（绝对路径/.. 逃逸在不知道工作区根时也能判）；完整"落点在注入
 * 工作区内"由各工具 execute 的 resolveInWorkspace 复核（知道根才判得准）。
 */

export function comfyuiGuardPredicate(execution: { name: string; arguments: unknown }): string | undefined {
  if (execution.name !== "comfy_submit") return undefined;
  const args = execution.arguments;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const rec = args as Record<string, unknown>;
  const deny = checkPath(rec.outputPath, "outputPath");
  if (deny) return deny;
  const assets = rec.assets;
  if (assets !== undefined && assets !== null) {
    if (typeof assets !== "object" || Array.isArray(assets)) return `[守卫拒收] comfy_submit.assets 须为对象（槽名→路径数组）`;
    for (const [slot, list] of Object.entries(assets as Record<string, unknown>)) {
      if (!Array.isArray(list)) return `[守卫拒收] comfy_submit.assets.${slot} 须为路径数组`;
      for (const item of list) {
        const hit = checkPath(item, `assets.${slot}`);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}

/** 路径语法门：绝对路径拒收；.. 段拒收（含编码变体）；空/非串放行（参数校验层点名）。 */
function checkPath(value: unknown, param: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const s = value.trim();
  if (s.startsWith("/") || s.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("~")) {
    return `[守卫拒收] comfy_submit.${param} 须为工作区相对路径，收到绝对路径`;
  }
  const segs = s.replace(/\\/g, "/").split("/");
  if (segs.some((seg) => seg === ".." || seg === "%2e%2e" || seg === "%2E%2E")) {
    return `[守卫拒收] comfy_submit.${param} 含 .. 逃逸段（落点必须在工作区内）`;
  }
  return undefined;
}
