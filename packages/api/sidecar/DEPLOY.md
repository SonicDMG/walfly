# Hosting the ASR sidecar (turnkey)

The transcription sidecar (`transcribe_sidecar.py`) is a self-contained FastAPI
service that runs Whisper Turbo via Docling. It needs no credentials, so the
whole "ASR pipeline" is one deploy + one env var.

Everything below assumes you run commands **from the repository root** — the
Dockerfile paths in all three provider configs are repository-root-relative.

---

## Option A — Fly.io (one command)

```bash
# once: install and sign in
brew install flyctl && fly auth login

# deploy (also works as: npm run deploy:asr)
fly deploy --config packages/api/sidecar/fly.toml
```

`fly.toml` is already configured:

- app name `walfly-asr` (change it if that name is taken, then update the URL in step 2)
- 2 GB shared-CPU machine — Whisper Turbo on CPU fits; `auto_stop_machines` keeps it free when idle
- health check against `/health`

Then point the API at it:

```bash
# packages/api/.env  (and wherever the API is deployed: Vercel project settings)
SIDECAR_URL=https://walfly-asr.fly.dev
```

Verify:

```bash
curl https://walfly-asr.fly.dev/health          # {"status":"ok"}
curl -F "files=@some-voice-memo.m4a" https://walfly-asr.fly.dev/v1/transcribe
```

### Cold starts

Machines stop when idle, so the first request after a quiet period pays a
one-time model-load penalty (tens of seconds). The client already retries with
backoff (`transcribe.ts`), so this shows up as a slow first chunk, not a
failure. If you want zero cold starts at a fixed monthly cost, set
`min_machines_running = 1` in `fly.toml` and redeploy.

## Option B — Render (blueprint)

`render.yaml` is a ready blueprint:

1. Render dashboard → **New → Blueprint** → select this repo.
2. Render reads `packages/api/sidecar/render.yaml` and builds the same
   Dockerfile on the `standard` plan (2 GB).
3. Copy the service URL into `SIDECAR_URL`.

## Option C — DigitalOcean App Platform

`digitalocean-app.yaml` is a ready spec:

```bash
doctl apps create --spec packages/api/sidecar/digitalocean-app.yaml
```

Then copy the app URL into `SIDECAR_URL`.

---

## How the API consumes it

`packages/api/lib/transcribe.ts` calls `POST {SIDECAR_URL}/v1/transcribe`
(synchronous, returns `{"markdown": "..."}`). Chunk uploads from the Walfly app
— whether from the phone mic or a Bee Pioneer — reach this endpoint through
`/api/recordings/{id}/chunks`, so no other wiring is needed.

Local development is unchanged: leave `SIDECAR_URL` unset and the API uses
`http://localhost:8888` with the sidecar started by `npm run dev`.

## Notes

- **Model**: `WHISPER_TURBO` via Docling's `AsrPipeline` (see
  `transcribe_sidecar.py`). Swapping models is a change to `asr_model_specs`
  in that file.
- **No auth**: the sidecar endpoint is intentionally credential-free for this
  MVP. Before exposing it beyond yourself, put it behind your host's private
  networking (Fly: `fly ips allocate-v6 --private`) or an auth proxy, and set
  `SIDECAR_URL` to the private address.
- **Storage**: the sidecar keeps tasks in memory only; audio temp files are
  deleted after each transcription. Nothing is persisted on the host.
