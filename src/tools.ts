/** tools.ts —— dsh-plugin-wwrs-comfyui DSH 工具面（W3 落地；5 工具）。
 *
 * 注册面（cordis apply 一次性 register）：
 * - comfy_submit：模板+参数+产物路径+资产提交远端（预检不过不建任务；overwrite 缺省 false；
 *   同输入命中旧收据绝不重提，防重复计费；进程内提交串行）；
 * - comfy_status：只读状态摘要（不写文件，不下载）；
 * - comfy_wait：分段等待（until=terminal|submitted，到点返回 renewable 由调用方循环续期；永不 408；
 *   terminal 成功即下载首个产物到 outputPath；exec.signal 只中断等待，不动远端任务）；
 * - comfy_cancel：按服务端能力中断（非 2xx 如实报错，不伪造成功；终态幂等直返）；
 * - comfy_templates：manifest 清单自描述（调前可查，无默认模板隐式链）。
 *
 * 形状与官方 defineTool 注册产物同形（output 全带 render；本包零运行时依赖，
 * 字面量自构，写法照抄官方用法）。收据永不含凭据；产物一律落工作区内。
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ComfyClient, type FetchFn, type RemoteOutput } from "./lib/comfy-client.ts";
import { FailLoudError, errorFields } from "./lib/errors.ts";
import type { ToolDefinition, ToolExec } from "./lib/host.ts";
import {
  applyAssets,
  applyFilenamePrefix,
  applyParams,
  getTemplate,
  hashJson,
  loadManifest,
  readWorkflowTemplate,
  validateParams,
  validateWorkflow,
  type ComfyWorkflow,
  type TemplateEntry,
  type TemplateManifest,
} from "./lib/manifest.ts";
import { preflightAssets, type PreflightAsset } from "./lib/preflight.ts";
import { enqueueSubmit, newClientId, readReceipt, reusableReceipt, taskIdFor, writeReceipt, type TaskReceipt, type TaskState } from "./lib/tasks.ts";
import { resolveInWorkspace, resolveWwrsWorkspace, type EnvMap } from "./lib/workspace.ts";

// ---------- 工具面公共形状 ----------

export type ToolFactoryConfig = {
  workspace?: string;
  comfyuiBaseUrl?: string;
  env?: EnvMap;
  templatesDir?: string;
  transport?: FetchFn;
};

type JsonValue = string | number | boolean | null | { [k: string]: JsonValue } | JsonValue[];
type Verdict = "ok" | "pending" | "error";
type ToolOutput = { verdict: Verdict; summary: string; details: Record<string, JsonValue> };

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string" },
    summary: { type: "string" },
    details: { type: "object" },
  },
  required: ["verdict", "summary", "details"],
} as const;

function renderOutput(_args: unknown, value: unknown): Array<{ type: string; text: string }> {
  const v = value as Partial<ToolOutput>;
  return [{ type: "text", text: String(v?.summary ?? "") }];
}

function ok(summary: string, details: Record<string, JsonValue> = {}): ToolOutput {
  return { verdict: "ok", summary, details };
}

function pending(summary: string, details: Record<string, JsonValue> = {}): ToolOutput {
  return { verdict: "pending", summary, details };
}

function errorOut(summary: string, details: Record<string, JsonValue> = {}): ToolOutput {
  return { verdict: "error", summary, details };
}

function failOut(tool: string, e: unknown, extra: Record<string, JsonValue> = {}): ToolOutput {
  const f = errorFields(e);
  return errorOut(`${tool} 失败：${f.error || "未知错误"}`.slice(0, 2000), { tool, ...fieldsToDetails(f), ...extra });
}

function fieldsToDetails(f: { error: string; param: string; expected: string; example: string }): Record<string, JsonValue> {
  return { error: f.error, param: f.param, expected: f.expected, example: f.example };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function reqString(args: Record<string, unknown>, key: string, tool: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new FailLoudError({ error: `[参数缺失] ${tool} 缺 ${key}`, param: key, expected: "非空字符串", example: `${key}=<值>` });
  }
  return v.trim();
}

// ---------- 运行上下文组装 ----------

type Runtime = { ws: string; client: ComfyClient; manifest: TemplateManifest; templatesDir: string; env: EnvMap; config: ToolFactoryConfig };

function runtime(config: ToolFactoryConfig | undefined, exec: ToolExec): Runtime {
  const env = config?.env ?? process.env;
  const ws = resolveWwrsWorkspace(process.cwd(), { configWorkspace: config?.workspace, env });
  const client = ComfyClient.fromEnv({ configBaseUrl: config?.comfyuiBaseUrl, env, transport: config?.transport });
  const loaded = loadManifest(config?.templatesDir);
  return { ws, client, manifest: loaded.manifest, templatesDir: loaded.dir, env, config: config ?? {} };
}

function progress(exec: ToolExec, text: string): void {
  try {
    if (typeof exec?.onProgress === "function") exec.onProgress({ content: [{ type: "text", text }] });
  } catch {
    /* 进度上报失败不挡主流程 */
  }
}

