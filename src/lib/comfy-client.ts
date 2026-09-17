/** comfy-client.ts —— 远端 ComfyUI 最小 HTTP 客户端（fetch 直调，零依赖）。
 *
 * 执行面（只认 ComfyUI 原生端点）：POST /prompt（提交，取 prompt_id）、
 * GET /history/{promptId}（状态+产物）、GET /queue（排队位置）、
 * POST /upload/{image|audio|video}（资产上传）、POST /queue {delete:[promptId]}（中断，
 * 按服务端能力：非 2xx 即如实报错，不伪造成功）。
 * 凭据只走 env/config：baseUrl 来自 config.comfyuiBaseUrl 显式注入或 env
 * COMFYUI_BASE_URL，token 来自 env COMFYUI_AUTH_TOKEN；token 只进 Authorization
 * 请求头，永不进日志/产物/收据。transport 可注入（测试替身面）。
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { FailLoudError } from "./errors.ts";
import type { EnvMap } from "./workspace.ts";
import type { ComfyWorkflow } from "./manifest.ts";

export const COMFYUI_BASE_URL_ENV = "COMFYUI_BASE_URL";
export const COMFYUI_AUTH_TOKEN_ENV = "COMFYUI_AUTH_TOKEN";
export const COMFYUI_HTTP_TIMEOUT_ENV = "COMFYUI_HTTP_TIMEOUT_MS";
export const DEFAULT_HTTP_TIMEOUT_MS = 120_000;

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** ComfyUI 服务端错误（status 可能 undefined = 传输层失败/提交结果未知）。 */
export class ComfyUIError extends Error {
  readonly status: number | undefined;
  readonly raw: unknown;
  constructor(message: string, status: number | undefined, raw?: unknown) {
    super(message);
    this.name = "ComfyUIError";
    this.status = status;
    this.raw = raw;
  }
}

/** 提交结果未知（传输失败/无 prompt_id——调用方先查状态再定夺，禁盲目重提防重复计费）。 */
export class UnknownSubmissionError extends ComfyUIError {
  constructor(message: string, raw?: unknown) {
    super(message, undefined, raw);
    this.name = "UnknownSubmissionError";
  }
}

/** 基地址解析：config 显式注入 > env，缺失即 fail-loud 点名两条出路。 */
export function resolveBaseUrl(opts: { configBaseUrl?: string; env?: EnvMap } = {}): string {
  const cfg = String(opts.configBaseUrl ?? "")
    .trim()
    .replace(/\/$/, "");
  if (cfg) return cfg;
  const env = opts.env ?? process.env;
  const ev = String(env[COMFYUI_BASE_URL_ENV] ?? "")
    .trim()
    .replace(/\/$/, "");
  if (ev) return ev;
  throw new FailLoudError({
    error: `[远端未配置] ComfyUI 基地址缺失（config.comfyuiBaseUrl 与 env ${COMFYUI_BASE_URL_ENV} 全空）`,
    param: "comfyuiBaseUrl",
    expected: `config.comfyuiBaseUrl=<基地址> 或 env ${COMFYUI_BASE_URL_ENV}=<基地址>`,
    example: `${COMFYUI_BASE_URL_ENV}=http://<远端>:8188`,
  });
}

