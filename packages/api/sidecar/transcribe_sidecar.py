"""
transcribe_sidecar.py

Minimal FastAPI sidecar that imports docling directly and exposes three
endpoints that mirror the docling-serve v1 async API shape:

  POST /v1/convert/file/async   — accepts multipart audio, returns task_id
  GET  /v1/status/poll/{id}     — returns task_status
  GET  /v1/result/{id}          — returns md_content

This lets the existing Next.js transcribe.ts work without any protocol
change — only DOCLING_SERVICE_URL needs to point here instead of docling-serve.

Run with:
  uv run python transcribe_sidecar.py
  # or
  uv run uvicorn transcribe_sidecar:app --port 5001

Dependencies (pyproject.toml):
  fastapi, uvicorn[standard], python-multipart, docling[asr]
"""

from __future__ import annotations

import logging
import os
import struct
import tempfile
import threading
import uuid
from enum import Enum
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
log = logging.getLogger("sidecar")

app = FastAPI(title="Walfly Transcription Sidecar", version="1.0.0")

# ---------------------------------------------------------------------------
# In-memory task store
# ---------------------------------------------------------------------------

class TaskStatus(str, Enum):
    PENDING = "pending"
    SUCCESS = "success"
    FAILURE = "failure"


_tasks: dict[str, dict[str, Any]] = {}
_tasks_lock = threading.Lock()


def _create_task() -> str:
    task_id = str(uuid.uuid4())
    with _tasks_lock:
        _tasks[task_id] = {"status": TaskStatus.PENDING, "markdown": None, "error": None}
    return task_id


def _set_success(task_id: str, markdown: str) -> None:
    with _tasks_lock:
        _tasks[task_id]["status"] = TaskStatus.SUCCESS
        _tasks[task_id]["markdown"] = markdown


def _set_failure(task_id: str, error: str) -> None:
    with _tasks_lock:
        _tasks[task_id]["status"] = TaskStatus.FAILURE
        _tasks[task_id]["error"] = error


def _get_task(task_id: str) -> dict[str, Any] | None:
    with _tasks_lock:
        return _tasks.get(task_id)


# ---------------------------------------------------------------------------
# Timestamp extraction + markdown formatting
# ---------------------------------------------------------------------------

