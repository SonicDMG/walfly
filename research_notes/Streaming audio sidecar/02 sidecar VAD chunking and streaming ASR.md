# 02 — Sidecar VAD, chunking and streaming ASR

Scope: what the FastAPI sidecar (`packages/api/sidecar/transcribe_sidecar.py`) must own once clients stream live audio — VAD, segmentation, streaming ASR, the result protocol, concurrency on a 4–8 vCPU Fly machine, and how to test it. Read alongside `01` (transport/protocol) if present. All numbers below are from primary sources (links at end) unless marked *estimate*.

---

## TL;DR

1. **Drop Docling.** `docling[asr]` pulls torch + transformers for a file-based `AsrPipeline` with no partial output, and fly.toml (2 vCPU / 2 GB, `auto_stop_machines`, 0 min machines) makes every cold start pay a model load. Go direct to **faster-whisper** (CTranslate2, MIT, no torch, PyAV built in). The Dockerfile also builds `python:3.11-slim` against `requires-python >=3.12`; fix while editing.
2. **VAD: Silero v6 ONNX** (~165× realtime on one CPU thread, MIT) with **our own segmentation state machine** — not `vad_filter`/`BatchedInferencePipeline`, both file-tuned. TEN-VAD is runner-up (lower RTF, 306 KB, Apache-2.0 + "no competing deployment" conditions). webrtcvad is obsolete for noisy rooms; pyannote is diarization tooling, not a realtime gate.
3. **ASR: faster-whisper in a LocalAgreement-2 loop** — 0.5–1.5 s partial cadence, stable committed prefixes, no new runtime. CPU: `small.en` int8. GPU: `large-v3-turbo` fp16, batched. sherpa-onnx streaming Zipformer is the only true-streaming CPU engine (escape hatch if sessions matter more than punctuation); Moonshine v2 is English-only with efficient streaming only in its own C++/ONNX runtime.
4. **Never let the re-decode window grow unbounded.** Left-trim at every committed sentence boundary; this is worth more CPU than any model swap.
5. **Segment-level finals only, partials as an ephemeral channel.** The markdown contract (`[time: m:ss.s-m:ss.s] text`) stays append-only; checkpoint per finalized segment so a crash loses ≤ 1 in-flight segment (≤ 25 s).

---

## 1. VAD

| | Silero v6 ONNX | TEN-VAD | webrtcvad | pyannote |
|---|---|---|---|---|
| Accuracy | strong; v6 (2025-08) beats v5 | best in TEN's PR curves vs Silero & WebRTC on their annotated testset (LibriSpeech/GigaSpeech/DNS) | 2011 GMM; degrades badly | excellent, but 10 s windows |
| Speed | 189 µs / 31.25 ms chunk, 1 thread (RTF ≈ 0.006, ~165×) | RTF 0.0086–0.016 (62–116×), 306 KB | very fast (~µs) | ~tens of ms/10 s window (GPU), heavy on CPU |
| Ops | onnxruntime, 2.2 MB | prebuilt C libs / pip-from-git, or ONNX ≥1.17.1 | C ext, trivial | torch, HF download, gated models |
| License | MIT | Apache-2.0 **plus**: may not be deployed to compete with Agora's offerings; derivatives stay under it | BSD | segmentation-3.0 MIT; newer pipelines vary |
| Verdict | **primary** | challenger if Silero false-triggers on music | reject | offline diarization later, never the gate |

**Exact operating parameters (Silero v6, 16 kHz mono):**

