# Walfly — setup and operations

Walfly is an npm-workspaces monorepo:

| Workspace | Package | What it is |
|---|---|---|
| `packages/db` | `@walfly/db` | Astra DB client, the `Recording` document type, bounded-text helpers, the schema seeder. Consumed as raw TypeScript (`main: ./src/index.ts`). |
| `packages/api` | `@walfly/api` | Next.js 16 App Router API. Docling SaaS transcription, LLM enrichment, audio storage. |
| `apps/mobile` | `@walfly/mobile` | Expo SDK 52 + expo-router client. Runs on web **and** native from the same source. |

Transcription runs entirely in the cloud (Docling SaaS). There is no local Python,
no `uv`, no subprocess. Audio bytes are always uploaded to Docling as multipart, so
Docling never needs to reach our storage.

---

## 1. Environment variables

**Next.js reads `.env*` only from `packages/api/`. Expo reads `.env*` only from `apps/mobile/`.**
There is no root env file — a root `.env` is read by neither.

### `packages/api/.env.local` (copy from `packages/api/.env.example`)

| Variable | Required | Where to get it | Notes |
|---|---|---|---|
| `ASTRA_DB_API_ENDPOINT` | **yes** | Astra console → your database → *Connect* → API Endpoint | Looks like `https://<db-id>-<region>.apps.astra.datastax.com`. Read by `packages/db/src/client.ts`. |
| `ASTRA_DB_APPLICATION_TOKEN` | **yes** | Astra console → *Generate Token* (role: Database Administrator) | Starts with `AstraCS:`. |
| `ASTRA_DB_KEYSPACE` | no | Astra console → your database → keyspaces | Omit to use the database's default keyspace. |
| `SIDECAR_URL` | **yes** (for file transcription) | Your sidecar host, or `http://localhost:8888` locally | The sidecar runs on faster-whisper now (see `packages/api/sidecar/`). Timeout is 10 minutes. |
| `WALFLY_WS_SECRET` | **yes** (for live recording) | Generate with `openssl rand -hex 32` | Shared secret for the short-lived WebSocket tickets. The sidecar reads it from its own environment or from this file (the config loader searches `packages/api/sidecar/.env.local`, this file, then the repo root). |
| `SIDECAR_WS_URL` | no | e.g. `wss://walfly-asr.fly.dev/v1/stream` | Where live audio streams. Defaults to `ws://localhost:8888/v1/stream`; the ticket response carries it to the app, so the mobile app needs no extra variable. |
| `LLM_BASE_URL` | no (but effectively yes) | Your OpenAI-compatible proxy | e.g. `https://openrouter.ai/api/v1`, a LiteLLM URL, or `http://localhost:11434/v1` for Ollama. Omit to hit api.openai.com. |
| `LLM_API_KEY` | **yes** (for enrichment and chat) | The proxy above | Use the literal string `ollama` for a local Ollama. |
| `LLM_MODEL` | **yes** (for enrichment and chat) | The proxy's model list | **No default by design.** A wrong default produces a 404 that reads like a network failure. |
| `LLM_JSON_MODE` | no | — | `off` disables `response_format: json_object` entirely. Anything else (including unset) attempts JSON mode and falls back automatically when the provider rejects it. |
| `WALFLY_API_TOKEN` | **yes in production** | Generate with `openssl rand -hex 32` | The single shared bearer token (`Authorization: Bearer <token>`) required on every `/api/*` route except `/api/health`. Unset → every gated route 500s on purpose (fail closed, not fail open). The mobile app prompts for it on first launch. |
| `S3_BUCKET` | **only in production** | Your S3-compatible provider (AWS S3 / Cloudflare R2 / Backblaze B2 / MinIO) | When unset, audio is written to `packages/api/.data/audio/` and served from `/api/recordings/audio/<name>` — fine for local dev, **not** for production (an ephemeral or multi-instance container loses it on restart/redeploy). |
| `S3_ENDPOINT` / `S3_REGION` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_PUBLIC_BASE_URL` | with `S3_BUCKET` | Your provider's console | `S3_ENDPOINT` unset means real AWS S3; set it for R2/B2/MinIO. `S3_PUBLIC_BASE_URL` is the public-read base the bucket is reachable at — the app constructs object URLs itself and never signs or re-signs them, so the bucket must be configured for public read. |
| `CORS_ALLOW_ORIGIN` | no | — | Defaults to `*`. Safe to leave as-is — `WALFLY_API_TOKEN` is the real access boundary, and CORS only governs what a *browser* enforces client-side. |
| `LOCAL_AUDIO_DIR` | no | — | Overrides the local audio directory. Default: `<cwd>/.data/audio`. Ignored in S3 mode. |
| `MAX_UPLOAD_BYTES` | no | — | Overrides the upload-size guard (default 100 MB). Align it with a fronting reverse proxy's own body-size limit if one exists. |

### `apps/mobile/.env` (copy from `apps/mobile/.env.example`)

| Variable | Required | Notes |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | **yes on native**, optional on web | Base URL of the Next.js API, no trailing slash. On Expo web it defaults to `http://localhost:3000`. On a device or emulator there is no usable default and the app throws a named error at first use. |

