# Spotify player setup (Soloist + Web API search)

Everything below is one-time per machine/account, plus two recurring
renewals the app warns you about.

## What you're setting up

Each `spotify` device = one **Spotify Soloist** daemon — a headless
Spotify Connect client that actually plays the audio on this machine.
The server spawns, supervises, updates, and kills it automatically.
The card/picker talks to it over a local WebSocket; catalog *search*
additionally uses the Spotify Web API (metadata only).

## One-time setup

### 1. Get a Soloist API key (required — plays the music)

- Needs a **Spotify Premium** account.
- Go to **developer.spotify.com** → log in → **Spotify Soloist** →
  *API Key* → generate a key (`spak_...`). It's per-user; don't share it.
- **Write down today's date** — it goes in `apiKeyIssued` (keys live
  ~180 days; the app warns you ~2 weeks before expiry).

### 2. Create a Spotify app (optional — only for the search box)

The picker's search box uses the Web API client-credentials grant.

- developer.spotify.com → **Create app**. Name it anything.
- **Redirect URI**: the form requires one but we never use it — any
  valid URI works, e.g. `http://127.0.0.1/callback`.
- Copy the **Client ID** and **Client Secret** from the app settings.

### 3. Write the device config — `config/devices/spotify.json`

```json
{
  "id": "spotify",
  "service": "spotify",
  "apiKey": "spak_xxxxxxxxxxxxxxxx",
  "apiKeyIssued": "2026-10-27",
  "deviceName": "Fleetwood",
  "clientId": "your-app-client-id",
  "clientSecret": "your-app-client-secret",
  "description": "Spotify player — managed Soloist daemon",
  "access": { "read": ["*"], "write": ["*"] }
}
```

| Field | Required | What it does |
|---|---|---|
| `apiKey` | Yes (no `source`) | Soloist API key from step 1 |
| `apiKeyIssued` | Recommended | `YYYY-MM-DD` the key was generated → expiry warning |
| `deviceName` | No | Name shown in the Spotify app device picker (defaults to `id`) |
| `clientId` / `clientSecret` | Optional | Enable `/search` in the picker; both or neither |
| `daemonBin` | No | Path to your own soloist binary — skips auto-download/updates (expiry warnings still apply) |
| `source` + `sourceType: "soloist"` | No | Attach to an external daemon (`ws://host:port`) instead of managed mode |

### 4. Pair it (once)

Start the server, open the Spotify app on the **same network**, tap
*Connect to a device* → select your `deviceName`. Login persists in
`~/.local/share/soloist` — you only re-pair if you revoke the account.

## Lifecycle (automatic, with warnings)

| Thing | Lifetime | What happens |
|---|---|---|
| soloist binary | ~90 days | App auto-downloads the new release into `data/soloist/` and respawns — nothing to do unless `daemonBin` is set |
| `apiKey` | ~180 days | Dashboard issue notification ~14 days early → regenerate at developer.spotify.com, update `apiKey` + `apiKeyIssued` |
| `clientId`/`clientSecret` | no expiry | N/A |

## Multiple players

One daemon = one stream. For simultaneous music in two rooms, add
another config (`spotify-office.json`) with a different `id` and
`deviceName` — same `apiKey` is fine. Bind each dashboard's
`media-player-card` to the room's device id.

## Troubleshooting

- **"not paired"** on the card → step 4 (also check `loggedIn` in
  `GET /api/spotify/spotify/state`).
- **"cannot run ... ENOENT"** → `daemonBin` points nowhere, or the managed
  download failed (`soloist download failed` notification).
- **Daemon logs** stream into the server console as `[soloist:<id>]`.
- **"client expires in N days"** → binary aging; under 14 days the app
  handles it automatically.
