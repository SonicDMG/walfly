/**
 * next.config.js
 *
 * CORS for the Expo client (which runs on a different origin in every
 * environment), and monorepo-aware output tracing so packages/db and the
 * root-hoisted node_modules are included in the deployment bundle.
 */

const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // @walfly/db is consumed as raw TypeScript via main: ./src/index.ts.
  transpilePackages: ['@walfly/db'],

  // Tracing defaults to the Next project directory; without this, packages/db
  // and the hoisted @datastax/astra-db-ts fall outside the traced root.
  outputFileTracingRoot: path.join(__dirname, '../../'),

  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: process.env.CORS_ALLOW_ORIGIN || '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PATCH, DELETE, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
          { key: 'Access-Control-Max-Age', value: '86400' },
          { key: 'Vary', value: 'Origin' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
