# Live run: gpu permission + app settings on a real NVIDIA card (2026-10-14, Harbor 0.34.0)

Proves decisions 179 (gpu permission) and 180 (app settings) on real hardware. The fake engine
cannot prove these.

**Host:** harbor-old, the physical test box.

| | |
|---|---|
| OS | Ubuntu 24.04.3, kernel 6.8.0-146 |
| CPU / memory | AMD Ryzen 9 5900X, 94 GiB |
| GPU | **NVIDIA GeForce RTX 3090** (24 GiB) |
| Driver | **595.99.02 open**, updated from 550 before this run with `apt install nvidia-driver-595-open` + reboot |
| Docker | 29.8.1 |
| Harbor | self-updated 0.33.2 → **0.34.0** from the signed GitHub release ("signature verified (SHA256SUMS.sig, key harbor-2026-10)") |

The harbor-apps `local-ai` packages were uploaded as your own apps under test ids:
- `ollama` revision 3 as **`ollama-gpu`**;
- `open-webui-shared` revision 1 as **`open-webui-gpu`**, whose link provider was renamed to `ollama-gpu`.

The official catalog was not touched.

## 1. NVIDIA card, no container toolkit

Before the toolkit was installed, `docker info` listed only the runtimes `io.containerd.runc.v2` and `runc`. The
`/dev/dri/renderD128` node belongs to the NVIDIA card (nvidia-drm), and Harbor correctly ignored it.

```
$ harbor gpu
Graphics card: NVIDIA GeForce RTX 3090 found, but the NVIDIA container toolkit is not installed: runs on the CPU until then (Install the NVIDIA container toolkit (Operator Guide, GPU), then restart the app)
```

`harbor --accept-permissions install ollama-gpu --yes`. The review listed:

```
  Permission: ollama: Use this machine's graphics card (GPU)
  GPU:       NVIDIA GeForce RTX 3090 found, but the NVIDIA container toolkit is not installed: runs on the CPU until then (...)
  Setting:   Context length (tokens) (context-length): 8192 (default; --set context-length=<value> to choose)
  ... (six settings, all defaults)
  succeeded    install succeeded
```

