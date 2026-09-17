/** workspace.ts —— 工作区定位与落点解析（包内单源；零业务名词，只认路径）。
 *
 * 工作区四级（第一命中即赢，禁绝对路径缺省）：
 * ① 调用方 config.workspace（绝对路径，由宿主 profile patch 行注入）；
 * ② env WWRS_WORKSPACE；
 * ③ 自起点向上找 `.wwrs/workspace.json` 中性锚（内容须为合法 JSON，不判 kind）；
 * ④ 全 miss 即 fail-loud：点名三条出路，绝不回落任何机器目录。
 * 落点铁律：所有输入输出路径只收工作区相对路径——绝对路径或越界（.. 逃出工作区）直接抛，
 * 相对路径拼入工作区。config 注入值被信任（存在性不判，由调用方保证）。
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { FailLoudError } from "./errors.ts";

export const WWRS_WORKSPACE_ENV = "WWRS_WORKSPACE";
export const WWRS_ANCHOR_REL = ".wwrs/workspace.json";

export type EnvMap = Record<string, string | undefined>;

/** 工作区根解析：config.workspace > env WWRS_WORKSPACE > 向上找 .wwrs/workspace.json 锚 > 抛三条出路。 */
export function resolveWwrsWorkspace(cwd: string, opts: { configWorkspace?: string; env?: EnvMap } = {}): string {
  const cfg = String(opts.configWorkspace ?? "").trim();
  if (cfg) return resolve(cfg);
  const env = opts.env ?? process.env;
  const ev = String(env[WWRS_WORKSPACE_ENV] ?? "").trim();
  if (ev) return resolve(ev);
  const start = resolve(cwd);
  const tried: string[] = [];
  let dir = start;
  for (;;) {
    const anchor = join(dir, ".wwrs", "workspace.json");
    tried.push(anchor);
    try {
      JSON.parse(readFileSync(anchor, "utf8"));
      return dir;
    } catch {
      /* 非有效锚，继续向上 */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new FailLoudError({
    error: `[工作区未找到] 从 ${start} 向上找不到 ${WWRS_ANCHOR_REL}（内容为合法 JSON 即认）`,
    param: "workspace",
    expected: `config.workspace 或 env ${WWRS_WORKSPACE_ENV}=<工作区根> 或 ${WWRS_ANCHOR_REL} 中性锚`,
    example: `${WWRS_WORKSPACE_ENV}=<工作区根>`,
  });
}

/** 落点解析：只收工作区相对路径；绝对路径或越界直接抛。返回原文相对路径 + 拼入后的绝对路径。 */
export function resolveInWorkspace(ws: string, raw: unknown, param: string): { rel: string; abs: string } {
  const s = String(raw ?? "").trim();
  if (!s) {
    throw new FailLoudError({
      error: `[路径为空] ${param} 为空`,
      param,
      expected: "工作区相对路径",
      example: "media/out.mp4",
    });
  }
  if (isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s)) {
    throw new FailLoudError({
      error: `[路径越界] ${param} 须传工作区相对路径，收到绝对路径：${s}`,
      param,
      expected: "工作区相对路径（拼入工作区根）",
      example: "media/out.mp4",
    });
  }
  const root = resolve(ws);
  const abs = resolve(root, s);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new FailLoudError({
      error: `[路径越界] ${param}=${s}（解析为 ${abs}）不在工作区 ${root} 内`,
      param,
      expected: "落点必须在工作区内（禁 .. 逃出）",
      example: "media/out.mp4",
    });
  }
  return { rel: s, abs };
}
