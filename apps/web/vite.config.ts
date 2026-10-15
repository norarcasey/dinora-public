import { contentSecurityPolicy } from '@dinora/core/csp';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

import { pwa } from './pwa.config.ts';

/**
 * The policy as the first thing in `<head>`, in the built page only: the dev server's React
 * refresh runs an inline script the policy would refuse. Why a `<meta>` and not a header is in
 * `packages/core/src/csp.ts`.
 */
function csp(): Plugin {
  let url: string | undefined;
  return {
    name: 'content-security-policy',
    apply: 'build',
    configResolved(config) {
      const value: unknown = config.env['VITE_SUPABASE_URL'];
      url = typeof value === 'string' ? value : undefined;
    },
    transformIndexHtml() {
      const policy = contentSecurityPolicy(url);
      // The name and never the value, as in src/env.ts.
      if (policy === null) throw new Error('VITE_SUPABASE_URL is not an http(s) URL');
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [react(), csp(), ...pwa()],
});
