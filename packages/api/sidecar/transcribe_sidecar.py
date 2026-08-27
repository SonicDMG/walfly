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


# ---------------------------------------------------------------------------
# Docling transcription (runs in a background thread)
# ---------------------------------------------------------------------------

def _run_transcription(task_id: str, audio_path: Path) -> None:
    log.info("[%s] Starting docling transcription of %s (%d bytes)",
             task_id, audio_path.name, audio_path.stat().st_size)
    try:
        from docling.datamodel import asr_model_specs
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import AsrPipelineOptions
        from docling.document_converter import AudioFormatOption, DocumentConverter
        from docling.pipeline.asr_pipeline import AsrPipeline

        pipeline_options = AsrPipelineOptions()
        pipeline_options.asr_options = asr_model_specs.WHISPER_TURBO

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
