/** manifest.ts —— 模板清单装载 + 参数校验 + 工作流冻结/注入（包内单源）。
 *
 * 设计意图：本包只懂 ComfyUI 原语（template/params/assets/outputs）。模板文件随包
 * `templates/` 发布，`templates/manifest.json` 登记 模板名→文件→参数 schema→资产槽
 * 位→输出节点——本包能力清单以 manifest 为准，不引用任何业务路由 id。
 * 参数注入是声明式的：manifest 的 targets 描述"参数值写到哪个节点的哪个输入"，
 * 三种 target 形态见 ParamTarget 注释。调用方必须显式指定模板，无默认模板隐式链。
 *
 * 零业务名词：数值限额（如时长/字节/数量上限）是模板级通用约束，注释与报错只谈
 * "模板约束"，不谈上游业务含义。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FailLoudError } from "./errors.ts";

// ---------- 基础类型 ----------

export type WorkflowNode = { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } };
export type ComfyWorkflow = Record<string, WorkflowNode>;

/** 参数值写入形态：value=直接写字面量；aspectSize=按 aspect 查 sizeMap 取 axis 维；aspectLabel=按 aspect 查 labelMap。 */
export type ParamTarget =
  | { node: string; input: string; from?: "value" }
  | { node: string; input: string; from: "aspectSize"; axis: 0 | 1 }
  | { node: string; input: string; from: "aspectLabel" };

export type ParamSpec = {
  type: "string" | "integer" | "number" | "boolean";
  required?: boolean;
  default?: string | number | boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  enum?: Array<string | number>;
  sizeMap?: Record<string, [number, number]>;
  labelMap?: Record<string, string>;
  targets: ParamTarget[];
  description?: string;
};

/** 直接挂载型资产槽（槽位=模板内固定 LoadX 节点；不够的由 dropInputs/dropNodes 摘除）。 */
export type DirectAssetSlot = {
  mode: "direct";
  kind: "image" | "audio" | "video";
  min: number;
  max: number;
  loaders: Array<{ node: string; input: string }>;
  /** 缺槽时同步摘除的引用输入（input 支持 {i} = 1-based 缺槽序号）。 */
  dropInputs?: Array<{ node: string; input: string }>;
  /** 缺槽时级联删除的节点（key=loader node，value=随之删除的适配节点）。 */
  dropNodes?: Record<string, string[]>;
  formats?: string[];
  maxBytes?: number;
  totalMaxBytes?: number;
};

/** 核心聚合型资产槽（槽位=核心节点的 ref_images.ref_image_{i} / ref_audios.ref_audio_{i} 前缀输入；
 * 首批复用 loaders 内固定节点，超出的合成 LoadX 节点 asset-{slot}-{i}）。 */
export type CoreAssetSlot = {
  mode: "core";
  kind: "image" | "audio" | "video";
  min: number;
  max: number;
  core: { node: string; inputPrefix: string };
  loaders: Array<{ node: string; input: string }>;
  loaderClass: string;
  loaderInput: string;
  formats?: string[];
  maxBytes?: number;
  totalMaxBytes?: number;
};

export type AssetSlot = DirectAssetSlot | CoreAssetSlot;

export type OutputSelector = { node: string; kind: "image" | "audio" | "video" };

export type TemplateEntry = {
  file: string;
  kind: "image" | "audio" | "video";
  description: string;
  params: Record<string, ParamSpec>;
  assets: Record<string, AssetSlot>;
  outputs: OutputSelector[];
};

export type TemplateManifest = { version: 1; templates: Record<string, TemplateEntry> };

// ---------- 装载 ----------

/** 包内 templates/ 目录（相对本文件向上两级；宿主直载源码，产物永远是源码本身）。 */
export function packageTemplatesDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");
}

