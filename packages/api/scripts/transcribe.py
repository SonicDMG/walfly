#!/usr/bin/env python3
"""
transcribe.py — CLI wrapper around Docling's AsrPipeline.

Usage:
    python transcribe.py <audio_file_path>

Prints the markdown transcript to stdout.
Exits non-zero on failure.

Follows the pattern from:
    https://github.com/SonicDMG/video_to_openrag/blob/main/pipeline/transcribe.py
"""

import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio_file_path>", file=sys.stderr)
        sys.exit(1)

    audio_path = Path(sys.argv[1]).resolve()
    if not audio_path.exists():
        print(f"File not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    try:
        from docling.datamodel import asr_model_specs
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import AsrPipelineOptions
        from docling.document_converter import AudioFormatOption, DocumentConverter
        from docling.pipeline.asr_pipeline import AsrPipeline
    except ImportError as exc:
        print(f"docling[asr] not installed: {exc}", file=sys.stderr)
        sys.exit(1)

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

    # Docling does not recognise .webm — rename to .ogg (same Opus codec).
    # We create a symlink so the original file is untouched.
    import os, tempfile
    if audio_path.suffix.lower() == '.webm':
        ogg_path = audio_path.with_suffix('.ogg')
        if not ogg_path.exists():
            os.symlink(audio_path, ogg_path)
        audio_path = ogg_path

    # Pass a Path object — NOT a str. When a str is passed, Docling's
    # _DocumentConversionInput.docs() calls resolve_source_to_stream()
    # which converts it to a BytesIO stream, losing the directory component.
    result = converter.convert(audio_path)
    markdown = result.document.export_to_markdown()
    print(markdown)


if __name__ == "__main__":
    main()
