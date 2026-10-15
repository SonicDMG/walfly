/**
 * blobUpload.ts — the non-web implementation of the direct-to-Blob upload.
 *
 * Blob's multipart protocol (create/uploadPart/complete) is not implemented on
 * native yet; the recovery flow keeps the buffer on the device and retries,
 * and the local/self-hosted route (`storage: 'local'`) is used instead there.
 * Never silently pretend success — the caller must know to keep the buffer.
 */

export async function uploadRecoveryBlob(_input: {
  handleUploadUrl: string;
  pathname: string;
  blob: Blob | null;
}): Promise<{ url: string; pathname: string }> {
  throw new Error(
    'Direct-to-Blob recovery upload is not available on this platform yet — the recording stays buffered on the device.',
  );
}
