/**
 * Reads every row, not just the first page of them.
 *
 * PostgREST caps a response at `max_rows` — 1000 by default, locally and hosted — and does it
 * silently: no error, no flag, just fewer rows than asked for. A read that fetches a table in
 * one request works until the thousand-and-first row, and then that row is missing from the
 * screen while it sits safely in the database. Paged here rather than by raising the limit,
 * because the limit is not the app's to rely on.
 *
 * Every paged query needs a total order (`id` at least), or a row can land on two pages or none.
 */

const PAGE_SIZE = 1000;

/** Far above any plausible table, so a bug cannot loop forever. */
const MAX_PAGES = 100;

type Page = { readonly data: readonly unknown[] | null; readonly error: { code: string } | null };

export async function fetchAllPages(
  page: (from: number, to: number) => PromiseLike<Page>,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let index = 0; index < MAX_PAGES; index += 1) {
    const from = index * PAGE_SIZE;
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error !== null) throw new Error(`read failed: ${error.code}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
  // Stopping silently here would be the capped read this file exists to prevent.
  throw new Error(`read stopped at ${MAX_PAGES * PAGE_SIZE} rows`);
}
