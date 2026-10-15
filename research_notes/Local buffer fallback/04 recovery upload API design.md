# 04 — Local buffer fallback: recovery upload API design

> Scope: the server half of "the client always keeps a complete local copy; deliver
> it later" — sidecar/network never reachable (A), streamed with gaps (B), crash (C).
> Client capture/buffer design lives in a sibling note; this document fixes the
> transport, routes, store functions, doc fields, and recovery behaviour.

## TL;DR

- **Transport: Vercel Blob client uploads** (`@vercel/blob/client` `upload()` with
  `multipart: true`) plus a `handleUpload` route. Bytes go browser→Blob directly, so
  the 4.5 MB function cap and upload data-transfer charges are avoided and no new
  infrastructure appears. Local dev (`BLOB_READ_WRITE_TOKEN` unset) falls back to one
  whole-file POST (`next dev` accepts the 30 MB; `maxUploadBytes()` allows 100 MB).
  tus and direct-to-sidecar are rejected (§1).
- **Four thin routes**: `GET /api/recordings/{id}/recover` (handshake/idempotency
  probe), `POST …/recover/upload` (token exchange, blob mode), `POST …/recover/audio`
  (local-dev whole-file upload), `POST …/recover/complete` (attach + decide + return
  the process contract). `/complete` is the only write that matters: a read-value
  compare-and-set on the doc's `audioUrl` makes duplicate delivery a no-op.
- **Idempotency key = the recording id.** Pathname is deterministic
  (`recordings/<id>.<ext>`, create-only, no random suffix), so a buffer delivered
  twice converges on one object and one doc state; `bytes` is the cheap content check.
- **Case B is server-owned**, decided once at attach by a pure
  `chooseTranscriptSource()`: keep the stitched transcript when the client's
  `gapMs ≤ 5 s` and streamed coverage ≥ 95 %, else re-transcribe the whole file
  (`transcriptSource` `'stream'` | `'batch'`). The client may force either; the
  server clamps.
- **Doc stays minimal**: `audioUrl` becomes real, plus `transcriptSource` and one
  `recover` sub-object; `/process` gains `transcriptSource` for the client's copy.
- No background jobs, no webhooks: `onUploadCompleted` is deliberately not the
  authority (it cannot fire locally); the client drives `/complete` then `/process`.

## 1. Transport evaluation and recommendation

| Option | 4 MB cap | Resumability | Idempotency | Local dev | New infra | Verdict |
|---|---|---|---|---|---|---|
| (a) Blob client uploads + `handleUpload` | bypassed (browser→Blob) | part-level retry in `upload(multipart:true)`; kill ⇒ bounded 30 MB restart | deterministic pathname + CAS attach | whole-file fallback route | none | **chosen** |
| (b) chunked POST + server cursor | ≤ ~3.5 MB parts, ~8 invocations | cursor per part index | part keys + manifest | works | none | rejected |
| (c) tus | chunked by design | excellent | server-owned | needs a tus server | **new infra** | rejected |
| (d) direct to sidecar | n/a | n/a | n/a | sidecar only | none | rejected |

**Why not (b):** Blob has no append, so a cursor means parts as separate objects
plus a manifest, then either teaching `loadAudio` to concatenate or a finalize step
that re-uploads 30 MB from the function — multipart reimplemented, function
bandwidth spent, ~8 invocations per file, orphan-part cleanup ours. Its one win —
one code path in dev and prod — is covered by a small local branch.
**Why not (c):** no tus endpoint exists on Vercel Blob; running one is the new
infrastructure the constraints rule out. **Why not (d):** the sidecar is stateless
and holds no storage credentials, so audio sent there is never archived — the
archive is the point; `/v1/transcribe` is also unauthenticated.

