# Device config reference

One JSON file per device in `src/server/config/devices/` by default (or the
directory selected by `CONFIG_DIR`) — the filename is just a name; the
`id` field is what dashboards and API URLs use. A `master` dashboard config
must exist, but device ids only need to be globally unique.

## Common shape

```json
{
  "id": "kitchen-light",
  "service": "light",
  "source": "http://192.168.1.40/light/kitchen",
  "sourceType": "esphome",
  "description": "Kitchen overhead light",
  "access": { "read": ["*"], "write": ["admin"] }
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique id — used in `/api/{service}/{id}` and view `device.id` |
| `service` | yes | Registered service type (table below) |
| `description` | yes | Human label |
| `source` | per service | Endpoint of the physical/logical source |
| `sourceType` | with `source` | How to interpret `source` (currently `esphome`) |
| `access.read` | yes | Roles allowed to view (`["*"]` = everyone) |
| `access.write` | yes | Roles allowed to control (roles come from `clients.json`) |

## Service types

| `service` | `source` | Extra fields | Notes |
|---|---|---|---|
| `light` | optional `esphome` URL | — | Missing source → virtual/dummy light |
| `thermostat` | optional `esphome` URL | — | ESPHome climate entity |
| `heater` | optional `esphome` URL | `maxTempC` | Heat-only climate; `maxTempC` caps setpoint |
| `zoned` | optional `esphome` URL | `zoneGroup` (req), `zoneRole` `master`\|`member` | Multi-head HVAC; every `zoneGroup` needs exactly one `master` |
| `weather` | none | — | Virtual weather (Open-Meteo etc. per view params) |
| `weather-gov` | none | — | NWS forecast |
| `spotify` | none | `deviceName`, `clientId`, `clientSecret`, `refreshToken` | One Spotify account; browser playback via Web Playback SDK. `refreshToken` is written by `npm --prefix src/server run spotify-auth -- <id>` and rotated by the service — do not hand-edit while running. See [Spotify browser player setup](SPOTIFY-SETUP.md). |
| `messenger` | none | — | Dashboard messaging |
| `intercom` | none | — | Dashboard audio intercom |

## Rules enforced at load

- `source` allowed/required per service's `sourceMode`
  (`optional`/`required`/`none` — table above).
- `sourceType` requires `source`.
- `zoned`: `zoneRole` requires `zoneGroup`; each group needs one
  `master` and any `source` must match the master's.
- `spotify`: `source` is not allowed; `clientId` and `clientSecret` are
  required. The account is authorized once on the server via the
  `spotify-auth` CLI, which writes `refreshToken` into the config file.
  Soloist fields (`apiKey`, `apiKeyIssued`, `daemonBin`) are no longer
  supported.
- Duplicate `id` across all files → config error.
