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
| `BLOB_READ_WRITE_TOKEN` | **only on Vercel** | Vercel dashboard → Storage → Blob → connect to the project | When unset locally, audio is written to `packages/api/.data/audio/` and served from `/api/recordings/audio/<name>`. When unset **on Vercel**, uploads hard-error: the filesystem there is read-only and per-instance. |
| `CORS_ALLOW_ORIGIN` | no | — | Defaults to `*`, which is correct for this no-auth MVP and lets any Expo origin (port / LAN IP / tunnel) reach the API. Set an explicit origin once auth exists. |
| `LOCAL_AUDIO_DIR` | no | — | Overrides the local audio directory. Default: `<cwd>/.data/audio`. Ignored in Blob mode. |
| `VERCEL` | — | Set by Vercel automatically | Never set this yourself. It is what makes a missing `BLOB_READ_WRITE_TOKEN` a hard error instead of a local-disk fallback. |

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

* creates the `recordings` collection with NVIDIA vectorize (`nvidia/nv-embedqa-e5-v5`, 1024 dims, cosine) and an indexing deny-list for the long free-text fields;
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

`status` is `ok` only when Astra is reachable, the `recordings` collection **exists**,
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

## 4. How a recording flows

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

## 5. Troubleshooting

### Setup and connectivity

| Message | Cause | Fix |
|---|---|---|
| `Missing ASTRA_DB_API_ENDPOINT or ASTRA_DB_APPLICATION_TOKEN env vars` | No `packages/api/.env.local`, or the file is at the repo root. | Create `packages/api/.env.local`. Next.js does not read a root env file. |
| Health says `"collection": "missing"` and `The 'recordings' collection does not exist — run: npm run seed --workspace=packages/db` | Env is correct but the schema was never seeded. | Run the seed command. Without it every upload 500s with `COLLECTION_NOT_EXIST`. |
| `[seed] Collection "recordings" exists with a definition this app cannot use` | The collection was created by an older version or by hand. Astra collection settings are immutable. | `npm run seed --workspace=packages/db -- --recreate` (drops all documents). |
| `Missing LLM_API_KEY env var` / `Missing LLM_MODEL env var` | Enrichment and chat are unconfigured. | Set both. `LLM_MODEL` has no default on purpose. |
| `Missing DOCLING_SERVICE_URL` / `Missing DOCLING_API_KEY` | Transcription is unconfigured. | Set both, then run the smoke test. |
| `EXPO_PUBLIC_API_URL is not set…` (thrown on native at first request) | Running on a device/emulator without a base URL. | Set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env` to your LAN IP (or `10.0.2.2` on the Android emulator) and restart Expo. |
| `…cannot reach the API at <url>. Check that the Next.js server is running and that EXPO_PUBLIC_API_URL points at it.` | The fetch never reached a server: wrong host, server down, firewall, or (on release Android) blocked cleartext. | Curl the URL from another machine on the same network. For a release Android build see the `expo-build-properties` note above. |
| `BLOB_READ_WRITE_TOKEN is required when deployed to Vercel (the filesystem is read-only and per-instance).` | Deployed without Blob storage. | Attach a Blob store in the Vercel dashboard and redeploy. |

### Recording and upload (client-side)

| Message | Cause | Fix |
|---|---|---|
| `Microphone permission denied. Enable microphone access for Walfly in your system settings.` | Permission refused, or the native build lacks the permission entirely. | Grant it in system settings. If the prompt never appeared on native, the `expo-av` config plugin was not applied — run `npx expo prebuild --clean` and rebuild. |
| `This browser cannot record audio (MediaRecorder is unavailable).` | Not a browser (or a very old one). | Use a current Chrome, Safari or Firefox. |
| `This browser cannot encode M4A or Ogg audio, and the transcription service cannot read WebM. Firefox (Ogg/Opus) and Safari (M4A) both work…` | The browser only offers WebM. Docling routes WebM to its **video** pipeline, so it can never reach ASR, and relabelling the MIME type transcodes nothing. | Use Firefox or Safari, or record on the native app. |
| `WebM/Matroska is a video container…` (HTTP 415 from upload) | Same thing, caught server-side from the magic bytes. | As above. |
| `Unrecognised audio container. Expected WAV, MP3, M4A/AAC-in-MP4, AAC, OGG or FLAC.` (415) | The uploaded bytes are not an audio container the ASR pipeline accepts. | Check what the client actually produced; the bytes are authoritative, not the filename. |
| `This N-minute recording is X MB, over the 4.0 MB upload limit.` / HTTP 413 `Audio exceeds the 4 MB upload limit` | Vercel rejects request bodies above ~4.5 MB at the routing layer. At 32 kbps that is ≈16 minutes. | Record shorter walks. Longer recordings need client-direct Blob upload, which is a documented follow-up. |
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

## 6. Building

```bash
npx tsc --noEmit -p packages/db/tsconfig.json    # db typecheck
npm run build --workspace=packages/api           # next build (typechecks too)
npx tsc --noEmit -p apps/mobile/tsconfig.json    # mobile typecheck
npm run build:mobile                             # expo export -p web
```

`apps/mobile` deliberately does **not** import `@walfly/db` — the wire types are mirrored in
`apps/mobile/lib/types.ts` so Metro can never pull the Astra driver into the client bundle.

---

## 7. Known limits

* **Upload cap 4 MB / 15 minutes.** Client-direct Vercel Blob upload is an explicit non-goal for now: it is unverified on Expo native and its `onUploadCompleted` webhook never fires on localhost.
* **No server-side reaper.** A job only advances while a client is ticking it. Vercel Queues or a cron reaper is the upgrade; the resumable state machine is the prerequisite and is already in place.
* **`sort: { createdAt: -1 }` is an in-memory Astra sort** and hard-errors past ~10,000 scanned documents. Keyset pagination is the documented upgrade.
* **No auth.** Single-user MVP. `CORS_ALLOW_ORIGIN=*` must become an explicit origin the moment that changes.
