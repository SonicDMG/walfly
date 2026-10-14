# Current live-session flow — map

> Reference for the streaming rewrite (`feat/streaming-sidecar`). Produced by a
> codebase exploration pass against `main` (1d0d0a3). Line numbers refer to that
> revision. Everything here describes the OLD (client-chunked) pipeline.

## 0. End-to-end sequence (current)

```
Mobile                        API (Next.js, nodejs)                  Astra                   Sidecar (FastAPI)
------                        ----------------------                 -----                   ----------------
POST /session ──────────────► createLiveSession() ─────────────────► recordings_v2 (status=recording, isLiveSession=true)
capture 15 s segments
POST /{id}/chunks (each) ───► chunks/route.ts ──► transcribeAudioBytes ──────────────────► POST /v1/transcribe (blocking)
                              recordChunkTranscript() ─────────────► recording_chunks_v2 upsert + re-stitch parent transcript/receivedChunks
POST /{id}/finalize ────────► finalizeLiveSession() ───────────────► status=uploaded (+totalExpectedChunks, duration)
loop POST /{id}/process ────► advanceRecording()
  status uploaded             (isLiveSession ⇒ skip ASR, reuse stitched transcript) ────► storeTranscript status=enriching
  status enriching            enrichTranscript + detectMusicFromTranscript (LLM) ────────► storeEnrichment status=ready
```

There is **no audio ever stored for a live session** (chunks are "ephemeral": `deletedAt` is stamped at write time; `audioUrl` is a placeholder that 404s). Transcription happens *inside the chunk-upload request*.

---

## 1. Client side (`apps/mobile`)

### 1.1 Entry points / UI

- Record screen: `apps/mobile/app/(tabs)/index.tsx`
  - Hook wiring: `useRecordingUpload()` L36-37, `useBeePioneerRecorder()` L38.
  - Mic button press: `handlePress()` L99-108 (start → stopAndUpload → reset+start again).
  - Bee pill press: `handleBeePress()` L110-118; "one capture source at a time" guard L100.
  - Progress bar only during `uploading`/`processing` L206-208.
  - Fake "streaming audio checkpoints" badge while recording L176-182 (static string, no real checkpoint data).
- List screen (self-healing ticker): `apps/mobile/app/(tabs)/recordings.tsx`
  - `tickPending()` L92-129: POSTs `/api/recordings/{id}/process` for up to `MAX_TICKS_PER_ROUND = 5` non-terminal rows (L52, L94, fetch at L100), applies returned status L117-125, delay computed from `retryAfterMs` clamped to `[2000, 8000]` L108-114.
  - Focus loop L243-260: immediate fetch L249, setTimeout chain L250-257, idle recheck `IDLE_RECHECK_MS = 5000` L55/L255.
  - Hibernation poll: `setInterval(..., 6000)` while `isWakingUp` L228-234.
  - Search debounce 50/500 ms L262-272.
- Detail screen: `apps/mobile/app/recording/[id].tsx`
  - Pipeline ticker while `isNonTerminal(status)` L116-146: POST `/process` L125, re-fetch on status change L130-132, else setTimeout `[2000, 8000]` L134-136 (no overall deadline).
  - Live sessions hide the audio player (placeholder URL): L338-345 (`!recording.isLiveSession` at L339).
- Hook teardown/app startup: `apps/mobile/app/_layout.tsx` L29-42 — `sweepOrphanedChunkFiles()` L32 and a health pre-ping L36.

### 1.2 `hooks/useRecordingUpload.ts` (phone mic path, web + native)

Constants: silence gate `SILENCE_DB_THRESHOLD = -32` dBFS L80, metering poll `METERING_POLL_MS = 250` L82, `MIN_RECORDING_MS = 700` L85, `MAX_RECORDING_MS = 15 min` L87, `PROCESSING_DEADLINE_MS = 20 min` L98, progress map L101-108, web mime preference L128-134, upload MIME table L137-149 (used only by dead code, see §7).

Start (`startRecording` L254-444):
- Teardown stale recorder L267; mic permission L269-274.
- Fire-and-forget location capture L278 (`requestAndCapture()`); **never sent to a live session** (see §7).
- Session id = `crypto.randomUUID()` L287; stored in `localStorage` under `ACTIVE_SESSION_STORAGE_KEY = 'walfly_active_recording_session'` L59/L289-293.
- **Session create**: `POST /api/recordings/session` with only `{id, createdAt}` L295-302 (void, error only logged).
- Web branch L306-338: `startWebRecording({ mimeTypes, audioBitsPerSecond: 32000, chunkIntervalMs: 15000, onChunk, onSilentChunk })` L307-338.
  - `onChunk` (L311-324): increments `chunkIndexCounterRef`, computes `offsetMs = now - startedAt - durationMillis` L314, enqueues `{recordingId, chunkIndex, offsetMs, duration, blob, attempts:0}` L316-323.
  - `onSilentChunk` (L325-337): same but `silent: true`, no blob.
- Native branch L339-429: `AudioModule.AudioRecorder` with `recordingOptions()` L340-344; metering interval 250 ms L350-364; **segment rotation interval 15000 ms** L368-428:
  - Sequence: new recorder created+started *before* stopping old L386-393, old stopped L393, peak snapshot/reset L381-383, silence check `peakDb < -32` L397, enqueue uri chunk L411-421 or silent marker L400-409; `isRotatingRef` skip guard L371.
