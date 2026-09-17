/** comfy-tools.test.ts —— 5 工具行为门（W3 落地）。
 *
 * 本地全覆盖：manifest↔模板文件同步 / 参数校验 / 资产预检 / overwrite 短路 /
 * 错误载荷 / 幂等不重提 / 状态推导 / 分段等待续期+下载 / 中断 / 守卫谓词 /
 * 工作区四级 / 凭据不落收据 / 工具合同形状。远端真链路仅在 env
 * COMFYUI_BASE_URL 存在时跑（缺即 skip，不删）。
 * 临时工作区一律 mkdtemp 于系统 tmp，不进任何仓库。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMFY_TOOL_NAMES, createComfyTools, type ToolFactoryConfig } from "../src/tools.ts";
import type { ToolDefinition } from "../src/lib/host.ts";
import { comfyuiGuardPredicate } from "../src/lib/guard-predicate.ts";
import { loadManifest, readWorkflowTemplate } from "../src/lib/manifest.ts";
import { resolveBaseUrl } from "../src/lib/comfy-client.ts";
import { resolveWwrsWorkspace } from "../src/lib/workspace.ts";

type ExecArgs = Record<string, unknown>;
type ToolResult = { verdict: string; summary: string; details: Record<string, unknown> };

// ---------- 测试脚手架 ----------

function makeWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "wwrs-comfy-"));
  mkdirSync(join(ws, "media"), { recursive: true });
  writeFileSync(join(ws, "media", "ref.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(ws, "media", "ref.mp3"), Buffer.from("ID3fake"));
  writeFileSync(join(ws, "media", "evil.txt"), "not-media");
  return ws;
}

type FakeRoute = { method: string; path: string; status: number; body: unknown };
type CallLog = { method: string; url: string };

/** 可编程远端替身（附调用日志；body 为 Uint8Array 时按二进制回）。 */
function makeFake(routes: FakeRoute[]): { fetch: (url: string, init: RequestInit) => Promise<Response>; calls: CallLog[] } {
  const calls: CallLog[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const method = String(init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    const path = new URL(url).pathname;
    const route = routes.find((r) => r.method === method && (path === r.path || path.endsWith(r.path)));
    if (!route) return new Response(JSON.stringify({ error: `no-route ${method} ${path}` }), { status: 404 });
    if (route.body instanceof Uint8Array) return new Response(route.body, { status: route.status });
    return new Response(JSON.stringify(route.body), { status: route.status });
  };
  return { fetch, calls };
}

const BASE = "http://127.0.0.1:9";
const PROMPT_ROUTES: FakeRoute[] = [
  { method: "POST", path: "/upload/image", status: 200, body: { name: "up-ref.png" } },
  { method: "POST", path: "/upload/audio", status: 200, body: { name: "up-ref.mp3" } },
  { method: "POST", path: "/prompt", status: 200, body: { prompt_id: "p-1" } },
  { method: "GET", path: "/history/p-1", status: 200, body: { "p-1": { status: { status_str: "success", completed: true }, outputs: {} } } },
  { method: "GET", path: "/queue", status: 200, body: { queue_running: [], queue_pending: [] } },
  { method: "POST", path: "/queue", status: 200, body: {} },
];

function localConfig(ws: string, fake: (url: string, init: RequestInit) => Promise<Response>, extraEnv: Record<string, string> = {}): ToolFactoryConfig {
  return { workspace: ws, comfyuiBaseUrl: BASE, env: { COMFYUI_BASE_URL: BASE, ...extraEnv }, transport: fake };
}

function toolsOf(config: ToolFactoryConfig): Record<string, ToolDefinition> {
  const out: Record<string, ToolDefinition> = {};
  for (const tool of createComfyTools(config)) out[tool.name] = tool;
  return out;
}

async function run(tool: ToolDefinition, args: ExecArgs): Promise<ToolResult> {
  return (await tool.execute(args, {})) as ToolResult;
}

const T2V = { template: "video-t2v", params: { prompt: "a cat walks", durationSec: 6 }, outputPath: "media/out.mp4" };

// ---------- 工具合同形状 ----------

test("5 工具齐备且输出带 render（缺 render 宿主 boot 期报）", () => {
  const tools = createComfyTools({ workspace: tmpdir(), comfyuiBaseUrl: BASE });
  assert.deepEqual(
    tools.map((t) => t.name),
    [...COMFY_TOOL_NAMES],
  );
  for (const tool of tools) {
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 20);
    assert.equal(typeof tool.execute, "function");
    assert.equal(typeof tool.output.render, "function");
    const rendered = tool.output.render({}, { summary: "hello" });
    assert.deepEqual(rendered, [{ type: "text", text: "hello" }]);
  }
});

