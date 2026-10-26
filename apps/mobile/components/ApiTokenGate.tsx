/**
 * ApiTokenGate
 *
 * Passthrough container for app layout. In local development / unauthenticated
 * mode, requests proceed without prompting for a token.
 */

import React from 'react';

export function ApiTokenGate({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
