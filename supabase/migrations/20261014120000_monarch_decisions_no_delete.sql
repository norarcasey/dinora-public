-- A Monarch decision is withdrawn, never deleted (DIN-15).
--
-- 20260928000000 took UPDATE back so a decision could not be rewritten in place, and left
-- DELETE with the owned-table pattern's grant. A delete loses more than a rewrite does: the
-- table is the history the file's copies used to be, and a deleted row takes the decision and
-- the fact it was ever made. Withdrawing one is `deleted_at`, which she already holds, and
-- nothing in the app or the import deletes a decision. Invariant 2.

revoke delete on table public.monarch_decisions from authenticated;
drop policy monarch_decisions_delete_own on public.monarch_decisions;
