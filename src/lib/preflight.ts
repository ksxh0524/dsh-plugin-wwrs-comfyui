/** preflight.ts —— 参考资产预检（文件面早筛；提交前执行，不过不建任务）。
 *
 * 通用模板参数校验：存在性 / 格式后缀 / 单文件字节 / 请求合计字节 / 槽位数量。
 * 只做本地文件面判定，不探媒体内容维度（时长/分辨率 probing 归他包，不管）。
 * 缺文件即 fail-loud（调用方补文件再提）；格式/配额问题同样 fail-loud 点名槽位。
 */

import { existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import { FailLoudError } from "./errors.ts";
import type { AssetSlot } from "./manifest.ts";
import { resolveInWorkspace } from "./workspace.ts";

export type PreflightAsset = { abs: string; rel: string; bytes: number };

/** 单槽预检：返回解析后的资产（含字节数，供合计配额用）。raw 非数组即抛。 */
export function preflightSlot(ws: string, slotName: string, slot: AssetSlot, raw: unknown): PreflightAsset[] {
  const list = raw === undefined || raw === null ? [] : raw;
  if (!Array.isArray(list)) {
    throw new FailLoudError({
      error: `[资产非法] assets.${slotName} 须为工作区相对路径数组，收到 ${typeof raw}`,
      param: `assets.${slotName}`,
      expected: "字符串数组（工作区相对路径）",
      example: "comfy_templates 查资产槽表",
    });
  }
  if (list.length < slot.min || list.length > slot.max) {
    throw new FailLoudError({
      error: `[资产数量错] 槽位 ${slotName} 需 ${slot.min}..${slot.max} 个，收到 ${list.length} 个`,
      param: `assets.${slotName}`,
      expected: `${slot.min}..${slot.max} 个 ${slot.kind} 文件（工作区相对路径）`,
      example: "comfy_templates 查资产槽表",
    });
  }
  const allowed = new Set((slot.formats ?? []).map((f) => f.toLowerCase()));
  let total = 0;
  const out: PreflightAsset[] = [];
  for (const item of list) {
    if (typeof item !== "string" || !item.trim()) {
      throw new FailLoudError({
        error: `[资产非法] 槽位 ${slotName} 含空路径`,
        param: `assets.${slotName}`,
        expected: "非空工作区相对路径",
        example: "comfy_templates 查资产槽表",
      });
    }
    const resolved = resolveInWorkspace(ws, item, `assets.${slotName}`);
    if (!existsSync(resolved.abs)) {
      throw new FailLoudError({
        error: `[资产缺失] 槽位 ${slotName} 文件不存在：${resolved.rel}`,
        param: `assets.${slotName}`,
        expected: "工作区内已存在的文件",
        example: "先把文件放入工作区再提交",
      });
    }
    const stat = statSync(resolved.abs);
    if (!stat.isFile()) {
      throw new FailLoudError({
        error: `[资产非法] 槽位 ${slotName} 非文件：${resolved.rel}`,
        param: `assets.${slotName}`,
        expected: "文件路径（非目录）",
        example: "comfy_templates 查资产槽表",
      });
    }
    const ext = extname(resolved.rel).slice(1).toLowerCase();
    if (allowed.size > 0 && !allowed.has(ext)) {
      throw new FailLoudError({
        error: `[资产格式错] 槽位 ${slotName} 的 .${ext || "(无后缀)"} 不在 [${[...allowed].join("/")}] 内：${resolved.rel}`,
        param: `assets.${slotName}`,
        expected: `后缀之一 [${[...allowed].join("/")}]`,
        example: "comfy_templates 查资产槽表",
      });
    }
    if (slot.maxBytes !== undefined && stat.size > slot.maxBytes) {
      throw new FailLoudError({
        error: `[资产超限] 槽位 ${slotName} 的 ${resolved.rel} ${stat.size} 字节，超过单文件上限 ${slot.maxBytes} 字节`,
        param: `assets.${slotName}`,
        expected: `单文件 ≤${slot.maxBytes} 字节`,
        example: "comfy_templates 查资产槽表",
      });
    }
    total += stat.size;
    out.push({ abs: resolved.abs, rel: resolved.rel, bytes: stat.size });
  }
  if (slot.totalMaxBytes !== undefined && total > slot.totalMaxBytes) {
    throw new FailLoudError({
      error: `[资产超限] 槽位 ${slotName} 合计 ${total} 字节，超过请求上限 ${slot.totalMaxBytes} 字节`,
      param: `assets.${slotName}`,
      expected: `合计 ≤${slot.totalMaxBytes} 字节`,
      example: "comfy_templates 查资产槽表",
    });
  }
  return out;
}

/** 整单预检：遍历模板全部资产槽（禁未知槽名，拼写漂移早暴露）。 */
export function preflightAssets(ws: string, slots: Record<string, AssetSlot>, raw: unknown): Record<string, PreflightAsset[]> {
  const rec = raw === undefined || raw === null ? {} : raw;
  if (typeof rec !== "object" || Array.isArray(rec)) {
    throw new FailLoudError({ error: "[资产非法] assets 须为对象（槽名→路径数组）", param: "assets", expected: "对象", example: "comfy_templates 查资产槽表" });
  }
  const input = rec as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(key in slots)) {
      throw new FailLoudError({
        error: `[未知资产槽] ${JSON.stringify(key)}（可用槽：${Object.keys(slots).join(" / ") || "（模板无资产槽）"}）`,
        param: `assets.${key}`,
        expected: `模板资产槽之一（${Object.keys(slots).join(" / ") || "（无）"}）`,
        example: "comfy_templates 查资产槽表",
      });
    }
  }
  const out: Record<string, PreflightAsset[]> = {};
  for (const [name, slot] of Object.entries(slots)) out[name] = preflightSlot(ws, name, slot, input[name]);
  return out;
}