export function manifestPath(dir?: string): string {
  return join(dir ?? packageTemplatesDir(), "manifest.json");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** manifest 结构校验（形状不对即 fail-loud 点名文件，不静默半载）。 */
export function parseManifest(raw: unknown, source: string): TemplateManifest {
  if (!isRecord(raw) || !isRecord(raw.templates) || Object.keys(raw.templates).length === 0) {
    throw new FailLoudError({
      error: `[模板清单损坏] ${source} 缺 templates 非空映射`,
      param: "template",
      expected: "manifest.json 含 version/templates，模板名→文件→参数 schema",
      example: "comfy_templates 查可用模板名",
    });
  }
  const out: Record<string, TemplateEntry> = {};
  for (const [name, e] of Object.entries(raw.templates)) {
    if (!isRecord(e) || typeof e.file !== "string" || !e.file) {
      throw new FailLoudError({
        error: `[模板清单损坏] ${source} 模板 ${name} 缺 file`,
        param: "template",
        expected: "每模板登记 file 文件名",
        example: "comfy_templates 查可用模板名",
      });
    }
    if (!isRecord(e.params) || !isRecord(e.assets) || !Array.isArray(e.outputs) || e.outputs.length === 0) {
      throw new FailLoudError({
        error: `[模板清单损坏] ${source} 模板 ${name} 缺 params/assets/outputs`,
        param: "template",
        expected: "每模板登记 params（参数 schema）+ assets（资产槽）+ outputs（输出节点）",
        example: "comfy_templates 查可用模板名",
      });
    }
    out[name] = e as unknown as TemplateEntry;
  }
  return { version: 1, templates: out };
}

export function loadManifest(dir?: string): { manifest: TemplateManifest; dir: string } {
  const d = dir ?? packageTemplatesDir();
  const path = join(d, "manifest.json");
  if (!existsSync(path)) {
    throw new FailLoudError({
      error: `[模板清单缺失] ${path} 不存在`,
      param: "template",
      expected: "随包发布的 templates/manifest.json",
      example: "comfy_templates 查可用模板名",
    });
  }
  return { manifest: parseManifest(JSON.parse(readFileSync(path, "utf8")), path), dir: d };
}

export function getTemplate(manifest: TemplateManifest, name: string): TemplateEntry {
  const entry = manifest.templates[name];
  if (!entry) {
    throw new FailLoudError({
      error: `[未知模板] ${JSON.stringify(name)} 不在清单里（可用：${Object.keys(manifest.templates).join(" / ") || "（空）"}）`,
      param: "template",
      expected: `manifest 已登记模板名（${Object.keys(manifest.templates).join(" / ") || "（空）"}）`,
      example: "comfy_templates 查完整清单",
    });
  }
  return entry;
}

/** 读模板工作流文件（BOM 容忍；非对象/空即 fail-loud）。 */
export function readWorkflowTemplate(dir: string, file: string): ComfyWorkflow {
  const path = join(dir, file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new FailLoudError({
      error: `[模板读盘失败] ${path}：${e instanceof Error ? e.message : String(e)}`,
      param: "template",
      expected: "合法 JSON 的 API 格式工作流",
      example: "comfy_templates 查可用模板名",
    });
  }
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    throw new FailLoudError({
      error: `[模板为空] ${path} 无节点`,
      param: "template",
      expected: "非空 API 格式工作流对象",
      example: "comfy_templates 查可用模板名",
    });
  }
  return raw as unknown as ComfyWorkflow;
}

