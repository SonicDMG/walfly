/**
 * api.ts — central API base URL config for the mobile app.
 *
 * In dev: point to local Next.js server (http://localhost:3000).
 * On device: set EXPO_PUBLIC_API_URL in your .env.local.
 */

export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}