Container: `devreq=null devices=null groups=null`. All six settings reached the environment
(`OLLAMA_CONTEXT_LENGTH=8192`, `OLLAMA_KEEP_ALIVE=5m`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=0`,
`OLLAMA_FLASH_ATTENTION=''`, `OLLAMA_KV_CACHE_TYPE=f16`). Ollama logged
`inference compute id=cpu library=cpu ... total="94.2 GiB"`.

## 2. Toolkit installed, Docker not restarted

These are the Operator Guide commands (GPU section), run as written, without the final `systemctl restart docker`.
They installed `nvidia-container-toolkit 1.20.1-1`, and `nvidia-ctk runtime configure` wrote `/etc/docker/daemon.json`.

```
$ harbor gpu
Graphics card: NVIDIA GeForce RTX 3090 found, but Docker has not restarted since the NVIDIA container toolkit was installed: runs on the CPU until then (Restart Docker so it can use the NVIDIA container toolkit (sudo systemctl restart docker; this restarts every app), then restart the app)
```

This is the review fix `NVIDIA_DOCKER_RESTART_NEEDED`. The hook's ctime is newer than dockerd's start time. The
`harbor` service user can read `/run/docker.pid` and `/proc/<pid>/stat` under `ProtectSystem=strict`.

## 3. Docker restarted, then the app restarted

```
$ docker info → runtimes: io.containerd.runc.v2 nvidia runc
$ harbor gpu
Graphics card: NVIDIA GeForce RTX 3090 (ready for apps)
$ harbor inspect ollama-gpu
  graphics card: NVIDIA GeForce RTX 3090 found; restart the app to use it
$ harbor restart ollama-gpu --yes
  preparing    Use the NVIDIA GeForce RTX 3090 (GPU) for ollama
  starting     recreating containers (same volumes, secrets and ports)
  succeeded    restart succeeded
$ harbor inspect ollama-gpu
  graphics card: NVIDIA GeForce RTX 3090 (in use)
```

What the restarted container showed:
- Device request: `[{"Driver":"nvidia","Count":-1,"Capabilities":[["gpu","compute","utility"]]}]`.
- `nvidia-smi` inside it: `NVIDIA GeForce RTX 3090, 595.99.02`.
- Ollama: `inference compute id=0 library=CUDA compute=8.6 description="NVIDIA GeForce RTX 3090" libdirs=ollama,cuda_v13 driver=13.2 type=discrete total="23.5 GiB"`.

## 4. Open WebUI linked to the shared Ollama, a real prompt

`harbor --accept-permissions install open-webui-gpu --yes`. The only Ollama was picked automatically
(`Link: ollama -> ollama-gpu/web as http://ollama-link:11434`).
- The install created the internal link network ("no route out, nothing published").
- It attached Ollama live: Ollama's `StartedAt` stayed at its Restart time.
- Ollama kept its device request and showed `(in use)` after the link re-render.
- Open WebUI's `OLLAMA_BASE_URL` is `http://ollama-link:11434`.

`ollama pull llama3.2:3b` took 21 s. A prompt was then sent from **inside the Open WebUI container, over the link**
(`POST http://ollama-link:11434/api/generate`):

```
answer: A harbor is a body of water protected from the open sea by natural or artificial boundaries, ...
tokens/s: 254.7 wall 40.2s            (wall time includes loading the model)
$ ollama ps
NAME           ID              SIZE      PROCESSOR    CONTEXT    RUNNER      UNTIL
llama3.2:3b    a80c4f17acd5    3.1 GB    100% GPU     8192       llamacpp    4 minutes from now
nvidia-smi: /usr/lib/ollama/llama-server, 3260 MiB
load_tensors: offloaded 29/29 layers to GPU
llama_context: flash_attn = auto   →   Flash Attention enabled
```

The `''` default ("Automatic") of the flash-attention setting leaves the choice to Ollama, as the package claims.

## 5. Changing settings

```
$ harbor configure ollama-gpu --set context-length=16384 --set keep-alive=30m --yes
  preparing    stored the settings: Context length (tokens) = 16384; Keep a model loaded for = 30m
  preparing    Use the NVIDIA GeForce RTX 3090 (GPU) for ollama
  starting     recreating the containers whose configuration changed (same volumes and ports)
  starting     attached ...-ollama-1 to link network ..._link_ollama as ollama-link only
  succeeded    configure succeeded
$ harbor settings ollama-gpu
context-length     Context length (tokens)        16384                     8192            whole number 0..262144
keep-alive         Keep a model loaded for        30m                       5m              text, max 16
num-parallel       Parallel requests per model    1 (default)               1               whole number 1..16
...
settings.json: {"format": 1, "values": {"context-length": 16384, "keep-alive": "30m"}}   (overrides only)
container env: OLLAMA_CONTEXT_LENGTH=16384, OLLAMA_KEEP_ALIVE=30m
$ ollama ps
llama3.2:3b    a80c4f17acd5    4.1 GB    100% GPU     16384      llamacpp    29 minutes from now
$ harbor configure ollama-gpu --set kv-cache=q2 --yes
error SETTING_INVALID: Conversation memory precision (setting kv-cache) must be one of f16, q8_0, q4_0
$ harbor configure ollama-gpu --set num-parallel=99 --yes
error SETTING_INVALID: Parallel requests per model (setting num-parallel) must be a whole number from 1 to 16
```

The configure kept the GPU and the link alias.

## Not covered by this run

- **Console screens:** the review's Options section, the app page Settings form and the Graphics card line were
  checked by e2e against the fake engine, not on this box.
- **Intel/AMD (dri) path:** harbor-old has no such graphics.
- **The bundled `open-webui` revision 4 with gpu.**
- **AnythingLLM / Vane / Langflow links.**

The test apps `ollama-gpu` and `open-webui-gpu` were left installed on harbor-old, together with the llama3.2:3b
model (2 GB).
