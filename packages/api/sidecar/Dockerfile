FROM python:3.11-slim

# Install system dependencies for audio decoding
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install uv for fast package management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

# Copy dependency definition files
COPY packages/api/sidecar/pyproject.toml /app/

# Install python dependencies
RUN uv pip install --system -r pyproject.toml

# Copy service code
COPY packages/api/sidecar/transcribe_sidecar.py /app/

# Create a non-root user for security
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

ENV PORT=8888
ENV PYTHONUNBUFFERED=1

EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

CMD ["python", "transcribe_sidecar.py"]
