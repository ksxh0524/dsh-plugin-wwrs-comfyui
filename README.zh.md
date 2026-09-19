# dsh-plugin-wwrs-comfyui

[English](./README.md)

远端 ComfyUI 工作流 DSH 插件（开源）：经远端 ComfyUI 做任务提交、状态查询、等待与中断；工作流模板随包发布。零运行时依赖。W3 已落地：`comfy_submit` / `comfy_status` / `comfy_wait` / `comfy_cancel` / `comfy_templates` 五工具已实现、有测试、全绿。

## 工具

先调 `comfy_templates`：模板必须显式指定，没有隐式默认模板。`overwrite` 缺省 `false`（产物已存在即短路返回 `state=exists`，不打远端）。

| 工具              | 参数                                                                       | 语义                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `comfy_submit`    | `template`、`params`、`outputPath`、`assets?`、`overwrite?`                | 预检不过不建任务；同输入命中同一 `taskId`，绝不重提远端（防重复计费）                                                                              |
| `comfy_status`    | `taskId`                                                                   | 只读状态摘要（`submitted\|pending\|running\|done\|failed\|cancelled\|unknown`）；不写文件                                                          |
| `comfy_wait`      | `taskId`、`until?`（`terminal`\|`submitted`）、`timeoutMs?`（缺省 120000） | 分段等待，永不 408：到点返回 `renewable=true` 由调用方循环续期；terminal 成功即下载首个产物到 `outputPath`；`exec.signal` 只中断等待，不动远端任务 |
| `comfy_cancel`    | `taskId`                                                                   | 按服务端能力删除；非 2xx 如实报错，不伪造成功；终态收据直接返回                                                                                    |
| `comfy_templates` | —                                                                          | 清单自描述（参数 schema + 资产槽 + 输出节点），共 10 模板                                                                                          |

提交串行：提交走进程内单条 promise 链（单 profile 并发=1 意图）。跨 profile、跨进程不保证串行——并发提交自负。本包只懂通用 ComfyUI 原语（模板/参数/任务 id/节点/产物）；正文字符串由调用方自备原文传入。

## 合同

ComfyUI 是 comfyanonymous 的开源项目，本包仅为其 DSH 接入客户端：直调 ComfyUI 原生 HTTP 接口（`/prompt`、`/history`、`/queue`、`/upload`、`/view`），未内嵌上游代码。鉴权 token 只来自环境变量 `COMFYUI_AUTH_TOKEN`，只进 `Authorization` 请求头——永不进日志、收据与产物。

`templates/` 内是运行时模板（随包发布的 API 格式 JSON + `templates/manifest.json` 登记表，共 10 模板）——不是新包起步件（起步件在索引仓根 `templates/`）。

## 配置

| 键               | 含义                                            | 缺省                                    |
| ---------------- | ----------------------------------------------- | --------------------------------------- |
| `workspace`      | 项目根（绝对路径）                              | `WWRS_WORKSPACE` 环境变量，再中性锚探测 |
| `comfyuiBaseUrl` | 远端 ComfyUI 基地址（注入面：配置键或环境变量） | `COMFYUI_BASE_URL` 环境变量，缺失即失败 |

工作区解析：`config.workspace` > 环境变量 `WWRS_WORKSPACE` > 向上探测 `.wwrs/workspace.json` > 大声失败。所有路径（产物、资产）必须用工作区相对路径；绝对路径或 `..` 逃逸一律拒收。任务收据落在工作区内 `.wwrs/comfy-tasks/<taskId>.json`（不含凭据）。缺失即大声失败并给出路；绝不静默降级。

## 安装

```json
{
  "dependencies": {
    "dsh-plugin-wwrs-comfyui": "link:/path/to/plugin-wwrs-comfyui"
  },
  "dsh": { "profile": { "bundles": ["dsh-plugin-wwrs-comfyui"] } }
}
```

## 验证

跑 `pnpm check`（prettier 检查 + `tsc --noEmit` + `node --test tests/*.test.ts`）。

## 无浏览器半

纯服务端工具——`pnpm check` 即全部门，无 `check:browser` 链。

## 已知边界

- 没有隐式默认模板——先调 `comfy_templates`，再显式传 `template`。
- 提交只串行进程内单条 promise 链；跨 profile、跨进程并发不保证串行。
- `comfy_wait` 永不挂住调用：到点返回 `renewable=true`，由调用方循环续期。
- `comfy_cancel` 按服务端能力删除；非 2xx 如实报错，不伪造成功。

## 许可

MIT.
