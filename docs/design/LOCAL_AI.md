# Local AI stack: GPU access, app settings, one shared Ollama

Status: Part 1 (`gpu` permission, decision 179) and Part 2 (app settings, decision 180) **built in 0.34.0**; the
read-only NVIDIA driver checks (decision 181) in 0.34.1. Part 3 is harbor-apps work that declares
`release.minHarbor: "0.34.0"` (after 0.34.0 is released).

Goal: an operator installs **Ollama** once and has it use the machine's GPU when there is one. They tune
its server parameters from the app page and download models from **Open WebUI**. Every AI app (Open WebUI,
AnythingLLM, Perplexica, Karakeep, n8n, Langflow) talks to that one Ollama, so models are downloaded once.

## What exists today (harbor-apps)

| App | State |
|---|---|
| `ollama` | Standalone, endpoint `web` (11434). Sets `OLLAMA_VULKAN=1`, but no device reaches the container, so it runs on CPU. |
| `open-webui` | Bundles its own `ollama` service and model volume (CPU only). |
| `karakeep` | Already links to `ollama` (`links:` with `provider.packages: [ollama]`, decision 126). |
| `localai`, `anythingllm`, `perplexica`, `langflow`, `n8n`, `llama-gpt` | CPU only; some bundle their own model server. |

Missing: (1) a way for a package to reach a GPU, and (2) non-secret values the operator can change. Part 3
(one shared Ollama) needs no engine work: links already do it.

## Part 1: the `gpu` permission (built in 0.34.0, decision 179)

```yaml
permissions:
  ollama: [gpu]
release:
  minHarbor: "0.34.0"
```

- `gpu` is a fourth value in the `permissions` enum (decision 163; `maxItems` 3 → 4). Package compose keeps refusing
  `devices`, `deploy`, `runtime`, and now also `group_add`, `device_cgroup_rules` and `gpus`. Only Harbor's renderer
  writes them. On a service granted `gpu`, the NVIDIA toolkit's selection variables (`NVIDIA_VISIBLE_DEVICES`,
  `NVIDIA_DRIVER_CAPABILITIES`, `NVIDIA_MIG_CONFIG_DEVICES`, `NVIDIA_MIG_MONITOR_DEVICES`, `NVIDIA_IMEX_CHANNELS`) are
  Harbor's too: not a compose literal, nor a secret, link, setting or configuration target (`NVIDIA_RESERVED_ENV`).
  Other services and other `NVIDIA_*` variables are untouched, so no published package changes meaning.