// ---------- manifest 自描述与文件同步 ----------

test("comfy_templates 列出 10 模板且 manifest↔文件逐项对齐", async () => {
  const ws = makeWorkspace();
  const { fetch } = makeFake([]);
  const out = await run(toolsOf(localConfig(ws, fetch)).comfy_templates as ToolDefinition, {});
  assert.equal(out.verdict, "ok");
  const templates = out.details.templates as Array<{ name: string; file: string }>;
  assert.equal(templates.length, 10);
  const { manifest, dir } = loadManifest();
  for (const card of templates) {
    const entry = manifest.templates[card.name];
    assert.ok(entry, `manifest 缺 ${card.name}`);
    assert.ok(existsSync(join(dir, entry.file)), `模板文件缺失 ${entry.file}`);
    const wf = readWorkflowTemplate(dir, entry.file);
    for (const [key, spec] of Object.entries(entry.params)) {
      for (const target of spec.targets) {
        assert.ok(wf[target.node], `${card.name} 参数 ${key} 目标节点 ${target.node} 不存在`);
        assert.ok(target.input in wf[target.node].inputs, `${card.name} 参数 ${key} 目标输入 ${target.node}.${target.input} 不存在`);
      }
    }
    for (const [slot, spec] of Object.entries(entry.assets)) {
      if (spec.mode === "direct") {
        for (const loader of spec.loaders) {
          assert.ok(wf[loader.node], `${card.name} 槽 ${slot} 装载节点 ${loader.node} 不存在`);
          assert.ok(loader.input in wf[loader.node].inputs, `${card.name} 槽 ${slot} 装载输入 ${loader.node}.${loader.input} 不存在`);
        }
      } else {
        assert.ok(wf[spec.core.node], `${card.name} 槽 ${slot} 核心节点 ${spec.core.node} 不存在`);
        for (const loader of spec.loaders) assert.ok(wf[loader.node], `${card.name} 槽 ${slot} 装载节点 ${loader.node} 不存在`);
      }
    }
    for (const output of entry.outputs) assert.ok(wf[output.node], `${card.name} 输出节点 ${output.node} 不存在`);
  }
});

// ---------- 参数校验（预检不过不建任务：fetch 零调用） ----------

test("未知模板/缺必填/类型错/越界/枚举外/未知键一律 error 且零远端调用", async () => {
  const cases: ExecArgs[] = [
    { template: "no-such", params: {}, outputPath: "media/o.mp4" },
    { template: "video-t2v", params: { durationSec: 6 }, outputPath: "media/o.mp4" },
    { template: "video-t2v", params: { prompt: "x", durationSec: "6" }, outputPath: "media/o.mp4" },
    { template: "video-t2v", params: { prompt: "x", durationSec: 99 }, outputPath: "media/o.mp4" },
    { template: "video-t2v", params: { prompt: "x", durationSec: 6, aspect: "1:1" }, outputPath: "media/o.mp4" },
    { template: "video-t2v", params: { prompt: "x", durationSec: 6, nope: 1 }, outputPath: "media/o.mp4" },
    { template: "video-t2v", params: "not-object", outputPath: "media/o.mp4" },
  ];
  for (const args of cases) {
    const ws = makeWorkspace();
    const { fetch, calls } = makeFake(PROMPT_ROUTES);
    const out = await run(toolsOf(localConfig(ws, fetch)).comfy_submit as ToolDefinition, args);
    assert.equal(out.verdict, "error", JSON.stringify(args));
    assert.equal(calls.length, 0, `预检失败仍打远端：${JSON.stringify(args)}`);
  }
});

// ---------- 资产预检 ----------

