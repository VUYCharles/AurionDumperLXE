/**
 * oauth-setup.js
 *
 * Obtains a Google OAuth2 refresh token for use with aurion-gcal.
 *
 * This script must be run on a machine with a web browser because
 * the authorisation flow requires user interaction. It is not
 * intended to run on the production LXC container.
 *
 * Prerequisites:
 *   1. Create a project at https://console.cloud.google.com
 *   2. Enable the Google Calendar API
 *   3. Create an OAuth2 client ID (type: Web application)
 *   4. Add http://localhost:3000/oauth2callback as an authorised
 *      redirect URI
 *   5. Add your Google account email as a test user under
 *      "OAuth consent screen"
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=xxx node scripts/oauth-setup.js
 *
 * The script starts a local HTTP server on port 3000, opens the
 * Google authorisation URL, and prints the refresh token to the
 * terminal once the flow completes.
 */

'use strict';

const { google } = require('googleapis');
const http       = require('http');
const url        = require('url');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI  = 'http://localhost:3000/oauth2callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    'Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.\n' +
    'Usage: GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=xxx node scripts/oauth-setup.js'
  );
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope:       ['https://www.googleapis.com/auth/calendar'],
  prompt:      'consent', // forces refresh_token to be returned
});

console.log('');
console.log('Open the following URL in your browser:');
console.log('');
console.log(authUrl);
console.log('');
console.log('Waiting for the authorisation callback on port 3000...');

const server = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url, true);

    if (parsed.pathname !== '/oauth2callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const code = parsed.query.code;
    if (!code) {
      res.writeHead(400);
      res.end('Missing authorisation code');
      return;
    }

    const { tokens } = await oauth2Client.getToken(code);

    console.log('');
    console.log('Authorisation successful. Add the following block to config.js:');
    console.log('');
    console.log('const oauth2Credentials = {');
    console.log(`  clientId:     '${CLIENT_ID}',`);
    console.log(`  clientSecret: '${CLIENT_SECRET}',`);
    console.log(`  redirectUri:  '${REDIRECT_URI}',`);
    console.log(`  refreshToken: '${tokens.refresh_token}',`);
    console.log('};');
    console.log('');

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<html><body>' +
      '<h2>Authorisation successful</h2>' +
      '<p>You can close this tab and return to the terminal.</p>' +
      '</body></html>'
    );

    server.close();

  } catch (err) {
    console.error('Error exchanging code:', err.message);
    res.writeHead(500);
    res.end('Internal server error');
  }
});

server.listen(3000);
