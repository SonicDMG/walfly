/**
 * POST /api/recordings/[id]/process
 *
 * One tick of the resumable recording pipeline. Each call advances the job by
 * at most one step and returns, so the longest invocation is a single Docling
 * submit or LLM call rather than a multi-minute transcription — which is what
 * makes this work identically under `next dev` and on a serverless platform
 * that freezes the sandbox the moment a response is flushed.
 *
 * Clients poll this endpoint. Every answer carries a body the client can show
 * the user: 200 with the tick, 404 when the recording is gone, and 503 with the
 * real message when the pipeline could not even read its state (an Astra
 * timeout, say) — that last case is retryable, and the recording is untouched.
 */

import { NextRequest, NextResponse } from 'next/server';
import { advanceRecording } from '@/lib/pipeline';
import type { PipelineStage, RecordingStatus } from '@walfly/db';

export const runtime = 'nodejs';
export const maxDuration = 300; // Hobby maximum; Pro allows 800.

interface ProcessResponse {
  id: string;
  status: RecordingStatus;
  stage: PipelineStage;
  error: string | null;
  retryAfterMs: number;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<ProcessResponse | { error: string; retryAfterMs?: number }>> {
  const { id } = await params;

  let result: Awaited<ReturnType<typeof advanceRecording>>;
  try {
    result = await advanceRecording(id);
  } catch (err) {
    // advanceRecording is written not to throw; this is the belt-and-braces
    // path so the client never has to interpret an empty-bodied 500.
    console.error(`[process] ${id} unexpected pipeline error:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Pipeline failed unexpectedly' },
      { status: 500 },
    );
  }

  if (!result.found) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
  }

  if (result.status === null) {
    // The pipeline could not read the document — the job state is unchanged and
    // the next tick will retry.
    return NextResponse.json(
      { error: result.error ?? 'Could not read the recording state', retryAfterMs: result.retryAfterMs },
      { status: 503 },
    );
  }

  return NextResponse.json({
    id: result.id,
    status: result.status,
    stage: result.stage,
    error: result.error,
    retryAfterMs: result.retryAfterMs,
  });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204 });
}
