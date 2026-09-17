/** tasks.ts —— 任务收据存取 + 进程内提交串行队列（包内单源）。
 *
 * 幂等：taskId = 模板名/参数/输出路径的稳定哈希——同输入重复提交命中同一收据，
 * 已提交（submitted/running/pending/done）绝不重提远端（防重复计费）；
 * failed/cancelled/unknown 允许重提（覆盖旧收据）。
 * 收据落工作区 `.wwrs/comfy-tasks/<taskId>.json`（产物与状态同区，跨进程可续查）；
 * 收据永不含凭据（只记 baseUrl，不记 token）。
 * 串行：进程内提交走单条 promise 链（单 profile 并发=1 意图；多进程/多 profile
 * 不保证串行——文档写明，调用方跨 profile 并发自负）。
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hashJson } from "./manifest.ts";

export type TaskState = "submitted" | "pending" | "running" | "done" | "failed" | "cancelled" | "unknown";

export type TaskReceipt = {
  version: 1;
  taskId: string;
  template: string;
  paramsHash: string;
  outputRel: string;
  promptId: string | null;
  clientId: string;
  baseUrl: string;
  state: TaskState;
  overwrite: boolean;
  workflowHash: string;
  submittedAt: string;
  updatedAt: string;
  downloadRel?: string;
  remoteOutputs?: Array<{ filename: string; subfolder: string; type: string; node: string; format: string }>;
  error?: string;
};

export const TASK_DIR_REL = ".wwrs/comfy-tasks";

/** 任务收据目录（工作区内；不存在即建）。 */
export function taskDir(ws: string): string {
  const dir = join(resolve(ws), TASK_DIR_REL);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function receiptPath(ws: string, taskId: string): string {
  return join(taskDir(ws), `${taskId}.json`);
}

/** taskId 派生（模板名 + 参数稳定哈希 + 输出相对路径；同输入同 id）。 */
export function taskIdFor(template: string, params: Record<string, string | number | boolean>, outputRel: string): string {
  const digest = createHash("sha256")
    .update(`${template}\n${hashJson(params)}\n${outputRel}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `ct-${digest}`;
}

export function newClientId(): string {
  return randomUUID();
}

function isTaskState(v: unknown): v is TaskState {
  return v === "submitted" || v === "pending" || v === "running" || v === "done" || v === "failed" || v === "cancelled" || v === "unknown";
}

function isReceipt(v: unknown): v is TaskReceipt {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return r.version === 1 && typeof r.taskId === "string" && typeof r.template === "string" && isTaskState(r.state);
}

/** 读收据（不存在/损坏返回 undefined，不抛——调用方按"无记录"处理）。 */
export function readReceipt(ws: string, taskId: string): TaskReceipt | undefined {
  const path = join(resolve(ws), TASK_DIR_REL, `${taskId}.json`);
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isReceipt(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 写收据（原子性不保证跨进程；updatedAt 自动刷新）。 */
export function writeReceipt(ws: string, receipt: TaskReceipt): TaskReceipt {
  const next: TaskReceipt = { ...receipt, updatedAt: new Date().toISOString() };
  writeFileSync(receiptPath(ws, receipt.taskId), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/** 可复用旧收据（submitted/pending/running/done 命中即返回，不重提）。 */
export function reusableReceipt(receipt: TaskReceipt | undefined): TaskReceipt | undefined {
  if (!receipt || !receipt.promptId) return undefined;
  if (receipt.state === "submitted" || receipt.state === "pending" || receipt.state === "running" || receipt.state === "done") return receipt;
  return undefined;
}

// ---------- 进程内提交串行队列 ----------

let submitTail: Promise<void> = Promise.resolve();

/** 提交串行化：fn 排入进程内单链执行（fn 的抛错不污染链条，只回给调用方）。 */
export function enqueueSubmit<T>(fn: () => Promise<T>): Promise<T> {
  const run = submitTail.then(fn, fn);
  submitTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
