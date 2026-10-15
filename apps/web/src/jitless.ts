import { z } from 'zod';

/**
 * Zod without its compiled fast path, because the page's policy (DIN-14) has no
 * `'unsafe-eval'`. Zod probes for eval with a `new Function` it catches, and finds out it
 * cannot; but the browser reports the refused probe as a violation all the same, and a
 * policy whose every page load reports one hides the violation that would matter.
 *
 * Imported first in main.tsx, before any module that parses: the probe runs once, on the
 * first object parsed, and `env.ts` parses as it is imported.
 */
z.config({ jitless: true });