export function resolveHttpTimeoutMs(env: EnvMap = process.env): number {
  const n = Number(env[COMFYUI_HTTP_TIMEOUT_ENV]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HTTP_TIMEOUT_MS;
}

export type ComfyClientOptions = {
  baseUrl: string;
  authToken?: string;
  transport?: FetchFn;
  timeoutMs?: number;
};

export type RemoteOutput = { filename: string; subfolder: string; type: string; node: string; format: string };
export type HistoryEntry = {
  found: boolean;
  completed: boolean;
  success: boolean;
  statusText: string;
  outputs: RemoteOutput[];
  raw: unknown;
};

const OUTPUT_LIST_KEYS = ["images", "videos", "audios", "gifs", "files", "audio", "image", "video"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

/** 错误载荷摘要（截断；只含服务端回显，不含请求头凭据）。 */
function summarize(raw: unknown): string {
  try {
    return JSON.stringify(raw).slice(0, 1200);
  } catch {
    return String(raw).slice(0, 1200);
  }
}

export class ComfyClient {
  readonly baseUrl: string;
  private readonly authToken: string | undefined;
  private readonly transport: FetchFn;
  private readonly timeoutMs: number;

  constructor(options: ComfyClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    const token = (options.authToken ?? "").trim();
    this.authToken = token ? token : undefined;
    this.transport = options.transport ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_HTTP_TIMEOUT_MS;
  }

  static fromEnv(opts: { configBaseUrl?: string; env?: EnvMap; transport?: FetchFn } = {}): ComfyClient {
    const env = opts.env ?? process.env;
    return new ComfyClient({
      baseUrl: resolveBaseUrl({ configBaseUrl: opts.configBaseUrl, env }),
      authToken: env[COMFYUI_AUTH_TOKEN_ENV],
      transport: opts.transport,
      timeoutMs: resolveHttpTimeoutMs(env),
    });
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}), ...extra };
  }

  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return this.transport(url, { ...init, signal: merged });
  }

  /** 资产上传（kind=image|audio|video；返回服务端文件名，供工作流输入引用）。 */
  async upload(localPath: string, absPath: string, kind: "image" | "audio" | "video", signal?: AbortSignal): Promise<string> {
    const body = new FormData();
    body.append(kind, new Blob([await readFile(absPath)]), basename(localPath));
    body.append("overwrite", "true");
    let response: Response;
    try {
      response = await this.request(`${this.baseUrl}/upload/${kind}`, { method: "POST", headers: this.headers(), body }, signal);
    } catch (e) {
      throw new ComfyUIError(`ComfyUI 上传失败（传输层）：${e instanceof Error ? e.message : String(e)}`, undefined, { kind, localPath });
    }
    const result = await parseJson(response);
    const name = isRecord(result) && typeof result.name === "string" ? result.name : undefined;
    if (!response.ok || !name) throw new ComfyUIError(`ComfyUI 上传失败 HTTP ${response.status}：${summarize(result)}`, response.status, { kind, localPath });
    return name;
  }

  /** 提交工作流（成功取 prompt_id；node_errors/非 2xx 即抛；传输失败=结果未知）。 */
  async submit(workflow: ComfyWorkflow, clientId: string, signal?: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await this.request(
        `${this.baseUrl}/prompt`,
        { method: "POST", headers: this.headers({ "Content-Type": "application/json" }), body: JSON.stringify({ prompt: workflow, client_id: clientId }) },
        signal,
      );
    } catch (e) {
      throw new UnknownSubmissionError(`ComfyUI /prompt 传输失败，提交结果未知（先查状态再定夺，禁盲目重提）：${e instanceof Error ? e.message : String(e)}`);
    }
    const result = await parseJson(response);
    if (isRecord(result) && isRecord(result.node_errors) && Object.keys(result.node_errors).length > 0) {
      throw new ComfyUIError(`ComfyUI 拒绝工作流节点：${summarize(result.node_errors)}`, response.status, result);
    }
    if (!response.ok) throw new UnknownSubmissionError(`ComfyUI /prompt HTTP ${response.status}，提交结果未知：${summarize(result)}`, result);
    const promptId = isRecord(result) && typeof result.prompt_id === "string" && result.prompt_id ? result.prompt_id : undefined;
    if (!promptId) throw new UnknownSubmissionError(`ComfyUI /prompt 未返回 prompt_id：${summarize(result)}`, result);
    return promptId;
  }

  /** 读历史（404=远端无此任务；其余非 2xx 即抛）。 */
  async history(promptId: string, signal?: AbortSignal): Promise<HistoryEntry> {
    let response: Response;
    try {
      response = await this.request(`${this.baseUrl}/history/${encodeURIComponent(promptId)}`, { headers: this.headers() }, signal);
    } catch (e) {
      throw new ComfyUIError(`ComfyUI history 传输失败：${e instanceof Error ? e.message : String(e)}`, undefined, { promptId });
    }
    if (response.status === 404) return { found: false, completed: false, success: false, statusText: "not-found", outputs: [], raw: null };
    const result = await parseJson(response);
    if (!response.ok) throw new ComfyUIError(`ComfyUI history 失败 HTTP ${response.status}：${summarize(result)}`, response.status, { promptId });
    const rec = isRecord(result) ? result : {};
    const byId: unknown = rec[promptId] ?? (isRecord(rec.data) ? rec.data[promptId] : undefined) ?? result;
    return interpretHistory(promptId, byId);
  }

  /** 读队列（running/pending 的 prompt_id 集合；非 2xx 即抛）。 */
  async queueIds(signal?: AbortSignal): Promise<{ running: string[]; pending: string[] }> {
    let response: Response;
    try {
      response = await this.request(`${this.baseUrl}/queue`, { headers: this.headers() }, signal);
    } catch (e) {
      throw new ComfyUIError(`ComfyUI queue 传输失败：${e instanceof Error ? e.message : String(e)}`, undefined, {});
    }
    const result = await parseJson(response);
    if (!response.ok) throw new ComfyUIError(`ComfyUI queue 失败 HTTP ${response.status}：${summarize(result)}`, response.status, {});
    const pick = (v: unknown): string[] => {
      if (!Array.isArray(v)) return [];
      return v
        .map((x) => {
          if (Array.isArray(x)) return String(x[1] ?? x[0] ?? "");
          if (isRecord(x)) return String(x.prompt_id ?? x.id ?? "");
          return String(x ?? "");
        })
        .filter((s) => s !== "");
    };
    const rec = isRecord(result) ? result : {};
    return { running: pick(rec.queue_running), pending: pick(rec.queue_pending) };
  }

  /** 中断（按服务端能力：非 2xx 即如实报错，不伪造成功）。 */
  async cancel(promptId: string, signal?: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await this.request(
        `${this.baseUrl}/queue`,
        { method: "POST", headers: this.headers({ "Content-Type": "application/json" }), body: JSON.stringify({ delete: [promptId] }) },
        signal,
      );
    } catch (e) {
      throw new ComfyUIError(`ComfyUI 中断传输失败：${e instanceof Error ? e.message : String(e)}`, undefined, { promptId });
    }
    if (!response.ok)
      throw new ComfyUIError(
        `ComfyUI 中断失败 HTTP ${response.status}（服务端可能不支持按任务删除）：${summarize(await parseJson(response))}`,
        response.status,
        { promptId },
      );
  }

  /** 产物下载（/view；JSON 错误体/空体即抛，不把错误对象写成媒体文件）。 */
  async download(output: RemoteOutput, destination: string, signal?: AbortSignal): Promise<string> {
    const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder, type: output.type });
    let response: Response;
    try {
      response = await this.request(`${this.baseUrl}/view?${query}`, { headers: this.headers() }, signal);
    } catch (e) {
      throw new ComfyUIError(`ComfyUI 下载传输失败：${e instanceof Error ? e.message : String(e)}`, undefined, { filename: output.filename });
    }
    if (!response.ok)
      throw new ComfyUIError(`ComfyUI 下载失败 HTTP ${response.status}：${summarize(await parseJson(response))}`, response.status, {
        filename: output.filename,
      });
    const buffer = Buffer.from(await response.arrayBuffer());
    const head = buffer.subarray(0, 512).toString("latin1").trimStart();
    if (head.startsWith("{")) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(head);
      } catch {
        parsed = null;
      }
      const message = isRecord(parsed) ? String(parsed.msg ?? parsed.message ?? parsed.error ?? head).slice(0, 500) : head.slice(0, 500);
      throw new ComfyUIError(`ComfyUI 下载返回错误载荷而非媒体：${message}`, undefined, { filename: output.filename });
    }
    if (buffer.length === 0) throw new ComfyUIError("ComfyUI 下载返回空体", undefined, { filename: output.filename });
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname, resolve } = await import("node:path");
    await mkdir(dirname(resolve(destination)), { recursive: true });
    await writeFile(destination, buffer);
    return destination;
  }
}

function interpretHistory(promptId: string, entry: unknown): HistoryEntry {
  if (!isRecord(entry)) return { found: false, completed: false, success: false, statusText: "not-found", outputs: [], raw: entry };
  const status = isRecord(entry.status) ? entry.status : {};
  const completed = status.completed === true;
  const statusStr = typeof status.status_str === "string" ? status.status_str : completed ? "success" : "running";
  const success = completed && statusStr === "success";
  const outputs: RemoteOutput[] = [];
  if (isRecord(entry.outputs)) {
    for (const [node, list] of Object.entries(entry.outputs)) {
      if (!isRecord(list)) continue;
      for (const key of OUTPUT_LIST_KEYS) {
        const arr = list[key];
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
          if (!isRecord(item) || typeof item.filename !== "string") continue;
          outputs.push({
            filename: item.filename,
            subfolder: typeof item.subfolder === "string" ? item.subfolder : "",
            type: typeof item.type === "string" ? item.type : "output",
            node,
            format: key,
          });
        }
      }
    }
  }
  void promptId;
  return { found: true, completed, success, statusText: completed ? statusStr : "running", outputs, raw: entry };
}
