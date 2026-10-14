import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { pwa } from './pwa.config.ts';

export default defineConfig({
  plugins: [react(), ...pwa()],
});
