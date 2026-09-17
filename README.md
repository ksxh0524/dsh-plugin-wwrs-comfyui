# dsh-plugin-wwrs-comfyui

ComfyUI workflow DSH plugin (open source): submit, query, and wait over remote ComfyUI; workflow templates ship with the package. Zero runtime dependencies.

## Status

W0 shell: mount layer (`src/cordis.ts`), guard shell, and standard gates are green. Tool implementations land in W1.

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

Missing base URL fails loud with three ways out; never silently degrade.

## Tools (W1)

`comfy_submit` / `comfy_status` / `comfy_wait` / `comfy_cancel` / `comfy_templates`.

## License

MIT.
