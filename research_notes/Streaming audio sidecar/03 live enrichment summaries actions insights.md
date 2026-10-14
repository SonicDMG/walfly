# Live enrichment: rolling summaries, action items, insights

Scope: while 15 s chunks stream in (`POST /api/recordings/[id]/chunks`), show progressive summary/actions/insights; at stop, the final pass writes the durable doc (`packages/db/src/types.ts`). Codebase constraints: client drives every long step (`/process` tick pattern), no server background work, `leaseUntil` CAS guards, `[time: m:ss.s-m:ss.s]` transcripts, `$vectorize` (512-token embedding cap) written only at `storeEnrichment`.

## TL;DR

**Hybrid (d): rolling ops-based update + periodic full-transcript rebuild + final authoritative pass.**
- New client-driven tick `POST /api/recordings/[id]/live` (after each chunk upload + 60 s interval) runs at most one LLM step under the existing `acquireLease(id, 'recording', …)`. Nothing runs in the chunk route.
- Roll at ≥8 contiguous new non-silent chunks (~2 min speech); rebuild after 6 rolls or ≥6 k new tokens; final unconditionally at finalize.
- The model returns **ops** (`add`/`update`/`complete`/`supersede`), never rewritten arrays. The server assigns ids, applies ops idempotently, and rejects any item whose `quote` is not verbatim-grounded in the segment — this, not the prompt, is the anti-hallucination mechanism.
- Live state lives in a `live` subdocument; durable fields are written only by the final pass, so search/indexing/user edits never see transient values.
- Output mode: `json_schema` strict when the proxy endpoint supports it (runtime probe, like `supportsJsonMode()`), then `json_object`, then the existing parser.
- Cost: **~$0.05–0.06 per recorded hour** (gpt-5-nano/gpt-6-luna rolls + gpt-6-sol final, list prices 2026-10) — ~10× below naive periodic re-summarization.

## 1. Architecture comparison

| Option | Live latency | Cost | Drift risk | Verdict |
|---|---|---|---|---|
| (a) Map-reduce windows + merge | summary only after first window; every global update needs a reduce | high (merge re-reads all window summaries) | low within windows; merge must resolve cross-window contradictions | use as final-pass fallback >2 h if context is small |
| (b) Hierarchical tree | root lags a full tree level | low at extreme lengths | low; per-level error compounding | over-engineered below 3 h |
| (c) Incremental running state | immediate | lowest | **highest**: anchoring, recency bias, duplicates, "planning to X" persisting after X happened | never alone |
| **(d) Hybrid** | immediate | ~(c) +15 % | self-correcting via rebuild; final authoritative | **recommended** |

