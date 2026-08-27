# Walfly — Plan

> **Superseded decisions.** This is the original planning document. The
> recording/transcription stack was rewritten afterwards and the following
> decisions no longer hold: transcription returns timestamped markdown, not SRT;
> the pipeline is a client-driven resumable state machine, not a background job
> kicked off by the upload route; chat is stateless and has no `conversationId`;
> `$vectorize` receives a bounded title/summary blob, never the transcript; the
> collection is created without `defaultId` so `_id` stays a string. The stack
> list, the schema block and the decisions table below have been corrected. The
> per-ticket todo lists are left as written and are historical.

## Overview

Walfly ("fly on the wall") is a passive conversation recorder. Users tap to record, stop, and the system automatically transcribes, vectorizes, and enriches the recording with metadata. Recordings are searchable and browsable via a multi-tab UI. Users can also chat with their recordings in real-time — per-recording or across all recordings globally.

**Stack:**
- Frontend: Expo (web first, then iOS/Android, then Apple Watch)
- API: Next.js API Routes (deployed on Vercel)
- Audio storage: Vercel Blob Storage
- Transcription: Docling SaaS in the cloud — audio is uploaded as multipart to `/v1/convert/file/async`, which returns timestamped markdown (diarization post-MVP)
- DB + Vector store: Astra DB (DataStax)
- LLM gateway: LiteLLM or OpenRouter proxy (OpenAI-API-compatible; swap any model without code changes)
- LLM model (default): OpenAI GPT-4o via the proxy
- LLM APIs used: OpenAI-compatible Chat Completions; chat responses streamed via SSE. The server is stateless — the client owns and sends the history
- Location: Browser Geolocation API (web) / expo-location (mobile), reverse-geocoded to human-readable + raw coords stored
- Auth: None (MVP, single-user; multi-user post-MVP)

**Monorepo layout:**
```
walfly/
  apps/
    mobile/          # Expo app (web + iOS + Android)
  packages/
    api/             # Next.js API routes (Vercel)
    db/              # Astra DB client + schema helpers
```

---

## Sub-Tasks

---

### ST-1 — Project Scaffolding

**Intent:** Stand up the monorepo, install core dependencies, and confirm the dev environment runs.

**Expected Outcomes:**
- `apps/mobile` is a working Expo project that renders on web (`npx expo start --web`)
- `packages/api` is a Next.js project deployable to Vercel
- `packages/db` exports an Astra DB client singleton
- Root-level `package.json` wires up a simple `dev` script

**Todo List:**
1. Init monorepo at root with `package.json` workspaces
2. Scaffold `apps/mobile` with `create-expo-app` (TypeScript, tabs template)
3. Scaffold `packages/api` with `create-next-app` (TypeScript, App Router, no src/)
4. Create `packages/db` — install `@datastax/astra-db-ts`, export client factory using env vars
5. Add `.env.example` at root listing all required secrets:
   - `ASTRA_DB_API_ENDPOINT`
   - `ASTRA_DB_APPLICATION_TOKEN`
   - `DOCLING_API_KEY`
   - `LLM_BASE_URL`
   - `LLM_API_KEY`
   - `LLM_MODEL`
   - `BLOB_READ_WRITE_TOKEN` (Vercel Blob)
6. Add root `turbo.json` or simple npm workspaces scripts for `dev`, `build`
7. Verify Expo web and Next.js both start without errors

**Relevant Context:** N/A — greenfield

**Status:** [x] done

---

### ST-2 — Astra DB Schema + Collection Setup

**Intent:** Define the data model for recordings in Astra DB with vector + metadata support.

**Expected Outcomes:**
- A `recordings` collection exists in Astra DB with vectorization enabled
- A helper script can create the collection idempotently
- TypeScript types for the `Recording` document are exported from `packages/db`

**Todo List:**
1. Design the `Recording` document shape:
   ```
   {
     _id: string (uuid)
     title: string (editable)
     createdAt: ISO timestamp
     duration: number (seconds)
     audioUrl: string (Vercel Blob URL, or /api/recordings/audio/<name> in local dev)
     audioContentType: string (the container actually stored)
     location: {
       coords: { lat, lng }
       placeName: string
     }
     status: "uploaded" | "transcribing" | "enriching" | "ready" | "failed"
     doclingTaskId / submittedAt / leaseUntil / failedStage / error (pipeline state)
     transcript: string (timestamped markdown from Docling ASR — not SRT)
     summary: string
     keyTakeaways: string[]
     actionItems: string[]
     speakers: string[] (diarization labels)
     tags: string[] (editable)
     notes: string (editable freeform)
     searchTokens: string[] (portable keyword fallback)
     $vectorize: string (bounded title/summary blob — never the transcript)
   }
   ```