**Why (a) wins:** client uploads exist for this size class — "when you need to upload
files larger than 4.5 MB … the file goes directly from the browser to Vercel Blob"
([client uploads][cu]) — and `upload()` supports `multipart: true` ("split the file
into multiple parts, upload them in parallel and retry failed parts") and progress
callbacks ([SDK reference][sdk]). In the installed 0.27.3, parts are 8 MiB, up to 6
in parallel in browsers, so 28.8 MB PCM is 4 parts. Multipart is recommended above
100 MB and unnecessary at 30 MB; we take it for the part-level retry alone. Client
uploads have no data-transfer charges; multipart bills per part ([Blob][blob]).
**Constraints:** the client `upload()` types require `access: 'public'` (matches
`storage.ts`), and `handleUpload` needs the static `BLOB_READ_WRITE_TOKEN` — OIDC is
not accepted ([client uploads][cu], [SDK][sdk]).

**Cross-restart resume (optional):** a kill restarts `upload()` — acceptable at
30 MB. If not: `createMultipartUpload` / `uploadPart` / `completeMultipartUpload`
with persisted `{uploadId, parts}`, no API change. 0.27.3 has no abort for abandoned
sessions, so leftover parts are accepted (open question).

## 2. Exact HTTP shapes

All routes: `runtime = 'nodejs'`, `OPTIONS → 204`, existing error style
(`{ error, code? }`), no auth (matching `/session`, `/segments`, `/finalize`).

### 2.1 `GET /api/recordings/{id}/recover?bytes=<n>&ext=<wav|m4a|…>`

Handshake; never mutates; safe on every launch/list refresh. `bytes`/`ext` are the
client's beliefs, used only to pre-answer "is my object already there". A **missing
document is recoverable** (case C3) and returns `needed: true`; only a malformed id
is rejected.

```jsonc
// 200
{
  "id": "0d6c…",
  "needed": true,                      // false ⇒ delete the buffer
  "reason": "audio_missing",           // | "already_attached" | "object_present" | "unknown_recording"
  "status": "recording",               // null when unknown_recording
  "mode": "blob",                      // storageMode()
  "pathname": "recordings/0d6c….wav",
  "contentType": "audio/wav",
  "uploadUrl": "/api/recordings/0d6c…/recover/upload",   // local mode: null
  "maxBytes": 67108864,
  "object": {                          // present when the object already exists
    "url": "https://….public.blob.vercel-storage.com/recordings/0d6c….wav",
    "bytes": 30146560,
    "sizeMatches": true                // false ⇒ divergent/partial delivery
  },
  "transcriptSource": null, "retryAfterMs": 0
}
```

### 2.2 `POST /api/recordings/{id}/recover/upload` — blob mode only

A `handleUpload` route ([client uploads][cu]); the client passes it as
`handleUploadUrl`; body is the SDK's `HandleUploadBody`. In
`onBeforeGenerateToken(pathname, clientPayload, multipart)`:

1. Guard the client-supplied pathname: starts with `recordings/<id>.`, no `..`,
   accepted audio extension — else throw.
2. Load the doc; throw when `ready`/`failed` or already attached (client then calls
   `GET /recover` and deletes its buffer). Unknown docs allowed (C3).
3. Return `{ allowedContentTypes, maximumSizeInBytes: 64 * 1024 * 1024,
   addRandomSuffix: false, validUntil: Date.now() + 24 * 3600 * 1000, tokenPayload }`.

`onUploadCompleted`: **no-op with a comment** — it cannot reach localhost and
`/complete` is the authority. Failures surface as
`BlobError('Failed to retrieve the client token')`; read that as "call `GET /recover`".
Local mode: `409 { code: "local_mode" }`.

### 2.3 `POST /api/recordings/{id}/recover/audio` — local mode only

`multipart/form-data`: `audio` (required), `duration`, `gapMs`. Blob mode:
`409 { code: "blob_mode" }`. Reuses the upload path — `normalizeAudioForAsr(bytes)`
to sniff/validate, then `storeAudio('recordings/<id>.<ext>', …)` under the existing
100 MB `maxUploadBytes()`. Stores but does **not** attach: one attach path in both
modes.

```jsonc
// 201
{ "pathname": "recordings/0d6c….wav", "url": "/api/recordings/audio/0d6c….wav",
  "bytes": 30146560, "contentType": "audio/wav" }
```

### 2.4 `POST /api/recordings/{id}/recover/complete`

Verifies the object exists, attaches it to the doc, decides the transcription path.
Idempotent by construction.

```jsonc
// request
{ "pathname": "recordings/0d6c….wav",
  "bytes": 30146560,
  "duration": 942.4,          // seconds, from the local file
  "gapMs": 4200,              // client's estimate of lost audio; null if unknown
  "prefer": "auto",           // "auto" | "stream" | "batch"
  "createdAt": "2026-10-14T18:03:11.000Z",       // only when the doc is missing
  "lat": 37.77, "lng": -122.41, "placeName": "…", // only when the doc is missing
  "clientAttempts": 2 }       // diagnostics
```

```jsonc
// 200 — the /process contract plus recovery fields
{ "id": "0d6c…", "status": "uploaded", "stage": "transcribe",
  "transcriptSource": "batch", "error": null, "retryAfterMs": 0,
  "audioUrl": "https://…", "recovered": true, "alreadyAttached": false }
```

- `409 object_missing` → the upload did not land; re-run `GET /recover`.
- `409 size_mismatch {expected, actual}` → another delivery won the pathname.
- `409 audio_conflict {audioUrl}` → attached elsewhere; the route deletes the
  offered `-rN` object (bounded cleanup), the client deletes its buffer.

`stage` is `transcribe` (or `enrich` when the stream transcript was kept) with
`retryAfterMs: 0`, so the client ticks `/process` immediately.

## 3. Server flow

Client: orphan buffer → `GET /recover` → skip upload if `object.sizeMatches`, else
upload to `pathname` → `POST /complete` → tick `POST /process` → delete local file
on `ready` (or terminal `failed`: the audio is archived either way).

Server, in order:

1. **`getRecoverState(id, { bytes, ext })`** — new `packages/api/lib/recover.ts`.
   Narrow projection (`status, isLiveSession, receivedChunks, transcript, audioUrl,
   duration, recover, transcriptSource, createdAt`), canonical pathname,
   `statStoredAudio(pathname)`, returns the §2.1 shape.
2. **Token mint / local store** — §2.2/§2.3, both re-verifying "still applicable".
3. **`attachRecoveredAudio(id, input)`** — new in `store.ts`:
   - Missing doc ⇒ insert a recovered document (`status:'uploaded'`, `audioUrl`
     from the object, `createdAt` from the body) — same trust as `/session`.
   - `statStoredAudio(pathname)` null ⇒ `object_missing`; byte mismatch ⇒
     `size_mismatch`.
   - `chooseTranscriptSource({ stitched: doc.transcript, receivedChunks, gapMs,
     streamedDuration: doc.duration, localDuration: input.duration, prefer })`.
   - Read `recover.attachedAt` first: set ⇒ return `alreadyAttached` (`$inc`
     `recover.attempts`, no other write). Else CAS
     `updateOne({ _id: id, audioUrl: <value just read> }, { $set: { … } })` — the
     read-value pattern `recordSegmentTranscript` already uses, avoiding
     dotted-path/`$exists` filters; a missed CAS re-reads and returns
     `alreadyAttached` or `audio_conflict`. `recover.attempts` is diagnostic.
4. **`/process` tick** — client-driven; the only `pipeline.ts` change is the §4
   condition. No new states or stages; `/process` returns the extended
   `ProcessResponse`.

## 4. Case B — who owns the source decision

The client knows the gaps (it holds the buffer and saw every `gap`/`ack`); the
server owns policy. One pure, unit-testable rule, applied once at attach:

```ts
// packages/api/lib/recover.ts
const GAP_TOLERANCE_MS = 5_000;   // "small" gaps: keep the streamed transcript
const COVERAGE_MIN = 0.95;        // streamed duration / local duration

export function chooseTranscriptSource(i: {
  stitched: string | null; receivedChunks: number;
  gapMs: number | null; streamedDuration: number; localDuration: number;
  prefer: 'auto' | 'stream' | 'batch';
}): 'stream' | 'batch' {
  if (!i.stitched?.trim() || i.receivedChunks === 0) return 'batch';  // case A
  if (i.prefer === 'batch') return 'batch';
  if (i.prefer === 'stream') return 'stream';
  const coverage = i.localDuration > 0 ? i.streamedDuration / i.localDuration : 0;
  return (i.gapMs ?? Infinity) <= GAP_TOLERANCE_MS && coverage >= COVERAGE_MIN
    ? 'stream' : 'batch';
}
```

`'stream'`: keep the stitched transcript, skip ASR, go to enrichment; the file is
for archive/re-listening. `'batch'`: the file is the transcript source; ASR the
whole thing. Audio is **always** uploaded. A wrong hint costs a slightly gappier
transcript or one extra ASR run — the trust level the API already gives `/segments`.

`pipeline.ts`: `if (!record.isLiveSession || record.transcriptSource === 'batch')`
takes the existing file path (12-minute lease, `transcribeAudio(record.audioUrl)`,
then `storeTranscript` overwrites the stitched copy only after ASR succeeds).
`AdvanceResult` and `ProcessResponse` carry `transcriptSource`.

## 5. Document fields

```ts
// packages/db/src/types.ts — Recording
transcriptSource?: 'stream' | 'batch';   // absent = legacy: live ⇒ stream, file ⇒ batch
recover?: {
  source: 'local-buffer';
  attachedAt: string;      // ISO; idempotency signal (read back before writing)
  pathname: string;        // recordings/<id>.<ext>
  bytes: number;
  durationSec: number;
  gapMs: number | null;
  attempts: number;        // /complete calls that touched the doc (diagnostic)
  clientAttempts?: number;
};
```

`audioUrl`/`audioContentType`/`duration` become real for live sessions (today the
URL is the placeholder `/api/recordings/audio/<id>-session`). `PipelineRecord` adds
`transcriptSource`; `RecordingSummary` is unchanged — the client renders recovery
from `status` + `transcriptSource` on ticks.

## 6. What changes in pipeline.ts / store.ts / the app

- `storage.ts`: add `statStoredAudio(pathname)` — blob `head(pathname)` (catch →
  null), local `stat(localAudioPath(flatten(name)))`; returns `{url, bytes,
  contentType}`. Reuse the existing flattening conventions, do not hand-roll.
- `pipeline.ts`: the §4 condition + `AdvanceResult.transcriptSource`. No lease or
  state changes.
- `store.ts`: `attachRecoveredAudio` (+ insert branch) and a `transcriptSource`
  projection in `getPipelineRecord`. Nothing changes in `recordSegmentTranscript`,
  `finalizeLiveSession`, `storeFailure`.
- New `lib/recover.ts`: `getRecoverState`, `recoverPathname(id, ext)`,
  `chooseTranscriptSource`, the shared applicability guard.
- New routes under `app/api/recordings/[id]/`: `recover/route.ts` (GET),
  `recover/upload/route.ts`, `recover/audio/route.ts`, `recover/complete/route.ts`.
- Client: persist `{recordingId, pathname, ext, bytes, duration, gapMs}` beside the
  buffer; `upload(pathname, file, { access:'public', handleUploadUrl, multipart:
  true, clientPayload })` in blob mode (single POST locally); `/complete`; delete on
  `ready`. The orphan-key crash handler becomes "finalize, then deliver".

## 7. Idempotency and cleanup

- **Delivery and attach:** deterministic create-only pathname → one object per
  recording; a retry after the object exists fails at upload, so any upload failure
  means "probe `GET /recover`" (0.27.3 has no distinct already-exists error class).
  Attach reads `recover.attachedAt` first, then CASes on the `audioUrl` value just
  read → one writer; duplicates get `alreadyAttached: true`.
- **Racing deliveries:** at worst two objects (`…wav`, `…-r2.wav`); one becomes
  `audioUrl`, the other dies in-band via the `audio_conflict` branch.
- **Guardrails:** `maximumSizeInBytes` 64 MB; pathname prefix/extension guard; local
  route reuses `maxUploadBytes()` (100 MB off-Vercel); `duration ≤ 4 h`; recovery
  refused for `ready`/`failed` docs; `validUntil` 24 h.
- **Orphan pruning:** no in-request `list()` scans. Attached objects die via the
  existing DELETE cascade, duplicates die in-band, and the residue (upload
  completed, app never returned) is handled by an ops script
  `packages/api/scripts/sweep-orphan-audio.mjs` (`list('recordings/')` → Astra
  lookup → delete unattached objects older than 7 days), keeping "no background
  jobs". Local `.data/audio` leftovers use the same naming and sweep logic.

## 8. Failure-mode table

| # | Scenario | State | Recovery behaviour |
|---|---|---|---|
| 1 | Upload interrupted mid-parts | partial multipart session, no object | `upload(multipart:true)` retries parts; next launch re-runs `upload()`; pathname unchanged |
| 2 | Upload completed, `/complete` lost (kill) | object present, doc untouched | next launch `GET /recover` → `sizeMatches:true` → skip upload → `/complete` |
| 3 | Killed again mid-upload / mid-`/complete` | buffer + id on device | as 1/2; attach is idempotent; buffer deleted only after `/complete` 200 |
| 4 | `/complete` 200, `/process` never ticked | doc `uploaded` (+`transcriptSource`) | doc stays non-terminal; next list refresh ticks it; no server-side kick (by design) |
| 5 | Sidecar up, API down at handshake | buffer only | `GET /recover` fails → client backoff; no doc change |
| 6 | API up, Blob unreachable / token invalid | buffer only | upload fails → retry; `validUntil` 24 h absorbs flaps |
| 7 | API dies after token minted, upload in flight | object may complete | bytes still land (Blob is independent); `/complete` later → case 2 |
| 8 | Doc deleted while buffer pending | no doc | `/recover` says `unknown_recording`; only re-create if the user did not delete — else drop the buffer |
| 9 | Duplicate concurrent deliveries | create-only pathname | one object wins; losers see `sizeMatches`/`size_mismatch`; attach returns `alreadyAttached`/`audio_conflict` |
| 10 | Divergent bytes, same id | two objects | first attach wins; second `409 audio_conflict`, its `-rN` object deleted in-band |
| 11 | Client token expired mid-multipart | partial session | re-run `GET /recover` → fresh token → re-upload (`BlobClientTokenExpiredError` is the tell) |
| 12 | ASR fails transiently after attach | audio stored, doc `uploaded` | existing pipeline semantics: retry, count attempts, `failed` after 5; audio safe |
| 13 | Case A, no segments, no finalize | doc `recording` | `/complete` sets `uploaded` + `'batch'`; recovery is a superset of `/finalize` |
| 14 | Case C3: no doc at all | buffer + id | `/recover` → `unknown_recording`; `/complete` inserts the recovered doc (trust as `/session`) |

## 9. Gotchas

- `handleUpload` needs the static `BLOB_READ_WRITE_TOKEN`; an OIDC-only deployment
  must switch to `handleUploadPresigned` ([SDK][sdk], [signed URLs][signed]).
- Client `upload()` in 0.27.x requires a **public** store (types enforce
  `access: 'public'`); `storage.ts` already stores public.
- `onUploadCompleted` never fires locally; never put attach logic there.
- Client-token default validity is 1 hour — set `validUntil` explicitly.
- The client cannot probe the object itself (no token): `/recover` must `head()`.
- A 30 MB `loadAudio` + 10-minute sidecar transcription sits inside the 12-minute
  lease, but batch recovery on a slow path is the tightest budget here.
- In blob mode the container is sniffed only at transcription
  (`normalizeAudioForAsr` inside `transcribeAudio`); a mislabeled upload fails
  non-retryably there, audio still archived.

## 10. Open questions

1. Abandoned multipart sessions: no abort/cleanup API in 0.27.3 — accept residue, or
   is there a store-level lifecycle?
2. Manual "re-transcribe from the archived file" later? The design supports it (audio
   always stored) but no route/reset transition exists.
3. Batch ASR of a 15-minute file on CPU `small.en` may exceed the 10-minute client
   timeout under concurrency; Groq escalation may need to be pulled forward.
4. Refine `gapMs` with sidecar-measured `gap` events (stored at `bye`)?

[cu]: https://vercel.com/docs/vercel-blob/client-upload
[sdk]: https://vercel.com/docs/vercel-blob/using-blob-sdk
[blob]: https://vercel.com/docs/vercel-blob
[signed]: https://vercel.com/docs/vercel-blob/vercel-signed-urls