Evidence: folding new text into a prior summary preserves coherence better than independent windows ([Copera](https://blog.copera.ai/how-copera-ai-summarizes-threads); refinement vs map-reduce, [Google Cloud](https://cloud.google.com/blog/products/ai-machine-learning/long-document-summarization-with-workflows-and-gemini-models)). But incremental summaries show documented **recency bias** and lose early content ([arXiv:2402.16986](https://arxiv.org/html/2402.16986v1)); recursive summarization needs consistency scaffolding ([arXiv:2308.15022](https://arxiv.org/html/2308.15022v3)). The rebuild is that scaffolding.

### Cadence triggers

All computed server-side from chunk docs; the client only pings.

1. **Roll** iff `contiguousNewNonSilentChunks ≥ 8` **or** `newChars ≥ 700`, and ≥90 s since last update, and lease acquired. Chunks beyond the contiguous prefix (upload-queue gaps) are excluded; `live.enrichedThroughChunk` is the watermark.
2. **Rebuild** iff 6 rolls since last rebuild (~12–15 min) **or** ≥6 k new tokens. Input: full stitched transcript up to the watermark (raise `MAX_ENRICH_CHARS`; §9).
3. **Final** at stop: the existing `enrich` stage calls `consolidateTranscript(full, liveState)` instead of `enrichTranscript(transcript)` for live sessions.
4. **Long sessions (≥90 min)**: roll every ~3 min, rebuild every ~20 min — cost stays linear in audio, state caps constant.
5. **Silence**: only non-silent chunks count; a 30-min walk with 4 min of speech earns ~2 updates.
6. **Never block**: 15 s timeout for rolls, 60 s for rebuilds. On failure: no write, release lease, next tick retries.

### Drift/duplication/contradiction rules

1. **Ops, not rewrites.** Only `summary` is a full rewrite per roll (bounded, ≤120 words).
2. **Quote or reject.** Every `add`/`revise` carries a verbatim quote; the server requires normalized substring containment against the segment. Drop + count ungrounded items (`live_ungrounded_items_total`).
3. **Monotonic status.** `open → done|superseded` only; supersede (with `supersededBy`) instead of delete; contradictions become revisions with `history` (≤2).
4. **Rebuild sees existing items with ids** and must re-emit, update, complete or supersede each. Unmatched open items survive (keep-unless-overturned). Prose (summary/takeaways) is replaced wholesale.
5. **Caps:** summary ≤120 words, takeaways ≤8, open actions ≤10, insights ≤6, entities ≤15; overflow resolved at rebuild, not by the roll.
6. **Server-side near-dup folding:** token-set similarity >0.8 against an open item converts `add` into `update` of the closest item. The LLM judges; the server keeps books.

## 2. Live state schema, ops, and final mapping

Stored as `Recording.live` (new optional field; `$unset`-able at final):

```ts
interface LiveEnrichment {
  version: 1; revision: number;          // ++ per applied update; UI diffs on it
  enrichedThroughChunk: number;          // contiguous-prefix watermark
  updatedAt: string; title: string|null; // title: provisional, never shown in list
  summary: string|null;                  // ≤120 words
  takeaways: LiveItem[]; actions: LiveAction[]; insights: LiveInsight[]; entities: LiveEntity[];
  stats: { updates: number; rebuilds: number; lastModel: string };
}
interface LiveItem    { id; text; quote; tStartMs; tEndMs; addedAtRevision; history?: string[] }
interface LiveAction  extends LiveItem { owner: string|null; due: string|null; confidence: number;
                                          status: 'open'|'done'|'superseded'; evidence?: string; supersededBy?: string|null }
interface LiveInsight extends LiveItem { kind: 'decision'|'question'|'risk'|'quote' }
interface LiveEntity  { id; name; kind: 'person'|'place'|'thing'|'org'; mentions: number[] }  // tMs
```

Ops response (flat strict-mode schema):

```json
{ "title": "…", "summary": "…",
  "takeaways": { "add": [{"text","quote","tStartMs","tEndMs"}], "revise": [{"id","text","quote"}] },
  "actions":   { "add": [{"text","quote","tStartMs","tEndMs","owner","due","confidence"}],
                 "update": [{"id","text?","owner?","due?"}],
                 "complete": [{"id","evidence"}], "supersede": [{"id","reason","quote"}] },
  "insights":  { "add": [{"kind","text","quote","tStartMs","tEndMs"}], "revise": [{"id","text"}] },
  "entities":  { "add": [{"name","kind","tMs"}] } }
```

Ids are assigned/validated server-side; ops referencing unknown ids are dropped. `applyOps(prev, ops, segmentText, rev)` is pure; re-applying the same ops is a no-op (`add` matching quote → skip; identical `update` → skip; one-way statuses).

**Final doc mapping**: keep the durable contract (`summary: string`, `actionItems: string[]`, `keyTakeaways: string[]`, `tags: string[]`) and extend `types.ts` additively (`actionsDetailed?: FinalAction[]`, `insights?`, `enrichmentQuality?: 'full'|'degraded'`). Derive `actionItems` from non-superseded actions once, and use that derivation in list UI + chat. `storeEnrichment` keeps `$vectorize`/`$lexical`/`searchTokens` as today.

## 3. Action items

- **Definition in prompt**: a commitment, assignment, or explicit unresolved "need to" — never a merely discussed topic; one item per distinct obligation.
- **Fields**: `text` (imperative, ≤25 words), `owner` (null unless a speaker is named or first-person attribution is unambiguous — never guess), `due` (only explicit wording like "by Friday"; no date inference), `quote`+timestamps (always), `confidence` (UI folds <0.5 into a "possible" section), `status`.
- **Dedup/revision**: **server-assigned ids, not content hashes** — hashes fork when the model rewords an item, which is exactly what happens across increments. The model gets open items with ids and emits ops; the server folds near-duplicates (§1.6). A separate cheap "reconcile A and B, keep one id" call only for post-hoc collisions.
- **Completion detection**: standing instruction in every roll — *scan the new segment for evidence any open item was completed ("sent it", "already booked", "skip that") and emit `complete`/`supersede` with an evidence quote*, grounding-checked like any other quote. Statuses never revert from a roll; only a rebuild may resurrect (with a reason).
- **Hallucination defense in depth** (cf. layered checks in [AUTOSUMM, ACL 2025 industry](https://aclanthology.org/2025.acl-industry.35)): prompt grounding → server substring check → time-range sanity (item's range must be covered) → fixtures/metrics → optional judge-model entailment audit on a sample.

## 4. Insights taxonomy

| Kind | Definition | Cues | Build? |
|---|---|---|---|
| **Decision** | Something settled | "we'll", "decided", "let's do", "final" | **Yes** — highest signal-to-noise |
| **Open question** | Left unresolved | explicit questions; "I wonder", "should we…" without resolution | **Yes** |
| Risk/worry | Concern voiced | "I'm worried", "what if" | Merge into questions as `kind:'risk'`; separate kind buys little |
| **Notable quote** | Verbatim memorable/emotional/funny line | model judgment; must be exact | **Yes** — verifiable, high delight |
| **Entities** | People/places/orgs/things named | names, referents | **Yes** — best memory/retrieval feature after summary; structure beats prose |
| Topics/tags | Retrieval vocabulary | — | Final pass only (live tags drift); reuse prior tags first |
| Promise | Personal commitment | "I'll…" | No — it is an action item; don't double-report |
| Time-bound event | "meeting Tuesday" | temporal expressions | No separate kind v1 — lives in `due`+quote; date inference is error-prone |
| Mood/sentiment arc | Tone over time | — | **Live: no** — flat in ~90 % of ambient recordings, wrong often. Optional one tone label in final |
| Life facts | Durable facts about the user | — | Defer; entities+quotes are the safe foundation |

UI: ≤3 live insights with "new" badges, older collapsed; acknowledge revisions with a line pulse; never autoscroll the summary.

## 5. Structured output reliability

Layered, probed once per model/endpoint and cached:

1. **`response_format: {type:'json_schema', json_schema:{name, strict:true, schema}}`** — the only output-side guarantee. LiteLLM and OpenRouter pass it through; support is **per endpoint**, so use `require_parameters`/`supports_response_schema` and keep a fallback ([OpenRouter](https://openrouter.ai/docs/guides/features/structured-outputs), [LiteLLM](https://docs.litellm.ai/docs/completion/json_mode)).
2. **`json_object`** (today's `supportsJsonMode()` path).
3. **Prompt-only + `parseJsonObject()`** (existing defensive parser).

Constraints/evidence: keep schemas **flat and simple** (strict-mode subsets exclude root unions; strict mode bills cache writes on current OpenAI models). Constrained decoding guarantees **form, not truth**: [JSONSchemaBench](https://openreview.net/forum?id=FKOaJqKoio) shows schema validity is easy while value accuracy lags, and format-restriction studies ([RANLP 2025](https://aclanthology.org/2025.ranlp-1.124/), [Tam et al., EMNLP 2024 industry](https://arxiv.org/pdf/2408.02442)) find degradation on generation/reasoning tasks that worsens with schema complexity. So: no reasoning inside the JSON; if final-pass evals show a deficit, use **draft-then-format** (free-form consolidation, then a cheap formatting call) instead of forcing a complex schema through the strong model.

- **Validation/repair**: validate with the same Zod schema; one repair round (errors + raw text back), then downgrade a tier; all-fail is transient. Never accept an item failing grounding regardless of schema validity.
- **Missing fields**: strict mode requires all keys — use nullable types/empty arrays; encode "no change" as empty ops. Server rule: `null`/empty `summary` keeps the previous; never clobber non-empty state with empty.
- **Streaming partial JSON**: skip for v1. The tick writes whole snapshots atomically (<1 s); the client polls ~20 s and diffs on `revision`. Token-streaming delta arrays would flicker and force partial-JSON parsing; if ever needed, stream only a "live line" and never merge partial arrays.
- **Idempotency**: lease + `enrichedThroughChunk` CAS; a crashed tick re-derives from the last durable watermark.

## 6. Cost and latency engineering

Assumptions: 150 wpm ≈ 13 k transcript tokens/hour (~40 k for 3 h); roll every 2 min → 30/h, input ≈ 2.3 k (instructions 0.7 k + state 1 k + segment 0.6 k), output ≈ 0.5 k; 5 rebuilds/h (8 k in/1 k out avg); final ≈ 14 k in/1.2 k out (1 h), 40 k/1.8 k (3 h). List prices from OpenAI, Anthropic and Google pricing pages (Oct 2026). Caching: OpenAI automatic ≥1024 prompt tokens, reads ~10 %; Anthropic explicit (5 m write 1.25×, reads 10 %); Gemini implicit 75–90 % off. **Rebuilds benefit most** (append-only prefix); roll prompts share only ~700 static tokens, below OpenAI's 1024 minimum — order prompts static-first so caching can be added later.

| Config | Rolling | Rebuild | Final | $/recorded hour | $/3 h |
|---|---|---|---|---|---|
| **Frugal** — gpt-5-nano roll+rebuild, gpt-6-sol final | $0.0095 | ~$0.004 | $0.040 | **~$0.055** | ~$0.14 |
| **Balanced** — gpt-6-luna roll+rebuild, gpt-6-sol final | $0.014 | ~$0.007 | $0.040 | **~$0.06** | ~$0.16 |
| **Premium** — claude-haiku-4.5 roll+rebuild, claude-sonnet-5.5 final | $0.14 | ~$0.07 | $0.040 | **~$0.25** | ~$0.75 |
| Naive — full transcript every 3 min, gpt-6-sol | — | — | — | **~$0.51** | ~$1.5 |

Candidate prices ($/M in–out, Oct 2026): gpt-5-nano $0.05/$0.40; **gpt-6-luna** $0.10/$0.50 (cached $0.01, write 1.25×); gpt-5.4-mini $0.75/$4.50; **gpt-6-sol** $2/$10; gpt-5.4 $2.50/$15; Claude Haiku 4.5 $1/$5, Haiku 5.5 $0.10/$0.50 (≤100 k ctx, tokenizer ~+30 %); Claude Sonnet 5.5 $2/$10; Gemini 3.1 Flash-Lite $0.25/$1.50; Gemini 3.8 Flash $0.75/$3.75 (promo). **Cheap model rolls, strong model final** — the final is the artifact users keep and ~70 % of the bill.

Latency: rolls 1–4 s, rebuilds 5–15 s, final 10–30 s (reasoning off/low, flat output). The tick returns `{revision, updatedAt}` after the write; nothing on the audio path awaits the LLM.

## 7. Consistency: live vs final

- **Separate storage**: `live` subdocument vs durable fields. Final sets `live.finalizedAt` and keeps `live` for audit/diff. UI shows live while `status ∈ {recording, uploaded, transcribing, enriching}`, durable at `ready`.
- **Shared vocabulary**: export the action-item definition, insight kinds and grounding rules as constants used by all prompts; the final prompt adds "cover the entire conversation" and receives live state as *hints that may be incomplete or wrong*.
- **Clean supersession**: the final pass is the only writer of durable fields; `revision` stops mattering at `ready`. On terminal final failure, **promote the live state into durable fields** with `enrichmentQuality:'degraded'` rather than failing the recording, while keeping `failedStage` diagnostics.
- **No leakage**: live values never touch `$vectorize`/`$lexical`/list `title`; the list keeps "Live Recording …" until `ready`.

## 8. Prompts (sketches)

**(a) Roll** — system + state + segment, output = ops JSON:

```
System: You keep live notes for a recording in progress. Use ONLY the NEW SEGMENT below as
evidence. Copy quotes verbatim; never fix ASR spelling. Do not restate topics as actions.
User: CURRENT NOTES (JSON): <live state>
NEW SEGMENT (chunk 42, t=612.3–734.1s): [time: …] …
Rules: scan for completions of open actions ("already sent it") and emit complete/supersede
with evidence; if new info contradicts an item, revise it by id — never add a near-duplicate;
every add needs an exact quote + time range; unchanged items are NOT repeated. Rewrite the
summary (≤120 words) to reflect the whole conversation so far.
Return only the delta JSON (schema attached).
```

**(b) Final consolidation** — full transcript + live state, output = durable doc:

```
System: Write the permanent notes for a finished recording. The full transcript is attached;
the live notes are hints and may be incomplete or wrong. Produce: title (≤8 words), summary
(2–4 sentences), keyTakeaways (3–7), actionItems (only real commitments; each with quote +
timestamp; empty array if none), tags (2–6, lowercase, reuse prior tags), speakers. Cover the
ENTIRE conversation, not just the end. Do not invent; where live notes and transcript
disagree, the transcript wins.
```

**(c) Item merge** (rare, post-hoc collision only):

```
System: These two action items appear to be the same obligation. Decide: same → {"same": true,
"keepId": …, "mergedText": …}; different → {"same": false, "reason": …}. Merge only when owner
and obligation match; when unsure, keep them separate.
```

## 9. Gotchas

- **`MAX_ENRICH_CHARS = 48_000` silently truncates the final pass at ~45 min of speech.** A 3 h recording is ~150–200 k chars; raise the cap or add a map-reduce reduce step for the final only.
- Chunk gaps: consume the contiguous prefix only; `recordChunkTranscript` re-stitches sorted by index, so holes are invisible in the stitched string.
- Don't enrich from the chunk route — it already awaits ASR; +2–5 s per chunk doubles latency and ~8× cost.
- Title churn: rebuild-only title updates; the provisional title never reaches the list.
- Quote fidelity: verbatim copying in the prompt; normalize server-side only for the grounding check, never for display.
- Proxy variance: `json_schema` support is per endpoint, not per model; probe per model id, cache downgrades (extend `isResponseFormatRejection`).
- Reasoning off/low for rolls; if a model requires thinking, split into a free-form notes call feeding the constrained call.
- Cost runaway: enforce the 90 s debounce + 3-min cap for long sessions; log tokens in `live.stats`.

## 10. Open questions

1. Does every candidate proxy endpoint serve `json_schema` strict? Test first — it changes schema design (nullable-everything vs clean optionals).
2. User-editable action status? The ops design supports it later; affects id stability and UI.
3. Is derived `actionItems` open-only or open+done? Affects chat/RAG text and list badges.
4. Diarization (post-MVP) changes `owner`/entity quality; keep fixtures relabelable.
5. Privacy: live enrichment roughly doubles transcript egress to the proxy; confirm retention settings.
6. Above ~4 h, switch the final to map-reduce and stop rebuilding from the full transcript.