// ---------- 稳定序列化与哈希（冻结审计用） ----------

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(rec[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

// ---------- 参数校验与注入 ----------

function isLink(v: unknown): v is [string, number] {
  return Array.isArray(v) && typeof v[0] === "string" && Number.isInteger(v[1]);
}

/** 校验 params（缺必填/类型错/越界/枚举外即抛；返回补 default 后的有效值）。禁未知参数（拼写漂移早暴露）。 */
export function validateParams(entry: TemplateEntry, templateName: string, raw: unknown): Record<string, string | number | boolean> {
  if (!isRecord(raw)) {
    throw new FailLoudError({
      error: `[参数非法] template=${templateName} 的 params 须为对象`,
      param: "params",
      expected: "对象（键见模板参数表）",
      example: "comfy_templates 查参数表",
    });
  }
  const specs = entry.params;
  for (const key of Object.keys(raw)) {
    if (!(key in specs)) {
      throw new FailLoudError({
        error: `[未知参数] template=${templateName} 无参数 ${JSON.stringify(key)}（可用：${Object.keys(specs).join(" / ") || "（无）"}）`,
        param: `params.${key}`,
        expected: `模板参数之一（${Object.keys(specs).join(" / ") || "（无）"}）`,
        example: "comfy_templates 查参数表",
      });
    }
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const has = raw[key] !== undefined && raw[key] !== null;
    if (!has) {
      if (spec.required) {
        throw new FailLoudError({
          error: `[缺必填参数] template=${templateName} 缺 params.${key}${spec.description ? `（${spec.description}）` : ""}`,
          param: `params.${key}`,
          expected: specDescription(spec),
          example: "comfy_templates 查参数表",
        });
      }
      if (spec.default !== undefined) out[key] = spec.default;
      continue;
    }
    out[key] = checkParamValue(templateName, key, spec, raw[key]);
  }
  return out;
}

function specDescription(spec: ParamSpec): string {
  const bits: string[] = [spec.type];
  if (spec.enum) bits.push(`枚举 ${spec.enum.map((v) => JSON.stringify(v)).join("/")}`);
  if (spec.min !== undefined || spec.max !== undefined) bits.push(`范围 ${spec.min ?? "-∞"}..${spec.max ?? "+∞"}`);
  if (spec.minLength !== undefined || spec.maxLength !== undefined) bits.push(`长度 ${spec.minLength ?? 0}..${spec.maxLength ?? "∞"}`);
  return bits.join("；");
}

function checkParamValue(templateName: string, key: string, spec: ParamSpec, value: unknown): string | number | boolean {
  const param = `params.${key}`;
  const expected = specDescription(spec);
  if (spec.type === "string") {
    if (typeof value !== "string")
      throw new FailLoudError({ error: `[参数类型错] template=${templateName} 的 ${param} 须为 string`, param, expected, example: "comfy_templates 查参数表" });
    const s = value;
    if (spec.minLength !== undefined && s.length < spec.minLength)
      throw new FailLoudError({ error: `[参数越界] ${param} 长度 ${s.length} < 最小 ${spec.minLength}`, param, expected, example: "comfy_templates 查参数表" });
    if (spec.maxLength !== undefined && s.length > spec.maxLength)
      throw new FailLoudError({ error: `[参数越界] ${param} 长度 ${s.length} > 最大 ${spec.maxLength}`, param, expected, example: "comfy_templates 查参数表" });
    if (spec.enum && !spec.enum.includes(s))
      throw new FailLoudError({
        error: `[参数枚举外] ${param}=${JSON.stringify(s)} 不在 ${spec.enum.map((v) => JSON.stringify(v)).join("/")} 内`,
        param,
        expected,
        example: "comfy_templates 查参数表",
      });
    return s;
  }
  if (spec.type === "integer" || spec.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || (spec.type === "integer" && !Number.isInteger(value))) {
      throw new FailLoudError({
        error: `[参数类型错] template=${templateName} 的 ${param} 须为 ${spec.type}，收到 ${JSON.stringify(value)}`,
        param,
        expected,
        example: "comfy_templates 查参数表",
      });
    }
    if (spec.min !== undefined && value < spec.min)
      throw new FailLoudError({ error: `[参数越界] ${param}=${value} < 最小 ${spec.min}`, param, expected, example: "comfy_templates 查参数表" });
    if (spec.max !== undefined && value > spec.max)
      throw new FailLoudError({ error: `[参数越界] ${param}=${value} > 最大 ${spec.max}`, param, expected, example: "comfy_templates 查参数表" });
    if (spec.enum && !spec.enum.includes(value))
      throw new FailLoudError({ error: `[参数枚举外] ${param}=${value} 不在 ${spec.enum.join("/")} 内`, param, expected, example: "comfy_templates 查参数表" });
    return value;
  }
  if (typeof value !== "boolean")
    throw new FailLoudError({ error: `[参数类型错] template=${templateName} 的 ${param} 须为 boolean`, param, expected, example: "comfy_templates 查参数表" });
  return value;
}

/** 参数注入：按 targets 把有效值写入工作流节点（缺节点/缺输入即抛，不静默跳过）。 */
export function applyParams(workflow: ComfyWorkflow, entry: TemplateEntry, values: Record<string, string | number | boolean>): void {
  for (const [key, spec] of Object.entries(entry.params)) {
    const value = values[key];
    if (value === undefined) continue;
    for (const target of spec.targets) {
      const node = workflow[target.node];
      if (!node || typeof node.class_type !== "string" || !node.inputs || typeof node.inputs !== "object") {
        throw new FailLoudError({
          error: `[模板节点缺失] 参数 ${key} 的目标节点 ${target.node} 不在工作流里`,
          param: `params.${key}`,
          expected: "manifest targets 与模板文件同步",
          example: "comfy_templates 查参数表",
        });
      }
      if (target.from === undefined || target.from === "value") {
        node.inputs[target.input] = value;
      } else if (target.from === "aspectSize") {
        const pair = spec.sizeMap?.[String(value)];
        if (!pair)
          throw new FailLoudError({
            error: `[模板映射缺失] 参数 ${key}=${JSON.stringify(value)} 无 sizeMap`,
            param: `params.${key}`,
            expected: "manifest sizeMap 覆盖全部枚举",
            example: "comfy_templates 查参数表",
          });
        node.inputs[target.input] = target.axis === 1 ? pair[1] : pair[0];
      } else {
        const label = spec.labelMap?.[String(value)];
        if (label === undefined)
          throw new FailLoudError({
            error: `[模板映射缺失] 参数 ${key}=${JSON.stringify(value)} 无 labelMap`,
            param: `params.${key}`,
            expected: "manifest labelMap 覆盖全部枚举",
            example: "comfy_templates 查参数表",
          });
        node.inputs[target.input] = label;
      }
    }
  }
}

// ---------- 资产槽位装配（uploaded 名 → 工作流输入） ----------

/** uploaded: slot 名 → 已上传远端文件名（顺序与调用方 assets 数组一致）。 */
export function applyAssets(workflow: ComfyWorkflow, entry: TemplateEntry, uploaded: Record<string, string[]>): void {
  for (const [slotName, slot] of Object.entries(entry.assets)) {
    const names = uploaded[slotName] ?? [];
    if (names.length < slot.min || names.length > slot.max) {
      throw new FailLoudError({
        error: `[资产数量错] 槽位 ${slotName} 需 ${slot.min}..${slot.max} 个，收到 ${names.length} 个`,
        param: `assets.${slotName}`,
        expected: `${slot.min}..${slot.max} 个 ${slot.kind} 文件（工作区相对路径）`,
        example: "comfy_templates 查资产槽表",
      });
    }
    if (slot.mode === "direct") applyDirectSlot(workflow, slotName, slot, names);
    else applyCoreSlot(workflow, slotName, slot, names);
  }
}

function setLoaderInput(workflow: ComfyWorkflow, nodeId: string, input: string, remoteName: string, slotName: string): void {
  const node = workflow[nodeId];
  if (!node || !node.inputs || typeof node.inputs !== "object" || !(input in node.inputs)) {
    throw new FailLoudError({
      error: `[模板节点缺失] 槽位 ${slotName} 的装载点 ${nodeId}.${input} 不在工作流里`,
      param: `assets.${slotName}`,
      expected: "manifest loaders 与模板文件同步",
      example: "comfy_templates 查资产槽表",
    });
  }
  node.inputs[input] = remoteName;
}

function applyDirectSlot(workflow: ComfyWorkflow, slotName: string, slot: DirectAssetSlot, names: string[]): void {
  names.forEach((remoteName, i) => {
    const loader = slot.loaders[i];
    if (!loader)
      throw new FailLoudError({
        error: `[资产槽位不足] 槽位 ${slotName} 第 ${i + 1} 个文件无装载点`,
        param: `assets.${slotName}`,
        expected: `≤${slot.loaders.length} 个（模板装载点数）`,
        example: "comfy_templates 查资产槽表",
      });
    setLoaderInput(workflow, loader.node, loader.input, remoteName, slotName);
  });
  // 缺槽摘除（1-based 序号代入 {i}）：先删引用输入，再删 loader 与级联适配节点。
  for (let i = names.length; i < slot.loaders.length; i++) {
    const seq = String(i + 1);
    for (const drop of slot.dropInputs ?? []) {
      const node = workflow[drop.node];
      if (node && node.inputs && typeof node.inputs === "object") delete node.inputs[drop.input.replace("{i}", seq)];
    }
    const loader = slot.loaders[i];
    if (loader) {
      for (const extra of slot.dropNodes?.[loader.node] ?? []) delete workflow[extra];
      delete workflow[loader.node];
    }
  }
}

function applyCoreSlot(workflow: ComfyWorkflow, slotName: string, slot: CoreAssetSlot, names: string[]): void {
  const core = workflow[slot.core.node];
  if (!core || !core.inputs || typeof core.inputs !== "object") {
    throw new FailLoudError({
      error: `[模板节点缺失] 槽位 ${slotName} 的核心节点 ${slot.core.node} 不在工作流里`,
      param: `assets.${slotName}`,
      expected: "manifest core 与模板文件同步",
      example: "comfy_templates 查资产槽表",
    });
  }
  names.forEach((remoteName, i) => {
    const key = `${slot.core.inputPrefix}${i}`;
    const loader = slot.loaders[i];
    if (loader) {
      setLoaderInput(workflow, loader.node, loader.input, remoteName, slotName);
      core.inputs[key] = [loader.node, 0];
    } else {
      const synth = `asset-${slotName}-${i}`;
      workflow[synth] = { class_type: slot.loaderClass, inputs: { [slot.loaderInput]: remoteName } };
      core.inputs[key] = [synth, 0];
    }
  });
  // 超额槽位摘除：只动本槽管理的 loader（固定 loader 且为装载类节点才删，不碰模板其它引用）。
  // 工作流每次从模板文件现读，存量 wiring 即模板自带 wiring；names 之后的序号位逐个摘除。
  for (let i = names.length; i < slot.max + slot.loaders.length; i++) {
    const key = `${slot.core.inputPrefix}${i}`;
    if (!(key in core.inputs)) continue;
    const link = core.inputs[key];
    delete core.inputs[key];
    if (isLink(link)) {
      const loader = slot.loaders.find((l) => l.node === link[0]);
      const node = loader ? workflow[loader.node] : undefined;
      if (loader && node && (node.class_type === "LoadImage" || node.class_type === "LoadAudio" || node.class_type === "LoadVideo"))
        delete workflow[loader.node];
    }
  }
}

// ---------- 冻结前结构校验（提交前最后一道本地门） ----------

function reachableNodes(workflow: ComfyWorkflow, outputNode: string): Set<string> {
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id) || !workflow[id]) return;
    seen.add(id);
    for (const value of Object.values(workflow[id].inputs)) {
      if (isLink(value)) visit(value[0]);
      else if (Array.isArray(value)) for (const item of value) if (isLink(item)) visit(item[0]);
    }
  };
  visit(outputNode);
  return seen;
}