test("资产缺失/格式错/数量错/未知槽一律 error 且零远端调用", async () => {
  const cases: ExecArgs[] = [
    { ...T2V, template: "video-i2v", params: { prompt: "x", durationSec: 6 }, assets: { firstFrame: ["media/gone.png"] }, outputPath: "media/o.mp4" },
    { ...T2V, template: "video-i2v", params: { prompt: "x", durationSec: 6 }, assets: { firstFrame: ["media/evil.txt"] }, outputPath: "media/o.mp4" },
    { ...T2V, template: "video-i2v", params: { prompt: "x", durationSec: 6 }, assets: {}, outputPath: "media/o.mp4" },
    {
      ...T2V,
      template: "video-i2v",
      params: { prompt: "x", durationSec: 6 },
      assets: { firstFrame: ["media/ref.png", "media/ref.png"] },
      outputPath: "media/o.mp4",
    },
    { ...T2V, assets: { nope: ["media/ref.png"] }, outputPath: "media/o.mp4" },
    {
      template: "image-edit",
      params: { prompt: "x" },
      assets: { refs: ["media/ref.png", "media/ref.png", "media/ref.png", "media/ref.png"] },
      outputPath: "media/o.png",
    },
  ];
  for (const args of cases) {
    const ws = makeWorkspace();
    const { fetch, calls } = makeFake(PROMPT_ROUTES);
    const tools = toolsOf(localConfig(ws, fetch));
    const out = await run(tools.comfy_submit as ToolDefinition, args);
    assert.equal(out.verdict, "error", JSON.stringify(args));
    assert.equal(calls.length, 0, `预检失败仍打远端：${JSON.stringify(args)}`);
  }
});

// ---------- 错误载荷 ----------

test("错误载荷四字段齐全（error/param/expected/example）", async () => {
  const ws = makeWorkspace();
  const { fetch } = makeFake(PROMPT_ROUTES);
  const out = await run(toolsOf(localConfig(ws, fetch)).comfy_submit as ToolDefinition, { template: "video-t2v", params: {}, outputPath: "media/o.mp4" });
  assert.equal(out.verdict, "error");
  for (const key of ["error", "param", "expected", "example"]) assert.ok(String(out.details[key] ?? "").length > 0, `缺 ${key}`);
  assert.match(String(out.details.error), /params\.prompt/);
});

// ---------- overwrite 短路 ----------

test("overwrite 缺省 false：产物已存在即短路，不建任务", async () => {
  const ws = makeWorkspace();
  writeFileSync(join(ws, "media", "out.mp4"), "old");
  const { fetch, calls } = makeFake(PROMPT_ROUTES);
  const out = await run(toolsOf(localConfig(ws, fetch)).comfy_submit as ToolDefinition, T2V);
  assert.equal(out.verdict, "ok");
  assert.equal(out.details.state, "exists");
  assert.equal(out.details.submitted, false);
  assert.equal(calls.length, 0);
  assert.equal(readFileSync(join(ws, "media", "out.mp4"), "utf8"), "old");
});

test("outputPath 为绝对路径/逃出工作区即 error", async () => {
  const ws = makeWorkspace();
  const { fetch, calls } = makeFake(PROMPT_ROUTES);
  const tools = toolsOf(localConfig(ws, fetch));
  for (const outputPath of ["/tmp/evil.mp4", "../evil.mp4"]) {
    const out = await run(tools.comfy_submit as ToolDefinition, { ...T2V, outputPath });
    assert.equal(out.verdict, "error", outputPath);
  }
  assert.equal(calls.length, 0);
});

// ---------- 提交成功 + 幂等 + 收据无凭据 ----------

test("提交成功写收据；同输入重提命中旧收据（/prompt 只打一次）；收据无 token", async () => {
  const ws = makeWorkspace();
  const { fetch, calls } = makeFake(PROMPT_ROUTES);
  const tools = toolsOf(localConfig(ws, fetch, { COMFYUI_AUTH_TOKEN: "secret-xyz" }));
  const first = await run(tools.comfy_submit as ToolDefinition, T2V);
  assert.equal(first.verdict, "pending");
  const taskId = String(first.details.taskId);
  assert.match(taskId, /^ct-[0-9a-f]{16}$/);
  assert.equal(first.details.promptId, "p-1");
  assert.equal(calls.filter((c) => c.url.endsWith("/prompt")).length, 1);
  const receiptPath = join(ws, ".wwrs", "comfy-tasks", `${taskId}.json`);
  assert.ok(existsSync(receiptPath));
  assert.ok(!readFileSync(receiptPath, "utf8").includes("secret-xyz"), "收据含 token");
  const second = await run(tools.comfy_submit as ToolDefinition, T2V);
  assert.equal(second.details.taskId, taskId);
  assert.equal(second.details.resumed, true);
  assert.equal(calls.filter((c) => c.url.endsWith("/prompt")).length, 1, "幂等命中仍重提");
});

