# Spotify browser player setup

A configured `spotify` device represents one Spotify account. Each Home Automation browser session can register as a Spotify Connect playback target for that account; press **Make Active** on a tablet to play through that tablet's browser. Tablets do not need the Spotify app or a Spotify login. Account authorization is done once on the server with the `spotify-auth` command; there is no link step in the web UI.

## Status: incomplete / under adjustment

The browser player works but is not finished. Known gaps and rough edges:

- Playback commands auto-transfer to the sending browser (or the only registered browser). A browser whose audio is autoplay-locked, or a recently-closed tab still in the player list, can end up as the silent transfer target.
- A page can register more than one SDK player for the same device when both the card view and the picker overlay mount (last registration wins).
- Registrations are in-memory and rebuilt via heartbeat after a server restart; there is a window where the player list is empty or stale.
- Volume is reported by the active SDK player; `s.volume` may read 0 until the first state report.
- No re-link or status affordance in the UI beyond the muted status line.
- Live playback on Android tablets over LAN HTTPS has not been verified end-to-end.

Treat remaining polish as follow-up work; the spec delta in `openspec/changes/configure-spotify-auth-server-side` tracks these as incomplete tasks.

## Requirements

- A Spotify Premium account. The Web Playback SDK requires Premium.
- Outbound HTTPS access to Spotify from the server and each tablet. Spotify streams audio directly to the browser; the Home Automation server does not proxy audio.
- A stable LAN hostname or reserved IP address, and a trusted HTTPS certificate for that exact name/address.
- A Spotify Developer app. Its client ID and client secret stay on the server.

The Home Automation server does not need to accept inbound connections from the public internet.

## 1. Configure the LAN HTTPS certificate

The app supports HTTPS with `TLS_CERT` and `TLS_KEY`, needed so the tablet page is a trusted secure context for the Web Playback SDK.

Reserve the server's LAN IP in your router or use a stable local hostname. If using Ubuntu, install mkcert and its NSS helper:

```bash
sudo apt install mkcert libnss3-tools
mkcert -install
```

`mkcert -install` creates and trusts a local certificate authority on this computer. It does not create the server certificate, and it does not install trust on the tablets.

Generate a server certificate for the exact host or IP the tablets will use. Replace the `LAN_HOST` value before running these commands:

```bash
LAN_HOST="replace-with-your-stable-lan-host-or-ip"
CERT_DIR="$HOME/.config/homeautomation/certs"
mkdir -p "$CERT_DIR"
mkcert \
  -cert-file "$CERT_DIR/homeautomation.pem" \
  -key-file "$CERT_DIR/homeautomation-key.pem" \
  "$LAN_HOST"
```

Use the generated `homeautomation.pem` and `homeautomation-key.pem` as the server certificate and key. **Do not use `rootCA.pem` or `rootCA-key.pem` as `TLS_CERT`/`TLS_KEY`. Never share `rootCA-key.pem`; it can sign certificates for any host.**

Install only the public `rootCA.pem` on each Android tablet so its browser trusts the mkcert certificate. Find it with:

```bash
mkcert -CAROOT
```

Copy `rootCA.pem` from that directory to each tablet and install it as a CA certificate in Android's security settings (the menu wording varies by Android version). Do not copy `rootCA-key.pem` to tablets.

## 2. Create the Spotify Developer app

Create an app in the Spotify Developer dashboard and copy its **Client ID** and **Client Secret**. Register the loopback redirect URI used by the authorization CLI (the CLI prints the exact URI to register):

```text
http://127.0.0.1:8787/callback
```

Spotify allows plain HTTP on loopback redirect addresses, so this does not need the LAN certificate. `8787` is the default `SPOTIFY_AUTH_PORT`; if you change the port, register the matching URI. The same redirect URI can be shared by every Spotify Developer app used here — each configured device runs the CLI separately with its own app's credentials.

## 3. Configure each Spotify device

Add or edit a device in `src/server/config/devices/<device-id>.json` (or the directory selected by `CONFIG_DIR`):

```json
{
  "id": "spotify",
  "service": "spotify",
  "deviceName": "Home Spotify",
  "clientId": "your-app-client-id",
  "clientSecret": "your-app-client-secret",
  "description": "Spotify account for the home",
  "access": { "read": ["*"], "write": ["*"] }
}
```

Each configured device has one Spotify account. `clientId` and `clientSecret` are required; `deviceName` is optional. Do not add `source`, `sourceType`, `apiKey`, `apiKeyIssued`, or `daemonBin`—those were used by the removed Soloist integration. Keep the config file private; config files created through the Admin dashboard are written with owner-only permissions. After creating or manually editing the config, restrict it with `chmod 600 src/server/config/devices/<device-id>.json`.