- Frame: 512 samples = 32 ms, with the 64-sample left context v5/v6 expects (576-sample model input). ONNX Runtime, `intra_op_num_threads=1`, one session per process, LSTM `(h, c)` state **per session**.
- `start_threshold = 0.5`; `end_threshold = 0.35` (hysteresis, cf. faster-whisper's `neg_threshold = max(threshold−0.15, 0.01)`).
- **Speech start confirm:** 2 consecutive frames ≥ 0.5 (64 ms) — kills clicks and cutlery. In restaurants, 3 frames ≥ 0.6.
- **Min speech:** 250 ms minimum, and only *open a segment* at ≥ 1.0 s cumulative speech. This removes most music/noise ASR calls.
- **Min silence to cut:** 800 ms of frames < 0.35 → close segment. (fw's 2000 ms file default is too slow live; whisper_streaming's 100 ms splits at breaths.)
- **Pre/post-roll:** 400 ms pre-trigger ring; segment audio = `[speech_start − 0.3 s, last_speech + 0.4 s]` (matches fw `speech_pad_ms=400`). Padding is what prevents clipped onsets.
- **Max segment:** forced cut at **25 s** of speech (Whisper window is 30 s), placed at the **quietest 100 ms frame in the last 3 s**, not a hard offset (cf. fw's `min_silence_at_max_speech`).
- **Overlap:** 0.5 s both sides of a forced cut; 0 s for silence cuts (cut at midpoint).

**Clipping/dedupe at boundaries:** (1) silence-midpoint cuts share no audio — no dedupe normally. (2) Forced cuts: decode `[cut ± 0.5 s]` in both segments with `word_timestamps=True` on finals, drop words starting before `last_committed_word_end − 0.02 s`. (3) Remaining dupes: align normalized word lists with `difflib.SequenceMatcher`, take longest common suffix(prev)/prefix(next), keep the higher-`avg_logprob` decode for the overlap (prefer the later decode), concatenate. (4) Never cut inside a word: finals only; partials may dangle and rewrite.

Music/noise: Silero fires on music. Pre-ASR gate: sustained RMS above −32 dBFS for > 10 s with no 800 ms dip (the existing `_SILENCE_RMS_THRESHOLD` inverted) catches held music/PA. The real defense is downstream (§4).

---

## 2. Streaming ASR engine comparison

RTF figures: turbo int8 GPU = 19.6 s for 13 min audio on RTX 3070 Ti (RTF 0.025); large-v3 fp16 = 52 s (0.067). `small` int8 CPU = 1 m 42 s for 13 min on i7-12700K/8 threads (RTF 0.13, ~7.6× realtime) — these are the only fully specified anchors; everything else is scaled/estimated.

| Engine | Mode | Latency (published) | CPU RTF (est.) | Multi | License / ops |
|---|---|---|---|---|---|
| **faster-whisper + LA-2 loop** (recommended) | pseudo-stream, chunk re-decode | whisper_streaming paper: **3.3 s** on unsegmented long-form; our target 1.5–3 s with `min_chunk_size` 0.5–1 s | `small` int8 **0.13** @8T → **0.25–0.3** @4T; turbo/distil-large int8 *≈0.7–1.1* @8T — too slow for low-latency partials at 4 vCPU | ✔ 98+ langs | MIT (fw + algorithm); single runtime, no torch; ops: hot model, warm queue |
| **whisper_streaming** (ufal) reference | LA-2 + sentence trim | 3.3 s | inherits fw | ✔ | MIT, but **author declares it superseded by SimulStreaming (MIT)** in 2025; backends: fw / mlx / openai-api |
| **WhisperLive** (Collabora) | server + WS protocol, fw/TensorRT/OpenVINO backends | "nearly-live", not a number | inherits fw | ✔ | MIT; `max_clients` defaults 4; has batched inference + hotwords + optional diarization; good protocol reference, heavier than we need |
| **sherpa-onnx streaming Zipformer** | true streaming transducer (chunk 320 ms + right context) | algorithmic ~0.3–1 s | **~0.05–0.3 per thread** (int8, varies by model) → 4 vCPU can host many sessions | en/zh focus | Apache-2.0; **no punctuation/casing, no word timestamps** → needs a punctuation model; ONNX-only, no torch |
| **NeMo Parakeet TDT 0.6B v3** | offline/full-context; NeMo FastConformer hybrids offer streaming ladders (`att_context_size` 80 ms→1.12 s) | ~82 ms to final segment in hosted benchmarks | poor on CPU (600 M conformer, torch) | 25 langs | open weights (NVIDIA license); GPU-first; sherpa-onnx ONNX exports exist for v2 |
| **Canary-1B-v2** | offline, ASR+translation | **RTFx 749** (paper) | GPU only in practice | en + 24 EU | as NeMo |
| **Moonshine v2** (34M/123M/245M) | true streaming encoder, 80 ms lookahead, provisional vs finalized states | 50/148/258 ms response on M3 (tiny/small/med); 5.8–43.7× faster than whisper peers | plausible (ONNX) | **English only** | MIT; efficient streaming only in Moonshine's own C++/ONNX path |
| **Hosted** Deepgram Nova-3 / AssemblyAI Universal-Streaming / gpt-4o-transcribe | real streaming | sub-300 ms; AssemblyAI ~300 ms, immutable partials | n/a | ✔ | Deepgram ~$0.0077/min PAYG; AssemblyAI **$0.15/connected-hr**; gpt-4o-transcribe $0.006/min block, realtime streaming materially more. Privacy/residency issues for a passive recorder |

**Decision.** CPU-only: **faster-whisper `small.en` int8** (down to `base.en` only if the SLO breaks; `distil-large-v3`/`turbo` for finals only if profiling allows). GPU: same code path, **`large-v3-turbo` fp16**, batched across sessions. Use `mobiuslabsgmbh/faster-whisper-large-v3-turbo` (correct alignment heads; the popular deepdml conversion has broken word-timestamp config). turbo: 13.40 % WER / 129.5× on YT-Commons; distil-large-v3 English-only, 15.0 % / 142.9×.

---

## 3. Recommended streaming loop

```python
# Session state (RAM ring buffer, max 45 s, float32 mono 16 kHz):
#   ring, vad_state, seg_start_s, last_speech_s, sil_ms,
#   committed (word list), committed_until_s, prev_hyp[2], prompt_tail, seq
# Session clock = samples_received / 16000. One decode at a time per session.

def on_frame(pcm: np.ndarray):                       # 512-sample frame
    S.ring = np.append(S.ring, pcm)[-int(45*16000):]
    p = silero(S, pcm)                               # per-session h,c state

    if S.vad_state == SILENCE and p >= 0.5: S.hit += 1
        if S.hit >= 2: S.vad_state, S.seg_start_s = ON, now() - 0.4
    elif S.vad_state == ON:
        if p >= 0.5: S.last_speech_s, S.sil_ms = now(), 0
        else: S.sil_ms += 32
        if S.sil_ms >= 800 or (S.last_speech_s - S.seg_start_s) >= 25:
            finalize(segment_audio(S.seg_start_s - 0.3, S.last_speech_s + 0.4))
            S.vad_state, S.hit = SILENCE, 0

    if S.vad_state == ON and now() - S.last_decode >= 0.8 and \
       (S.last_speech_s - S.seg_start_s) >= 1.0 and decode_budget_ok():
        S.last_decode = now()
        audio = S.ring[from_s(S.committed_until_s - 0.3):]        # left-trim!
        hyp = model.transcribe(audio, beam_size=1, temperature=0.0,
                               condition_on_previous_text=False,
                               initial_prompt=S.prompt_tail or None,
                               word_timestamps=True, language="en",
                               no_speech_threshold=0.6, compression_ratio_threshold=2.4)
        hyp = dedupe_against_committed(hyp)                        # rule 2/3 above
        agree = common_word_prefix(S.prev_hyp, hyp)                # LA-2
        if len(agree) > len(S.committed):
            S.committed, S.committed_until_s = agree, agree[-1].end
            S.prompt_tail = tail(S.committed, 150)
            emit("partial", seq=S.seq, text=S.committed, t=S.committed_until_s)  # grows only
        S.prev_hyp = (S.prev_hyp + [hyp])[-2:]

def finalize(seg_audio):
    hyp = model.transcribe(seg_audio, beam_size=5, temperature=[0.0,0.2,0.4,0.6,0.8,1.0],
                           condition_on_previous_text=False, initial_prompt=S.prompt_tail or None,
                           word_timestamps=True, no_speech_threshold=0.6)
    hyp = drop_hallucinations(hyp)          # §4
    seg = {"seq": S.seq, "start": S.seg_start_s, "end": S.last_speech_s + 0.4,
           "text": hyp.text, "words": hyp.words, "avg_logprob": hyp.avg_logprob}
    emit("segment", **seg); checkpoint(seg); S.seq += 1
```

Key rules: partials only ever *grow* (committed prefix never rewritten — LA-2); one decode at a time per session; the decode interval adapts upward (0.8 s → 2 s) when a decode overruns it (self-adaptive latency). Partials: beam 1, T=0. Finals: beam 5 + fallback ladder.

---

## 4. Context carry-over & hallucination suppression

- **`condition_on_previous_text=False` always.** True is Whisper's offline behaviour and the main cause of repetition loops and prompt echo in streaming. The only context channel is `initial_prompt` = **tail of committed text, ≤ ~150 chars** (strip timestamps, flatten odd punctuation) — enough to keep names/terms consistent; long prompts get regurgitated verbatim on silence.
- **Hotwords vs prompt:** fw supports `hotwords=` (keyword boosting); for a known attendee/product list, prefer hotwords + a short prompt. Turbo hallucinates more on noisy/short clips (issue #1030); observed mitigations: no word_timestamps in partials, mobiuslabs conversion, short prompt.
- **On silence/music:** never call ASR on < 1 s of speech (§1); keep `no_speech_threshold=0.6`, `log_prob_threshold=-1.0`, `compression_ratio_threshold=2.4` (fw's built-in hallucination detector). Drop segments that duplicate the previous final verbatim or match a small blocklist ("Thanks for watching", "Subtitles by…", "Please subscribe", repeated single tokens).
- **Temperature tradeoff:** the default fallback `[0.0…1.0]` is for offline robustness; in the partial loop it makes every retry inconsistent. Split: partials T=0 only; finals full ladder. Largest stability win for growing finals.
- Punctuation/casing: Whisper does both natively; no post-processing beyond whitespace. Keep `_fmt_time`; only finals enter the markdown contract — partials travel on a separate channel with a `revision` counter.

---

## 5. Result protocol & checkpoint

Client→server (`WS /v1/stream?session_id=…`): `{"type":"audio","seq":n,"pcm_b64":"…"}` (16 kHz mono s16le preferred; m4a/webm only for the file path), `{"type":"end"}`.

Server→client:

```
{"type":"session.ready","session_id":…,"sample_rate":16000,"format":"pcm_s16le"}
{"type":"partial","revision":r,"t_end":18.4,"text":"…","stable_chars":213}
{"type":"segment","seq":7,"start":12.1,"end":18.4,"text":"…",
 "words":[{"w":"coffee","s":12.3,"e":12.7,"p":0.93}],"avg_logprob":-0.31,"no_speech_prob":0.02}
{"type":"error"|"session.closed"}
```

Times are float seconds on the **session clock = samples_received/16000** (device clocks are untrustworthy). Reconnects: client resends from the last acked `seq`; server dedupes `(session_id, seq)`. Finals are immutable and ordered; the partial stream is UI state only.

**Checkpoint** (POST to Next API or object storage per finalized segment):

```json
{"session_id":"…","version":1,"last_seq":7,"clock":18.4,
 "segments":[{"seq":6,"start":4.8,"end":12.0,"text":"…"},{"seq":7,…}],
 "prompt_tail":"…", "vad":{"state":"ON","seg_start":12.1,"last_speech":18.4},
 "model":{"name":"small.en","compute":"int8"},"created_at":"…"}
```

Crash loses ≤ the in-flight segment (≤ 25 s). Let the *client* hold a durable local buffer and resend from the checkpoint on reconnect so the sidecar owns no long-lived audio. The markdown renderer consumes `segments` only; retire the Next.js `adjustTimestamps` offset pass once times are session-relative.

---

## 6. Concurrency & memory (4–8 vCPU)

Cost per *active* session ≈ `RTF_decode × amplification × duty`, where amplification = decoded audio / new audio = (window length ÷ decode interval), duty ≈ speech fraction (~0.5–0.7 in meetings).

- `small.en` int8 @4 threads: RTF_decode ≈ 0.25; trimmed window ~8 s / step 1 s → amp ≈ 8; duty 0.6 → **≈1.2 cores per active session** → 4 vCPU ≈ **3 sessions**, 8 vCPU ≈ 6. Untrimmed (30 s window, amp 30) collapses to ~1 session on 4 vCPU — trimming is the whole game.
- turbo/distil-large int8 @4 threads: RTF_decode ≈ 0.8–1.0; finals only, or GPU. **Never turbo on CPU for partials.**
- GPU (L4/T4, turbo fp16, batch 8): RTF ≈ 0.025 single-stream → 20–40 concurrent sessions; ~4 GB VRAM of weights + batch activations.
- Memory: turbo int8 ≈ 1.6 GB weights (fp16 3.1 GB) + 300–600 MB CT2 workspace → RSS 2–2.5 GB. `small.en` int8 ≈ 250 MB weights, RSS < 1 GB. **The current 2 GB Fly VM fits `small.en`, not turbo**; large needs `memory_mb=4096`, `min_machines_running=1`, model baked into the image.

Warm-keeping & threads: bake model files into the Docker layer (`/models`) to skip the HF download; **CTranslate2 uses OpenMP** — set `OMP_NUM_THREADS` and per-call `cpu_threads` so concurrent-decodes × threads ≤ vCPUs (never oversubscribe; two 8-thread decodes on 4 vCPU lose to serial). One CT2 model instance per process is thread-safe; prefer 2 worker processes × `cpu_threads=2` over 1 × 4 for tail latency. Queueing: per-session FIFO depth 1 (drop partial jobs, never finals). Backpressure: if decode latency > 2× interval, raise the session's decode interval (self-adaptive) and skip the current partial.

---

## 7. Testing

1. **Synthetic fixtures**: deterministic-seed 16 kHz mono WAVs — speech (TTS or fixed corpus) + MUSAN noise/music at SNR −5/0/+10 dB, plus edge clips (200 ms cough, 1.2 s music sting, interruptions, a segment straddling the 25 s force-cut). Expected boundaries in JSON, ±300 ms tolerance.
2. **VAD unit tests**: feed probability arrays (not audio) into the state machine → exact boundary assertions; properties: no segment below min-speech, no cut while `p ≥ 0.35` for < 800 ms, segment count monotonic.
3. **LA-2 unit tests**: scripted hypothesis sequences (rewrite, insertion, dangling partial word) → expected commit points; assert committed text never shrinks.
4. **Replay harness with fake clock**: feed fixture frames; a "comp-unaware" mode advances virtual time only as the pipeline drains (whisper_streaming's trick) to isolate algorithmic latency, a wall-clock mode for SLO.
5. **Golden regression**: WER vs reference ≤ threshold, p95 partial latency ≤ 3 s, zero hallucination strings on silence/music fixtures; nightly, slow-marked.
6. **Load test**: N synthetic sessions at real-time feed → p95 latency, bounded queues, RSS ceiling.
7. **Crash/checkpoint**: SIGKILL mid-session, restart, replay from checkpoint; final transcript equals an uninterrupted run modulo the in-flight segment.

---

## 8. Gotchas

- **Client formats**: Expo/iOS/Android record containers (m4a/webm); for WS use raw PCM s16le 16 kHz and keep PyAV for the file path only. Resample if the BLE mic is 8/24/48 kHz.
- Silero's LSTM state is per-session; sharing state across sessions is a silent, cross-talk bug.
- Word timestamps in partials: +10–20 % decode cost and the trigger for the deepdml turbo conversion misbehaving. Partials without, finals with.
- `BatchedInferencePipeline` is for files (internal VAD + 30 s windows + batch); never for streaming.
- Whisper on < 1 s windows is garbage; enforce min speech.
- Fly shared-CPU machines are bursty: benchmark *there*, and log `decode_ms / audio_ms` per session as the production health metric.
- Fly `auto_stop_machines=true` + 0 min machines = a model load per cold request on a product whose value is live latency.

## 9. Open questions

- BLE-mic vs phone-mic audio format/sample rate — decides resampling, VAD tuning, whether clients can stream PCM at all.
- Multilingual? distil-* are English-only; if Spanish/French meetings matter the primary becomes `turbo` (multilingual, **no translation**) and CPU sizing worsens.
- Diarization later? pyannote (community-1) as an offline post-pass over the finalized segment timeline, never in the realtime loop.
- Checkpoint home: Next API/Postgres vs sidecar→S3 direct — affects recovery and markdown appending.
- Does the `[time: …]` line contract stay one-line-per-segment, or move to JSON segments + renderer? Partials need a home; JSON segments + markdown projection is the cleaner evolution.
- GPU on Fly: region availability, cold-start, whether GPU machines may auto-stop (likely keep one warm).

---

## Sources

- Silero VAD (perf metrics: 189 µs/31.25 ms ONNX, 1 thread; v6 history) — https://github.com/snakers4/silero-vad
- TEN-VAD (RTF table, PR curves, license) — https://github.com/ten-framework/ten-vad
- faster-whisper (small int8 CPU 1 m 42 s/13 min; batched API; `vad.py` defaults) — https://github.com/SYSTRAN/faster-whisper
- turbo numbers + hallucination discussion — https://github.com/SYSTRAN/faster-whisper/issues/1030
- Whisper-Streaming: LA-2, 3.3 s; superseded note — https://github.com/ufal/whisper_streaming , https://aclanthology.org/2023.ijcnlp-demo.3.pdf
- WhisperLive — https://github.com/collabora/WhisperLive
- sherpa-onnx streaming Zipformer — https://github.com/k2-fsa/sherpa-onnx
- Moonshine v2 — https://arxiv.org/html/2602.12241v1
- Parakeet/Canary RTFx 749 + streaming ladders — https://arxiv.org/html/2509.14128v1 , https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3 , https://huggingface.co/nvidia/stt_en_fastconformer_hybrid_large_streaming_multi
- pyannote segmentation-3.0 — https://huggingface.co/pyannote/segmentation-3.0
- Hosted: Deepgram Nova-3 $0.0077/min — https://deepgram.com/learn/deepgram-vs-google-vs-assemblyai ; AssemblyAI $0.15/hr, ~300 ms — https://www.assemblyai.com/universal-streaming ; OpenAI pricing — https://developers.openai.com/api/docs/pricing
- Local contracts — `packages/api/sidecar/{transcribe_sidecar.py,pyproject.toml,Dockerfile,fly.toml}`, `packages/api/lib/transcribe.ts`
