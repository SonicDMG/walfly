/**
 * proxy.ts
 *
 * Gates every /api/* request behind a single shared bearer token
 * (WALFLY_API_TOKEN), except /api/health (operational probe) and /api/wiki/*
 * (public codebase Q&A — no user data behind either). Runs in the Node.js
 * runtime, which is Proxy's default as of Next 16 (this file replaces the
 * deprecated `middleware.ts` convention — same mechanism, renamed).
 *
 * This is the one check that matters most: POST /api/recordings/[id]/ws-ticket
 * had no caller check before this existed, so anyone who knew/guessed a
 * recording id could mint a ticket and stream to the ASR sidecar for free.
 * Gating it here requires no changes to wsTicket.ts or the sidecar's HMAC
 * verification — both stay exactly as they are.
 */

import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const EXEMPT_PREFIXES = ['/api/health', '/api/wiki'];

/**
 * Mirrors next.config.js's `headers()` CORS block for /api/:path*. Duplicated
 * rather than imported — next.config.js is build-time config, not a runtime
 * module — so keep the two in sync by hand if either changes. Attached to
 * every response Proxy produces itself (not just left to next.config.js) so a
 * bad/missing token surfaces to the browser as a clean 401, never an opaque
 * CORS failure.
 */
function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Hashes both sides before comparing — sidesteps timingSafeEqual's throw on a length mismatch. */
function tokensMatch(a: string, b: string): boolean {
  const digest = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

export function proxy(request: NextRequest): NextResponse {
  // Browsers never attach custom headers (like Authorization) to a CORS
  // preflight. Rejecting OPTIONS here would make every authenticated
  // browser/Expo-web call fail before it's even sent.
  if (request.method === 'OPTIONS') return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  const expected = process.env.WALFLY_API_TOKEN;
  if (!expected) {
    // Fail closed and loud. An admin who forgot to set this should see
    // "everything is broken, go set it" — never a silently wide-open API.
    return NextResponse.json(
      { error: 'Server misconfigured: WALFLY_API_TOKEN is not set' },
      { status: 500, headers: corsHeaders() },
    );
  }

  const [scheme, token] = (request.headers.get('authorization') ?? '').split(' ');
  if (scheme !== 'Bearer' || !token || !tokensMatch(token, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders() });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};