## 4. Authorize the account on the server

Run the authorization CLI once per configured Spotify device:

```bash
npm --prefix src/server run spotify-auth -- <device-id>
```

The command prints the loopback redirect URI to register (step 2) and a Spotify consent URL. Open that URL in any browser and approve the request.

- If the browser runs on the server itself, the redirect reaches the CLI's temporary listener automatically.
- On a headless server, the redirect lands on `http://127.0.0.1:8787/callback?...` on the browser's own machine and the page fails to load — that is expected. Copy the full URL from the browser's address bar and paste it into the CLI prompt.

The CLI exchanges the authorization code and writes `refreshToken` into the device config file; the token is never printed. Re-run the command any time Spotify revokes access. Restart the server after authorizing so it picks up the new token. `CONFIG_DIR` is honored the same way as the server, and `SPOTIFY_AUTH_PORT` changes the listener port.

## 5. Start the HTTPS app

From the repository root, set the generated certificate paths, then build and start the app:

```bash
export TLS_CERT="$HOME/.config/homeautomation/certs/homeautomation.pem"
export TLS_KEY="$HOME/.config/homeautomation/certs/homeautomation-key.pem"

npm run build
npm run start
```

The server requires `TLS_CERT` and `TLS_KEY` together. Open `https://<LAN_HOST>:3001`; a Spotify device shows as authorized when its config carries a valid `refreshToken`. Tablets only receive short-lived playback tokens from the server and do not log into Spotify.

On each tablet, open the same HTTPS Home Automation address. Its browser player will register as a target. Tap **Make Active** on the tablet that should play audio. Multiple tablets can be available for one account, but a Spotify account plays to one target at a time.

## Development mode

`npm run dev` runs Vite at `http://localhost:5173` and the API server at `http://localhost:3001`; Vite proxies `/api` to that server. This is suitable for ordinary development on the computer. A phone visiting the LAN IP over HTTP is not a trusted browser context for Spotify playback/OAuth. For tablet playback testing, use the HTTPS `npm run start` setup above.

For ordinary dev work, do not export `TLS_CERT` or `TLS_KEY`. If you do run `npm run dev` with `TLS_CERT`/`TLS_KEY` set, the dev API server starts in HTTPS mode and Vite automatically proxies `/api` to `https://localhost:3001` with certificate verification relaxed. `API_PROXY_TARGET` overrides the proxy destination entirely.

## Troubleshooting

- **`ConfigError: ... apiKey ... no longer supported`**: remove old Soloist fields (`apiKey`, `apiKeyIssued`, `daemonBin`, and any Spotify `source`/`sourceType`) from each Spotify device config. Keep `clientId` and `clientSecret`.
- **Vite reports `http proxy error: ECONNREFUSED 127.0.0.1:3001`**: the API server is not listening. Check the earlier `[server]` output; in the supplied `npm run dev` log, the server was crashing while the obsolete Soloist config fields were present. Once the config is valid, the server starts and Vite's proxy errors stop.
- **Vite reports `http proxy error: socket hang up`**: the API server is running in HTTPS mode (look for `server listening on https://`) but Vite proxied plain HTTP. Either restart `npm run dev` without `TLS_CERT`/`TLS_KEY`, or keep them — the dev proxy now detects `TLS_CERT` and proxies to `https://localhost:3001` automatically.
- **`ENOENT` for `homeautomation.pem`**: `mkcert -install` only installed the local CA. Generate the leaf certificate in step 1, then point `TLS_CERT` and `TLS_KEY` at the generated `homeautomation.pem` and `homeautomation-key.pem` files.
- **Certificate authority or name mismatch warning on a tablet**: install `rootCA.pem` on that tablet and make sure the URL host/IP exactly matches the name used when generating the leaf certificate.
- **Spotify shows "redirect URI mismatch"**: the Developer app's registered redirect URI must exactly match the URI printed by `spotify-auth` (default `http://127.0.0.1:8787/callback`), including the port.
- **Card says "Spotify account not authorized"**: the device config has no valid `refreshToken`. Run `npm --prefix src/server run spotify-auth -- <device-id>` and restart the server.
- **"state mismatch" from spotify-auth**: the redirect URL does not belong to the in-flight authorization; run the flow again and use the newest consent URL.
- **Player unavailable in the browser**: confirm the page is HTTPS, the account is authorized, the account has Premium, and the tablet can reach Spotify over HTTPS.
