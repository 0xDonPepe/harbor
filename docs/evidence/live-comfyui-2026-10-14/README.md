# Live run: ComfyUI on the graphics card, linked from Open WebUI (2026-10-14, Harbor 0.34.1)

Proves the harbor-apps `comfyui` package (revision 1) and the optional `comfyui` link of `open-webui` (revision 5)
and `open-webui-shared` (revision 2), decision 182, on real hardware. The fake engine cannot prove these.

**Host:** harbor-old, the physical test box (the same machine as
[live-gpu-2026-10-14](../live-gpu-2026-10-14/README.md)): RTX 3090 24 GiB, driver 595.99.02 open, container toolkit
1.20.1, Docker 29.8.1, Harbor 0.34.1.

The harbor-apps branch `comfyui` packages were uploaded as your own apps under test ids:
- `comfyui` as **`comfyui-gpu`** (revision 1 with a `setup:` block, then revision 2 = the final package without it);
- `open-webui-shared` as **`open-webui-gpu`** (revision 2 = the link, revision 3 = the link + workflow defaults),
  link providers renamed to `ollama-gpu` and `comfyui-gpu`.

The official catalog was not touched. `comfyui-gpu` was installed `--unencrypted`: Harbor had restarted since the
last login, so the machine key for sealed apps was locked (`MACHINE_KEY_LOCKED`) and only the owner's password
unlocks it.

## 1. Install on the card

`harbor --accept-permissions install comfyui-gpu --unencrypted --yes`:

```
  - Allow comfyui: Use this machine's graphics card (GPU)
  - Use the NVIDIA GeForce RTX 3090 (GPU) for comfyui
  GPU:       NVIDIA GeForce RTX 3090 (driver 595.99.02, ready for apps)
  pulling      pulling 1 image(s) by digest                 (21:30:45 -> 21:32:40, 5 GB compressed, 16.9 GB on disk)
  checking     probing http://127.0.0.1:18081/system_stats (deadline 300s)
  checking     readiness passed after 10 attempt(s) with status 200
  succeeded    install succeeded
```

ComfyUI's log: `Using image-bundled ComfyUI (copied to workdir)`, `pytorch version: 2.13.0+cu130`,
`Device: cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync`, `ComfyUI version: 0.40.0`, `ComfyUI-Manager (V4.2.2)`.
The `python` volume (`/root/.local`) stayed empty: the Manager installs nothing at start.

Revision 1 had a `setup:` block, and the review then said "After install you'll create your ComfyUI (GPU test)
account". Harbor reads `setup` as "has its own login", which also turns off the default basic-auth on a public
domain, so the final package has no `setup:` (docs/TODO.md: `setup:` without an account).

## 2. A model through the Manager

`POST /api/v2/manager/queue/install_model` with the Manager's own list entry for `sd_xl_base_1.0.safetensors`, then
`/queue/start`: 6.94 GB landed in `models/checkpoints/SDXL/` in about 3 minutes. That is the path the README sends
people through (Manager, Model Manager).

## 3. Without a card: the CPU fallback

The same image digest in a throwaway `docker run --rm` without `--gpus` (not through Harbor, nothing published):

| Start command | Result |
|---|---|
| The image's own `CMD` | exit 1, `RuntimeError: Found no NVIDIA driver on your system` |
| The package's `command` (`torch.cuda.is_available()` or `CLI_ARGS=--cpu`) | `Set vram state to: DISABLED`, `Device: cpu`, `/system_stats` 200 after about 20 s |

So the no-card, toolkit-missing and old-driver paths that Harbor's review promises ("runs on the CPU") hold, and the
catalog's CPU-only smoke runners can start it.

## 4. Open WebUI installed before ComfyUI: update, then link

`harbor update open-webui-gpu` (revision 1 to 2): `optional link comfyui has no provider yet`, update succeeded.
`harbor configure open-webui-gpu --link comfyui=comfyui-gpu`:

```
  Link:      comfyui -> comfyui-gpu/web as http://comfyui-link:8188
  preparing    created the private link network hb_bc68…_link_comfyui (internal: no route out, nothing published)
  preparing    updated the private Compose file of comfyui-gpu for its links
  succeeded    configure succeeded
```

Inside Open WebUI: `COMFYUI_BASE_URL=http://comfyui-link:8188` and `curl http://comfyui-link:8188/system_stats`
answered (`"comfyui_version": "0.40.0"`). ComfyUI's `StartedAt` did not change: it was attached live, and its
model download went on. This Open WebUI's own settings were already seeded at its first start, so its Images page
still has an empty base URL. That is why the README has the address and the node IDs to type.

## 5. Open WebUI installed after ComfyUI: an image from a chat request

A throwaway `open-webui-gpu` revision 3 (`owui-imgtest`, `--link comfyui=comfyui-gpu`, a test admin from
`/api/v1/auths/signup`). `GET /api/v1/images/config` as installed:

```
ENABLE_IMAGE_GENERATION False, IMAGE_GENERATION_ENGINE openai, IMAGE_SIZE 1024x1024, IMAGE_STEPS 25,
COMFYUI_BASE_URL http://comfyui-link:8188,
nodes: prompt ['6'], model ['4'], width ['5'], height ['5'], steps ['3'], seed ['3']
```

Then only what the README asks (`ENABLE_IMAGE_GENERATION` true, engine `comfyui`, model
`SDXL/sd_xl_base_1.0.safetensors`; `/api/v1/images/models` listed it from ComfyUI over the link), and
`POST /api/v1/images/generations`:

```
generate 1: 200 in 16.2s     ComfyUI: Requested to load SDXL ... Prompt executed in 15.87 seconds
generate 2: 200 in 14.2s     25/25 steps at about 2.0 it/s, Prompt executed in 13.88 seconds
-> generated-image.png, PNG 1024 x 1024, stored by Open WebUI (/api/v1/files/<id>/content)
nvidia-smi during the run: 100 % utilization; python3.13 (ComfyUI) next to Ollama's llama-server
```

[open-webui-image.png](open-webui-image.png) is a 512 px copy of the first request's picture ("a lighthouse on a
rocky harbor at sunset, oil painting").

About 2 it/s is slow for SDXL on a 3090. Ollama had a 16 GB chat model loaded the whole time (`ollama ps`: Qwen
27B IQ4_XS, 100% GPU, someone using it), so ComfyUI ran with about 7 GB free and swapped parts of SDXL in and out.
The model was left loaded on purpose. The README says how sharing the card works.

## 6. Update keeps the data, brings the new ComfyUI

`harbor update comfyui-gpu` (revision 1 to 2): it re-attached both link networks (`as comfyui-link only`), and
readiness passed after 6 attempts. The new container logged `Using image-bundled ComfyUI (copied to workdir)`
again: `/root/ComfyUI` is not a volume, so an update runs the new image's ComfyUI. `models/checkpoints/SDXL/`
and `output/` were kept.

## Left on harbor-old

- `comfyui-gpu` revision 2, unencrypted, with SDXL base downloaded, linked from `open-webui-gpu`.
- `open-webui-gpu` revision 2 (revision 3 is offered; it only adds first-start defaults, which an existing install
  does not read). Its Images page still has to be filled in once (README, "installed before ComfyUI").
- `owui-imgtest` was purged, and the temporary token and config files in /tmp were deleted.

Not covered live: an Open WebUI chat through the browser (the same `/api/v1/images/generations` route the chat's
Image button calls), FLUX workflows, and the Intel/AMD path (ComfyUI does not use them: CPU).