---

## 2. First-time setup

```bash
git clone <repo> && cd david-walfly
npm install

cp packages/api/.env.example packages/api/.env.local   # then fill it in
cp apps/mobile/.env.example  apps/mobile/.env          # then fill it in
```

### Create the Astra collection

```bash
npm run seed --workspace=packages/db
```

The seeder:

* creates the `recordings_v2` collection with NVIDIA vectorize (`nvidia/nv-embedqa-e5-v5`, 1024 dims, cosine) and an indexing deny-list for the long free-text fields;
* **first attempts** `lexical` + `rerank` (hybrid search) and retries without them if the database rejects them. Those are a region-limited public preview — AWS `us-east-2` Serverless (vector) only. Falling back is a *capability report, not a failure*: search then uses vector + `searchTokens` fusion, which works everywhere;
* if the collection already exists, **checks it for drift** and exits non-zero listing the problems rather than pretending. Astra collection settings are immutable, so the only fix is:

```bash
npm run seed --workspace=packages/db -- --recreate   # DROPS the collection and all documents
```

### Verify the ASR sidecar transcribes

```bash
# File path (same response contract the pipeline consumes):
curl -F "files=@./my-voice-memo.m4a" http://localhost:8888/v1/transcribe

# Streaming path against a local audio file (speech recommended; a tone proves
# nothing). Prints partials, segments and PASS/FAIL:
uv run --project packages/api/sidecar python packages/api/sidecar/scripts/stream_smoke.py \
    ./my-voice-memo.m4a --secret "$WALFLY_WS_SECRET"
```

The first run downloads the Whisper model (`ASR_MODEL`, default `small.en`;
`tiny.en` is a fast local choice) into the Hugging Face cache.

### Check everything at once

```bash
curl -s http://localhost:3000/api/health | jq
```

```json
{
  "status": "ok",
  "service": "walfly-api",
  "checks": {
    "astra": "ok",
    "collection": "ok",
    "docling": "configured",
    "llm": "configured",
    "storage": "local"
  },
  "hybridSearch": false,
  "detail": null
}
```

`status` is `ok` only when Astra is reachable, the `recordings_v2` collection **exists**,
and both Docling and LLM credentials are present. `hybridSearch: false` is normal outside
`us-east-2` and is not an error.

---

## 3. Running locally

```bash
npm run dev            # API + Expo together
npm run dev:api        # Next.js on http://localhost:3000
npm run dev:mobile     # Expo dev server
```

Then:

* **Web** — press `w` in the Expo terminal (or `npm run dev:mobile -- --web`). No `EXPO_PUBLIC_API_URL` needed; it defaults to `http://localhost:3000`.
* **iOS simulator / Android emulator** — press `i` / `a`. The Android emulator reaches the host at `10.0.2.2`, so set `EXPO_PUBLIC_API_URL=http://10.0.2.2:3000`.

### Pointing a physical device at the API

`localhost` on a phone means the phone. Use your machine's LAN IP:

```bash
ipconfig getifaddr en0        # macOS, e.g. 192.168.1.42
```

```bash
# apps/mobile/.env
EXPO_PUBLIC_API_URL=http://192.168.1.42:3000
```