test("带资产提交：上传→装配→提交链完整（i2v 首帧）", async () => {
  const ws = makeWorkspace();
  const { fetch, calls } = makeFake(PROMPT_ROUTES);
  const tools = toolsOf(localConfig(ws, fetch));
  const out = await run(tools.comfy_submit as ToolDefinition, {
    template: "video-i2v",
    params: { prompt: "x", durationSec: 6 },
    assets: { firstFrame: ["media/ref.png"] },
    outputPath: "media/i2v.mp4",
  });
  assert.equal(out.verdict, "pending");
  assert.ok(
    calls.some((c) => c.url.endsWith("/upload/image")),
    "未调上传",
  );
  assert.ok(
    calls.some((c) => c.url.endsWith("/prompt")),
    "未调提交",
  );
  assert.ok(calls.findIndex((c) => c.url.endsWith("/upload/image")) < calls.findIndex((c) => c.url.endsWith("/prompt")), "先传后提顺序错");
});

// ---------- 状态推导 ----------

test("comfy_status：done 只读不下载；running 带 renewable；未知任务 error", async () => {
  const ws = makeWorkspace();
  const { fetch } = makeFake(PROMPT_ROUTES);
  const tools = toolsOf(localConfig(ws, fetch));
  const sub = await run(tools.comfy_submit as ToolDefinition, T2V);
  const taskId = String(sub.details.taskId);
  const st = await run(tools.comfy_status as ToolDefinition, { taskId });
  assert.equal(st.details.state, "done");
  assert.equal(st.verdict, "ok");
  assert.equal(existsSync(join(ws, "media", "out.mp4")), false, "status 不该下载产物");
  const running = await run(tools.comfy_status as ToolDefinition, { taskId: "ct-0000000000000000" });
  assert.equal(running.verdict, "error");
});

test("comfy_status：在队任务报 running/pending 且 renewable", async () => {
  const ws = makeWorkspace();
  const routes: FakeRoute[] = [
    { method: "POST", path: "/prompt", status: 200, body: { prompt_id: "p-9" } },
    { method: "GET", path: "/history/p-9", status: 404, body: {} },
    { method: "GET", path: "/queue", status: 200, body: { queue_running: [["0", "p-9"]], queue_pending: [] } },
  ];
  const { fetch } = makeFake(routes);
  const tools = toolsOf(localConfig(ws, fetch));
  const sub = await run(tools.comfy_submit as ToolDefinition, T2V);
  const st = await run(tools.comfy_status as ToolDefinition, { taskId: String(sub.details.taskId) });
  assert.equal(st.details.state, "running");
  assert.equal(st.details.renewable, true);
});

// ---------- 分段等待 ----------

test("comfy_wait terminal：完成即下载首个产物到 outputPath", async () => {
  const ws = makeWorkspace();
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const routes: FakeRoute[] = [
    { method: "POST", path: "/prompt", status: 200, body: { prompt_id: "p-2" } },
    {
      method: "GET",
      path: "/history/p-2",
      status: 200,
      body: {
        "p-2": {
          status: { status_str: "success", completed: true },
          outputs: { 92: { videos: [{ filename: "wwrs_vid.mp4", subfolder: "wwrs/ct-x", type: "output" }] } },
        },
      },
    },
    { method: "GET", path: "/queue", status: 200, body: { queue_running: [], queue_pending: [] } },
    { method: "GET", path: "/view", status: 200, body: bytes },
  ];
  const { fetch } = makeFake(routes);
  const tools = toolsOf(localConfig(ws, fetch));
  const sub = await run(tools.comfy_submit as ToolDefinition, T2V);
  const waited = await run(tools.comfy_wait as ToolDefinition, { taskId: String(sub.details.taskId), timeoutMs: 15000 });
  assert.equal(waited.verdict, "ok");
  assert.deepEqual(new Uint8Array(readFileSync(join(ws, "media", "out.mp4"))), bytes);
});