def _fmt_time(seconds: float) -> str:
    """Format seconds as M:SS.S — matches the [time: a-b] format the app expects."""
    m = int(seconds // 60)
    s = seconds % 60
    return f"{m}:{s:04.1f}"


def _build_timestamped_markdown(document: object) -> str:
    """Extract per-segment timestamps from DoclingDocument and emit [time: a-b] lines.

    Falls back to plain export_to_markdown() if no TrackSource timestamps are found.
    """
    lines: list[str] = []

    if hasattr(document, "texts"):
        for text_item in document.texts:  # type: ignore[union-attr]
            text = getattr(text_item, "text", "").strip()
            if not text:
                continue

            start: float | None = None
            end: float | None = None

            source = getattr(text_item, "source", None)
            sources = source if isinstance(source, list) else ([source] if source is not None else [])

            for src in sources:
                s = getattr(src, "start_time", None) or getattr(src, "start", None)
                e = getattr(src, "end_time", None) or getattr(src, "end", None)
                if s is not None:
                    start = float(s)
                    end = float(e) if e is not None else start
                    break

            if start is not None:
                lines.append(f"[time: {_fmt_time(start)}-{_fmt_time(end)}] {text}")
            else:
                lines.append(text)

    if lines:
        log.info("Built timestamped markdown: %d segments", len(lines))
        return "\n\n".join(lines)

    # Fallback — no timestamps available
    log.warning("No timestamps found in DoclingDocument, falling back to plain markdown")
    return document.export_to_markdown()  # type: ignore[union-attr]


# TODO: remove after client-side VAD gate confirmed in production
# ---------------------------------------------------------------------------
# Silence detection
# ---------------------------------------------------------------------------

# RMS amplitude below this threshold (on a 0–1 scale) is treated as silence.
# Whisper Turbo hallucinates on silent input (e.g. repeated "the", "I can't do that").
# 0.025 corresponds to approx -32 dBFS RMS, reliably cutting off ambient background/mic hiss.
_SILENCE_RMS_THRESHOLD = 0.025

# Minimum number of PCM samples required before we bother computing RMS.
# Avoids a divide-by-zero on a zero-byte or malformed file.
_MIN_SAMPLES_FOR_RMS = 64


def _is_silent_audio(audio_path: Path) -> bool:
    """Return True if the audio file (WAV, MP4/M4A, WebM, etc.) contains only silence.

    First tries PyAV (`av`) to decode the audio stream and compute RMS amplitude across all formats.
    Falls back to direct PCM WAV parsing if PyAV is unavailable or fails.
    """
    try:
        import av
        import numpy as np

        with av.open(str(audio_path)) as container:
            audio_streams = [s for s in container.streams if s.type == "audio"]
            if not audio_streams:
                return False

            sum_squares = 0.0
            total_samples = 0

            for frame in container.decode(audio_streams[0]):
                # Convert audio frame to float32 numpy array normalized to [-1.0, 1.0]
                arr = frame.to_ndarray()
                if arr.dtype == np.int16:
                    float_arr = arr.astype(np.float32) / 32768.0
                elif arr.dtype == np.int32:
                    float_arr = arr.astype(np.float32) / 2147483648.0
                elif arr.dtype == np.uint8:
                    float_arr = (arr.astype(np.float32) - 128.0) / 128.0
                elif np.issubdtype(arr.dtype, np.floating):
                    float_arr = arr.astype(np.float32)
                else:
                    float_arr = arr.astype(np.float32)

                sum_squares += float(np.sum(float_arr ** 2))
                total_samples += float_arr.size

            if total_samples < _MIN_SAMPLES_FOR_RMS:
                return False

            rms = (sum_squares / total_samples) ** 0.5
            log.info("Audio silence check (PyAV): rms=%.5f threshold=%.5f file=%s",
                     rms, _SILENCE_RMS_THRESHOLD, audio_path.name)
            return rms < _SILENCE_RMS_THRESHOLD
    except Exception as pyav_exc:
        log.debug("PyAV decode failed or uninstalled (%s), attempting raw WAV parser fallback", pyav_exc)

    try:
        with audio_path.open("rb") as f:
            header = f.read(44)

        # WAV files start with RIFF…WAVE; reject anything else quickly.
        if len(header) < 44 or header[:4] != b"RIFF" or header[8:12] != b"WAVE":
            return False

        # Parse enough of the canonical 44-byte PCM header to find bit depth.
        bits_per_sample = struct.unpack_from("<H", header, 34)[0]
        if bits_per_sample not in (8, 16, 24, 32):
            return False

        # Read the full file and skip to the "data" sub-chunk.
        data = audio_path.read_bytes()
        offset = 12  # skip RIFF header
        data_payload = b""
        while offset + 8 <= len(data):
            chunk_id = data[offset:offset + 4]
            chunk_size = struct.unpack_from("<I", data, offset + 4)[0]
            if chunk_id == b"data":
                data_payload = data[offset + 8: offset + 8 + chunk_size]
                break
            offset += 8 + chunk_size

        if not data_payload:
            return False

        if bits_per_sample == 16:
            fmt = "<" + "h" * (len(data_payload) // 2)
            if len(data_payload) // 2 < _MIN_SAMPLES_FOR_RMS:
                return False
            samples = struct.unpack(fmt, data_payload[: (len(data_payload) // 2) * 2])
            rms = (sum(s * s for s in samples) / len(samples)) ** 0.5 / 32768.0
        elif bits_per_sample == 8:
            samples = list(data_payload)
            if len(samples) < _MIN_SAMPLES_FOR_RMS:
                return False
            # 8-bit WAV is unsigned, centre is 128
            rms = (sum((s - 128) ** 2 for s in samples) / len(samples)) ** 0.5 / 128.0
        else:
            return False

        log.debug("Silence check (raw WAV): rms=%.5f threshold=%.5f path=%s",
                  rms, _SILENCE_RMS_THRESHOLD, audio_path.name)
        return rms < _SILENCE_RMS_THRESHOLD

    except Exception as exc:  # noqa: BLE001
        log.warning("Silence check failed (%s) — treating as non-silent", exc)
        return False


# ---------------------------------------------------------------------------
# Docling transcription (runs in a background thread)
# ---------------------------------------------------------------------------

def _run_transcription(task_id: str, audio_path: Path) -> None:
    log.info("[%s] Starting docling transcription of %s (%d bytes)",
             task_id, audio_path.name, audio_path.stat().st_size)

    # Short-circuit: return an empty transcript rather than let Whisper
    # hallucinate on a silent audio chunk (M4A, WAV, etc.).
    if _is_silent_audio(audio_path):
        log.info("[%s] Silence detected — skipping Whisper, returning empty transcript", task_id)
        _set_success(task_id, "")
        try:
            audio_path.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass
        return

    try:
        import torch
        from docling.datamodel import asr_model_specs
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import AcceleratorOptions, AsrPipelineOptions
        from docling.document_converter import AudioFormatOption, DocumentConverter
        from docling.pipeline.asr_pipeline import AsrPipeline

        # Docling's 'auto' mode misses MPS on Apple Silicon in some versions,
        # so we resolve the best available device explicitly.
        if torch.backends.mps.is_built() and torch.backends.mps.is_available():
            _device = "mps"
        elif torch.backends.cuda.is_built() and torch.cuda.is_available():
            _device = "cuda"
        else:
            _device = "cpu"
        log.info("[%s] Selected accelerator device: %s", task_id, _device)

        pipeline_options = AsrPipelineOptions()
        pipeline_options.asr_options = asr_model_specs.WHISPER_TURBO
        pipeline_options.accelerator_options = AcceleratorOptions(device=_device)

        converter = DocumentConverter(
            format_options={
                InputFormat.AUDIO: AudioFormatOption(
                    pipeline_cls=AsrPipeline,
                    pipeline_options=pipeline_options,
                )
            }
        )

        log.info("[%s] Running DocumentConverter with AsrPipeline (whisper-turbo)…", task_id)
        result = converter.convert(audio_path)
        markdown = _build_timestamped_markdown(result.document)

        log.info("[%s] Transcription complete — %d chars", task_id, len(markdown))
        _set_success(task_id, markdown)

    except Exception as exc:  # noqa: BLE001
        log.error("[%s] Transcription failed: %s", task_id, exc, exc_info=True)
        _set_failure(task_id, str(exc))
    finally:
        # Clean up the temp file
        try:
            audio_path.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _write_temp_audio(filename: str, audio_bytes: bytes) -> Path:
    """Write audio bytes to a temp file, normalising .m4a → .mp4."""
    raw_suffix = Path(filename or "recording.m4a").suffix or ".m4a"
    suffix = ".mp4" if raw_suffix.lower() == ".m4a" else raw_suffix
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp.write(audio_bytes)
    tmp.close()
    return Path(tmp.name)


@app.post("/v1/convert/file/async")
async def convert_file_async(
    files: UploadFile = File(...),
    to_formats: str = Form(default="md"),  # noqa: ARG001
    target_type: str = Form(default="inbody"),  # noqa: ARG001
) -> JSONResponse:
    """Accept an audio file, enqueue transcription, return a task_id."""
    audio_bytes = await files.read()
    log.info("Received file: name=%s size=%d mime=%s",
             files.filename, len(audio_bytes), files.content_type)

    audio_path = _write_temp_audio(files.filename or "recording.m4a", audio_bytes)
    task_id = _create_task()
    log.info("Created task %s for %s", task_id, audio_path)

    thread = threading.Thread(
        target=_run_transcription,
        args=(task_id, audio_path),
        daemon=True,
    )
    thread.start()

    return JSONResponse({"task_id": task_id})


@app.post("/v1/transcribe")
async def transcribe_sync(files: UploadFile = File(...)) -> JSONResponse:
    """Synchronous transcription — blocks until docling completes, returns markdown.

    Used by the Next.js pipeline's single-call transcribeAudio() function.
    Response: {"markdown": "..."}
    """
    audio_bytes = await files.read()
    log.info("[sync] Received file: name=%s size=%d mime=%s",
             files.filename, len(audio_bytes), files.content_type)

    audio_path = _write_temp_audio(files.filename or "recording.m4a", audio_bytes)
    task_id = _create_task()
    log.info("[sync] Created task %s for %s", task_id, audio_path)

    # Run in a thread and block until complete
    done = threading.Event()

    def _run_and_signal() -> None:
        _run_transcription(task_id, audio_path)
        done.set()

    threading.Thread(target=_run_and_signal, daemon=True).start()
    done.wait()  # blocks the async handler — fine for a local sidecar

    task = _get_task(task_id)
    if task is None or task["status"] == TaskStatus.FAILURE:
        error = (task or {}).get("error", "Transcription failed")
        log.error("[sync] Task %s failed: %s", task_id, error)
        raise HTTPException(status_code=500, detail=error)

    markdown = task.get("markdown") or ""
    log.info("[sync] Task %s complete — %d chars", task_id, len(markdown))

    with _tasks_lock:
        _tasks.pop(task_id, None)

    return JSONResponse({"markdown": markdown})


@app.get("/v1/status/poll/{task_id}")
def poll_status(task_id: str) -> JSONResponse:
    """Return the current task status in docling-serve poll format."""
    task = _get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found")

    status = task["status"]
    log.info("Poll %s → %s", task_id, status)

    if status == TaskStatus.PENDING:
        return JSONResponse({"task_id": task_id, "task_status": "pending", "error_message": None})
    if status == TaskStatus.SUCCESS:
        return JSONResponse({"task_id": task_id, "task_status": "success", "error_message": None})

    # failure
    return JSONResponse({
        "task_id": task_id,
        "task_status": "failure",
        "error_message": task.get("error"),
        "failure": {"message": task.get("error"), "retryable": False},
    })


@app.get("/v1/result/{task_id}")
def get_result(task_id: str) -> JSONResponse:
    """Return the transcript markdown in docling-serve inbody format."""
    task = _get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found")

    status = task["status"]

    if status == TaskStatus.PENDING:
        raise HTTPException(status_code=425, detail="Task is still processing")

    if status == TaskStatus.FAILURE:
        return JSONResponse(
            status_code=200,
            content={
                "kind": "TaskFailureResult",
                "failure": {"message": task.get("error"), "retryable": False},
            },
        )

    markdown = task.get("markdown") or ""
    log.info("Result %s → %d chars", task_id, len(markdown))

    # Clean up from memory once fetched
    with _tasks_lock:
        _tasks.pop(task_id, None)

    return JSONResponse({
        "document": {
            "md_content": markdown,
            "text_content": None,
            "filename": "transcript.md",
        },
        "num_succeeded": 1,
        "num_failed": 0,
    })


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("SIDECAR_PORT", "8888"))
    log.info("Starting transcription sidecar on port %d", port)
    uvicorn.run(app, host="0.0.0.0", port=port)