// ---------- 状态推导（status/wait 共用；只读远端，不写文件） ----------

async function refreshState(rt: Runtime, receipt: TaskReceipt, signal?: AbortSignal): Promise<TaskReceipt> {
  if (receipt.state === "done" || receipt.state === "failed" || receipt.state === "cancelled" || !receipt.promptId) return receipt;
  const history = await rt.client.history(receipt.promptId, signal);
  if (history.found && history.completed) {
    return writeReceipt(rt.ws, {
      ...receipt,
      state: history.success ? "done" : "failed",
      remoteOutputs: history.outputs,
      ...(history.success ? {} : { error: `远端任务失败：${history.statusText}` }),
    });
  }
  if (history.found && !history.completed) {
    const queue = await rt.client.queueIds(signal);
    const inFlight = queue.running.includes(receipt.promptId) || queue.pending.includes(receipt.promptId);
    const state: TaskState = queue.running.includes(receipt.promptId) ? "running" : inFlight ? "pending" : "running";
    return writeReceipt(rt.ws, { ...receipt, state, remoteOutputs: history.outputs });
  }
  const queue = await rt.client.queueIds(signal);
  if (queue.running.includes(receipt.promptId)) return writeReceipt(rt.ws, { ...receipt, state: "running" });
  if (queue.pending.includes(receipt.promptId)) return writeReceipt(rt.ws, { ...receipt, state: "pending" });
  return writeReceipt(rt.ws, { ...receipt, state: "unknown" });
}

function receiptDetails(receipt: TaskReceipt, ws: string): Record<string, JsonValue> {
  const abs = resolve(ws, receipt.outputRel);
  const details: Record<string, JsonValue> = {
    taskId: receipt.taskId,
    template: receipt.template,
    state: receipt.state,
    promptId: receipt.promptId ?? "",
    outputPath: receipt.outputRel,
    outputExists: existsSync(abs),
  };
  if (receipt.downloadRel) details.downloadPath = receipt.downloadRel;
  if (receipt.remoteOutputs) details.remoteOutputs = receipt.remoteOutputs as unknown as JsonValue;
  if (receipt.error) details.error = receipt.error;
  return details;
}

// ---------- comfy_submit ----------

