/**
 * Putting a Monarch copy and its bank account together, as the app calls it (BANK-17).
 * Everything it does is `api/_lib/join.ts`; this is the door and the log line.
 */
import { join } from '../_lib/join.ts';

export async function POST(request: Request): Promise<Response> {
  const { status, answer } = await join(request, process.env, fetch);
  // The outcome and counts only: never an account's name, which is hers.
  console.log(
    answer.kind === 'joined'
      ? `monarch join: joined, ${answer.days_moved} day(s) and ${answer.transactions_moved} transaction(s) moved`
      : `monarch join: refused, ${answer.reason}`,
  );
  return Response.json(answer, { status, headers: { 'Cache-Control': 'no-store' } });
}
