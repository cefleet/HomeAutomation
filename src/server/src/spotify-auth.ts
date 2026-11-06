import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { updateDeviceConfigFile } from './configLoader.js';
import { TOKEN_SCOPES } from './services/spotify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const configDir = process.env.CONFIG_DIR ?? path.resolve(here, '..', 'config');
const port = Number(process.env.SPOTIFY_AUTH_PORT ?? 8787);
const redirectUri = `http://127.0.0.1:${port}/callback`;
const deviceId = process.argv[2];

const fail = (message: string): never => {
  console.error(`spotify-auth: ${message}`);
  process.exit(1);
};

if (!deviceId) fail('usage: npm run spotify-auth -- <device-id>');

const devicesDir = path.join(configDir, 'devices');
const device =
  fs
    .readdirSync(devicesDir)
    .filter((file) => file.endsWith('.json'))
    .map(
      (file) =>
        JSON.parse(fs.readFileSync(path.join(devicesDir, file), 'utf8')) as Record<string, unknown>,
    )
    .find((entry) => entry.id === deviceId) ??
  fail(`no device config in ${devicesDir} declares id "${deviceId}"`);

if (device.service !== 'spotify') fail(`device "${deviceId}" is not a spotify device`);
const clientId = typeof device.clientId === 'string' ? device.clientId : '';
const clientSecret = typeof device.clientSecret === 'string' ? device.clientSecret : '';
if (!clientId || !clientSecret)
  fail(`device "${deviceId}" needs "clientId" and "clientSecret" in its config`);

const state = randomBytes(16).toString('hex');
const authorizeUrl = new URL('https://accounts.spotify.com/authorize');
authorizeUrl.search = new URLSearchParams({
  client_id: clientId,
  response_type: 'code',
  redirect_uri: redirectUri,
  scope: TOKEN_SCOPES,
  state,
  show_dialog: 'true',
}).toString();

const codeFromUrl = (raw: string): string | null => {
  try {
    const url = new URL(raw.trim());
    if (url.searchParams.get('state') !== state) fail('redirect state mismatch — run the flow again');
    if (url.searchParams.get('error')) fail(`Spotify denied the request: ${url.searchParams.get('error')}`);
    return url.searchParams.get('code');
  } catch (error) {
    if (error instanceof Error && error.message.includes('state')) throw error;
    fail('that does not look like a redirect URL — paste the full address bar contents');
  }
  return null;
};

const code = await new Promise<string>((resolve, reject) => {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith('/callback')) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const found = codeFromUrl(`${redirectUri.split('/callback')[0]}${req.url}`);
      res.setHeader('content-type', 'text/html');
      res.end(
        found
          ? '<p>Spotify authorization received. Return to the Home Automation terminal.</p>'
          : '<p>Authorization did not complete; check the terminal.</p>',
      );
      if (found) {
        resolve(found);
        rl.close();
        server.close();
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');

    console.log(`\nRegister this redirect URI in the Spotify Developer app for this device:\n  ${redirectUri}\n`);
    console.log(`Open this URL in a browser and approve the request:\n  ${authorizeUrl}\n`);
    rl.question(
      'If the browser cannot reach this server, paste the full redirect URL here: ',
      (answer) => {
        const found = codeFromUrl(answer);
        if (found) resolve(found);
        else reject(new Error('no authorization code in that URL'));
        rl.close();
        server.close();
      },
    );
    rl.on('close', () => {
      server.close();
      reject(new Error('input closed before authorization completed'));
    });
  }).catch((error: unknown) =>
    fail(error instanceof Error ? error.message : String(error)),
  );

const response = await fetch('https://accounts.spotify.com/api/token', {
  method: 'POST',
  headers: {
    authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    'content-type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  }),
});
if (!response.ok) fail(`Spotify token exchange failed (${response.status})`);
const data = (await response.json()) as Record<string, unknown>;
const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : '';
if (!refreshToken) fail('Spotify did not return a refresh token');

const file = updateDeviceConfigFile(configDir, deviceId, { refreshToken });
console.log(`Authorized "${deviceId}". Refresh token written to ${file}.`);
console.log('Restart the server so it picks up the new token.');