function makeSubmitTool(factoryConfig?: ToolFactoryConfig): ToolDefinition {
  return {
    name: "comfy_submit",
    description:
      "Submit a ComfyUI workflow task (template + params + outputPath + assets). Template must be explicit (see comfy_templates); no implicit default. Preflight failures never reach the server. Same inputs hit the same taskId and never resubmit (no double billing). Params: template（清单名） + params（模板参数对象） + outputPath（工作区相对路径，产物落点） + assets?（槽名→工作区相对路径数组） + overwrite?（缺省 false，存在即短路直返）。",
    parameters: {
      type: "object",
      properties: {
        template: { type: "string", description: "Manifest template name (see comfy_templates)" },
        params: { type: "object", description: "Template params object (validated against manifest schema)" },
        outputPath: { type: "string", description: "Workspace-relative output file path" },
        assets: { type: "object", description: "Slot name -> workspace-relative file path array" },
        overwrite: { type: "boolean", description: "Overwrite existing output (default false = short-circuit)" },
      },
      required: ["template", "outputPath"],
      additionalProperties: false,
    },
    output: { schema: { ...OUTPUT_SCHEMA }, render: renderOutput },
    async execute(rawArgs: unknown, rawExec: ToolExec): Promise<ToolOutput> {
      const tool = "comfy_submit";
      try {
        const args = (isRecord(rawArgs) ? rawArgs : {}) as Record<string, unknown>;
        const rt = runtime(factoryConfig, rawExec);
        const templateName = reqString(args, "template", tool);
        const entry = getTemplate(rt.manifest, templateName);
        const values = validateParams(entry, templateName, args.params ?? {});
        const out = resolveInWorkspace(rt.ws, args.outputPath, "outputPath");
        if (existsSync(out.abs)) {
          if (statSync(out.abs).isDirectory()) {
            throw new FailLoudError({
              error: `[落点冲突] outputPath 已存在且为目录：${out.rel}`,
              param: "outputPath",
              expected: "不存在的文件路径（工作区相对）",
              example: "media/out.mp4",
            });
          }
          if (args.overwrite !== true) {
            return ok(`[已存在短路] ${out.rel} 已存在且 overwrite=false，未提交远端`, {
              tool,
              template: templateName,
              state: "exists",
              submitted: false,
              outputPath: out.rel,
            });
          }
        }
        // 预检（文件面不过即返，不建任务、不占串行队列）。
        const rawAssets = isRecord(args.assets) || args.assets === undefined ? (args.assets ?? {}) : args.assets;
        const checked = preflightAssets(rt.ws, entry.assets, rawAssets);
        const taskId = taskIdFor(templateName, values, out.rel);
        const hit = reusableReceipt(readReceipt(rt.ws, taskId));
        if (hit) {
          return hit.state === "done"
            ? ok(`[幂等命中] ${taskId} 已完成，未重提远端`, { tool, resumed: true, ...receiptDetails(hit, rt.ws) })
            : pending(`[幂等命中] ${taskId} 已在远端（${hit.state}），未重提`, { tool, resumed: true, ...receiptDetails(hit, rt.ws) });
        }
        const receipt = await enqueueSubmit(() => submitRemote(rt, rawExec, templateName, entry, values, checked, out.rel, taskId, args.overwrite === true));
        return pending(`[已提交] ${taskId} → prompt ${receipt.promptId}（${receipt.baseUrl}），用 comfy_status/comfy_wait 跟进`, {
          tool,
          resumed: false,
          ...receiptDetails(receipt, rt.ws),
        });
      } catch (e) {
        return failOut(tool, e);
      }
    },
  };
}

