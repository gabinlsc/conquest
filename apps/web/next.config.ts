import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Image Docker minimale (server.js + node_modules tracés).
  output: 'standalone',
  // Racine du monorepo, nécessaire pour tracer @conquest/shared dans le build standalone.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  transpilePackages: ['@conquest/shared'],
  poweredByHeader: false,
  async rewrites() {
    // Dev uniquement : en prod, Caddy route /api vers le serveur.
    if (process.env.NODE_ENV === 'production') return [];
    return [{ source: '/api/:path*', destination: 'http://localhost:3001/api/:path*' }];
  },
};

export default config;