- Hard stop timer L432-435; state `recording` L430.

Stop/upload (`stopAndUpload` L446-655):
- Synchronously claims recorder L452-457, clears timers L459-471, sets `uploading`.
- Enforces `MIN_RECORDING_MS` L477-478.
- Web: `webHandle.stop()` L484 (result blob **discarded**; only duration used L485).
- Native: capture final peak L488-496, `recording.stop()` L500, release iOS session L506, compute duration L516-519, enqueue final segment L522-558 (`recording.uri`; missing-URI error log L543-546).
- **Drain then finalize** (current-session branch L569-595): `await chunkUploadQueue.drain()` L572; `POST /{id}/finalize` with `{totalExpectedChunks: chunkIndexCounterRef.current, duration}` L576-583; remove localStorage key L589-593; `activeSessionIdRef = null` L594.
- Dead single-shot upload branch L596-628 (see §7).
- Then `drivePipeline(targetRecordingId, ...)` L633, done + auto-reset `AUTO_RESET_MS = 2000` L640-645.

Crash recovery (web-ish): mount effect L223-252:
- Reads orphan id L229-230, fires `POST /{id}/finalize` with `{}` L232-236, removes the key in `.finally()` **even if the finalize failed** L236-240.

Pipeline driver `drivePipeline` L810-853: loop until `PROCESSING_DEADLINE_MS`; POST `/process` L824; abort → return L820/826; 404 → throw L833; 3 consecutive non-OK/network failures → throw L827/L834-836; progress from `PROGRESS_BY_STATUS[tick.status]` L843; `failed` → throw L845; `ready` → return L846; delay = clamp(`tick.retryAfterMs`, 1500, 8000) L848.

Recording config `recordingOptions()` L701-719: metering on, `.m4a`, 22050 Hz mono, 32 kbps, AAC; playback/record audio-mode helpers L682-694, `releaseIosRecordSession` L722-728.

### 1.3 Web capture/chunking/VAD — `lib/webRecorder.ts`

- Why: expo-av web loses the single blob on browser-initiated halt; direct MediaRecorder with timeslice instead (doc L1-19).
- Constants: `DEFAULT_TIMESLICE_MS = 1000` L21, `STOP_EVENT_FALLBACK_MS = 3000` L23 (declared, **never used**).
- `startWebRecording` L39-46; `getUserMedia` L47; mime negotiation L49-53.
- **VAD = energy gate, not Silero**: Web Audio `AnalyserNode` (fftSize 512) polled every **100 ms** L86-101; `SILENCE_DBFS_GATE = -32` L70; sets `hadSpeech` L98-100. If AudioContext fails → `hadSpeech = true` L102-108.
- Segment recorders accumulate in per-segment blob arrays `createSegmentRecorder` L116-130.
- `cycleChunk` L135-171: swaps recorder, resets `hadSpeech`/`windowPeakDb` L143-145, starts next segment L149-152, on old recorder `stop` emits `onChunk(sliceBlob, chunkDuration)` L155-164 or `onSilentChunk(duration)` L161-163.
- Start with timeslice L175; **chunk timer** `setInterval(cycleChunk, options.chunkIntervalMs)` L178-183 (15 000 ms from the hook).
- `stop()` L186-241: clears chunk/meter timers, disconnects analyser, emits final chunk L213-228, resolves `{blob, durationMillis, endedEarly}` — `endedEarly` is always `false` (L226).
- `cancel()` L242-266.

### 1.4 Native chunking

Covered in §1.2 — 15 s rolling `AudioRecorder` segments (L368-428) with dBFS metering (250 ms), final segment at stop L522-558.

### 1.5 Chunk queue — `lib/chunkQueue.ts`

- `QueuedChunk` shape L11-22: `{recordingId, chunkIndex, offsetMs, duration, blob?, uri?, filename?, attempts, silent?}`.
- Singleton `chunkUploadQueue` L24, exported L144. **In-memory only** despite the "Persistent" docstring L4.
- `enqueue` L29-32 → `processQueue` L57-100 (single-flight via `isProcessing`; sequential FIFO; shift + callbacks L65-67; deletes temp file L70-77).
- Failure path L78-96: `attempts += 1`; **drop after >5 attempts** L80-91 (deletes file, logs); backoff `min(1000·2^attempts, 10000)` L94.
- `uploadChunkWithRetry` L102-141: multipart fields `chunkIndex`, `offsetMs`, `duration`, `silent` or `audio` (`chunk-N.{ext}` for blobs L112-119, `fileRef` + `filename ?? chunk-N.mp4` for native L120-123); POST to `/api/recordings/{id}/chunks` L125-128; any non-OK/network error → false L130-140.
- `drain()` L38-48: 100 ms `setInterval` poll until queue empty and not processing (used by both hooks). `getPendingCount` L34-36 and `onChunkUploaded` L50-55 are **unused**.
- `sweepOrphanedChunkFiles` L152-169: deletes only `*.m4a` in cache (L162) — Bee `.aac` leftovers are never swept.

