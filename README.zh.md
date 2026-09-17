# dsh-plugin-wwrs-comfyui

远端 ComfyUI 工作流 DSH 插件（开源）：经远端 ComfyUI 做任务提交、状态查询与等待；工作流模板随包发布。零运行时依赖。

## 状态

W0 空壳：挂载层（`src/cordis.ts`）、守卫壳与标准门已绿。工具实现在 W1 落地。

## 安装

```json
{
  "dependencies": {
    "dsh-plugin-wwrs-comfyui": "link:/path/to/plugin-wwrs-comfyui"
  },
  "dsh": { "profile": { "bundles": ["dsh-plugin-wwrs-comfyui"] } }
}
```

## 配置

| 键               | 含义                | 缺省                                    |
| ---------------- | ------------------- | --------------------------------------- |
| `workspace`      | 项目根（绝对路径）  | `WWRS_WORKSPACE` 环境变量，再中性锚探测 |
| `comfyuiBaseUrl` | 远端 ComfyUI 基地址 | `COMFYUI_BASE_URL` 环境变量，缺失即失败 |

基地址缺失即大声失败并给出路；绝不静默降级。

## 工具（W1）

`comfy_submit` / `comfy_status` / `comfy_wait` / `comfy_cancel` / `comfy_templates`。

## 许可

MIT.
