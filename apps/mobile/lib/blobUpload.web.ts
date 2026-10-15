/**
 * blobUpload.web.ts
 *
 * Web-only: the browser uploads a recovered buffer straight to Vercel Blob
 * (negotiating a short-lived, pathname-scoped token with our API first), which
 * is the only way past the 4.5 MB serverless request-body cap. The native
 * platform uses `blobUpload.ts` (currently unsupported → buffer stays local).
 */

import { upload } from '@vercel/blob/client';

export async function uploadRecoveryBlob(input: {
  handleUploadUrl: string;
  pathname: string;
  blob: Blob;
}): Promise<{ url: string; pathname: string }> {
  const result = await upload(input.pathname, input.blob, {
    access: 'public',
    handleUploadUrl: input.handleUploadUrl,
    multipart: true,
    contentType: 'audio/wav',
  });
  return { url: result.url, pathname: result.pathname };
}
