FROM python:3.12-slim

# curl is used by the healthcheck; PyAV wheels bundle their own ffmpeg libs, so
# no system ffmpeg is needed (faster-whisper decodes through PyAV).
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install uv for fast package management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

# Copy dependency definition files
COPY packages/api/sidecar/pyproject.toml /app/

# Install python dependencies
RUN uv pip install --system -r pyproject.toml

# Bake the Whisper model into the image so cold starts never pay a download.
# Override at build time:  fly deploy --build-arg ASR_MODEL=large-v3-turbo
ARG ASR_MODEL=small.en
ENV ASR_MODEL=${ASR_MODEL}
ENV HF_HOME=/models
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('${ASR_MODEL}', device='cpu', compute_type='int8')"

# Copy service code
COPY packages/api/sidecar/transcribe_sidecar.py /app/
COPY packages/api/sidecar/walfly_asr /app/walfly_asr/
COPY packages/api/sidecar/scripts /app/scripts/

# Create a non-root user for security
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

ENV PORT=8888
ENV PYTHONUNBUFFERED=1

EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

CMD ["python", "transcribe_sidecar.py"]