2. Create `packages/db/src/collections.ts` — exports `getRecordingsCollection()` using Astra DB client
3. Create `packages/db/src/seed-schema.ts` — script that creates the `recordings` collection with NVIDIA vectorize and an indexing deny-list, and with NO `defaultId` so `_id` stays a string
4. Export TypeScript `Recording` type from `packages/db/src/types.ts`
5. Run seed script against real Astra DB and confirm collection exists

**Relevant Context:** Astra DB JS client `@datastax/astra-db-ts`, collection vectorize docs

**Status:** [x] done

---

### ST-3 — API Service: Write Path (Upload → Transcribe → Enrich → Store)

**Intent:** Build the server-side pipeline that takes a raw audio upload and produces a fully enriched recording document in Astra DB.

**Expected Outcomes:**
- `POST /api/recordings/upload` accepts audio blob + metadata, uploads to Vercel Blob, creates a `processing` doc in Astra DB, and immediately returns the new recording ID
- A background job (or sequential async chain) calls Docling SaaS, then the LLM proxy, then writes the enriched doc back to Astra DB
- Status field transitions: `processing` → `ready` (or `error`)

**Todo List:**
1. Create `POST /api/recordings/upload`:
   - Accept `multipart/form-data` with fields: `audio` (file), `lat`, `lng`, `placeName`, `duration`, `clientTimestamp`
   - Upload audio to Vercel Blob via `@vercel/blob`
   - Insert `Recording` doc into Astra DB with `status: "processing"`
   - Return `{ id, status }` immediately
   - Kick off async enrichment (use `waitUntil` from Vercel if available, or fire-and-forget)
   - **Superseded:** the upload route starts no work at all. The client drives the
     pipeline by POSTing `/api/recordings/{id}/process`, one awaited step per call.
2. Create `packages/api/lib/transcribe.ts`:
   - POST audio URL to Docling SaaS API
   - Poll or await response (SRT format)
   - Return raw SRT string (no diarization for MVP)
3. Create `packages/api/lib/llm.ts`:
   - Thin wrapper around the OpenAI SDK pointed at the LLM proxy base URL
   - Reads `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` from env
   - Exports `llmClient` for both streaming and non-streaming use
4. Create `packages/api/lib/enrich.ts`:
   - Call LLM proxy (OpenAI-compatible) using the Responses API — non-streaming batch call
   - System prompt extracts: `summary`, `keyTakeaways[]`, `actionItems[]`, suggested `title`
   - Return structured JSON object
5. Create `packages/api/lib/store.ts`:
   - Patch the Astra DB doc with transcript, enrichment fields, and `status: "ready"`
   - Set `$vectorize` to the transcript text so Astra auto-embeds it
6. Wire steps 2-5 together in an `enrichRecording(id)` function called after upload
7. Add `GET /api/recordings/:id` to poll status from the UI

**Relevant Context:** Vercel `waitUntil`, Docling SaaS API docs, Astra DB `updateOne`, `$vectorize` field convention, OpenAI SDK `baseURL` override for proxy routing

**Status:** [x] done

---

### ST-4 — API Service: Read Path (Search + Retrieve)

**Intent:** Build the query endpoints the UI needs — hybrid search (keyword + vector) and single-record fetch.

**Expected Outcomes:**
- `GET /api/recordings` returns a ranked list based on hybrid search query (or all recordings sorted by date if no query)
- `GET /api/recordings/:id` returns a full recording document
- `PATCH /api/recordings/:id` supports partial updates (editable metadata fields)
- `DELETE /api/recordings/:id` removes the doc and the Vercel Blob asset

**Todo List:**
1. `GET /api/recordings`:
   - Accept optional `q` query param
   - If `q` present: run Astra vector search with `sort: { $vectorize: q }` in parallel with a `filter`-based keyword search on `title`, `tags`, `notes`, `transcript`
   - Merge and deduplicate results, sort by combined relevance score
   - If no `q`: return all recordings sorted by `createdAt` desc
2. `GET /api/recordings/:id`: fetch single doc by `_id`
3. `PATCH /api/recordings/:id`:
   - Allowed fields: `title`, `tags`, `notes`, `location.placeName`
   - Validate and `updateOne` in Astra DB
4. `DELETE /api/recordings/:id`:
   - Delete Vercel Blob asset via `del()` from `@vercel/blob`
   - Delete Astra DB doc via `deleteOne()`
5. Define shared response types in `packages/db/src/types.ts` (reused by both API and mobile)

**Relevant Context:** Astra DB `find`, `sort.$vectorize`, `updateOne`, `deleteOne`; `@vercel/blob` `del`