- **Host facts are a planner input** (`HostGpu` in `src/contracts/types.ts`: `kind: nvidia | dri | none`, `detail`
  ("NVIDIA GeForce RTX 3090", "Intel graphics"), optional `problem: NVIDIA_TOOLKIT_MISSING | NVIDIA_DOCKER_RESTART_NEEDED` (0.34.1 adds
  `NVIDIA_DRIVER_MISSING | NVIDIA_REBOOT_NEEDED | NVIDIA_DRIVER_TOO_OLD`), `renderNode`, `renderGid`, and since 0.34.1
  optional `driverVersion`, `libraryVersion`).
  `renderCompose({ ..., gpu })` stays pure. `ctx.gpu: GpuObserver` (`src/system/gpu.ts`) collects them:
  `HostGpuObserver` in the daemon (root `/`, 30 s cache, never throws), `FakeGpu` in fake mode (no card; tests set
  any facts; `HARBOR_DEV_GPU=nvidia|dri|dri-toolkit-missing|toolkit-missing|restart-needed|driver-missing|reboot-needed|driver-too-old|none`
  for `pnpm dev` and e2e; the console mock takes `?gpu=` with the same names).
  - **NVIDIA present**: `/proc/driver/nvidia/version` or `/dev/nvidia0`, or (0.34.1) a PCI device with `vendor`
    0x10de and `class` 0x0300xx/0x0302xx under `/sys/bus/pci/devices` (a card with no driver; its audio function does
    not count, nor a card bound to `vfio-pci`/`pci-stub` for a virtual machine). Name from the `Model:` line of `/proc/driver/nvidia/gpus/*/information` (else "NVIDIA graphics
    card"; several cards: "… and N more").
  - **Driver checks (decision 181, 0.34.1, read-only: Harbor never installs, updates or removes a driver)**, before
    the toolkit checks. `driverVersion` = the running module from `/proc/driver/nvidia/version` (both "Kernel Module
    550.163.01" and "Open Kernel Module for x86_64  595.99.02"); every installed
    `libnvidia-ml.so.<version>` in /usr/lib/x86_64-linux-gnu, /usr/lib64, /usr/lib/aarch64-linux-gnu is read, and
    `libraryVersion` = the running version's own when installed, else the newest. Blocking, in order (`none`, or `dri`
    with Intel/AMD graphics; nothing rendered): on the PCI bus without the /proc file → `NVIDIA_DRIVER_MISSING`
    ("Install the NVIDIA driver (sudo ubuntu-drivers install), then restart the machine"; with its libraries installed:
    "installed but not running", restart the machine, Secure Boot may be blocking it); the running version's library
    gone and another installed → `NVIDIA_REBOOT_NEEDED` ("Restart the machine to finish the NVIDIA driver update"; an
    unknown installed version, or an extra library next to the running one's, never claims it). A note, not a block:
    major below `NVIDIA_DRIVER_MIN_MAJOR` (525: CUDA 12, Ollama's CUDA builds) on a usable card → `kind: nvidia` +
    `NVIDIA_DRIVER_TOO_OLD` (CUDA 11 images and NVENC still get the card). A working card is named with its driver
    ("NVIDIA GeForce RTX 3090 (driver 595.99.02, in use)") on the app page, Settings, `harbor inspect` and `harbor
    gpu`; the review and plan lines carry no version next to a working card (the reboot problem names both). While a
    reboot is pending, an app whose runtime file still hands it the NVIDIA card reads "(in use)" until a Restart.
  - **NVIDIA usable**: `docker info` lists the `nvidia` runtime (new `DockerAdapter.info()`; it only shows after a
    Docker restart with the toolkit installed), **or** an executable `nvidia-container-runtime-hook` in /usr/bin,
    /usr/local/bin or /usr/sbin that was installed before dockerd started. Docker's built-in NVIDIA device request
    runs that hook, so `nvidia-ctk runtime configure` is not strictly needed, but Docker registers its `nvidia`
    device driver only once, at daemon start: right after `apt-get install nvidia-container-toolkit` a device
    request fails ("could not select device driver nvidia") until Docker restarts. So the hook counts only when
    dockerd's start time (`/run/docker.pid` → `/proc/<pid>/stat` start ticks / 100 + `/proc/stat` btime) is not
    older than the hook's ctime (dpkg keeps the package's build time as mtime). Unknown start time = not usable.
  - present + usable → `nvidia`; present, no hook → `none` + `NVIDIA_TOOLKIT_MISSING`; present, hook newer than
    dockerd → `none` + `NVIDIA_DOCKER_RESTART_NEEDED` (nothing is rendered, the app keeps running on the CPU); with
    an Intel/AMD node too, `dri` + the problem.
  - **dri**: a `/dev/dri/renderD*` whose `/sys/class/drm/<node>/device/driver` is i915, xe, amdgpu or radeon. An
    nvidia-drm node (harbor-old's renderD128) does not count. `renderNode` = its name, `renderGid` = its gid. The
    `video` group is not read: it opens the `card<N>` primary nodes, which compute and transcoding do not need.
- **What gets rendered** for a service granted `gpu`:
  - nvidia: `deploy.resources.reservations.devices: [{driver: nvidia, count: all, capabilities: [gpu, compute,
    utility]}]` (no env; naming the driver capabilities makes Docker set `NVIDIA_DRIVER_CAPABILITIES=compute,utility`
    itself, so CUDA and nvidia-smi work and the image's environment cannot add graphics, display or video)
  - dri: `devices += ['/dev/dri/<renderNode>:/dev/dri/<renderNode>']` (only that node, after `/dev/net/tun` when
    `tun` is granted too) + `group_add: [<renderGid>]` (skipped when unknown). No `card<N>`, no `video` group, so no
    display or modesetting access; multi-GPU stays "the first Intel/AMD node" (choosing one card is not in v1).
  - none: nothing (the app runs on the CPU)
- **When the facts are read**: plans of packages that grant gpu (install, adopt, restore, update) record them
  (`PlanProposal.gpu` / `PlanDto.gpu`: kind, detail, problem; never gids) and add one change line per service
  ("Use the NVIDIA GeForce RTX 3090 (GPU) for ollama", "No usable graphics card found: ollama runs on the CPU", or
  the toolkit sentence). The runner reads **fresh** facts every time it renders the runtime file
  (`renderAndValidate`: install, Restart, update and its rollback, configure, reinstall, move, seal, restore), so a
  toolkit installed later is used by the next **Restart**. Start after Stop reuses the existing containers (`compose
  start`) and does not re-render; adding a re-render there would recreate containers, so it was left out. A link
  re-render with no restart (`rewriteCompose`) keeps what the running containers have (`gpuFromRendered`, read back
  from the current file, like decision 167's port binding).
- **Acceptance**: like the other permissions (`PERMISSION_LABEL.gpu` = "Use this machine's graphics card (GPU)"), also
  when no card is found (the grant is about the package). An update that adds `gpu` stops update-all and
  auto-update with `PERMISSION_REQUIRED`. Adopting a drive app (which submits its own plan) takes the same yes:
  `FoundAppDto.permissions` lists what its package asks for, Settings → Storage → *Adopt…* shows them with an
  *Allow … to do this* box, `POST /v1/found-apps/adopt` takes `acceptPermissions`, `harbor adopt
  --accept-permissions`. Without it the adopt is refused (409 `PERMISSION_REQUIRED`) before anything touches the
  drive (no recovery card stamped) or this machine's records. (Building that test found adopt had never succeeded
  end to end: the `__home__` row was inserted before its instance and hit the foreign key; submit now records it in
  the same transaction as the instance.)
- **Where it shows**: the review's *This app asks to* box (one sentence about the card next to the checkbox);
  the app page's *Graphics card* section (`InstanceDetail.gpu` + `inUse`: "NVIDIA GeForce RTX 3090 (in use)",
  "… found · restart the app to use it", "none found — runs on the CPU", or the problem with the next step). `inUse`
  is true only when the current Compose file hands over the **kind found now** (`gpuFromRendered(...).kind ===
  detected.kind`): a file with Intel graphics on a machine that now offers the NVIDIA card says restart. With Intel/AMD
  graphics next to an unusable NVIDIA card, every surface names both (the review, Settings, the app page, `harbor
  inspect`, `harbor gpu`); the console wording lives in `web/src/app/gpu-text.ts` (pure, unit-tested);
  Settings → Overview → *Graphics card* (`GET /v1/system/host` gains `gpu`, no new route); CLI: the plan's `GPU:`
  line, `harbor inspect` (*graphics card:*), and `harbor gpu`.
- **Not in v1** (docs/FUTURE.md): AMD ROCm (`/dev/kfd` + a `:rocm` image; the image is chosen by the package, so this
  needs per-host image variants), choosing a specific GPU, sharing limits.
- **Toolkit install**: Harbor's bootstrap does **not** install OS packages on its own. The Operator Guide (*GPU
  (graphics cards)*) lists the Ubuntu 24.04 commands (NVIDIA's apt repository, `nvidia-container-toolkit`,
  `nvidia-ctk runtime configure --runtime=docker`, `systemctl restart docker`, then restart the app). Until Docker
  restarts, Harbor reports `NVIDIA_DOCKER_RESTART_NEEDED` and keeps the app on the CPU instead of rendering a device
  request that would fail.
  `harbor-bootstrap --with-nvidia` is a separate decision (docs/TODO.md).

## Part 2: app settings (built in 0.34.0, decision 180)

The package declares typed, non-secret values the operator can see and change (`release.minHarbor: "0.34.0"`):

```yaml
settings:
  - id: context-length
    label: "Context length (tokens)"
    help: "How much text a model keeps in mind. More uses more memory."
    type: integer            # integer | number | boolean | string | choice
    default: 8192
    min: 2048
    max: 131072
    bindings:
      - {service: ollama, environment: OLLAMA_CONTEXT_LENGTH}
  - id: flash-attention
    label: "Flash attention"
    type: boolean
    default: false
    onValue: "1"             # what the variable gets (default "true"/"false")
    offValue: "0"
    bindings:
      - {service: ollama, environment: OLLAMA_FLASH_ATTENTION}
  - id: kv-cache
    label: "Memory cache precision"
    type: choice
    default: f16
    choices: [{value: f16, label: Full}, {value: q8_0, label: Half}, {value: q4_0, label: Quarter}]
    bindings:
      - {service: ollama, environment: OLLAMA_KV_CACHE_TYPE}
```

- **Format** (`src/contracts/manifest.schema.ts`, `src/packages/manifest.ts`): ≤ 32 settings; `id`
  `^[a-z][a-z0-9-]{0,39}$`; `label` ≤ 80, `help` ≤ 300; `default` required and type-matched; `min`/`max` for
  integer/number, `maxLength` (1–1024, default 256) for string, `choices` (1–32 `{value, label?}`) for choice,
  `onValue`/`offValue` for boolean; 1–8 `bindings` (`service`, `environment`, optional `template` with one
  `{{value}}`, no `$`). Unknown keys stay refused. A bound variable is the setting's alone: not a compose literal
  (the error says to move it into the default), a secret, a link, a configuration binding or another setting.
- **Values are visible.** They appear in plans, `InstanceSummary.settings` (`SettingDto`: definition, `default`,
  effective `value`, `overridden`), operation events, logs and backups.
- **Storage:** only overrides, in `instances/<id>/settings.json` (`{format: 1, values}`, 0644, written atomically;
  no file = every default). No migration. Effective value = the override if the installed release allows it, else
  the release's default, so a package that changes a default moves every app that never overrode it. An override
  stays the operator's even when a later release's default equals it (an update keeps it: otherwise the release
  after that would move a value the operator chose, and its plan would claim they "kept the default"). Only
  choosing the default on the app page or at install means "follow the default" (configure says "stays 8192, now as
  the default" when the value does not move). The file
  follows the instance directory: kept by remove/reinstall, deleted by a full uninstall, copied into backups
  (`settings.json` in the stage) and put back by restore in place and restore on another machine (a restore point
  without it means every default). An app adopted from a drive starts at the defaults (the file stayed with the old
  machine). The column alternative (`settings_json`, migration v13) was dropped: the file has the secrets' lifecycle
  already, and backups carry the instance directory slice, not the DB row.
- **Rendering** (`src/planner/settings.ts`, pure; `renderCompose({ settingOverrides })`): integer/number →
  `String(n)`, boolean → onValue/offValue, string/choice → the value, then the template; escaped with `$$` like every
  literal. The runner reads the file on every render (`renderAndValidate`), so Restart, update, seal, move and restore
  keep the values.
- **Plans.** `PlanDto.settings: PlanSettingDto[]` (`change` new/set/reset/dropped, `ask`, `previous`):
  - install: every setting with `ask` and one change line ("Apply its 3 settings (…), or the values you choose under
    Options"); the chosen values ride `POST /v1/operations` `settings` and are checked at submit (`SETTING_INVALID`,
    400, label + what is allowed; ids the plan does not ask about are refused too); held in memory by plan id until
    the runner starts (like operator secrets; a restart marks the queued operation needs_action anyway); an event
    says "with the settings you chose: …";
  - update: settings the new release adds (`ask`, at the default), dropped ones, stored values it no longer allows
    (`reset`: back to the default, so auto-update and update-all keep flowing), and a line when a default changes
    for an app that kept it; the runner merges, drops unknown/disallowed values and writes the file after storing the new
    release (an override equal to the new default stays), and the rollback puts the old file back;
  - configure: `settings` in the plan request (not secret), checked at plan time; change lines "Context length
    (tokens): 8192 -> 16384" and "(back to the default)" (which removes the override); the same value is "nothing to
    change"; the runner writes the file, re-renders, `up`, readiness. One configure may carry secrets, links and
    settings together;
  - restore plans say "Put back its secrets, settings and release"; remove/purge lines mention settings.
- **Console:** install review → collapsed **Options** (`<details>`, the same fields, defaults filled in, "2 changed",
  Install waits while a value is out of range: the summary then says "1 to fix", a `role=alert` line next to the
  buttons names the setting, and the section will not collapse until it is fixed); app page → **Settings** (label, value, *(default)*) → **Change…** (a
  `<dialog>` form: number inputs with min/max, checkbox, select, text; help below; *Reset to default* per field;
  Review disabled until something changed) → the usual review (*Setting* facts "Full → Half") → Apply. Pure form
  logic in `web/src/app/setting-draft.ts`, fields in `settings-fields.tsx`.
- **CLI:** `--set id=value` on `install`, `apply`, `update` (new settings only) and `configure` (typed by the plan's
  or the app's definition: numbers, on/off/true/false); `harbor settings <app>` (ID, SETTING, VALUE, DEFAULT,
  ALLOWED; `--json`); plan output has a `Setting:` line per entry.
- **Not in v1** (docs/FUTURE.md): settings that pick an image or reach `command`/volumes, settings shown only when
  another one is set, secret settings (those stay operator-provided secrets).

## Part 3: one shared Ollama (packages only, harbor-apps)

1. **`ollama`** revision 3:
   - `permissions: {ollama: [gpu]}` + `minHarbor`.
   - Settings bound to Ollama's environment variables:
     - context length
     - keep-alive
     - parallel requests (`OLLAMA_NUM_PARALLEL`)
     - max loaded models (`OLLAMA_MAX_LOADED_MODELS`)
     - flash attention (`OLLAMA_FLASH_ATTENTION`)
     - KV cache type
   - The models volume gets an `external` hint, as Open WebUI's has.
   - Keep `OLLAMA_IGPU_ENABLE=1`: Ollama drops integrated Intel/AMD graphics (Vulkan) without it; it does not change
     a discrete NVIDIA card. (`OLLAMA_VULKAN` is on by default since 0.34.)
2. **A new `open-webui-shared`** ("Open WebUI for Ollama"): no bundled `ollama` service, and
   `links: [{id: ollama, provider: {packages: [ollama], endpoint: web}, bindings: [{service: web,
   environment: OLLAMA_BASE_URL, format: url}]}]`. **Built with the link required** (the plan said optional):
   Harbor never preselects an optional link, and Open WebUI saves the Ollama address in its database at its first
   start, so an install that left the picker on "None for now" kept a dead address forever. Required, the only
   Ollama is picked for you and none means "install Ollama first"; API-key-only users take the bundled `open-webui`.
   That app stays as it is, so existing installs and its models keep working, and it gets `gpu` too, with
   `OLLAMA_IGPU_ENABLE=1` on its Ollama (0.34.4 drops integrated Intel/AMD graphics without it).
3. **Other apps:** add an optional `ollama` link to AnythingLLM, Perplexica, n8n and Langflow where they
   can point at an Ollama URL (Karakeep already does). Built for AnythingLLM, Vane (Perplexica) and Langflow.
   AnythingLLM keeps its provider choices in `/app/server/.env` inside the container (no volume reaches it), so any
   recreate (a link set later, Restart, update) resets them; its README says to choose the link at install. A
   package-level way to keep such a file is not in the format (docs/TODO.md candidate).
4. **Models:** downloads and per-model options (temperature, context, system prompt) live in Open WebUI's
   admin UI. "Models to download on install" is left out: Ollama has no environment variable for it, and a
   one-shot pull service needs Harbor to understand services that exit (FUTURE).

## Evidence

- Unit: `tests/unit/gpu.test.ts` (format, reserved NVIDIA variables, render nvidia/dri/none, detection incl. a hook
  newer than dockerd, plan/CLI lines, the console wording for every machine) and `tests/unit/app-settings.test.ts`
  (format + validator refusals, render with defaults/overrides/onValue/template/`$`, install/update/configure plans,
  submissions, CLI `--set` parsing, the console form helpers).
- Integration: `tests/integration/gpu.test.ts` (incl. `inUse` across a card switch and the restart-needed case),
  `tests/integration/app-homes.test.ts` (adopting a gpu drive app: refused without the yes with the drive and the
  database untouched, then adopted) and `tests/integration/app-settings.test.ts` (install with defaults and
  with chosen values, `SETTING_INVALID`, configure + re-render, back to the default, Restart, remove + reinstall,
  update adds/drops/resets, unattended update, purge); `tests/integration/backups.test.ts` carries `settings.json`
  through a backup, restore in place and restore on another machine.
- E2E: "decision 179" (review, drawer, Settings row) and "decision 180" (Options in the install review, the app page's
  Settings → Change… → review → new value).
- Live (not yet):
  - **NVIDIA** on harbor-old (RTX 3090, driver 550, no toolkit yet): CPU install + the toolkit-missing line first;
    after Carlos installs the toolkit, Restart → `ollama ps` shows `100% GPU` after a prompt through Open WebUI.
  - Settings on a real Docker engine: change Ollama's context length on the app page and check
    `docker exec <ollama> env | grep OLLAMA_CONTEXT_LENGTH` and Ollama's own log line.
  - CPU fallback on the usual droplet: install succeeds and the review says "runs on the CPU".
