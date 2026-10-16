<div align="center">

```
██╗    ██╗ █████╗ ██╗     ███████╗██╗  ██╗   ██╗
██║    ██║██╔══██╗██║     ██╔════╝██║  ╚██╗ ██╔╝
██║ █╗ ██║███████║██║     █████╗  ██║   ╚████╔╝
██║███╗██║██╔══██║██║     ██╔══╝  ██║    ╚██╔╝
╚███╔███╔╝██║  ██║███████╗██║     ███████╗██║
 ╚══╝╚══╝ ╚═╝  ╚═╝╚══════╝╚═╝     ╚══════╝╚═╝
```

[![Expo SDK](https://img.shields.io/badge/Expo-SDK%2057-000020?logo=expo&logoColor=white)](https://expo.dev)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![Astra DB](https://img.shields.io/badge/Astra%20DB-Vector-00C4F0?logo=datastax&logoColor=white)](https://astra.datastax.com)
[![Vercel](https://img.shields.io/badge/Deployed-Vercel-000000?logo=vercel)](https://vercel.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

</div>

---

## What is walfly?

**walfly** ("fly on the wall") is a passive conversation recorder. Tap to begin. Talk. Tap to stop. Everything else happens automatically.

The app captures audio, transcribes it with speech recognition, enriches it with AI-generated summaries, key takeaways, and action items, then stores everything in a searchable, vector-indexed library you can chat with — all from a single button.

> **The name.** A fly on the wall witnesses a moment without changing it. In walfly, *you* are the fly. The central metaphor is **amber** — the fossil resin that preserves creatures, including flies, for millions of years. A moment captured in walfly is a piece of time made tangible: permanent, warm, golden.

<table>
<tr>
<td align="center" width="25%">

**record**

<img src="docs/screenshots/record.png" width="200" alt="record screen — amber mic button on midnight background"/>

One button. Midnight background. Amber glow ring. Tap to begin.

</td>
<td align="center" width="25%">

**moments**

<img src="docs/screenshots/moments.png" width="200" alt="moments screen — scrollable list of AI-titled recordings"/>

Your library. AI-titled cards, smart clusters, hybrid search.

</td>
<td align="center" width="25%">

**detail**

<img src="docs/screenshots/detail.png" width="200" alt="recording detail — summary, takeaways, action items, transcript"/>

Summary, key takeaways, action items, collapsible transcript.

</td>
<td align="center" width="25%">

**chat**

<img src="docs/screenshots/chat.png" width="200" alt="chat screen — ask questions across all recordings"/>

RAG-grounded streaming chat across all your moments.

</td>
</tr>
</table>

---

## What we're trying to accomplish

Most recording apps stop at the file. walfly goes further:

| Layer | What walfly does |
|---|---|
| **Capture** | One-tap recording on web, iOS, and Android from a single codebase |
| **Transcription** | Real-time streaming ASR via faster-whisper sidecar with live captions; full-fidelity file transcription as fallback |
| **Enrichment** | LLM-generated title, summary, key takeaways, and action items for every recording |
| **Memory** | Hybrid vector + lexical search across all your recordings — ask anything, find anything |
| **Conversation** | Chat with a single recording or across your entire library with RAG-grounded answers |

The longer vision: walfly becomes the persistent memory layer for your professional and personal life. Every meeting, every idea, every conversation — searchable, summarized, and conversational. Apple Watch companion is planned as a future phase.

---

## Architecture

[![walfly system architecture](docs/screenshots/diagram-architecture.png)](.archify/architecture-walfly-20250724-120000/walfly-architecture.html)

<sub>↑ Click to open the interactive diagram — [**walfly — System Architecture**](.archify/architecture-walfly-20250724-120000/walfly-architecture.html)</sub>

### How a live recording flows

[![walfly live recording sequence](docs/screenshots/diagram-sequence.png)](.archify/sequence-recording-20250724-120000/walfly-sequence.html)

<sub>↑ Click to open the interactive diagram — [**walfly — Live Recording Flow**](.archify/sequence-recording-20250724-120000/walfly-sequence.html)</sub>

Every finalized segment is checkpointed to Astra before being acknowledged to the sidecar. If the connection drops, the sidecar replays unacknowledged segments. If the app dies, a local OPFS buffer delivers the full recording on the next launch. **Nothing you say is lost.**

---

## Stack

| Layer | Technology | Why |
|---|---|---|
| **Frontend** | Expo SDK 57 + expo-router | One codebase for web, iOS, Android |
| **API** | Next.js 16 App Router on Vercel | Edge-compatible, serverless, zero-ops |
| **ASR** | faster-whisper + Silero VAD on Fly.io | Real-time streaming transcription; LocalAgreement-2 for stable partials |
| **Transcription (file)** | Docling SaaS | Timestamped markdown output; no local Python needed |
| **Database** | Astra DB (DataStax) | Vector store + document DB; built-in NVIDIA embeddings |
| **Vector search** | Hybrid lexical + rerank (AWS `us-east-2`) / vector + RRF (all regions) | Semantic + keyword search across all recordings |
| **LLM** | OpenAI-compatible proxy (OpenRouter / LiteLLM / Ollama) | Swap any model without code changes via env vars |
| **Audio storage** | Vercel Blob (prod) / local `.data/audio/` (dev) | Zero-config local fallback |
| **Language** | TypeScript end-to-end | Shared types between API and mobile |

---

## App screens

<table>
<tr>
<td align="center" width="25%">

**record**

<img src="docs/screenshots/record.png" width="200" alt="record screen — amber mic button on midnight background"/>

One button. Midnight background. Amber glow ring. Tap to begin.

</td>
<td align="center" width="25%">

**moments**

<img src="docs/screenshots/moments.png" width="200" alt="moments screen — scrollable list of AI-titled recordings"/>

Your library. AI-titled cards, smart clusters, hybrid search.

</td>
<td align="center" width="25%">

**detail**

<img src="docs/screenshots/detail.png" width="200" alt="recording detail — summary, takeaways, action items, transcript"/>

Summary, key takeaways, action items, collapsible transcript.

</td>
<td align="center" width="25%">

**chat**

<img src="docs/screenshots/chat.png" width="200" alt="chat screen — ask questions across all recordings"/>

RAG-grounded streaming chat across all your moments.

</td>
</tr>
</table>

### `record` — the only thing that matters

One screen. One button. Midnight background, amber glow ring. Tap to start; tap to stop. Live captions appear as you speak.

- Location is captured silently at record-start and reverse-geocoded to a human-readable place name
- A crash-safe local buffer writes every frame to disk in parallel with the WebSocket stream
- After stop: the recording is enriched automatically — title, summary, takeaways, action items

### `moments` — your library

A scrollable list of every recording, sorted by date. Each card shows the AI-generated title, location, duration, and status.

- Search bar at the top runs hybrid vector + keyword search across all recordings
- Status badges: `uploading` · `transcribing` · `enriching` · `ready` · `failed`
- Tap any card to open the detail view

### Recording detail

The full enriched view: editable title, summary card, key takeaways as chips, action items as a checklist, and a collapsible full transcript with timestamps.

- Inline editing for title, tags, notes, and place name
- Delete with confirmation removes the blob and the database record

### `chat` — talk to your recordings

A streaming chat interface, token-by-token, powered by RAG.

- **Per-recording**: "chat about this" from the detail screen — the transcript is the context
- **Global**: Tab 3 — vector search injects relevant titles, summaries, and takeaways from across your library as context
- Amber user bubbles · dark assistant bubbles · amber streaming dot

---

## Design language

walfly is dark-first. Amber on midnight.

| | |
|---|---|
| **Primary background** | `#0D0D0F` — midnight |
| **Brand accent** | `#F5A623` — amber |
| **Primary text** | `#F5EDD6` — cream (warm, not harsh white) |
| **Display font** | Fraunces — timeless, editorial, journal-like |
| **Body font** | Inter — legible, neutral, native-feeling |
| **Tagline** | *The moments you were there for.* |

The record button rests with a soft amber glow (`box-shadow: 0 0 12px #F5A62340`). When recording, the glow ring pulses and scales. When processing, a `braille` spinner signals work in progress. Every animation checks `prefers-reduced-motion`.

---

## Getting started

### Prerequisites

- Node.js 20+
- `uv` (Python package manager, for the ASR sidecar)
- An [Astra DB](https://astra.datastax.com) Serverless (Vector) database
- An LLM proxy key (OpenRouter, LiteLLM, or local Ollama)

### Install

```bash
git clone https://github.com/SonicDMG/walfly && cd walfly
npm install
```

### Configure

```bash
cp packages/api/.env.example packages/api/.env.local   # fill in your keys
cp apps/mobile/.env.example  apps/mobile/.env          # set EXPO_PUBLIC_API_URL
```

Minimum required variables:

| Variable | Where | What |
|---|---|---|
| `ASTRA_DB_API_ENDPOINT` | `packages/api/.env.local` | Your Astra DB API endpoint |
| `ASTRA_DB_APPLICATION_TOKEN` | `packages/api/.env.local` | Astra admin token |
| `WALFLY_WS_SECRET` | `packages/api/.env.local` | `openssl rand -hex 32` |
| `LLM_API_KEY` | `packages/api/.env.local` | Your LLM proxy key |
| `LLM_MODEL` | `packages/api/.env.local` | e.g. `openai/gpt-4o` |
| `EXPO_PUBLIC_API_URL` | `apps/mobile/.env` | `http://localhost:3030` for web |

### Seed the database

```bash
npm run seed --workspace=packages/db
```

Creates the `recordings` collection with NVIDIA vector embeddings and hybrid search (where the region supports it).

### Run

```bash
npm run dev          # sidecar + API (port 3030) + Expo — all together
npm run dev:api      # sidecar + API only
npm run dev:mobile   # Expo only
```

Press `w` in the Expo terminal to open the web app at `http://localhost:8081`.

### Verify

```bash
curl -s http://localhost:3030/api/health | jq
```

```json
{
  "status": "ok",
  "service": "walfly-api",
  "checks": {
    "astra": "ok",
    "collection": "ok",
    "llm": "configured",
    "storage": "local"
  }
}
```

---

## Monorepo layout

```
walfly/
├── apps/
│   └── mobile/              # Expo app — web, iOS, Android
│       ├── app/(tabs)/      # record · moments · chat screens
│       ├── app/recording/   # recording detail screen
│       └── lib/             # theme tokens, types, hooks
├── packages/
│   ├── api/                 # Next.js API (Vercel)
│   │   ├── app/api/         # route handlers
│   │   ├── lib/             # transcribe · enrich · llm · store
│   │   └── sidecar/         # Python ASR sidecar (Fly.io)
│   └── db/                  # Astra DB client, schema, types
└── research_notes/          # architecture decisions and research
```

`apps/mobile` deliberately does **not** import `@walfly/db` — wire types are mirrored in `apps/mobile/lib/types.ts` so Metro never pulls the Astra driver into the client bundle.

---

## Roadmap

- [x] Project scaffolding and monorepo setup
- [x] Astra DB schema with vector embeddings
- [x] Upload pipeline (transcribe → enrich → store)
- [x] Hybrid search (vector + lexical)
- [x] Record screen with location
- [x] Recordings library with search
- [x] Recording detail with inline editing
- [x] Streaming chat (per-recording + global RAG)
- [x] Streaming ASR sidecar (faster-whisper + Silero VAD)
- [x] Live captions via WebSocket
- [x] Crash-safe local buffer with recovery upload
- [ ] Live rolling enrichment (phase 2)
- [ ] Multi-user auth
- [ ] Apple Watch companion (ST-9)
- [ ] Client-direct Vercel Blob upload (removes 4 MB / 15 min cap)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution guide and [SETUP.md](SETUP.md) for full environment and operations documentation.

---

<div align="center">
<sub>walfly — <em>the moments you were there for.</em></sub>
</div>