**Status:** [x] done

---

### ST-5 — Mobile App: Tab 1 — Record Screen

**Intent:** Build the Record tab — a simple, prominent record button that captures audio, attaches metadata, and uploads to the API.

**Expected Outcomes:**
- A large record button is visible on Tab 1
- Tapping starts audio recording; tapping again stops it
- On stop, location is captured (web: Geolocation API, native: expo-location), then the file is uploaded to `POST /api/recordings/upload`
- A loading/processing indicator shows until the recording reaches `ready` status (poll `GET /api/recordings/:id`)
- Works on web today; same code path works on iOS/Android via Expo

**Todo List:**
1. Configure Expo tabs navigation: Tab 1 = Record, Tab 2 = My Recordings, Tab 3 = Chat
2. Install `expo-av` (audio recording), `expo-location` (location), and `braille` (progress/wait animations)
3. Build `useLocationPermission` hook:
   - Called on first tap of the record button, before recording starts
   - On web: call `navigator.geolocation.getCurrentPosition` with a permissions check
   - On native: call `expo-location.requestForegroundPermissionsAsync()`
   - If granted: store permission state, capture coords immediately at record-start time
   - If denied: store `locationDenied = true` and continue — recording proceeds without location; `location` field stored as `null` in the doc
   - Permission is only requested once per session; subsequent taps reuse stored state
4. Build `RecordButton` component:
   - Idle state: large circular mic button
   - On first tap: trigger `useLocationPermission`, then start recording
   - Recording state: pulsing red indicator + stop icon; use `braille` spinner for any async wait
   - Processing state: `braille` progress bar while upload + enrichment pipeline runs
   - Done state: brief checkmark, then reset to idle
5. On stop:
   - Use already-captured location from record-start (or `null` if permission was denied)
   - Reverse-geocode on native via `expo-location.reverseGeocodeAsync()`; on web via Nominatim API
   - Graceful degrade: if reverse-geocode fails, store raw coords only; if no coords, store `null`
   - Upload audio + metadata via `fetch POST /api/recordings/upload`
6. After upload, poll `GET /api/recordings/:id` every 3s until `status === "ready"`, show `braille` progress animation during wait, then show success
7. Handle errors with a visible error state on the button; never silently swallow failures

**Relevant Context:** `expo-av` `Audio.Recording`, `expo-location.requestForegroundPermissionsAsync`, `braille` npm package, Expo web compatibility notes, Nominatim reverse-geocode API (no key required)

**Status:** [x] done

---

### ST-6 — Mobile App: Tab 2 — My Recordings List

**Intent:** Build the recordings browser with hybrid search.

**Expected Outcomes:**
- Tab 2 shows a scrollable list of recordings sorted by date descending
- Each list item shows: title, date/time, duration, place name, status badge
- A search bar at top triggers hybrid search via `GET /api/recordings?q=...` (debounced)
- Tapping a recording navigates to the Recording Detail screen

**Todo List:**
1. Build `RecordingsList` screen:
   - Fetch `GET /api/recordings` on mount
   - Render `FlatList` of `RecordingCard` components
2. Build `RecordingCard` component:
   - Title, date, duration, place name
   - Status badge (processing / ready / error)
3. Build `SearchBar` component:
   - Controlled input, debounced 300ms
   - On change fires `GET /api/recordings?q=<term>`
   - Clear button resets to full list
4. Wire navigation: tapping a card pushes to `RecordingDetail` screen (pass `id`)
5. Pull-to-refresh to reload list

**Relevant Context:** Expo Router file-based routing, `FlatList`, React Query or `useSWR` for data fetching, `braille` for any loading states

**Status:** [x] done

---

### ST-7 — Mobile App: Recording Detail Screen

**Intent:** Build the single-recording view with summary, takeaways, action items, expandable transcript, and editable metadata.

**Expected Outcomes:**
- Detail screen shows: title (editable), date/time, duration, place name (editable), tags (editable)
- Summary, key takeaways, action items displayed prominently
- Transcript section is collapsed by default, expands on tap
- Edit mode allows updating title, tags, notes, place name via `PATCH /api/recordings/:id`
- Delete button triggers `DELETE /api/recordings/:id` with confirmation

**Todo List:**
1. Build `RecordingDetail` screen:
   - Load recording via `GET /api/recordings/:id`
   - Sections: Metadata header, Summary card, Key Takeaways list, Action Items list, Transcript (collapsible)
2. Build `EditableField` component for inline editing (title, place name, notes)
3. Build `TagEditor` component (add/remove tag chips)
4. Build `TranscriptSection` component:
   - Collapsed: shows first 3 lines + "Show full transcript" button
   - Expanded: full scrollable transcript text
