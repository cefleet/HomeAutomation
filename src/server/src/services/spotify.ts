import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { updateDeviceConfigFile } from '../configLoader.js';
import type { Service } from '../registry.js';

const VALID_REPEAT = new Set(['off', 'context', 'track']);
const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';
/** Spotify user scopes required for Web Playback SDK playback/control;
 *  shared with the spotify-auth CLI. */
export const TOKEN_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');
const PLAYER_STALE_MS = 120_000;
const PLAYER_SWEEP_MS = 30_000;

export interface BrowserPlayer {
  id: string;
  name: string;
  isActive: boolean;
}

export interface MediaPlayerState {
  id: string;
  connected: boolean;
  loggedIn: boolean;
  isActive: boolean;
  deviceName: string;
  players: BrowserPlayer[];
  activePlayerId: string | null;
  playing: boolean;
  track: string;
  artist: string;
  album: string;
  contextName: string;
  albumArtUrl: string;
  volume: number;
  progressMs: number;
  speed: number;
  durationMs: number;
  shuffle?: boolean;
  repeat?: 'off' | 'context' | 'track';
  updatedAt: string;
}

type RecordValue = Record<string, unknown>;
type TokenCache = { accessToken: string; expiresAt: number };
type PlayerSession = {
  id: string;
  deviceId: string;
  name: string;
  lastSeen: number;
};

const isRecord = (v: unknown): v is RecordValue =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const repeatFromSdk = (v: unknown): MediaPlayerState['repeat'] =>
  v === 1 ? 'context' : v === 2 ? 'track' : 'off';

const itemFields = (item: unknown) => {
  const track = isRecord(item) ? item : {};
  const album = isRecord(track.album) ? track.album : {};
  const artists = Array.isArray(track.artists) ? track.artists : [];
  const images = Array.isArray(track.images)
    ? track.images
    : Array.isArray(album.images)
      ? album.images
      : [];
  return {
    track: str(track.name) ?? '',
    artist: artists
      .map((artist) => (isRecord(artist) ? str(artist.name) : undefined))
      .filter((name): name is string => !!name)
      .join(', '),
    album: str(album.name) ?? '',
    albumArtUrl: images
      .map((image) => (isRecord(image) ? str(image.url) : undefined))
      .find((url): url is string => !!url) ?? '',
    durationMs: num(track.duration_ms) ?? 0,
  };
};

const mapEntry = (item: unknown) => {
  const track = isRecord(item) ? item : {};
  const fields = itemFields(track);
  return {
    uri: str(track.uri) ?? '',
    name: fields.track,
    artist: fields.artist,
    artUrl: fields.albumArtUrl,
    source: str(track.type) ?? '',
  };
};

const responseError = async (
  res: Response,
  state: MediaPlayerState,
  onUnauthorized?: () => void,
) => {
  if (res.status === 401) {
    state.loggedIn = false;
    onUnauthorized?.();
    return { status: 401, error: 'Spotify authorization expired; re-run spotify-auth to authorize the account' };
  }
  if (res.status === 429) return { status: 429, error: 'Spotify rate limit reached' };
  return { status: 502, error: `Spotify request failed (${res.status})` };
};

