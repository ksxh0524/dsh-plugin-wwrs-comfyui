# dsh-plugin-wwrs-comfyui

[中文](./README.zh.md)

Remote ComfyUI workflow DSH plugin (open source): submit, query, wait, and cancel tasks over a remote ComfyUI server; workflow templates ship with the package. Zero runtime dependencies. W3 landed: `comfy_submit` / `comfy_status` / `comfy_wait` / `comfy_cancel` / `comfy_templates` are implemented, tested, and green.

## Tools

Call `comfy_templates` first: the template must be explicit, there is no implicit default template. `overwrite` defaults to `false` (existing output short-circuits the submit with `state=exists`, no server call).

| Tool              | Params                                                                      | Semantics                                                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `comfy_submit`    | `template`, `params`, `outputPath`, `assets?`, `overwrite?`                 | Preflight failures never reach the server; same inputs hit the same `taskId` and never resubmit (no double billing)                                                                                                        |
| `comfy_status`    | `taskId`                                                                    | Read-only state summary (`submitted\|pending\|running\|done\|failed\|cancelled\|unknown`); never writes files                                                                                                              |
| `comfy_wait`      | `taskId`, `until?` (`terminal`\|`submitted`), `timeoutMs?` (default 120000) | Segmented wait, never 408s: on budget expiry returns `renewable=true` for the caller to loop; terminal success downloads the first artifact to `outputPath`; `exec.signal` only interrupts the wait, never the remote task |
| `comfy_cancel`    | `taskId`                                                                    | Server-capability delete; non-2xx is reported honestly, never faked; terminal receipts return as-is                                                                                                                        |
| `comfy_templates` | —                                                                           | Manifest registry (params schema + asset slots + output nodes), 10 templates                                                                                                                                               |

Serial submission: submissions run through one in-process promise chain (single-profile concurrency-1 intent). Cross-profile and cross-process concurrency is not serialized — concurrent submitters are on their own. Only generic ComfyUI primitives are understood here (template/params/promptId/nodes/artifacts); prompt bodies are caller-owned verbatim strings.

## Contract

ComfyUI is an open-source project by comfyanonymous — this package is only its DSH access client. It speaks the native ComfyUI HTTP API (`/prompt`, `/history`, `/queue`, `/upload`, `/view`); no upstream code is vendored. The auth token comes only from env `COMFYUI_AUTH_TOKEN` and travels only in the `Authorization` header — it never enters logs, receipts, or artifacts.

`templates/` holds runtime templates (shipped API-format JSON plus the `templates/manifest.json` registry, 10 templates) — not the new-package starter (that starter lives at the index repo root `templates/`).

## Config

| Key              | Meaning                                                        | Default                                         |
| ---------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| `workspace`      | Project root (absolute path)                                   | `WWRS_WORKSPACE` env, then neutral-anchor probe |
| `comfyuiBaseUrl` | Remote ComfyUI base URL (injection surface: config key or env) | `COMFYUI_BASE_URL` env, missing fails loud      |

Workspace resolution: `config.workspace` > env `WWRS_WORKSPACE` > upward probe for `.wwrs/workspace.json` > fail loud. All paths (output, assets) must be workspace-relative; absolute or escaping (`..`) paths are rejected. Task receipts live at `.wwrs/comfy-tasks/<taskId>.json` inside the workspace (no credentials inside). Missing values fail loud with guidance; never silently degrade.

## Install

```json
{
  "dependencies": {
    "dsh-plugin-wwrs-comfyui": "link:/path/to/plugin-wwrs-comfyui"
  },
  "dsh": { "profile": { "bundles": ["dsh-plugin-wwrs-comfyui"] } }
}
```

## Verify

Run `pnpm check` (`prettier --check` + `tsc --noEmit` + `node --test tests/*.test.ts`).

## No browser half

Server-side tools only — `pnpm check` is the full gate, no `check:browser` chain.

## Known limits

- No implicit default template — call `comfy_templates` first and pass `template` explicitly.
- Submission serializes one in-process promise chain only; cross-profile and cross-process concurrency is not serialized.
- `comfy_wait` never holds the call: budget expiry returns `renewable=true` and the caller loops.
- `comfy_cancel` follows server capability; non-2xx outcomes are reported, never faked.

## License

MIT.