5. Wire edit save → `PATCH /api/recordings/:id`; optimistic update locally
6. Delete: confirmation modal → `DELETE /api/recordings/:id` → navigate back to list

**Relevant Context:** Expo Router, `useLocalSearchParams` for `id`, React state for expand/collapse

**Status:** [x] done

---

### ST-8 — Chat: Per-Recording and Global (Streaming)

**Intent:** Add a real-time streaming chat interface so users can converse with their recordings — either a single recording or across all recordings — using the OpenAI Conversations API via the LLM proxy.

**Expected Outcomes:**
- A chat panel is accessible from the Recording Detail screen (per-recording context)
- A new Tab 3 provides global chat across all recordings
- Responses stream token-by-token to the UI via SSE
- Conversation history is maintained per session using the Conversations API thread management
- RAG: user query → Astra vector search → relevant transcript chunks injected as context into the LLM prompt

**Todo List:**
1. Add Tab 3 — "Chat" — to Expo tab navigation
2. Build `ChatScreen` component (shared between per-recording and global):
   - Message list (user + assistant bubbles)
   - Input bar with send button
   - Streaming: assistant message renders token-by-token as chunks arrive
3. Create `POST /api/chat` streaming endpoint:
   - Accept `{ message, conversationId?, recordingId? }` in request body
   - If `recordingId` present: fetch that recording's transcript from Astra DB as context
   - If no `recordingId` (global): run Astra vector search using the user message, pull top-N transcript chunks as context
   - Build system prompt with injected context (RAG)
   - Call LLM proxy using Conversations API (maintain thread via `conversationId`)
   - **Superseded:** `conversationId` does not exist. `POST /api/chat` takes
     `{ messages, recordingId? }` and is stateless.
   - Stream response back using `ReadableStream` / `TransformStream` (Vercel Edge compatible)
   - Return `conversationId` in first chunk so client can persist thread continuity
4. Build `useChat` hook in the Expo app:
   - Manages message history state
   - Handles SSE streaming fetch (EventSource on web, polyfill on native)
   - Appends tokens to in-progress assistant message as they arrive
5. Wire per-recording chat: "Chat about this" button on Recording Detail → opens `ChatScreen` with `recordingId`
6. Wire global chat: Tab 3 opens `ChatScreen` with no `recordingId`

**Relevant Context:** OpenAI Responses API + Conversations API streaming, Vercel Edge `ReadableStream`, `EventSource` API, RAG pattern with Astra `sort.$vectorize`

**Status:** [x] done

---

### ST-9 — Apple Watch Companion (Future Phase)

**Intent:** Add a minimal Apple Watch UI — single button, tap to start/stop recording, triggers same upload pipeline.

**Expected Outcomes:**
- Watch app shows one button
- Tap starts recording on the watch's mic
- Tap again stops and hands off to the paired iPhone for upload

**Todo List:**
1. Research WatchConnectivity bridge via Expo / React Native Watch Connectivity
2. Build minimal Watch UI using `react-native-watch-connectivity` or native WatchKit target
3. On stop: send audio file + metadata from Watch → iPhone via `transferFile`
4. iPhone receives transfer and calls same `POST /api/recordings/upload` endpoint
5. Confirm Watch target can be added within Expo managed workflow or requires bare workflow

**Relevant Context:** `react-native-watch-connectivity`, WatchKit, Expo bare workflow requirement for Watch targets

**Status:** [ ] pending

---

## Open Questions / Decisions Made

| Question | Decision |
|---|---|
| Transcription service | Docling SaaS in the cloud (timestamped markdown; bytes always uploaded as multipart) |
| Diarization | Post-MVP — transcript stored without speaker labels |
| DB | Astra DB with built-in vectorize |
| Audio blob storage | Vercel Blob |
| API framework | Next.js API Routes on Vercel |
| LLM gateway | LiteLLM or OpenRouter proxy (OpenAI-API-compatible) |
| LLM model default | GPT-4o via proxy |
| LLM APIs | OpenAI-compatible Chat Completions, streaming; stateless server, client-held history |
| LLM model swappability | Via env vars LLM_BASE_URL / LLM_API_KEY / LLM_MODEL |
| Chat scope | Per-recording (from detail screen) + global cross-recording (Tab 3) |
| Chat RAG | Per-recording: that transcript, truncated. Global: Astra vector search injects titles/summaries/takeaways only |
| Auth | None for MVP |
| Search mode | Hybrid (lexical + rerank) where the Astra region supports it, otherwise vector + `searchTokens` fused with RRF |
| Location | Reverse-geocoded human name + raw coords |
| Apple Watch | Post-MVP (ST-9) |
