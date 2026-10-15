// First: before any module that parses. See jitless.ts.
import './jitless.ts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
// The display face (UI-06): one weight, latin only. Imported here, not fetched from a font
// host, so the build emits it and the service worker precaches it with the shell.
import '@fontsource/source-serif-4/latin-600.css';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { startLock } from './device/lock.ts';
import { startOfflineRead } from './device/start.ts';
import './pwa/shell.css';
import { watchForStaleChunks } from './pwa/staleChunks.ts';
import { watchForUpdates } from './pwa/updates.ts';
import { watchVisibility } from './pwa/veil.ts';
import { SYNCED_TABLES } from './queries/tables.ts';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

// Before the first render: a lazy route can be reached as soon as anything is on screen.
watchForStaleChunks();
watchForUpdates();
watchVisibility();
// After the veil, and before the first render, so a locked app never draws open.
startLock();

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
// Before React mounts, so the disk read overlaps the first render. See `device/start.ts`.
startOfflineRead(queryClient, SYNCED_TABLES);

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