export function createSpotifyService(fetchImpl: typeof fetch = fetch): Service {
  return {
    type: 'spotify',
    transport: 'push',
    dataType: 'media-player',
    sourceMode: 'none',
    validateDevices(devices) {
      const errors: string[] = [];
      for (const d of devices) {
        if (d.service !== 'spotify') continue;
        const raw = d as DeviceConfigWithLegacyFields;
        for (const field of ['apiKey', 'apiKeyIssued', 'daemonBin'] as const) {
          if (raw[field] !== undefined)
            errors.push(`device "${d.id}": "${field}" is no longer supported by spotify`);
        }
        if (d.source !== undefined)
          errors.push(`device "${d.id}": spotify does not accept "source"`);
        if (!d.clientId || !d.clientSecret)
          errors.push(`device "${d.id}": spotify requires "clientId" and "clientSecret"`);
      }
      return errors;
    },
    createRoutes(ctx) {
      const r = Router();
      const device = ctx.device;
      let refreshToken: string | null = device.refreshToken ?? null;
      let tokenCache: TokenCache | null = null;
      let tokenRequest: Promise<TokenCache> | null = null;
      let searchToken: TokenCache | null = null;
      const players = new Map<string, PlayerSession>();
      const state: MediaPlayerState = {
        id: device.id,
        connected: false,
        loggedIn: false,
        isActive: false,
        deviceName: device.deviceName ?? device.id,
        players: [],
        activePlayerId: null,
        playing: false,
        track: '',
        artist: '',
        album: '',
        contextName: '',
        albumArtUrl: '',
        volume: 0,
        progressMs: 0,
        speed: 0,
        durationMs: 0,
        updatedAt: new Date().toISOString(),
      };
      state.loggedIn = refreshToken !== null;

      const current = (): MediaPlayerState => {
        const registered = [...players.values()].map((player) => ({
          id: player.id,
          name: player.name,
          isActive: player.deviceId === activeSpotifyDeviceId,
        }));
        const active = [...players.values()].find(
          (player) => player.deviceId === activeSpotifyDeviceId,
        );
        return {
          ...state,
          connected: registered.length > 0,
          players: registered,
          activePlayerId: active?.id ?? null,
          isActive: !!active,
        };
      };
      let activeSpotifyDeviceId: string | null = null;
      const touch = () => {
        state.updatedAt = new Date().toISOString();
        ctx.push(current());
      };
      const persistRefreshToken = (value: string) => {
        try {
          updateDeviceConfigFile(ctx.configDir, device.id, { refreshToken: value });
        } catch (error) {
          console.error(`[spotify:${device.id}] could not persist the rotated refresh token`, error);
          ctx.notify({
            type: 'issue',
            title: `Spotify (${device.id})`,
            body: 'Could not write the rotated Spotify refresh token to the device config; re-run spotify-auth if authorization is lost on restart.',
          });
        }
        refreshToken = value;
        state.loggedIn = true;
      };
      const basicAuth = () =>
        `Basic ${Buffer.from(`${device.clientId}:${device.clientSecret}`).toString('base64')}`;
      const getAccessToken = async (): Promise<TokenCache> => {
        if (tokenCache && Date.now() < tokenCache.expiresAt - 30_000) return tokenCache;
        if (tokenRequest) return tokenRequest;
        if (!refreshToken) throw new Error('Spotify account is not authorized; run spotify-auth');
        tokenRequest = (async () => {
          const response = await fetchImpl(`${ACCOUNTS}/api/token`, {
            method: 'POST',
            headers: {
              authorization: basicAuth(),
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken! }),
          });
          if (!response.ok) {
            if (response.status === 400 || response.status === 401) {
              state.loggedIn = false;
              tokenCache = null;
              touch();
            }
            throw new Error(response.status === 400 || response.status === 401
              ? 'Spotify authorization expired; re-run spotify-auth to authorize the account'
              : `Spotify token refresh failed (${response.status})`);
          }
          const data = (await response.json()) as RecordValue;
          const accessToken = str(data.access_token);
          if (!accessToken) throw new Error('Spotify token response was invalid');
          const rotated = str(data.refresh_token);
          if (rotated) persistRefreshToken(rotated);
          state.loggedIn = true;
          tokenCache = {
            accessToken,
            expiresAt: Date.now() + ((num(data.expires_in) ?? 3600) * 1000),
          };
          return tokenCache;
        })();
        try {
          return await tokenRequest;
        } finally {
          tokenRequest = null;
        }
      };
      const spotifyRequest = async (
        endpoint: string,
        method = 'GET',
        body?: unknown,
      ): Promise<Response> => {
        const token = await getAccessToken();
        return fetchImpl(`${API}${endpoint}`, {
          method,
          headers: {
            authorization: `Bearer ${token.accessToken}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      };
      const applyPlayback = (raw: unknown) => {
        const playback = isRecord(raw) ? raw : {};
        const deviceInfo = isRecord(playback.device) ? playback.device : {};
        const deviceId = str(deviceInfo.id) ?? null;
        activeSpotifyDeviceId = deviceId;
        const activePlayer = [...players.values()].find((player) => player.deviceId === deviceId);
        state.playing = playback.is_playing === true;
        state.speed = state.playing ? 1 : 0;
        state.progressMs = num(playback.progress_ms) ?? 0;
        state.volume = num(deviceInfo.volume_percent) ?? state.volume;
        state.shuffle = typeof playback.shuffle_state === 'boolean' ? playback.shuffle_state : state.shuffle;
        const repeat = str(playback.repeat_state);
        if (repeat && VALID_REPEAT.has(repeat)) state.repeat = repeat as MediaPlayerState['repeat'];
        const item = itemFields(playback.item);
        state.track = item.track;
        state.artist = item.artist;
        state.album = item.album;
        state.albumArtUrl = item.albumArtUrl;
        state.durationMs = item.durationMs;
        state.contextName = str(isRecord(playback.context) ? playback.context.type : undefined) ?? '';
        state.activePlayerId = activePlayer?.id ?? null;
      };
      const clearPlayback = () => {
        activeSpotifyDeviceId = null;
        state.activePlayerId = null;
        state.playing = false;
        state.speed = 0;
        state.progressMs = 0;
        state.track = '';
        state.artist = '';
        state.album = '';
        state.contextName = '';
        state.albumArtUrl = '';
        state.durationMs = 0;
      };
      const refreshPlayback = async () => {
        const response = await spotifyRequest('/me/player');
        if (response.status === 204) {
          clearPlayback();
          return;
        }
        if (!response.ok) throw await responseError(response, state, touch);
        applyPlayback(await response.json());
      };
      const sendError = (res: import('express').Response, error: unknown) => {
        const message = error instanceof Error ? error.message : 'Spotify request failed';
        const status = message.includes('not authorized') || message.includes('expired') ? 401
          : message.includes('(429)') ? 429
            : 502;
        res.status(status).json({ error: message });
      };
      const playerFor = (id: unknown) =>
        typeof id === 'string' ? players.get(id) : undefined;

      const sweeper = setInterval(() => {
        const now = Date.now();
        let changed = false;
        for (const [id, player] of players) {
          if (now - player.lastSeen <= PLAYER_STALE_MS) continue;
          players.delete(id);
          if (activeSpotifyDeviceId === player.deviceId) activeSpotifyDeviceId = null;
          changed = true;
        }
        if (changed) touch();
      }, PLAYER_SWEEP_MS);
      sweeper.unref();

      r.get('/token', async (_req, res) => {
        try {
          const token = await getAccessToken();
          res.set('Cache-Control', 'no-store').json({ accessToken: token.accessToken, expiresIn: Math.max(0, Math.floor((token.expiresAt - Date.now()) / 1000)) });
        } catch (error) {
          sendError(res, error);
        }
      });

      r.get('/state', async (_req, res) => {
        if (refreshToken) {
          try {
            await refreshPlayback();
            touch();
          } catch (error) {
            if (error instanceof Error && error.message.includes('expired')) state.loggedIn = false;
          }
        }
        res.json(current());
      });

      r.post('/players', async (req, res) => {
        const deviceId = str(req.body?.deviceId);
        const name = str(req.body?.name)?.trim();
        if (!deviceId || deviceId.length > 256 || !name || name.length > 80) {
          res.status(400).json({ error: 'deviceId and a player name are required' });
          return;
        }
        try {
          await getAccessToken();
        } catch (error) {
          sendError(res, error);
          return;
        }
        let player = [...players.values()].find((entry) => entry.deviceId === deviceId);
        if (!player) {
          player = {
            id: randomUUID(),
            deviceId,
            name,
            lastSeen: Date.now(),
          };
          players.set(player.id, player);
        } else {
          player.name = name;
          player.lastSeen = Date.now();
        }
        try {
          await refreshPlayback();
        } catch {}
        touch();
        res.json({ id: player.id });
      });

      r.post('/players/:playerId/heartbeat', (req, res) => {
        const player = playerFor(req.params.playerId);
        if (!player) {
          res.status(404).json({ error: 'browser player not registered' });
          return;
        }
        player.lastSeen = Date.now();
        res.status(204).end();
      });

      r.delete('/players/:playerId', (req, res) => {
        const player = playerFor(req.params.playerId);
        if (!player) {
          res.status(204).end();
          return;
        }
        players.delete(player.id);
        if (activeSpotifyDeviceId === player.deviceId) activeSpotifyDeviceId = null;
        touch();
        res.status(204).end();
      });

      r.post('/players/:playerId/state', (req, res) => {
        const player = playerFor(req.params.playerId);
        if (!player) {
          res.status(404).json({ error: 'browser player not registered' });
          return;
        }
        player.lastSeen = Date.now();
        if (player.deviceId === activeSpotifyDeviceId) {
          const data = isRecord(req.body) ? req.body : {};
          const track = isRecord(data.track) ? data.track : {};
          const artists = Array.isArray(track.artists) ? track.artists : [];
          const album = isRecord(track.album) ? track.album : {};
          const images = Array.isArray(album.images) ? album.images : [];
          state.playing = data.paused === false;
          state.speed = state.playing ? 1 : 0;
          state.progressMs = num(data.position) ?? 0;
          state.durationMs = num(data.duration) ?? 0;
          state.track = str(track.name) ?? '';
          state.artist = artists
            .map((artist) => (isRecord(artist) ? str(artist.name) : undefined))
            .filter((artist): artist is string => !!artist)
            .join(', ');
          state.album = str(album.name) ?? '';
          state.albumArtUrl = images
            .map((image) => (isRecord(image) ? str(image.url) : undefined))
            .find((url): url is string => !!url) ?? '';
          const context = isRecord(data.context) ? data.context : {};
          const metadata = isRecord(context.metadata) ? context.metadata : {};
          state.contextName = str(metadata.name) ?? str(metadata.title) ?? str(metadata.context_description) ?? '';
          if (typeof data.shuffle === 'boolean') state.shuffle = data.shuffle;
          state.repeat = repeatFromSdk(data.repeatMode);
          const volume = num(data.volume);
          if (volume !== undefined) state.volume = clamp(Math.round(volume * 100), 0, 100);
          touch();
        }
        res.status(204).end();
      });

      r.post('/players/:playerId/activate', async (req, res) => {
        const player = playerFor(req.params.playerId);
        if (!player) {
          res.status(404).json({ error: 'browser player not registered' });
          return;
        }
        try {
          const response = await spotifyRequest('/me/player', 'PUT', {
            device_ids: [player.deviceId],
            play: true,
          });
          if (!response.ok) {
            const error = await responseError(response, state, touch);
            res.status(error.status).json({ error: error.error });
            return;
          }
          activeSpotifyDeviceId = player.deviceId;
          player.lastSeen = Date.now();
          touch();
          res.json(current());
        } catch (error) {
          sendError(res, error);
        }
      });

      r.get('/queue', async (_req, res) => {
        try {
          const response = await spotifyRequest('/me/player/queue');
          if (response.status === 204) {
            res.json({ upcoming: [] });
            return;
          }
          if (!response.ok) {
            const error = await responseError(response, state, touch);
            res.status(error.status).json({ error: error.error });
            return;
          }
          const data = (await response.json()) as RecordValue;
          const upcoming = Array.isArray(data.queue) ? data.queue.map(mapEntry).filter((entry) => entry.uri) : [];
          res.json({ upcoming });
        } catch (error) {
          sendError(res, error);
        }
      });

      r.get('/search', async (req, res) => {
        const query = str(req.query.q)?.trim();
        if (!query) {
          res.status(400).json({ error: 'missing "q"' });
          return;
        }
        try {
          if (!searchToken || Date.now() >= searchToken.expiresAt - 30_000) {
            const response = await fetchImpl(`${ACCOUNTS}/api/token`, {
              method: 'POST',
              headers: {
                authorization: basicAuth(),
                'content-type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({ grant_type: 'client_credentials' }),
            });
            if (!response.ok) {
              res.status(response.status === 429 ? 429 : 502).json({ error: `Spotify search token failed (${response.status})` });
              return;
            }
            const data = (await response.json()) as RecordValue;
            const accessToken = str(data.access_token);
            if (!accessToken) {
              res.status(502).json({ error: 'Spotify search token response was invalid' });
              return;
            }
            searchToken = {
              accessToken,
              expiresAt: Date.now() + (num(data.expires_in) ?? 3600) * 1000,
            };
          }
          const response = await fetchImpl(
            `${API}/search?q=${encodeURIComponent(query)}&type=track,album,playlist&limit=8`,
            { headers: { authorization: `Bearer ${searchToken.accessToken}` } },
          );
          if (!response.ok) {
            res.status(response.status === 429 ? 429 : 502).json({ error: `Spotify search failed (${response.status})` });
            return;
          }
          const data = (await response.json()) as RecordValue;
          const items = (key: string) => {
            const list = isRecord(data[key]) ? data[key].items : undefined;
            return Array.isArray(list) ? list : [];
          };
          const artists = (item: unknown) => itemFields(item).artist;
          const image = (item: unknown) => itemFields(item).albumArtUrl;
          const results = [
            ...items('tracks').map((item) => ({
              uri: str(isRecord(item) ? item.uri : undefined) ?? '',
              type: 'track',
              name: str(isRecord(item) ? item.name : undefined) ?? '',
              sub: artists(item),
              artUrl: image(item),
            })),
            ...items('albums').map((item) => ({
              uri: str(isRecord(item) ? item.uri : undefined) ?? '',
              type: 'album',
              name: str(isRecord(item) ? item.name : undefined) ?? '',
              sub: artists(item),
              artUrl: image(item),
            })),
            ...items('playlists').map((item) => ({
              uri: str(isRecord(item) ? item.uri : undefined) ?? '',
              type: 'playlist',
              name: str(isRecord(item) ? item.name : undefined) ?? '',
              sub: `playlist by ${str(isRecord(item) && isRecord(item.owner) ? item.owner.display_name : undefined) ?? 'spotify'}`,
              artUrl: image(item),
            })),
          ].filter((item) => item.uri);
          res.json({ results });
        } catch {
          res.status(502).json({ error: 'Spotify search request failed' });
        }
      });

      r.post('/command', async (req, res) => {
        const { command, value } = req.body ?? {};
        const valid =
          (['play', 'pause', 'next', 'previous'].includes(command) && value === undefined) ||
          (command === 'volume' && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100) ||
          (command === 'seek' && typeof value === 'number' && Number.isFinite(value) && value >= 0) ||
          (command === 'shuffle' && typeof value === 'boolean') ||
          (command === 'repeat' && typeof value === 'string' && VALID_REPEAT.has(value)) ||
          (command === 'play-uri' && typeof value === 'string' && value.startsWith('spotify:')) ||
          (command === 'queue-add' && typeof value === 'string' && value.startsWith('spotify:track:'));
        if (!valid) {
          res.status(400).json({ error: 'invalid command' });
          return;
        }
        const requester = playerFor(req.body?.playerId);
        const solePlayer = players.size === 1 ? [...players.values()][0] : undefined;
        const target = requester ?? solePlayer;
        if (target && target.deviceId !== activeSpotifyDeviceId) {
          try {
            const transfer = await spotifyRequest('/me/player', 'PUT', {
              device_ids: [target.deviceId],
              play: command === 'play' || command === 'play-uri',
            });
            if (!transfer.ok) {
              const error = await responseError(transfer, state, touch);
              res.status(error.status).json({ error: error.error });
              return;
            }
            activeSpotifyDeviceId = target.deviceId;
            target.lastSeen = Date.now();
          } catch (error) {
            sendError(res, error);
            return;
          }
        }
        const active = [...players.values()].find((player) => player.deviceId === activeSpotifyDeviceId);
        if (!active) {
          res.status(409).json({ error: 'no active browser player' });
          return;
        }
        const query = new URLSearchParams({ device_id: active.deviceId });
        let endpoint = '';
        let method = 'PUT';
        let body: unknown;
        switch (command) {
          case 'play': endpoint = `/me/player/play?${query}`; break;
          case 'pause': endpoint = `/me/player/pause?${query}`; break;
          case 'next': endpoint = `/me/player/next?${query}`; method = 'POST'; break;
          case 'previous': endpoint = `/me/player/previous?${query}`; method = 'POST'; break;
          case 'volume':
            if (typeof value !== 'number' || value < 0 || value > 100) break;
            endpoint = `/me/player/volume?${new URLSearchParams({ ...Object.fromEntries(query), volume_percent: String(Math.round(value)) })}`;
            break;
          case 'seek':
            if (typeof value !== 'number' || value < 0) break;
            endpoint = `/me/player/seek?${new URLSearchParams({ ...Object.fromEntries(query), position_ms: String(Math.round(value)) })}`;
            break;
          case 'shuffle':
            if (typeof value !== 'boolean') break;
            endpoint = `/me/player/shuffle?${new URLSearchParams({ ...Object.fromEntries(query), state: String(value) })}`;
            break;
          case 'repeat':
            if (typeof value !== 'string' || !VALID_REPEAT.has(value)) break;
            endpoint = `/me/player/repeat?${new URLSearchParams({ ...Object.fromEntries(query), state: value })}`;
            break;
          case 'play-uri':
            if (typeof value !== 'string' || !value.startsWith('spotify:')) break;
            endpoint = `/me/player/play?${query}`;
            body = value.startsWith('spotify:track:') ? { uris: [value] } : { context_uri: value };
            break;
          case 'queue-add':
            if (typeof value !== 'string' || !value.startsWith('spotify:track:')) break;
            endpoint = `/me/player/queue?${new URLSearchParams({ ...Object.fromEntries(query), uri: value })}`;
            method = 'POST';
            break;
          default:
            break;
        }
        if (!endpoint) {
          res.status(400).json({ error: 'invalid command' });
          return;
        }
        try {
          const response = await spotifyRequest(endpoint, method, body);
          if (!response.ok) {
            const error = await responseError(response, state, touch);
            res.status(error.status).json({ error: error.error });
            return;
          }
          try {
            await refreshPlayback();
          } catch {
            /* the command succeeded; state will be updated by the browser */
          }
          touch();
          res.json(current());
        } catch (error) {
          sendError(res, error);
        }
      });

      return r;
    },
  };
}

interface DeviceConfigWithLegacyFields {
  id: string;
  service: string;
  apiKey?: unknown;
  apiKeyIssued?: unknown;
  daemonBin?: unknown;
  source?: string;
  clientId?: string;
  clientSecret?: string;
  deviceName?: string;
}

export const spotifyService = createSpotifyService();
