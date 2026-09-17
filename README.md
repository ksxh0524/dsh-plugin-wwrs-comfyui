# dsh-plugin-wwrs-comfyui

Remote ComfyUI workflow DSH plugin (open source): submit, query, wait, and cancel tasks over a remote ComfyUI server; workflow templates ship with the package. Zero runtime dependencies.

## Status

W3 landed: `comfy_submit` / `comfy_status` / `comfy_wait` / `comfy_cancel` / `comfy_templates` are implemented, tested, and green.

## Upstream

ComfyUI is an open-source project by comfyanonymous. This package is only a DSH access client for it: it speaks the native ComfyUI HTTP API (`/prompt`, `/history`, `/queue`, `/upload`, `/view`) and ships API-format workflow templates alongside a `templates/manifest.json` registry. No upstream code is vendored.

## Install

```json
{
  "dependencies": {
    "dsh-plugin-wwrs-comfyui": "link:/path/to/plugin-wwrs-comfyui"
  },
  "dsh": { "profile": { "bundles": ["dsh-plugin-wwrs-comfyui"] } }
}
```

## Config

| Key              | Meaning                      | Default                                         |
| ---------------- | ---------------------------- | ----------------------------------------------- |
| `workspace`      | Project root (absolute path) | `WWRS_WORKSPACE` env, then neutral-anchor probe |
| `comfyuiBaseUrl` | Remote ComfyUI base URL      | `COMFYUI_BASE_URL` env, missing fails loud      |

Missing base URL fails loud with two ways out; never silently degrade. The auth token only comes from env `COMFYUI_AUTH_TOKEN` and only ever travels in the `Authorization` header — it never enters logs, receipts, or artifacts.

Workspace resolution: `config.workspace` > env `WWRS_WORKSPACE` > upward probe for `.wwrs/workspace.json` > fail loud. All paths (output, assets) must be workspace-relative; absolute or escaping (`..`) paths are rejected. Task receipts live at `.wwrs/comfy-tasks/<taskId>.json` inside the workspace (no credentials inside).

## Tools

Call `comfy_templates` first: the template must be explicit, there is no implicit default template. `overwrite` defaults to `false` (existing output short-circuits the submit with `state=exists`, no server call).

| Tool              | Params                                                      | Semantics                                                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `comfy_submit`    | `template`, `params`, `outputPath`, `assets?`, `overwrite?` | Preflight failures never reach the server; same inputs hit the same `taskId` and never resubmit (no double billing)                                                                                                        |
| `comfy_status`    | `taskId`                                                    | Read-only state summary (`submitted\|pending\|running\|done\|failed\|cancelled\|unknown`); never writes files                                                                                                              |
| `comfy_wait`      | `taskId`, `until?` (`terminal`\|`submitted`), `timeoutMs?`  | Segmented wait, never 408s: on budget expiry returns `renewable=true` for the caller to loop; terminal success downloads the first artifact to `outputPath`; `exec.signal` only interrupts the wait, never the remote task |
| `comfy_cancel`    | `taskId`                                                    | Server-capability delete; non-2xx is reported honestly, never faked; terminal receipts return as-is                                                                                                                        |
| `comfy_templates` | —                                                           | Manifest registry (params schema + asset slots + output nodes), 10 templates                                                                                                                                               |

Serial submission: submissions run through one in-process promise chain (single-profile concurrency-1 intent). Cross-profile and cross-process concurrency is not serialized — concurrent submitters are on their own. Only generic ComfyUI primitives are understood here (template/params/promptId/nodes/artifacts); prompt bodies are caller-owned verbatim strings.

## License

MIT.