/** 工作流结构校验：非空节点 + 输出选择器合法 + 资产装载点可达。 */
export function validateWorkflow(workflow: ComfyWorkflow, entry: TemplateEntry, assets: Record<string, Array<{ nodeId: string; inputName: string }>>): void {
  if (!workflow || Object.keys(workflow).length === 0)
    throw new FailLoudError({ error: "[工作流为空] 注入后工作流无节点", param: "template", expected: "非空工作流", example: "comfy_templates 查可用模板名" });
  for (const [id, node] of Object.entries(workflow)) {
    if (!node || typeof node.class_type !== "string" || !node.class_type || !node.inputs || typeof node.inputs !== "object") {
      throw new FailLoudError({
        error: `[工作流节点非法] 节点 ${id} 缺 class_type/inputs`,
        param: "template",
        expected: "每节点含 class_type 与 inputs 对象",
        example: "comfy_templates 查可用模板名",
      });
    }
  }
  if (entry.outputs.length === 0)
    throw new FailLoudError({ error: "[模板无输出] outputs 为空", param: "template", expected: "≥1 个输出选择器", example: "comfy_templates 查可用模板名" });
  for (const output of entry.outputs) {
    const node = workflow[output.node];
    if (!node)
      throw new FailLoudError({
        error: `[输出节点缺失] ${output.node} 不在工作流里`,
        param: "template",
        expected: "manifest outputs 与模板文件同步",
        example: "comfy_templates 查可用模板名",
      });
    if (
      !/^(Save|Preview|VHS_).*?(Image|Video|Audio|GIF|Combine)/i.test(node.class_type) &&
      !["SaveImage", "SaveVideo", "SaveAudio", "SaveAudioAdvanced"].includes(node.class_type)
    ) {
      throw new FailLoudError({
        error: `[输出节点非法] ${output.node} 是 ${node.class_type}，非保存/输出类节点`,
        param: "template",
        expected: "输出选择器指向保存类节点",
        example: "comfy_templates 查可用模板名",
      });
    }
    const reachable = reachableNodes(workflow, output.node);
    for (const list of Object.values(assets)) {
      for (const asset of list) {
        if (asset.nodeId === output.node) continue;
        if (!reachable.has(asset.nodeId))
          throw new FailLoudError({
            error: `[资产不可达] ${asset.nodeId} 到输出 ${output.node} 无链路`,
            param: "assets",
            expected: "资产装载点须在输出上游",
            example: "comfy_templates 查资产槽表",
          });
        const target = workflow[asset.nodeId];
        if (!target || !(asset.inputName in target.inputs))
          throw new FailLoudError({
            error: `[资产装载点缺失] ${asset.nodeId}.${asset.inputName} 不存在`,
            param: "assets",
            expected: "manifest loaders 与模板文件同步",
            example: "comfy_templates 查资产槽表",
          });
      }
    }
  }
}

/** 输出 filename_prefix 改写（产物归集前缀，形如 wwrs/<taskId>）。 */
export function applyFilenamePrefix(workflow: ComfyWorkflow, entry: TemplateEntry, prefix: string): void {
  for (const output of entry.outputs) {
    const node = workflow[output.node];
    if (node && node.inputs && typeof node.inputs === "object" && "filename_prefix" in node.inputs) node.inputs.filename_prefix = prefix;
  }
}