test("comfy_wait：到点返回 renewable（永不 408）；signal 中断协作式返回", async () => {
  const ws = makeWorkspace();
  const routes: FakeRoute[] = [
    { method: "POST", path: "/prompt", status: 200, body: { prompt_id: "p-3" } },
    { method: "GET", path: "/history/p-3", status: 404, body: {} },
    { method: "GET", path: "/queue", status: 200, body: { queue_running: [], queue_pending: [["0", "p-3"]] } },
  ];
  const { fetch } = makeFake(routes);
  const tools = toolsOf(localConfig(ws, fetch));
  const sub = await run(tools.comfy_submit as ToolDefinition, T2V);
  const taskId = String(sub.details.taskId);
  const tool = tools.comfy_wait as ToolDefinition;
  const timeout = (await tool.execute({ taskId, timeoutMs: 50 }, {})) as ToolResult;
  assert.equal(timeout.verdict, "pending");
  assert.equal(timeout.details.renewable, true);
  const controller = new AbortController();
  controller.abort();
  const aborted = (await tool.execute({ taskId, timeoutMs: 15000 }, { signal: controller.signal })) as ToolResult;
  assert.equal(aborted.details.aborted, true);
  assert.equal(aborted.details.renewable, true);
});

test("comfy_wait until=submitted：远端可见即返", async () => {
  const ws = makeWorkspace();
  const routes: FakeRoute[] = [
    { method: "POST", path: "/prompt", status: 200, body: { prompt_id: "p-4" } },
    { method: "GET", path: "/history/p-4", status: 404, body: {} },
    { method: "GET", path: "/queue", status: 200, body: { queue_running: [], queue_pending: [["0", "p-4"]] } },
  ];
  const { fetch } = makeFake(routes);
  const tools = toolsOf(localConfig(ws, fetch));
  const sub = await run(tools.comfy_submit as ToolDefinition, T2V);
  const out = await run(tools.comfy_wait as ToolDefinition, { taskId: String(sub.details.taskId), until: "submitted", timeoutMs: 10000 });
  assert.equal(out.details.renewable, true);
});

// ---------- 中断 ----------

test("comfy_cancel：成功置 cancelled；终态幂等；未知任务 error", async () => {
  const ws = makeWorkspace();
  const routes: FakeRoute[] = [
    { method: "POST", path: "/prompt", status: 200, body: { prompt_id: "p-5" } },
    { method: "GET", path: "/history/p-5", status: 404, body: {} },
    { method: "GET", path: "/queue", status: 200, body: { queue_running: [["0", "p-5"]], queue_pending: [] } },
    { method: "POST", path: "/queue", status: 200, body: {} },
  ];
  const { fetch, calls } = makeFake(routes);
  const tools = toolsOf(localConfig(ws, fetch));
  const sub = await run(tools.comfy_submit as ToolDefinition, T2V);
  const taskId = String(sub.details.taskId);
  const cancelled = await run(tools.comfy_cancel as ToolDefinition, { taskId });
  assert.equal(cancelled.details.state, "cancelled");
  assert.ok(
    calls.some((c) => c.method === "POST" && c.url.endsWith("/queue")),
    "未调中断",
  );
  const again = await run(tools.comfy_cancel as ToolDefinition, { taskId });
  assert.equal(again.details.alreadyTerminal, true);
  const unknown = await run(tools.comfy_cancel as ToolDefinition, { taskId: "ct-ffffffffffffffff" });
  assert.equal(unknown.verdict, "error");
});

test("comfy_cancel：服务端拒绝如实 error（不伪造成功）", async () => {
  const ws = makeWorkspace();
  const routes: FakeRoute[] = [
    { method: "POST", path: "/prompt", status: 200, body: { prompt_id: "p-6" } },
    { method: "GET", path: "/history/p-6", status: 404, body: {} },
    { method: "GET", path: "/queue", status: 200, body: { queue_running: [["0", "p-6"]], queue_pending: [] } },
    { method: "POST", path: "/queue", status: 405, body: { error: "delete not supported" } },
  ];
  const { fetch } = makeFake(routes);
  const tools = toolsOf(localConfig(ws, fetch));
  const sub = await run(tools.comfy_submit as ToolDefinition, T2V);
  const out = await run(tools.comfy_cancel as ToolDefinition, { taskId: String(sub.details.taskId) });
  assert.equal(out.verdict, "error");
});

