/**
 * Reading a source again, as the app calls it (BANK-18). Everything it does is
 * `api/_lib/read.ts`; this is the door and the log line.
 */
import { readAgain } from '../_lib/read.ts';

export async function POST(request: Request): Promise<Response> {
  const { status, answer } = await readAgain(request, process.env, fetch, new Date());
  // The kind and a reason only: a reason is a status, a count or an aggregator's complaint,
  // never an amount or a payee (invariant 4).
  console.log(`bank read: ${answer.kind}${answer.kind === 'read' ? '' : `, ${answer.reason}`}`);
  return Response.json(answer, { status, headers: { 'Cache-Control': 'no-store' } });
}
