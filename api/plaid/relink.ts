/**
 * Signing a Plaid bank in again, as the app calls it (BANK-12). Everything it does is
 * `api/_lib/relink.ts`; this is the door and the log line.
 */
import { relink } from '../_lib/relink.ts';

export async function POST(request: Request): Promise<Response> {
  const { status, answer } = await relink(request, process.env, fetch, new Date());
  // The kind and a refusal's reason only: never the address, which opens her bank's sign-in.
  console.log(
    `plaid relink: ${answer.kind}${answer.kind === 'refused' || answer.kind === 'failed' ? `, ${answer.reason}` : ''}`,
  );
  return Response.json(answer, { status, headers: { 'Cache-Control': 'no-store' } });
}
