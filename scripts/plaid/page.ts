/**
 * The one page `pnpm plaid:link` serves on 127.0.0.1: Plaid Link, which hands its public
 * token back to the script. The link token is single-use and expires in hours, and it is
 * placed as JSON, so nothing in it can close the script element.
 */
export function linkPage(linkToken: string): string {
  const token = JSON.stringify(linkToken).replace(/</g, '\\u003c');
  return `<!doctype html>
<meta charset="utf-8">
<title>Dinora — link through Plaid</title>
<p id="status">Opening Plaid Link…</p>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
  const status = document.getElementById('status');
  const post = (path, body) =>
    fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  Plaid.create({
    token: ${token},
    onSuccess: (public_token) =>
      post('/done', { public_token }).then(() => (status.textContent = 'Linked. You can close this tab.')),
    onExit: (error, metadata) =>
      post('/exit', {
        code: error ? error.error_type + '/' + error.error_code : null,
        status: (metadata && metadata.status) || null,
        session: (metadata && metadata.link_session_id) || null,
      }).then(() => (status.textContent = 'Closed without linking.')),
  }).open();
</script>
`;
}