Restart the Expo dev server after editing `.env` — `EXPO_PUBLIC_*` values are inlined at
bundle time. Both machines must be on the same network, and the Next dev server must be
reachable (macOS firewall may prompt on first connection).

**Android release / internal-distribution builds** need cleartext HTTP explicitly allowed.
That is configured through the `expo-build-properties` plugin in `app.json`
(`android.usesCleartextTraffic: true`) — a bare `expo.android.usesCleartextTraffic` key is
*not* read by any Expo SDK 52 plugin and is silently discarded. Any plugin change requires a
new native build:

```bash
cd apps/mobile && npx expo prebuild --clean
```

Debug builds already permit cleartext via Expo's prebuild template, which is why this only
bites on the first release build. iOS permits it via Expo's default `NSAllowsArbitraryLoads`.

---

## 4. Deployment

Walfly is Docker-first and host-agnostic — nothing here is locked to one platform. Two
genuinely different paths exist, because "hostable anywhere" splits into two cases that
need different answers for TLS and object storage:

| | Own a box (VPS, homelab) | Managed platform (Render / Fly / DigitalOcean) |
|---|---|---|
| **TLS** | Nobody gives you this for free — something has to terminate it | The platform terminates it for you, free, on a `*.onrender.com` / `*.fly.dev` / `*.ondigitalocean.app` subdomain |
| **Object storage** | Bundled, self-hosted (Garage), zero accounts | Bring your own S3-compatible bucket (R2's free tier is the easiest fit) — or Fly's own `fly storage create` |
| **One-step path** | `./deploy.sh` | Render: one click. Fly/DigitalOcean: a short one-time runbook |

### Own box: `./deploy.sh`

```bash
./deploy.sh
```

Generates every secret the app needs, stands up self-hosted S3-compatible storage
(Garage — see `garage.toml.example`'s comment on why not MinIO) and Caddy in front of
everything for automatic HTTPS (once you have a domain) or plain HTTP (before you do),
then builds and starts the full stack: **`api`**, **`sidecar`**, **`garage`**, **`caddy`**.
Prompts once for the handful of external credentials nothing can auto-generate — your
Astra DB endpoint/token and your LLM proxy key — then prints the generated API token and
the URLs to use. Safe to re-run; every value already in `.env` is left untouched. Running
`docker compose up --build` directly also works once `.env` exists.

Verified end-to-end while building this: the full stack reaches healthy, the auth gate
401s/200s correctly through Caddy, and a real object written via the S3 API is readable
through the public `/media` route (including `Range` requests, for audio scrubbing).

To use real AWS S3 / Cloudflare R2 / Backblaze B2 instead of the bundled Garage: remove
the `garage` service from `docker-compose.yml` and point the `S3_*` vars at that
provider instead (see `docker-compose.env.example`).

### Managed platform: Render (one click)

In the Render dashboard: **New → Blueprint**, pick this repo. `render.yaml` at the repo
root defines both services together; Render creates them with free HTTPS subdomains and
prompts you once, during creation, for Astra, your LLM key, and an S3-compatible bucket's
credentials (Render has no bundled object storage — R2's free tier is the easiest fit).
`WALFLY_API_TOKEN` and `WALFLY_WS_SECRET` are generated and shared between the two
services automatically; nothing to copy by hand.

### Managed platform: Fly.io

Not a single command — Fly deploys each Dockerfile as its own app, so the API
(`packages/api/fly.toml`) and the sidecar (`packages/api/sidecar/fly.toml`) are two
separate `fly deploy` runs. The full runbook (`fly apps create`, `fly storage create` for
a free Tigris S3-compatible bucket, `fly secrets set`, `fly deploy`) is in the comment
block at the top of `packages/api/fly.toml`.

### Managed platform: DigitalOcean App Platform

```bash
doctl apps create --spec digitalocean-app.yaml
```

One command provisions both services as one "app". DO has no auto-generated-secret
feature (unlike Render) and its assigned subdomains include a random suffix not knowable
ahead of time, so `digitalocean-app.yaml` needs its `REPLACE_ME` placeholders filled in
by hand first, and `SIDECAR_WS_URL` filled in *after* the first deploy once you can see
the sidecar's assigned URL — both called out in that file's own comments.

### The one non-obvious trap, if you're configuring any of this by hand: `SIDECAR_WS_URL`

`mintWsTicket()` (`packages/api/lib/wsTicket.ts`) hands the client a WebSocket URL to open
**directly** — it is not proxied through the API. A Docker-internal address like
`ws://sidecar:8888/v1/stream` only resolves *between containers*; the end user's device is
never on that network. It must be the sidecar's real public `wss://` address. Get this
wrong and every HTTP call still works fine while live streaming silently fails to
connect — easy to not notice until someone actually tries to record. `deploy.sh` and
`render.yaml` compute this correctly by construction; it's only a manual-configuration
risk on Fly/DigitalOcean or if you edit `docker-compose.env.example` by hand.

### Self-hosting without Docker

Each service also runs as a plain process:

```bash
npm run build --workspace=packages/api && npm run start --workspace=packages/api
uv run --project packages/api/sidecar python packages/api/sidecar/transcribe_sidecar.py
```

### Shipping the iOS app against a deployed API

`EXPO_PUBLIC_API_URL` is inlined into the JS bundle at build time, read from whatever
`apps/mobile/.env` contains when Xcode's "Bundle React Native code" phase runs. Before
archiving a Release build:

```bash
cp apps/mobile/.env.production apps/mobile/.env   # fill in the real HTTPS URL first
```

Restore the dev value in `apps/mobile/.env` afterward. Signing is otherwise unchanged —
the project already has `DEVELOPMENT_TEAM` set in Xcode for Automatic signing; the only
requirement is that the machine archiving it has an Apple ID signed in with access to
that team.

---

## 5. How a recording flows

**Live (the record button) — streaming:**

1. Client opens a session (`POST /api/recordings/session`) and streams **16 kHz mono PCM** over one WebSocket to the ASR sidecar in 100 ms binary frames. The sidecar owns VAD, segmentation and transcription; partial transcripts stream back for live captions.
2. Every finalized segment is checkpointed with `POST /api/recordings/{id}/segments` and only then ACKed to the sidecar. Acked means durable in Astra. A dropped socket reconnects with a fresh ticket and re-sends everything un-acked; nothing the client captured is lost.
3. Independently, **every frame is also written to a crash-safe local file** (`walfly-recordings/<id>.wav`; OPFS on web). If the sidecar or the API is unreachable — or the app dies — the recording is delivered and transcribed from that file on a later launch (`streaming-plan.md` §11). Only server-confirmed deliveries delete it.
4. On stop the client waits for the sidecar's final flush, delivers the local buffer, and the recording moves `uploaded → enriching → ready` through the same `/process` ticks below. The server keeps the streamed transcript when it is complete (small gaps, ≥95% coverage) and re-transcribes the file otherwise. Live sessions never re-run ASR unless the recovered file demands it.

**File upload (secondary path):**

5. `POST /api/recordings/upload` (multipart) sniffs the **magic bytes** — the client's filename and declared MIME are diagnostics only — stores the bytes, inserts the document with `status: "uploaded"`, and returns. **It starts no work.**
6. The client POSTs `/api/recordings/{id}/process` repeatedly. Each tick advances the job by **exactly one step** — transcribe → enrich — under an expiring lease held in Astra, so nothing ever outlives a serverless function's budget and a mid-step crash is recoverable.
7. Statuses are `uploaded → transcribing → enriching → ready` (file) or `uploaded → enriching → ready` (live), or `failed`.
8. A transient error (network blip, Blob 500, ASR 5xx, LLM connection error) frees the lease, bumps an attempt counter and leaves the status alone so the next tick retries. Only a non-retryable error, or the 5th consecutive transient one, writes `failed`.
9. If the app is backgrounded mid-job, the **Recordings tab** keeps ticking non-terminal rows on a timer while it is focused, honouring the server's own `retryAfterMs`.

---

## 6. Troubleshooting

### Setup and connectivity

| Message | Cause | Fix |
|---|---|---|
| `Missing ASTRA_DB_API_ENDPOINT or ASTRA_DB_APPLICATION_TOKEN env vars` | No `packages/api/.env.local`, or the file is at the repo root. | Create `packages/api/.env.local`. Next.js does not read a root env file. |
| Health says `"collection": "missing"` and `The 'recordings_v2' collection does not exist — run: npm run seed --workspace=packages/db` | Env is correct but the schema was never seeded. | Run the seed command. Without it every upload 500s with `COLLECTION_NOT_EXIST`. |
| `[seed] Collection "recordings_v2" exists with a definition this app cannot use` | The collection was created by an older version or by hand. Astra collection settings are immutable. | `npm run seed --workspace=packages/db -- --recreate` (drops all documents). |
| `Missing LLM_API_KEY env var` / `Missing LLM_MODEL env var` | Enrichment and chat are unconfigured. | Set both. `LLM_MODEL` has no default on purpose. |
| `Missing DOCLING_SERVICE_URL` / `Missing DOCLING_API_KEY` | Transcription is unconfigured. | Set both, then run the smoke test. |
| `EXPO_PUBLIC_API_URL is not set…` (thrown on native at first request) | Running on a device/emulator without a base URL. | Set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env` to your LAN IP (or `10.0.2.2` on the Android emulator) and restart Expo. |
| `…cannot reach the API at <url>. Check that the Next.js server is running and that EXPO_PUBLIC_API_URL points at it.` | The fetch never reached a server: wrong host, server down, firewall, or (on release Android) blocked cleartext. | Curl the URL from another machine on the same network. For a release Android build see the `expo-build-properties` note above. |
| `{"error":"Unauthorized"}` (HTTP 401) | `WALFLY_API_TOKEN` is missing or wrong on the client. | Enter the correct token (the first-launch prompt on mobile, or an `Authorization: Bearer <token>` header manually). |
| `Server misconfigured: WALFLY_API_TOKEN is not set` (HTTP 500) | The API itself has no `WALFLY_API_TOKEN` configured — it fails closed rather than silently allowing every request. | Set `WALFLY_API_TOKEN` on the API host and restart it. |
| `S3_BUCKET is set but S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are missing.` | S3-compatible storage is half-configured. | Set all of `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_PUBLIC_BASE_URL` together. |

### Recording and upload (client-side)

| Message | Cause | Fix |
|---|---|---|
| `Microphone permission denied. Enable microphone access for Walfly in your system settings.` | Permission refused, or the native build lacks the permission entirely. | Grant it in system settings. If the prompt never appeared on native, the `expo-av` config plugin was not applied — run `npx expo prebuild --clean` and rebuild. |
| `This browser cannot record audio (MediaRecorder is unavailable).` | Not a browser (or a very old one). | Use a current Chrome, Safari or Firefox. |
| `This browser cannot encode M4A or Ogg audio, and the transcription service cannot read WebM. Firefox (Ogg/Opus) and Safari (M4A) both work…` | The browser only offers WebM. Docling routes WebM to its **video** pipeline, so it can never reach ASR, and relabelling the MIME type transcodes nothing. | Use Firefox or Safari, or record on the native app. |
| `WebM/Matroska is a video container…` (HTTP 415 from upload) | Same thing, caught server-side from the magic bytes. | As above. |
| `Unrecognised audio container. Expected WAV, MP3, M4A/AAC-in-MP4, AAC, OGG or FLAC.` (415) | The uploaded bytes are not an audio container the ASR pipeline accepts. | Check what the client actually produced; the bytes are authoritative, not the filename. |
| HTTP 413 `Audio exceeds the N MB upload limit` | Hit the `maxUploadBytes()` guard (default 100 MB; override with `MAX_UPLOAD_BYTES`). | Record a shorter walk, or raise `MAX_UPLOAD_BYTES` (and any fronting reverse proxy's own body-size limit) if that's not actually the ceiling you want. |
| `The recording is empty — no audio was captured.` | Stopped before any frames landed, or the input device produced nothing. | Record for at least a second and check the microphone selection. |
| `Recording could not be finalised: …` | `stopAndUnloadAsync()` rejected. | Usually transient; try again. The recorder is always released, so the next attempt is not blocked. |

### Pipeline and processing

| Message | Cause | Fix |
|---|---|---|
| `Processing failed: HTTP 503 <astra message>` | `/process` could not read the recording's state — an Astra timeout or bad credentials. The recording is **untouched** and will resume. | Read the message. It is the Data API's own. |
| `[unsupported_media] Docling submit rejected the payload (415)` | The Docling instance refuses this audio. | Run the smoke test with a real speech file. A 415 on a plain WAV means the deployment cannot do ASR. |
| `[asr_unavailable] Docling task … returned no transcript and reported an ASR/ffmpeg problem.` | The Docling deployment has no working Whisper/ffmpeg. | No client flag fixes this. Swap in a dedicated STT provider behind the three functions in `packages/api/lib/transcribe.ts`. |
| `[empty_transcript] Docling task … produced an empty transcript.` | The task succeeded but returned nothing. Often genuine silence. | Check the audio plays back. If it has clear speech, treat it as `asr_unavailable`. |
| `[not_found] Docling result for … is gone (single-use, 24h retention)` | The result endpoint was consumed or expired. | Re-record. The lease exists to prevent two ticks racing for the single-use result; if this recurs, the instance is slow enough that `LEASE_TRANSCRIBE_MS` needs raising. |
| `Docling task … did not finish within 20 minutes.` | The job never reached a terminal state. | Check Docling instance health; re-record. |
| `Refusing to enrich an empty transcript — the transcription step produced no speech content.` | Guard against an LLM hallucinating a summary from nothing. Working as intended. | Fix the transcription problem, not the enrichment step. |
| `LLM enrichment returned unparseable JSON (…)` | The proxy returned prose the defensive parser could not rescue. | Try a stronger model, or set `LLM_JSON_MODE=on`. If the provider rejects `response_format`, set `LLM_JSON_MODE=off`. |
| `Processing timed out — the recording is still on the server and will resume from the Recordings tab.` | The client's 20-minute deadline. The job is still alive server-side. | Open the Recordings tab and leave it focused; it keeps ticking non-terminal rows automatically. |

### Search and chat

| Message | Cause | Fix |
|---|---|---|
| `Could not load recordings (HTTP 500): <astra message>` | The Data API rejected the query; the message carries its `errorCode`. | Check the server log line `[recordings] search failed (<CODE>)`. |
| Search returns nothing on a very long query | Query strings are clamped to 1500 chars before being sent to the embedding model, which caps at 512 tokens. Long queries are truncated, not rejected. | Search with fewer words. |
| Health shows `"hybridSearch": false` | The collection has no `lexical`/`rerank` — the region does not support the preview. | Nothing to fix. Search automatically uses vector + `searchTokens` fusion. To get hybrid, create the database in AWS `us-east-2` and re-seed. |
| `[capabilities] Could not probe the recordings collection…` in the server log | A transient Astra failure during the capability probe. It is **not** cached, so the next call re-probes. | Ignore unless it repeats; then check Astra reachability. |
| `Chat failed (HTTP 500): …` | Retrieval or LLM config failed *before* the stream opened, so you get an honest JSON error rather than a silent empty stream. | Read the message; it names the missing env var or the Data API error. |

---

## 7. Building

```bash
npx tsc --noEmit -p packages/db/tsconfig.json    # db typecheck
npm run build --workspace=packages/api           # next build (typechecks too)
npx tsc --noEmit -p apps/mobile/tsconfig.json    # mobile typecheck
npm run build:mobile                             # expo export -p web
```

`apps/mobile` deliberately does **not** import `@walfly/db` — the wire types are mirrored in
`apps/mobile/lib/types.ts` so Metro can never pull the Astra driver into the client bundle.

---

## 8. Known limits

* **No server-side reaper.** A job only advances while a client is ticking it. A cron reaper is the upgrade; the resumable state machine is the prerequisite and is already in place.
* **`sort: { createdAt: -1 }` is an in-memory Astra sort** and hard-errors past ~10,000 scanned documents. Keyset pagination is the documented upgrade.
* **Single shared token, not per-user accounts.** `WALFLY_API_TOKEN` (§1, §4) gates the API but everyone who has it sees everyone else's recordings. Fine for single-user self-hosting; real multi-user isolation would need actual accounts.
