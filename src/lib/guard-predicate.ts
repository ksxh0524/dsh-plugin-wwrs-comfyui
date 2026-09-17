/** comfyui-guard.ts —— 写保护守卫谓词真源（W0 空壳：恒放行；W1 接产物落点判定）。
 *
 * 独立零依赖文件：守卫寄居主管线模块会随其加载失败静默消失，故谓词永不 import 业务模块。
 * 单调只拒不放：返回 string = 拒绝并说明理由，undefined = 通过。
 */

export function comfyuiGuardPredicate(_execution: { name: string; arguments: unknown }): string | undefined {
  // W0 空壳：尚无工具注册，无拦截面。W1 起判定"产物是否落在注入工作区内"。
  return undefined;
}