### 1.6 Bee Pioneer BLE path — `useBeePioneerRecorder.ts` + `lib/beePioneer.ts` + `lib/beeProtocol.ts`

Differences from the phone path:
- Phone encodes AAC→file per 15 s; Bee already emits ADTS/AAC frames over BLE notify and the client concatenates them raw — "no PCM, no re-encode" (hook doc L9-15).
- Constants: `CHUNK_INTERVAL_MS = 15000` L42, `MAX_RECORDING_MS = 15 min` L46, `PROCESSING_DEADLINE_MS = 20 min` L47.
- BLE plumbing `lib/beePioneer.ts`: GATT service/characters L30-32 in `beeProtocol.ts`; audio monitor strips 2-byte header and pushes through `AdtsFramer` L153-172 (L164-169); `startAudio()`/`stopAudio()` write `0xC006` L232-243; control timeout 5 s L40, scan timeout 20 s L41; disconnect callback L126-131.
- `startRecording` L170-238: platform guard (no web) L171-175; connect + remember device L183-198; **same session create** `POST /api/recordings/session` `{id, createdAt}` L208-221 (no localStorage recovery); `startAudio()` L223; `setInterval(flushChunk, 15000)` L226; 15-min max timer L227.
- `onAudioFrame` accumulates frames + sample count L192-195.
- `flushChunk` L111-168: computes offset/duration from ADTS sample rate L121-128; empty window → silent marker L130-140; else concatenates frames, writes `bee-chunk-N-<ts>.aac` to cache, enqueues with `filename: chunk-N.aac` L142-156; write failure → silent marker L157-167.
- `stopAndUpload` L240-292: stop timers L244, `stopAudio()` L250, **final flush** L251, disconnect L252, `drain()` L257, finalize L261-268, `drivePipeline` L273-283 (local copy L349-383, same 1500-8000 ms clamp L378).
- No crash recovery, no persistence of the session id.

### 1.7 `lib/api.ts`

- Base URL resolution L23-39 (`EXPO_PUBLIC_API_URL`; web default `http://localhost:3030` L34; native throws L38).
- `apiUrl` L41-43; `resolveAudioUrl` L50-52; hibernation error helpers L57-85; `describeRequestError` L93-108 (TypeError → "cannot reach the API" L97-105).
- Wire types re-exported from `lib/types.ts` L114-134; the mirror of the DB contract lives in `apps/mobile/lib/types.ts` — `RecordingStatus` L46, `NON_TERMINAL_STATUSES` L50-55, `Recording` L61-89 (live fields `isLiveSession`/`checkpointSeq`/`totalExpectedChunks`/`receivedChunks` L83-88), `RecordingChunk` L36-44, `ProcessResponse` L131-137.

### 1.8 Complete polling/timer inventory (client)

| Where | Timer | Interval | Purpose |
|---|---|---|---|
| `useRecordingUpload.ts` L350-364 | `setInterval` | 250 ms | native metering peak tracking |
| `useRecordingUpload.ts` L368-428 | `setInterval` | 15 000 ms | native segment rotation |
| `useRecordingUpload.ts` L432-435 | `setTimeout` | 900 000 ms | hard stop |
| `useRecordingUpload.ts` L640-645 | `setTimeout` | 2 000 ms | auto-reset done→idle |
| `useRecordingUpload.ts` L819-850 | loop + sleeps | 1 500–8 000 ms | `/process` drive until ready (20 min deadline) |
| `webRecorder.ts` L86-101 | `setInterval` | 100 ms | Web Audio RMS gate |
| `webRecorder.ts` L178-183 | `setInterval` | `chunkIntervalMs` (15 000) | web chunk rotation |
| `chunkQueue.ts` L41-46 | `setInterval` | 100 ms | `drain()` spin |
| `chunkQueue.ts` L94 | `setTimeout` | 1–10 s exp. | upload retry backoff |
| `useBeePioneerRecorder.ts` L226-227 | `setInterval`/`setTimeout` | 15 000 / 900 000 | Bee flush / hard stop |
| `useBeePioneerRecorder.ts` L354-379 | loop | 1 500–8 000 ms | `/process` drive |
| `recordings.tsx` L227-234 | `setInterval` | 6 000 ms | hibernation retry of list |
| `recordings.tsx` L243-260 | setTimeout chain | 5 s idle / 2–8 s tick | list self-healing `/process` (max 5 rows/round) |
| `recordings.tsx` L262-272 | `setTimeout` | 50/500 ms | search debounce |
| `recording/[id].tsx` L116-146 | setTimeout chain | 2–8 s | detail-screen `/process` ticker (no deadline) |

---

## 2. Server API (`packages/api/app/api/recordings/*`)

All routes are `runtime = 'nodejs'`.

### 2.1 `POST /api/recordings/session` — `session/route.ts` L6-29
- Body: `{id?, createdAt?, lat?, lng?, placeName?, title?}` L8-18.
- `createLiveSession(...)` L12-19 → 201 `{id, status: 'recording'}` L21; 500 on error L22-27.
- **Datastore write**: `recordings_v2.insertOne` (see §4.1).

