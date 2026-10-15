/*
 * Mint the Chrome Web Store refresh token the release workflow uses
 * (docs/releasing.md). Run it on your machine, signed in to the developer
 * account in your browser:
 *
 *   CLIENT_ID=… CLIENT_SECRET=… node scripts/cws-token.mjs
 *
 * It listens on http://localhost:8080 (add that as a redirect URI on the
 * OAuth client), prints the consent URL to open, catches the code Google
 * sends back, exchanges it, and prints the refresh token once. Nothing is
 * written anywhere: put the token in the CWS_REFRESH_TOKEN secret and close
 * the terminal.
 */
import { createServer } from 'node:http';

const clientId = process.env['CLIENT_ID'];
const clientSecret = process.env['CLIENT_SECRET'];
if (!clientId || !clientSecret) {
  console.error('Set CLIENT_ID and CLIENT_SECRET (the OAuth client, type Desktop app, with http://localhost:8080 as a redirect URI).');
  process.exit(1);
}
const redirect = 'http://localhost:8080';
const scope = 'https://www.googleapis.com/auth/chromewebstore';

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', redirect);
  const code = url.searchParams.get('code');
  if (!code) { res.writeHead(404); res.end('No code here.'); return; }
  const answer = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirect }),
  });
  const token = await answer.json();
  if (!token.refresh_token) {
    res.end('Google answered without a refresh token; see the terminal.');
    console.error('No refresh token in the answer:', JSON.stringify(token));
    server.close();
    process.exit(1);
  }
  res.end('Done. Back to the terminal; you can close this tab.');
  console.log('\nCWS_REFRESH_TOKEN (shown once; set it as the secret, then clear this terminal):\n');
  console.log(token.refresh_token);
  console.log();
  server.close();
});

server.listen(8080, '127.0.0.1', () => {
  const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  consent.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope, access_type: 'offline', prompt: 'consent' }).toString();
  console.log('Open this in the browser where the developer account is signed in, and approve:\n');
  console.log(consent.href);
  console.log('\nWaiting for Google to send the code back to http://localhost:8080 …');
});
