# Dashboard config reference

One JSON file per dashboard in `config/dashboards/`. The `id` must
match the filename. A `master` dashboard is required. Clients are
routed to a dashboard by `config/clients.json` (ip/mac → dashboard +
role).

## Top-level shape

```json
{
  "id": "kitchen",
  "title": "Kitchen",
  "admin": false,
  "layout": { "type": "grid", "columns": 3 },
  "disabled": ["intercom"],
  "views": [ ... ],
  "overlays": [ ... ],
  "theme": { ... }
}
```

| Field | Meaning |
|---|---|
| `id` | Matches filename; `master` must exist |
| `title` | Display title |
| `admin` | `true` → auto-generated grid of every device (diagnostic view; ignores `views`) |
| `layout` | `{type:"grid", columns?}` — grid columns (default if omitted) |
| `disabled` | Opt out of auto features: `messages`, `intercom`, `notifications` |
| `views` | Ordered tiles (below) |
| `overlays` | Modal overlays opened via `onTap` or notifications |
| `theme` | `colorScheme`, `colors` (background/surface/text/muted/accent/border), `background.image` (file in `dashboards/assets/`) |

## Views

```json
{
  "component": "media-player-card",
  "device": { "type": "spotify", "id": "spotify" },
  "dataType": "media-player",
  "params": { "grid": "TAE,31,83" },
  "props": { "units": "F", "pollMs": 30000 },
  "onTap": { "overlay": "player-picker" }
}
```

| Field | Meaning |
|---|---|
| `component` | Registered component name (see below); `hr` = separator row, no device |
| `device` | `{type, id}` — `type` is the device's `service`, `id` its `id`. Required for all but `hr` |
| `dataType` | Optional contract check — loader errors if it mismatches the service's data type |
| `params` | Query params the component appends to its API calls (string/number) |
| `props` | Render props handed to the component (e.g. `units`, `color`, `pollMs`) |
| `onTap.overlay` | Opens the overlay with that `id` when the tile is tapped |

## Overlays

```json
"overlays": [{
  "id": "player-picker",
  "title": "Spotify",
  "views": [
    { "component": "media-player-card", "device": { "type": "spotify", "id": "spotify" } },
    { "component": "media-picker",      "device": { "type": "spotify", "id": "spotify" } }
  ]
}]
```

Views inside overlays render normally (minus tap interactions).

## Components

| `component` | Contract | Notes |
|---|---|---|
| `light-card` | `light` | `props: color, shape` |
| `thermostat-card` | `thermostat` | `props: units` |
| `zoned-thermostat-card` | `zoned-thermostat` | `props: units` |
| `heater-card` | `heater` | `props: units` |
| `weather-card` | `weather` | `params: grid` (weather-gov), `props: units, pollMs` |
| `weather-chip` | `weather` | compact; good with `onTap` → detail overlay |
| `media-player-card` | `media-player` | player controls; `onTap` → picker overlay |
| `media-picker` | `media-player` | search + queue; designed for overlays |
| `hr` | — | visual separator, no `device` |

Unmatched `dataType` on the admin dashboard falls back to a JSON dump
card.

## clients.json

```json
[
  { "ip": "192.168.1.50", "dashboard": "kitchen", "role": "viewer" },
  { "ip": "192.168.1.10", "dashboard": "master",  "role": "admin" }
]
```

`ip` and/or `mac` match the client; `dashboard` routes it; `role` is
what `access.read`/`access.write` in device configs match against
(`"*"` = all roles). In dev, the login page picks a dashboard + role
directly.