### 2.2 `POST /api/recordings/{id}/chunks` — `[id]/chunks/route.ts`
- Multipart fields: `chunkIndex`, `offsetMs`, `duration`, `silent`, `audio` (Blob/File). Parsing L58-65.
- Silent-without-audio branch L69-84: calls `recordChunkTranscript({... transcript:'', deletedAt: now, silent:true})` L70-78 → 200 `{status:'silent', chunkIndex}` L80-83.
- Missing audio → 400 L86-88.
- Bytes → `Uint8Array` L90-92.
- **Music buffer** (module-scope `Map` L19-23, 8 non-silent chunks ≈120 s, L17): accumulate L96-101; on threshold `flushMusicBuffer` L102-104; flush concatenates, deletes entry *before* the async call L25-49, then fire-and-forget `detectMusicFromAudio(...).then(storeMusicDetection)` L43-49. This is an explicit `void` detached promise (contradicts the codebase's "no detached work" invariant).
- **Transcription**: `await transcribeAudioBytes(bytes, audioFilename, offsetMs)` L107 (blocking; request duration = sidecar ASR duration).
- Store: if non-empty transcript → `recordChunkTranscript({..., deletedAt: now})` L112-121; if empty (sidecar said silent) → **nothing stored at all** L122-124 (comment at L109-111 claims the chunk "is still counted as processed"; it is not).
- Response L126-134 `{recordingId, chunkIndex, status: 'transcribed'|'silent', transcriptLength}`; 500 on any throw L135-141.
- Note: no `export const maxDuration` here, so on Vercel this route gets the platform default while it synchronously waits on Whisper.

### 2.3 `POST /api/recordings/{id}/finalize` — `[id]/finalize/route.ts` L6-28
- Body `{totalExpectedChunks?, duration?}` L12-18 → `finalizeLiveSession(id, totalExpectedChunks, duration)` L14-18 → 200 `{id, status:'uploaded'}` L20; 500 L21-27.
- No chunk-completeness validation.

### 2.4 `POST /api/recordings/{id}/process` — `[id]/process/route.ts`
- Doc: one tick per call L1-14; `maxDuration = 300` L21.
- `advanceRecording(id)` L39; 404 L50-52; 503 `{error, retryAfterMs}` when state unreadable (`result.status === null`) L54-61; 200 tick `{id, status, stage, error, retryAfterMs}` L63-69.
- Response contract mirrored in `apps/mobile/lib/types.ts` L131-137.

### 2.5 `GET|POST /api/recordings/upload` — `upload/route.ts` (non-live path)
- `GET` L64-70 → `{maxUploadBytes, storage, acceptedMimeTypes}`; cap = 4 MB on Vercel / 100 MB local L42-44.
- `POST` L72-189: parse multipart L73-79; require `audio` L81-84; empty check L91-93; size check L94-106; sniff magic bytes L108 (`sniffAudioContainer`); normalize L113-122 (`normalizeAudioForAsr`, 415 on `unsupported_media` L117-119); fields `duration/clientTimestamp/lat/lng/placeName` L124-129; `crypto.randomUUID()` L131; `storeAudio('recordings/{id}.{ext}')` L133-142; `createRecording` L144-154; orphan cleanup + hibernation 503 L155-181; 201 `{id, status:'uploaded', audioUrl, audioContentType}` L185-188.
- **No work is started here** (doc L13-16); the client must drive `/process`.

### 2.6 `GET|PATCH|DELETE /api/recordings/{id}` — `[id]/route.ts`
- GET L33-62: raw `findOne({_id})` (unprojected, so transcript included) → 200 full doc; 404 L38-40; hibernation 503 L44-56.
- PATCH L66-185: validates title/tags/notes/placeName L80-144; `updateOne` L151; re-read L156; `{success, recording}` L161.
- DELETE L189-235: best-effort `deleteAudio` L201-205; **cascade chunk delete** `chunksCollection.deleteMany({recordingId})` L208-210; `deleteOne` L212.
- `GET /api/recordings` (list/search, not live-specific): `route.ts` L70-138, projection L39-51/`toSummary` L54-68.

### 2.7 `GET /api/recordings/audio/[filename]` — serve route
- Path-traversal guard L34, local-mode only L38, Range support L59-84, streamed body L71-73.

---

## 3. Pipeline + store (`packages/api/lib`)

### 3.1 State machine — `pipeline.ts` / `store.ts`

Statuses (`packages/db/src/types.ts` L48): `recording → uploaded → transcribing | enriching → ready | failed`. (`transcribing` is no longer produced by the current pipeline — live sessions skip ASR entirely and go `uploaded → enriching`.)

Transitions in `advanceRecording` (`pipeline.ts` L58-134):

| Current status | Action | Next status | Code |
|---|---|---|---|
| `ready`/`failed` | no-op terminal | same | L72-74 |
| `recording` | wait (no lease) | `recording`, retryAfterMs 3000 | L77-79 |
| `uploaded` | acquire 12-min lease L84; live ⇒ `markdown = record.transcript` L88-92, else `transcribeAudio(record.audioUrl)` L91; empty ⇒ throw L94-96; `storeTranscript` L98 | `enriching` | L82-101 |
| `enriching` (no transcript) | throw L106 | ← terminal failure path | L104-106 |
| `enriching` | acquire 4-min lease L107; `Promise.all([enrichTranscript, detectMusicFromTranscript])` L110-115; optional `storeMusicDetection` L116-118; `storeEnrichment` L119 | `ready` | L104-122 |
| unrecognised (legacy `processing`/`error`) | terminal passthrough, retryAfterMs 0 | same | L124-130 |

Failure routing `handleFailure` L141-183:
- `status === null` (first read failed) → no write; process route answers 503 L151-157.
- Retryable (`isRetryable` L190-206: `TranscriptionError.retryable`, unparseable-LLM-JSON L195, Timeout/Abort/TypeError L199, DataAPI/Fetch/TransientStorage name patterns L200-202, ECONNRESET etc. L204-205) **and** `nextAttempt < MAX_TRANSIENT_ATTEMPTS = 5` L47 → `recordTransientFailure` (status unchanged, `$inc attempts`, `leaseUntil=0`, `failedStage`, `error`), retryAfterMs `min(2000·2^attempts, 30 000)` L174.
- Otherwise `storeFailure` → `status='failed'`, retryAfterMs 0 L178-182.
- Note: `storeTranscript` and `storeEnrichment` reset `attempts` to 0 on success (`store.ts` L351, L389).

### 3.2 Lease mechanism — `store.ts` L293-310
- CAS update: filter `{_id, status: expectedStatus, leaseUntil: {$lt: now}}` → `$set {leaseUntil: now + leaseMs}`; acquired iff `matchedCount === 1` L302-309.
- Durations: `LEASE_TRANSCRIBE_MS = 12 min` (`pipeline.ts` L42), `LEASE_ENRICH_MS = 240 s` L44.
- Expiry is the crash-recovery mechanism (doc L7-9); `releaseLease` L313-316 exists but is **never called**; the retry path frees the lease implicitly via `recordTransientFailure` L463 and success paths write `leaseUntil: 0` (`store.ts` L328, L351, L388, L508).

### 3.3 Chunk transcripts / stitching — `store.ts` L147-199 (`recordChunkTranscript`)
- Chunk doc id: `` `${recordingId}_chunk_${String(chunkIndex).padStart(6,'0')}` `` L157.
- Upsert into `recording_chunks_v2` L160-175: `{recordingId, chunkIndex, duration, offsetMs, status:'transcribed', transcript: clampUtf8Bytes(...) (≤7500 bytes), deletedAt (now), silent}` — **pure WAL, no `$vectorize`, no audioUrl**.
- Re-reads **all** chunk docs sorted by `chunkIndex` L178-182 and re-stitches `transcript = chunks.map(c=>c.transcript).filter(Boolean).join('\n\n')` L184-187.
- Parent update L190-198: `{receivedChunks: allRecordedChunks.length, transcript: stitchedTranscript}` — does **not** touch `status`, `checkpointSeq`, `totalExpectedChunks`, or `attempts`.
- `checkpointSeq` is initialised to 0 in `createLiveSession` L93 and **never updated anywhere** (grep: only type declarations). Effectively dead.
- O(n²) cost: every chunk upload re-reads the full chunk log. No `recordingId` index is created for `recording_chunks_v2` (`collections.ts` L108-110 only sets an indexing deny list).

### 3.4 `finalizeLiveSession` — `store.ts` L104-130
- `updateOne({_id, isLiveSession: true}, {$set: {status:'uploaded', totalExpectedChunks?, duration?}})` L112-125; throws if not matched L127-129.
- No check that `receivedChunks ≈ totalExpectedChunks`; no "stop accepting chunks" flag; a chunk arriving after finalize still upserts and mutates `transcript` (used next tick by the pipeline).

### 3.5 `createLiveSession` document — `store.ts` L60-101
- `status:'recording'` L77, `leaseUntil:0` L80, `attempts:0` L81, `isLiveSession:true` L92, `checkpointSeq:0` L93, `totalExpectedChunks:0` L94, `receivedChunks:0` L95, `audioUrl: '/api/recordings/audio/{id}-session'` (placeholder) L74, `audioContentType:'audio/mp4'` L75.

### 3.6 Enrichment
- Pipeline call site: `pipeline.ts` L110-119.
- `enrich.ts`: `enrichTranscript` L67-97 (refuses empty transcript L68-73, truncates at 48 000 chars L28/L75-78, JSON-mode fallback L103-136, defensive parse L155-182).
- Transcript music inference: `detectMusicFromTranscript` L252-320 (never throws, caps inferred score at 0.6 L301).
- Audio music detection: `music.ts` `detectMusicFromAudio` L54-147 (base64 audio to multimodal LLM L75-91, min score 0.85 L111); called only from the chunk route.
- `storeEnrichment` `store.ts` L361-444: capability probe L369; builds `$set` with `status:'ready'`, search tokens, bounded `$vectorize` L390-400; leaves `music` untouched when `undefined` (live path) L401-403; optional `$lexical` with optimistic fallback L407-427; 0-match guard L429-431.
- LLM client: `llm.ts` L24-42 — 60 s timeout, `maxRetries: 0` L37-38 (the lease is the retry loop); models: `getLlmModel` L48-54, `getMusicDetectionModel` L69-71.

---

## 4. DB (`packages/db/src`)

Collections (`constants.ts` L7-12): live path writes **`recordings_v2`** + **`recording_chunks_v2`**; v1 names retained.

### 4.1 `Recording` as written (`types.ts` L54-85; live doc literal `store.ts` L69-96)

| Field | Value on live create | Notes |
|---|---|---|
| `_id` | client-generated UUID (session id) | `session/route.ts` L9 |
| `title` | `Live Recording <locale date>` | store L71, clamped to 300 chars |
| `duration` | 0 → client value at finalize | L73 / L118-120 |
| `audioUrl` | `/api/recordings/audio/{id}-session` (does not exist) | L74; player hidden for live |
| `audioContentType` | `audio/mp4` | L75 |
| `status` | `recording` → `uploaded` → `enriching` → `ready` | L77 etc. |
| `leaseUntil` / `attempts` | 0 / 0 | L80-81 |
| `transcript` | null, replaced by stitched chunk transcript | L84 + `recordChunkTranscript` L190-198 |
| `isLiveSession` | `true` | L92 |
| `checkpointSeq` | `0`, never updated | L93 |
| `totalExpectedChunks` | 0 → client at finalize | L94 / L116 |
| `receivedChunks` | 0 → `allRecordedChunks.length` after each chunk | L95 / L194 |
| `chunks?` | never written (legacy v1 array) | types L83 |
| `music?` | optional, merge-written by chunk route / enrichment | types L84 |

`PipelineRecord` projection (`types.ts` L95-99; `store.ts` L251-263) includes `isLiveSession` + `music` but **not** `receivedChunks`/`totalExpectedChunks`.

### 4.2 `RecordingChunk` as written (`types.ts` L33-45; `store.ts` L160-175)

`_id = recordingId_chunk_NNNNNN`, `recordingId`, `chunkIndex`, `duration` (s), `offsetMs`, `status:'transcribed'`, `transcript` (≤7 500 UTF-8 bytes), `deletedAt` = ISO now (ephemeral), `silent`. `audioUrl` and `$vectorize` are declared but never set by the live path. No index on `recordingId`.

### 4.3 Collection plumbing
- `ensureRecordingChunksV2Collection` lazy-creates without vector config (`collections.ts` L99-128); DELETE cascade uses it (`[id]/route.ts` L193/L208-210).
- Seeder: `seed-schema-v2.ts` (hybrid def L44-48, fallback L87-92; chunks v2 L95-111).
- Capability probe **queries the v1 collection name** (`capabilities.ts` L18/L49 vs `constants.ts` L7/L11) — so `storeEnrichment`'s `$lexical` gate and `/api/recordings` search capabilities are decided from the wrong collection's definition.
- Text clamps: `text.ts` — `clampUtf8Bytes` L61-86, `buildSearchTokens` L29-37, `buildVectorizeText` L21-26.

---

## 5. Sidecar + transcribe client

### 5.1 HTTP surface — `packages/api/sidecar/transcribe_sidecar.py`

| Endpoint | Lines | Request | Response |
|---|---|---|---|
| `GET /health` | L321-323 | — | `{"status":"ok"}` |
| `POST /v1/convert/file/async` | L336-358 | multipart `files`, optional `to_formats`, `target_type` | `{"task_id": uuid}`; runs in daemon thread L351-356 |
| `POST /v1/transcribe` | L361-398 | multipart `files` | `{"markdown": "..."}` — **blocks**: thread L379-383 + `done.wait()` L384; 500 w/ detail on failure L386-390; task popped L395-396 |
| `GET /v1/status/poll/{task_id}` | L401-422 | — | `{task_id, task_status: pending/success/failure, error_message}` (+`failure` on failure L417-422) |
| `GET /v1/result/{task_id}` | L425-461 | — | `{document:{md_content,...}, num_succeeded, num_failed}`; 425 while pending L434-435; failure body L437-444; popped on read L449-451 |

Internals:
- In-memory task store + lock L51-82.
- Timestamped markdown `_build_timestamped_markdown` L96-134 → `[time: m:ss.s-m:ss.s] text` lines (format defined by `_fmt_time` L89-93).
- Silence short-circuit `_is_silent_audio` L152-246 (PyAV full decode L158-193; raw-WAV fallback L197-242; `_SILENCE_RMS_THRESHOLD = 0.025 ≈ -32 dBFS` L145) with a **TODO to remove after client-side VAD is confirmed** L137-140.
- `_run_transcription` L253-314: silence → empty markdown L259-266; explicit device resolution mps/cuda/cpu L278-283; Docling `AsrPipeline` + `WHISPER_TURBO` L286-297; `converter.convert(audio_path)` L300; temp-file cleanup L309-314.
- Temp files written with `.m4a → .mp4` rename L326-333.
- Entrypoint: `SIDECAR_PORT`/`PORT`/8888 L468-472.

### 5.2 API→sidecar client — `packages/api/lib/transcribe.ts`
- Config: `SIDECAR_URL` default `http://localhost:8888` L43-45; `TRANSCRIBE_TIMEOUT_MS = 10 min` L21.
- `transcribeAudioBytes(bytes, filename, offsetMs)` L51-109: normalize L56; multipart field **`files`** with normalized filename/mime L58-63; POST `{SIDECAR_URL}/v1/transcribe` L65; `AbortSignal.timeout` L73; timeout/network → `TranscriptionError('timeout'|'transient', retryable:true)` L75-83; non-OK → retryable iff 429/≥500 L85-93; JSON parse errors retryable L95-100; `offsetMs > 0` patches `[time:]` prefixes via `adjustTimestamps` L104-106/L111-122.
- `transcribeAudio(audioUrl)` L128-183: identical request after `loadAudio(audioUrl)` L129-130; empty markdown → non-retryable `empty_transcript` L176-179.
- Deployment/consumption documented in `packages/api/sidecar/DEPLOY.md` L71-79; cold-start note L42-48; no auth L86-89; in-memory only L90-91.

---

## 6. Integration points for server-side streaming

Where a "stream audio to sidecar" path plugs in / replaces code:

1. **Client capture taps**
   - Web: `lib/webRecorder.ts` `cycleChunk` L135-171 and the `onChunk`/`onSilentChunk` invocations L155-164, L213-221 — or bypass buffering entirely and forward `dataavailable` (L122-127) to a socket.
   - Native: rotation interval `hooks/useRecordingUpload.ts` L368-428 and final segment L522-558; the recorder's file URI (L411) is the only handle today.
   - Bee: `hooks/useBeePioneerRecorder.ts` `bee.onAudioFrame` L192-195 (frames are already real-time; the file-write in `flushChunk` L142-156 is the client-side chunker) and `lib/beePioneer.ts` audio monitor L153-172.
2. **Client transport**: `lib/chunkQueue.ts` `uploadChunkWithRetry` L102-141 is the unit to replace with a persistent socket/SSE writer; preserve the `drain()` contract L38-48 because both hooks await it (`useRecordingUpload.ts` L572; `useBeePioneerRecorder.ts` L257).
3. **Server ingest**: `app/api/recordings/[id]/chunks/route.ts` — call site `transcribeAudioBytes` L107 and store call L114; a streaming equivalent would be a new route beside `session/finalize` (same `[id]` folder) or a WS/SSE handler.
4. **Sidecar**: new streaming endpoint next to `POST /v1/transcribe` L361-398; `_run_transcription` L253-314 is file-based and would need a stream variant. The unused async trio (`/v1/convert/file/async` L336-358, `/v1/status/poll` L401-422, `/v1/result` L425-461) is already a "task" API that could be repurposed or deleted.
5. **API→sidecar client**: `lib/transcribe.ts` L58-74 (and the duplicate L132-148) is the single outbound request block to replace; `sidecarUrl()` L43-45.
6. **Durability/state**: `store.ts` `recordChunkTranscript` L147-199 already implements the WAL semantics a streaming server needs; `finalizeLiveSession` L104-130 is where "stream finished" settles; `pipeline.ts` L88-92 is the existing live-session branch that skips re-ASR; enrichment trigger stays L104-122.
7. **Client-side streaming precedent**: `app/api/chat/route.ts` SSE `ReadableStream` L95-133 (headers incl. `X-Accel-Buffering: no` L128-131) and `apps/mobile/hooks/useChat.ts` (expo/fetch streaming body, L9-11, L106) — the pattern to copy if using SSE rather than WS.

---

## 7. Pain points, dead code, TODOs

### Reliability / races
1. **Chunk upload = synchronous ASR request.** `chunks/route.ts` L107 awaits Whisper; `chunkQueue` serializes uploads (L57-63) and `drain()` blocks finalize until the slowest transcription finishes (L572). No `maxDuration` on the chunks route (`[id]/process` has 300 s) — on Vercel the function can be killed mid-transcription by the default timeout.
2. **Queue is not actually persistent.** `chunkQueue.ts` docstring says "Persistent, retry-resilient" (L4) but it is an in-memory module singleton (L24/L144); a crash/app kill loses every queued chunk and its temp files are only deleted on the queue's own paths (L70-77, L84-91).
3. **Crash recovery is partial and web-biased.** `useRecordingUpload.ts` L223-252: guarded by `typeof window !== 'undefined' && window.localStorage` — on RN Hermes there is typically no `window.localStorage`, so native never recovers; it fires finalize with an empty body (L232-236) without replaying chunks; the key is removed in `.finally()` even when the finalize fails (L236-240), permanently orphaning the server session.
4. **Stuck sessions.** If finalize never arrives, status stays `recording` forever; `/process` answers "waiting 3000 ms" (`pipeline.ts` L77-79) and every list screen keeps ticking it (isNonTerminal includes `recording`).
5. **Crash-finalized sessions almost always die.** finalize sets `uploaded` with no chunks guaranteed; the pipeline's live branch takes `record.transcript` (L88-92) and throws `No transcript available for recording` when empty (L94-96); that error is **not** classified retryable (`isRetryable` L190-206), so `storeFailure` fires on the first tick (L178-182).
6. **Dropped chunks are silent.** After 5 failed tries the chunk is dropped (L80-91) with only a console error; finalize never reconciles `totalExpectedChunks` vs `receivedChunks` (which are also semantically inconsistent: server-detected-silent audio chunks are never persisted, `chunks/route.ts` L112-124, yet the comment at L109-111 claims they are counted).
7. **Client timeout kills the driver even on server-declared retryables.** `drivePipeline` treats 3 consecutive non-OK (including 503 with `retryAfterMs`) as fatal (L827, L834-836); only the list/detail tickers keep retrying.
8. **No idempotency/duplicate protection.** A retry whose first attempt committed server-side (e.g. response lost after ASR+store) re-runs ASR and re-adds bytes to the music buffer; `chunkQueue` only checks `res.ok` (L130) — the upsert itself is idempotent by `chunkId`, but the work isn't.
9. **Music buffering is process-local and lossy.** Map never evicted for sessions with <8 non-silent chunks (`chunks/route.ts` L19-23); flush is a detached `void` promise (L43-49) that a serverless freeze can drop; `storeMusicDetection` is read-modify-write (`store.ts` L475-490) so concurrent flushes can clobber.
10. **Deletion race.** DELETE removes chunks (`[id]/route.ts` L208-210) but an in-flight upload can re-insert a chunk doc afterwards, and `recordChunkTranscript` throws "Recording not found" (L151-154) → 500 → 5 client retries.
11. **Location dropped on live path.** `requestAndCapture()` fires (L278) but the session POST (L295-302) and finalize body (L579-582) carry no lat/lng/placeName; only the dead single-shot branch sends location (L600-606). `locationPromiseRef` is never settled on the live path.
12. **Native rotation window loss.** `isRotatingRef` skip guard (L371) can drop a full 15 s window if `prepareToRecordAsync` is slow; chunk index is consumed even if the rotation throws (L375 increments before the try at L386-427), and a missing final URI silently loses the tail (L543-546).
13. **Web timing is timer-based.** Background-tab throttling can delay `cycleChunk` (L178-183) and the 15-min max timer (L432); `endedEarly` is never set (L226) so "browser halted capture" is undetectable by callers despite the type claiming it (L28-29).
14. **Lease vs live sessions.** `uploaded` acquires a 12-minute lease before the `isLiveSession` branch that does no transcription (`pipeline.ts` L83-92), so a crashed tick locks a live session for 12 min.
15. **Capability probe points at `recordings` (v1), not `recordings_v2`** (`capabilities.ts` L18/L49 vs `constants.ts` L7/L11).
16. **Sidecar concurrency = 1.** `done.wait()` blocks the event loop in the sync endpoint (L384), so simultaneous chunk transcriptions serialize; `_tasks` entry leaks on sync failure (L386-390 never pops); no auth (DEPLOY.md L86-89); cold starts tens of seconds (DEPLOY.md L42-48).
17. **O(n²) stitching + missing index.** Every chunk re-reads every chunk (`store.ts` L178-187); `recording_chunks_v2` gets no `recordingId` index (`collections.ts` L108-110).
18. **`chunks` route has no rate/size guard beyond multipart parsing** — no byte cap check for chunks (upload route has one, L94-106).

### Dead code / TODOs relating to this flow
- `useRecordingUpload.ts`: single-shot upload branch L596-628 is unreachable in practice (`activeSessionIdRef` is always set by `startRecording`); its helpers `uploadShapeFor` L732-739, `prepareWebUpload` L751-757, `assertUploadSize` L759-770, `fetchMaxUploadBytes` L777-793, `raceLocation` L795-803, plus the `transcodeToWav` import L54 and `UPLOAD_SHAPE_BY_MIME` L137-149 are never called elsewhere (grep-verified). `FALLBACK_MAX_UPLOAD_BYTES` L94 is only used by that dead helper.
- `store.ts`: `releaseLease` L313-316 and `storeDoclingTaskId` L319-338 have zero call sites.
- `docling.ts`: `submitDoclingJob` L171-208, `pollDoclingTask` L227-291, `fetchDoclingResult` L316-376 and the poll/result types are unused (only `sniffAudioContainer`/`normalizeAudioForAsr`/constants/`isDoclingConfigured` are live; health route L69).
- `whisper.ts` (L1-60) is entirely unused.
- Sidecar async endpoints `/v1/convert/file/async` L336-358, `/v1/status/poll` L401-422, `/v1/result` L425-461 are unused by `transcribe.ts` (which only calls `/v1/transcribe` L65/L139); the module docstring still advertises them as the interface (L4-12). `STOP_EVENT_FALLBACK_MS` (`webRecorder.ts` L23) is declared but unused.
- **Silero VAD is installed but unwired**: `@ricky0123/vad-web` dependency (`apps/mobile/package.json` L18), assets in `apps/mobile/assets/vad/` + `public/assets/vad/`, Metro asset exts (`metro.config.js` L9-15) — but `webRecorder.ts` uses an RMS gate instead (L62-111). Sidecar TODO to delete server silence detection "after client-side VAD gate confirmed" (`transcribe_sidecar.py` L137).
- `checkpointSeq` is write-once (`store.ts` L93) and never read for logic; the UI badge "streaming audio checkpoints" (`index.tsx` L176-182) is static, and `chunkQueue.onChunkUploaded` (L50-55) — the callback meant to drive it — has no subscribers.
- `Recording.chunks?: RecordingChunk[]` (`packages/db/src/types.ts` L83, mirror `apps/mobile/lib/types.ts` L87) is legacy v1 and never written in v2.
- `sweepOrphanedChunkFiles` only deletes `.m4a` (`chunkQueue.ts` L162) — Bee `bee-chunk-*.aac` cache files accumulate forever.