// ---------- 守卫谓词 ----------

test("守卫：绝对路径/.. 拒收，相对放行，非本包工具放行", () => {
  assert.match(String(comfyuiGuardPredicate({ name: "comfy_submit", arguments: { template: "video-t2v", outputPath: "/tmp/x.mp4" } })), /守卫拒收/);
  assert.match(String(comfyuiGuardPredicate({ name: "comfy_submit", arguments: { template: "video-t2v", outputPath: "../x.mp4" } })), /守卫拒收/);
  assert.match(
    String(comfyuiGuardPredicate({ name: "comfy_submit", arguments: { template: "video-t2v", outputPath: "media/x.mp4", assets: { refs: ["/abs.png"] } } })),
    /守卫拒收/,
  );
  assert.equal(comfyuiGuardPredicate({ name: "comfy_submit", arguments: { template: "video-t2v", outputPath: "media/x.mp4" } }), undefined);
  assert.equal(comfyuiGuardPredicate({ name: "comfy_status", arguments: { taskId: "ct-1" } }), undefined);
  assert.equal(comfyuiGuardPredicate({ name: "other_tool", arguments: {} }), undefined);
});

// ---------- 工作区与基地址 ----------

test("工作区四级：config > env > 中性锚 > fail-loud", () => {
  const ws = makeWorkspace();
  assert.equal(resolveWwrsWorkspace("/nonexistent-start", { configWorkspace: ws }), ws);
  assert.equal(resolveWwrsWorkspace("/nonexistent-start", { env: { COMFYUI_BASE_URL: BASE, WWRS_WORKSPACE: ws } }), ws);
  const child = join(ws, "a", "b");
  mkdirSync(child, { recursive: true });
  mkdirSync(join(ws, ".wwrs"), { recursive: true });
  writeFileSync(join(ws, ".wwrs", "workspace.json"), JSON.stringify({ root: ws }));
  assert.equal(resolveWwrsWorkspace(child, { env: {} }), ws);
  assert.throws(() => resolveWwrsWorkspace(tmpdir(), { env: {} }), /工作区未找到/);
});

test("基地址缺失 fail-loud 点名 COMFYUI_BASE_URL", () => {
  assert.throws(() => resolveBaseUrl({ env: {} }), /COMFYUI_BASE_URL/);
  assert.equal(resolveBaseUrl({ env: { COMFYUI_BASE_URL: `${BASE}/` } }), BASE);
});

// ---------- 远端真链路（门控：缺 COMFYUI_BASE_URL 即 skip） ----------

const HAS_REMOTE = Boolean(process.env.COMFYUI_BASE_URL);

test("远端真链路：templates 可读 + 提交非法模板被服务端前本地拦截", { skip: !HAS_REMOTE }, async () => {
  const ws = makeWorkspace();
  const tools = toolsOf({ workspace: ws });
  const list = (await tools.comfy_templates.execute({}, {})) as ToolResult;
  assert.equal(list.verdict, "ok");
  const bad = (await tools.comfy_submit.execute({ template: "no-such", params: {}, outputPath: "media/o.mp4" }, {})) as ToolResult;
  assert.equal(bad.verdict, "error");
});

test("远端真链路：image-base 端到端提交→等待→产物落盘", { skip: !HAS_REMOTE }, async () => {
  const ws = makeWorkspace();
  const tools = toolsOf({ workspace: ws });
  const sub = (await tools.comfy_submit.execute(
    { template: "image-base", params: { prompt: "a red circle icon" }, outputPath: "media/remote.png" },
    {},
  )) as ToolResult;
  assert.equal(sub.verdict, "pending");
  const taskId = String(sub.details.taskId);
  let verdict = "";
  for (let i = 0; i < 40; i++) {
    const waited = (await tools.comfy_wait.execute({ taskId, timeoutMs: 60000 }, {})) as ToolResult;
    verdict = waited.verdict;
    if (verdict === "ok") break;
    if (verdict === "error") assert.fail(`远端任务失败：${waited.summary}`);
    assert.equal(waited.details.renewable, true);
  }
  assert.equal(verdict, "ok");
  assert.ok(existsSync(join(ws, "media", "remote.png")));
});
