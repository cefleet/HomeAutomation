# Device config reference

One JSON file per device in `config/devices/` — the filename is just a
name; the `id` field is what dashboards and API URLs use. A `master`
dashboard config must exist, but device ids only need to be globally
unique.

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
| `sourceType` | with `source` | How to interpret `source` (`esphome`, `soloist`) |
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
| `spotify` | optional `soloist` ws URL | `apiKey`, `apiKeyIssued`, `deviceName`, `daemonBin`, `clientId`, `clientSecret` | No `source` → managed daemon (see SPOTIFY-SETUP.md) |
| `messenger` | none | — | Dashboard messaging |
| `intercom` | none | — | Dashboard audio intercom |

## Rules enforced at load

- `source` allowed/required per service's `sourceMode`
  (`optional`/`required`/`none` — table above).
- `sourceType` requires `source`.
- `zoned`: `zoneRole` requires `zoneGroup`; each group needs one
  `master` and any `source` must match the master's.
- `spotify`: `apiKey` required when no `source`; `clientId` and
  `clientSecret` must be set together.
- Duplicate `id` across all files → config error.