async function submitRemote(
  rt: Runtime,
  exec: ToolExec,
  templateName: string,
  entry: TemplateEntry,
  values: Record<string, string | number | boolean>,
  checked: Record<string, PreflightAsset[]>,
  outputRel: string,
  taskId: string,
  overwrite: boolean,
): Promise<TaskReceipt> {
  // 串行区内复查（并发同输入第二个排到此时直接复用，不重提）。
  const hit = reusableReceipt(readReceipt(rt.ws, taskId));
  if (hit) return hit;
  const workflow: ComfyWorkflow = structuredClone(readWorkflowTemplate(rt.templatesDir, entry.file));
  applyParams(workflow, entry, values);
  // 资产上传（串行区内：单 profile 并发=1 意图；跨 profile/多进程不保证，见 README）。
  const uploaded: Record<string, string[]> = {};
  const assetRefs: Record<string, Array<{ nodeId: string; inputName: string }>> = {};
  for (const [slotName, files] of Object.entries(checked)) {
    const slot = entry.assets[slotName];
    const names: string[] = [];
    const refs: Array<{ nodeId: string; inputName: string }> = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;
      progress(exec, `[comfy_submit] 上传资产 ${slotName}[${i}] ${file.rel}`);
      const remoteName = await rt.client.upload(file.rel, file.abs, slot.kind, exec?.signal);
      names.push(remoteName);
      if (slot.mode === "direct") {
        const loader = slot.loaders[i];
        if (loader) refs.push({ nodeId: loader.node, inputName: loader.input });
      } else {
        const loader = slot.loaders[i];
        refs.push(loader ? { nodeId: loader.node, inputName: loader.input } : { nodeId: `asset-${slotName}-${i}`, inputName: slot.loaderInput });
      }
    }
    uploaded[slotName] = names;
    assetRefs[slotName] = refs;
  }
  applyAssets(workflow, entry, uploaded);
  applyFilenamePrefix(workflow, entry, `wwrs/${taskId}`);
  validateWorkflow(workflow, entry, assetRefs);
  const workflowHash = hashJson(workflow);
  const clientId = newClientId();
  const promptId = await rt.client.submit(workflow, clientId, exec?.signal);
  progress(exec, `[comfy_submit] 已提交 prompt ${promptId}`);
  return writeReceipt(rt.ws, {
    version: 1,
    taskId,
    template: templateName,
    paramsHash: hashJson(values),
    outputRel,
    promptId,
    clientId,
    baseUrl: rt.client.baseUrl,
    state: "submitted",
    overwrite,
    workflowHash,
    submittedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

// ---------- comfy_status ----------

function makeStatusTool(factoryConfig?: ToolFactoryConfig): ToolDefinition {
  return {
    name: "comfy_status",
    description:
      "Query a submitted ComfyUI task state (read-only: never writes files, never downloads). Params: taskId（comfy_submit 返回）。Returns state submitted|pending|running|done|failed|cancelled|unknown + outputExists.",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string", description: "Task id returned by comfy_submit" } },
      required: ["taskId"],
      additionalProperties: false,
    },
    output: { schema: { ...OUTPUT_SCHEMA }, render: renderOutput },
    async execute(rawArgs: unknown, rawExec: ToolExec): Promise<ToolOutput> {
      const tool = "comfy_status";
      try {
        const args = (isRecord(rawArgs) ? rawArgs : {}) as Record<string, unknown>;
        const rt = runtime(factoryConfig, rawExec);
        const taskId = reqString(args, "taskId", tool);
        const receipt = readReceipt(rt.ws, taskId);
        if (!receipt) {
          throw new FailLoudError({
            error: `[未知任务] ${taskId} 在本工作区无收据`,
            param: "taskId",
            expected: "comfy_submit 返回的 taskId（同工作区）",
            example: "先调 comfy_submit 再查",
          });
        }
        const fresh = await refreshState(rt, receipt, rawExec?.signal);
        const details = { tool, ...receiptDetails(fresh, rt.ws) };
        if (fresh.state === "done")
          return ok(`[${taskId}] done（产物${existsSync(resolve(rt.ws, fresh.outputRel)) ? "已落盘" : "待 comfy_wait terminal 下载"}）`, details);
        if (fresh.state === "failed" || fresh.state === "cancelled")
          return errorOut(`[${taskId}] ${fresh.state}${fresh.error ? `：${fresh.error}` : ""}`, details);
        return pending(`[${taskId}] ${fresh.state}（renewable：循环 comfy_status/comfy_wait 跟进）`, { ...details, renewable: true });
      } catch (e) {
        return failOut(tool, e);
      }
    },
  };
}

// ---------- comfy_wait ----------

function sleep(ms: number, signal?: AbortSignal): Promise<"slept" | "aborted"> {
  return new Promise((resolveSleep) => {
    if (signal?.aborted) {
      resolveSleep("aborted");
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveSleep("slept");
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolveSleep("aborted");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function makeWaitTool(factoryConfig?: ToolFactoryConfig): ToolDefinition {
  return {
    name: "comfy_wait",
    description:
      "Wait for a submitted ComfyUI task in segments (never 408s: on timeout returns renewable=true for the caller to loop). until=terminal（缺省：到完成/失败为止，成功即下载首个产物到 outputPath）| submitted（远端可见即返）。exec.signal 只协作式中断等待（远端任务不动）。Params: taskId + until? + timeoutMs?（缺省 120000）。",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task id returned by comfy_submit" },
        until: { type: "string", enum: ["terminal", "submitted"], description: "Wait until terminal (default) or submitted-visible" },
        timeoutMs: { type: "number", description: "Segment budget in ms (default 120000)" },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    output: { schema: { ...OUTPUT_SCHEMA }, render: renderOutput },
    async execute(rawArgs: unknown, rawExec: ToolExec): Promise<ToolOutput> {
      const tool = "comfy_wait";
      try {
        const args = (isRecord(rawArgs) ? rawArgs : {}) as Record<string, unknown>;
        const rt = runtime(factoryConfig, rawExec);
        const taskId = reqString(args, "taskId", tool);
        const until = args.until === undefined || args.until === null ? "terminal" : args.until;
        if (until !== "terminal" && until !== "submitted") {
          throw new FailLoudError({
            error: `[参数枚举外] until=${JSON.stringify(until)}`,
            param: "until",
            expected: "terminal | submitted",
            example: "until=terminal",
          });
        }
        const timeoutMs = args.timeoutMs === undefined || args.timeoutMs === null ? 120_000 : args.timeoutMs;
        if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          throw new FailLoudError({
            error: `[参数非法] timeoutMs 须为正数毫秒，收到 ${JSON.stringify(timeoutMs)}`,
            param: "timeoutMs",
            expected: "正有限数（毫秒）",
            example: "timeoutMs=120000",
          });
        }
        const receipt = readReceipt(rt.ws, taskId);
        if (!receipt) {
          throw new FailLoudError({
            error: `[未知任务] ${taskId} 在本工作区无收据`,
            param: "taskId",
            expected: "comfy_submit 返回的 taskId（同工作区）",
            example: "先调 comfy_submit 再等",
          });
        }
        if (!receipt.promptId) {
          throw new FailLoudError({
            error: `[任务未提交] ${taskId} 无 promptId（提交未知态，重调 comfy_submit 续）`,
            param: "taskId",
            expected: "已提交收据（含 promptId）",
            example: "重调 comfy_submit（同输入幂等）",
          });
        }
        const deadline = Date.now() + timeoutMs;
        const POLL_MS = 3000;
        for (;;) {
          const fresh = await refreshState(rt, receipt, rawExec?.signal);
          Object.assign(receipt, fresh);
          if (until === "submitted" && fresh.state !== "unknown") {
            return pending(`[${taskId}] 远端可见（${fresh.state}），submitted 段到点`, { tool, ...receiptDetails(fresh, rt.ws), renewable: true });
          }
          if (until === "terminal" && (fresh.state === "done" || fresh.state === "failed" || fresh.state === "cancelled")) {
            if (fresh.state !== "done")
              return errorOut(`[${taskId}] ${fresh.state}${fresh.error ? `：${fresh.error}` : ""}`, { tool, ...receiptDetails(fresh, rt.ws) });
            return downloadFirstOutput(rt, fresh, rawExec?.signal);
          }
          if (Date.now() >= deadline) {
            return pending(`[${taskId}] 本段到点（${fresh.state}），renewable=true 请循环续期`, { tool, ...receiptDetails(fresh, rt.ws), renewable: true });
          }
          const waitMs = Math.min(POLL_MS, Math.max(0, deadline - Date.now()));
          if (waitMs <= 0) {
            return pending(`[${taskId}] 本段到点（${fresh.state}），renewable=true 请循环续期`, { tool, ...receiptDetails(fresh, rt.ws), renewable: true });
          }
          if ((await sleep(waitMs, rawExec?.signal)) === "aborted") {
            return pending(`[${taskId}] 等待被协作式中断（远端任务不动，${fresh.state}），renewable=true 可续`, {
              tool,
              ...receiptDetails(fresh, rt.ws),
              renewable: true,
              aborted: true,
            });
          }
        }
      } catch (e) {
        return failOut(tool, e);
      }
    },
  };
}

/** terminal 成功即下载首个产物到 outputPath（幂等：已存在且 overwrite=false 则跳过）。 */
async function downloadFirstOutput(rt: Runtime, receipt: TaskReceipt, signal?: AbortSignal): Promise<ToolOutput> {
  const tool = "comfy_wait";
  const outputs = receipt.remoteOutputs ?? [];
  if (outputs.length === 0) {
    return ok(`[${receipt.taskId}] done（远端无产物文件记录）`, { tool, ...receiptDetails(receipt, rt.ws) });
  }
  const abs = resolve(rt.ws, receipt.outputRel);
  if (existsSync(abs) && !receipt.overwrite) {
    return ok(`[${receipt.taskId}] done（${receipt.outputRel} 已存在且 overwrite=false，跳过下载）`, {
      tool,
      ...receiptDetails(receipt, rt.ws),
      skippedDownload: true,
    });
  }
  const first = outputs[0] as RemoteOutput;
  try {
    await rt.client.download(first, abs, signal);
  } catch (e) {
    const f = errorFields(e);
    return errorOut(`[${receipt.taskId}] 远端完成但下载失败：${f.error}`.slice(0, 2000), { tool, ...receiptDetails(receipt, rt.ws), ...fieldsToDetails(f) });
  }
  const fresh = writeReceipt(rt.ws, { ...receipt, downloadRel: receipt.outputRel });
  return ok(`[${receipt.taskId}] done → ${receipt.outputRel}`, { tool, ...receiptDetails(fresh, rt.ws) });
}

// ---------- comfy_cancel ----------

function makeCancelTool(factoryConfig?: ToolFactoryConfig): ToolDefinition {
  return {
    name: "comfy_cancel",
    description:
      "Cancel a submitted ComfyUI task (server-capability delete; non-2xx is reported honestly, never faked. Terminal receipts return as-is). Params: taskId。",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string", description: "Task id returned by comfy_submit" } },
      required: ["taskId"],
      additionalProperties: false,
    },
    output: { schema: { ...OUTPUT_SCHEMA }, render: renderOutput },
    async execute(rawArgs: unknown, rawExec: ToolExec): Promise<ToolOutput> {
      const tool = "comfy_cancel";
      try {
        const args = (isRecord(rawArgs) ? rawArgs : {}) as Record<string, unknown>;
        const rt = runtime(factoryConfig, rawExec);
        const taskId = reqString(args, "taskId", tool);
        const receipt = readReceipt(rt.ws, taskId);
        if (!receipt) {
          throw new FailLoudError({
            error: `[未知任务] ${taskId} 在本工作区无收据`,
            param: "taskId",
            expected: "comfy_submit 返回的 taskId（同工作区）",
            example: "先调 comfy_submit",
          });
        }
        if (receipt.state === "done" || receipt.state === "failed" || receipt.state === "cancelled") {
          return ok(`[${taskId}] 已终态（${receipt.state}），无需中断`, { tool, ...receiptDetails(receipt, rt.ws), alreadyTerminal: true });
        }
        if (!receipt.promptId) {
          throw new FailLoudError({
            error: `[任务未提交] ${taskId} 无 promptId，无可中断的远端任务`,
            param: "taskId",
            expected: "已提交收据（含 promptId）",
            example: "重调 comfy_submit（同输入幂等）",
          });
        }
        await rt.client.cancel(receipt.promptId, rawExec?.signal);
        const fresh = writeReceipt(rt.ws, { ...receipt, state: "cancelled" });
        return ok(`[${taskId}] 已中断（prompt ${receipt.promptId}）`, { tool, ...receiptDetails(fresh, rt.ws) });
      } catch (e) {
        return failOut(tool, e);
      }
    },
  };
}

// ---------- comfy_templates ----------

function templateCard(name: string, entry: TemplateEntry): Record<string, JsonValue> {
  const params: Record<string, JsonValue> = {};
  for (const [key, spec] of Object.entries(entry.params)) {
    const card: Record<string, JsonValue> = { type: spec.type, required: spec.required === true };
    if (spec.default !== undefined) card.default = spec.default as JsonValue;
    if (spec.enum) card.enum = spec.enum as unknown as JsonValue;
    if (spec.min !== undefined) card.min = spec.min;
    if (spec.max !== undefined) card.max = spec.max;
    if (spec.description) card.description = spec.description;
    params[key] = card;
  }
  const assets: Record<string, JsonValue> = {};
  for (const [slot, spec] of Object.entries(entry.assets)) {
    assets[slot] = { kind: spec.kind, min: spec.min, max: spec.max, ...(spec.formats ? { formats: spec.formats } : {}) } as unknown as JsonValue;
  }
  return { name, kind: entry.kind, file: entry.file, description: entry.description, params, assets, outputs: entry.outputs as unknown as JsonValue };
}

function makeTemplatesTool(factoryConfig?: ToolFactoryConfig): ToolDefinition {
  return {
    name: "comfy_templates",
    description:
      "List ComfyUI workflow templates shipped with this package (self-describing: params schema + asset slots + output nodes). Call before comfy_submit; template must be explicit, no implicit default. Params: none.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: { schema: { ...OUTPUT_SCHEMA }, render: renderOutput },
    async execute(rawArgs: unknown, rawExec: ToolExec): Promise<ToolOutput> {
      const tool = "comfy_templates";
      try {
        const rt = runtime(factoryConfig, rawExec);
        void rawArgs;
        const templates = Object.entries(rt.manifest.templates).map(([name, entry]) => templateCard(name, entry));
        return ok(`可用模板 ${templates.length} 个：${templates.map((t) => String(t.name)).join(" / ")}`, {
          tool,
          count: templates.length,
          templates: templates as unknown as JsonValue,
        });
      } catch (e) {
        return failOut(tool, e);
      }
    },
  };
}

// ---------- 注册面工厂（cordis apply 消费；tests 直调验合同形状） ----------

export function createComfyTools(config?: ToolFactoryConfig): ToolDefinition[] {
  return [makeSubmitTool(config), makeStatusTool(config), makeWaitTool(config), makeCancelTool(config), makeTemplatesTool(config)];
}

/** 工具名表（守卫与 cordis 共用；改名必同步两端）。 */
export const COMFY_TOOL_NAMES = ["comfy_submit", "comfy_status", "comfy_wait", "comfy_cancel", "comfy_templates"] as const;
