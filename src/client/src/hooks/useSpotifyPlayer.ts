import { useEffect, useRef, useState } from 'react';
import { apiGet, apiSend } from '../api';
import { showError } from '../errors';

interface SpotifyTrack {
  name: string;
  uri: string;
  artists: { name: string }[];
  album: { name: string; images: { url: string }[] };
}

interface SpotifyPlayerState {
  paused: boolean;
  position: number;
  duration: number;
  repeat_mode: number;
  shuffle: boolean;
  track_window: { current_track: SpotifyTrack };
  context: { metadata: { name?: string } };
}

interface SpotifyPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  getVolume(): Promise<number>;
  activateElement(): Promise<void>;
  addListener(
    event: 'ready' | 'not_ready',
    listener: (data: { device_id: string }) => void,
  ): boolean;
  addListener(
    event: 'player_state_changed',
    listener: (state: SpotifyPlayerState | null) => void,
  ): boolean;
  addListener(event: 'initialization_error' | 'authentication_error' | 'account_error' | 'playback_error', listener: (data: { message: string }) => void): boolean;
}

interface SpotifySdk {
  Player: new (options: {
    name: string;
    getOAuthToken: (callback: (token: string) => void) => void;
  }) => SpotifyPlayer;
}

declare global {
  interface Window {
    Spotify?: SpotifySdk;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

let sdkPromise: Promise<SpotifySdk> | null = null;

function loadSpotifySdk(): Promise<SpotifySdk> {
  if (window.Spotify?.Player) return Promise.resolve(window.Spotify);
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<SpotifySdk>((resolve, reject) => {
    const previousReady = window.onSpotifyWebPlaybackSDKReady;
    window.onSpotifyWebPlaybackSDKReady = () => {
      previousReady?.();
      if (window.Spotify?.Player) resolve(window.Spotify);
      else reject(new Error('Spotify playback SDK failed to initialize'));
    };
    let script = document.querySelector<HTMLScriptElement>(
      'script[src="https://sdk.scdn.co/spotify-player.js"]',
    );
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://sdk.scdn.co/spotify-player.js';
      script.async = true;
      script.onerror = () => reject(new Error('Unable to load Spotify playback SDK'));
      document.head.appendChild(script);
    } else {
      script.addEventListener('error', () => reject(new Error('Unable to load Spotify playback SDK')), {
        once: true,
      });
    }
  }).catch((error: unknown) => {
    sdkPromise = null;
    throw error;
  });
  return sdkPromise;
}

export interface SpotifyBrowserPlayer {
  connected: boolean;
  name: string;
  registrationId: string | null;
  activate: () => void;
}

const sdkPlayers = new Map<string, SpotifyPlayer>();
const playerRegistrations = new Map<string, string>();

/** Unlock this device's SDK audio inside a user gesture; no-op when the
 *  browser has no player (e.g. insecure context). */
export function unlockSpotifyPlayer(deviceId: string): void {
  try {
    void sdkPlayers.get(deviceId)?.activateElement();
  } catch {
    /* activation unsupported */
  }
}

/** Server-side registration id of this browser's player, when connected. */
export function spotifyPlayerRegistration(deviceId: string): string | null {
  return playerRegistrations.get(deviceId) ?? null;
}

export function useSpotifyPlayer(deviceId: string, deviceName: string, enabled: boolean): SpotifyBrowserPlayer {
  const [connected, setConnected] = useState(false);
  const [registrationId, setRegistrationId] = useState<string | null>(null);
  const [name] = useState(() => {
    const label = window.name.trim().slice(0, 32);
    return label || `Browser ${Math.random().toString(36).slice(2, 6)}`;
  });
  const playerRef = useRef<SpotifyPlayer | null>(null);
  const registrationRef = useRef<string | null>(null);
  const activateRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      setRegistrationId(null);
      return;
    }
    if (!window.isSecureContext) {
      setConnected(false);
      showError(`${deviceId}: Spotify playback requires a trusted HTTPS page`);
      return;
    }
    let disposed = false;
    let deviceSpotifyId: string | null = null;
    let registerInFlight = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let latestState: SpotifyPlayerState | null = null;
    let player: SpotifyPlayer | null = null;
    const base = `/api/spotify/${encodeURIComponent(deviceId)}`;

    const unregister = (id: string) => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      if (registrationRef.current === id) {
        registrationRef.current = null;
        playerRegistrations.delete(deviceId);
        if (!disposed) {
          setRegistrationId(null);
          setConnected(false);
        }
      }
      void apiSend(`${base}/players/${encodeURIComponent(id)}`, 'DELETE').catch(() => {});
    };

    const reportState = (
      id: string,
      state: SpotifyPlayerState | null,
      volume?: number,
    ) => {
      if (!state) return;
      const report: Record<string, unknown> = {
        paused: state.paused,
        position: state.position,
        duration: state.duration,
        repeatMode: state.repeat_mode,
        shuffle: state.shuffle,
        track: state.track_window.current_track,
        context: state.context,
      };
      if (volume !== undefined) report.volume = volume;
      void apiSend(`${base}/players/${encodeURIComponent(id)}/state`, 'POST', report).catch(() => {});
    };

    const register = async (spotifyDeviceId: string) => {
      if (registerInFlight || registrationRef.current || disposed) return;
      registerInFlight = true;
      deviceSpotifyId = spotifyDeviceId;
      setConnected(true);
      try {
        const result = await apiSend<{ id: string }>(`${base}/players`, 'POST', {
          deviceId: spotifyDeviceId,
          name,
        });
        if (disposed || deviceSpotifyId !== spotifyDeviceId) {
          void apiSend(`${base}/players/${encodeURIComponent(result.id)}`, 'DELETE').catch(() => {});
          return;
        }
        registrationRef.current = result.id;
        playerRegistrations.set(deviceId, result.id);
        setRegistrationId(result.id);
        heartbeat = setInterval(() => {
          void apiSend(`${base}/players/${encodeURIComponent(result.id)}/heartbeat`, 'POST').catch(
            (error: unknown) => {
              if (disposed || registrationRef.current !== result.id) return;
              if (!(error instanceof Error && error.message.includes(': 404'))) return;
              if (heartbeat) clearInterval(heartbeat);
              heartbeat = undefined;
              registrationRef.current = null;
              playerRegistrations.delete(deviceId);
              setRegistrationId(null);
              setConnected(false);
              if (deviceSpotifyId) void register(deviceSpotifyId);
            },
          );
        }, 30_000);
        reportState(result.id, latestState);
      } catch (error) {
        if (!disposed) {
          setConnected(false);
          showError(`${deviceId}: ${error instanceof Error ? error.message : error}`);
        }
      } finally {
        registerInFlight = false;
      }
    };

    const start = async () => {
      try {
        const sdk = await loadSpotifySdk();
        if (disposed) return;
        player = new sdk.Player({
          name: `Home Automation — ${deviceName} — ${name}`,
          getOAuthToken: (callback) => {
            void apiGet<{ accessToken: string; expiresIn: number }>(`${base}/token`)
              .then(({ accessToken }) => callback(accessToken))
              .catch((error: unknown) => {
                if (!disposed)
                  showError(`${deviceId}: ${error instanceof Error ? error.message : error}`);
              });
          },
        });
        playerRef.current = player;
        sdkPlayers.set(deviceId, player);
        player.addListener('ready', ({ device_id }) => {
          setConnected(true);
          void register(device_id);
        });
        player.addListener('not_ready', ({ device_id }) => {
          if (deviceSpotifyId === device_id) {
            deviceSpotifyId = null;
            const id = registrationRef.current;
            if (id) unregister(id);
            else setConnected(false);
          }
        });
        player.addListener('player_state_changed', (state) => {
          latestState = state;
          const id = registrationRef.current;
          if (id) {
            void player!.getVolume()
              .then((volume) => reportState(id, state, volume))
              .catch(() => reportState(id, state));
          }
        });
        const onError = ({ message }: { message: string }) => {
          if (!disposed) setConnected(false);
          if (!disposed) showError(`${deviceId}: Spotify player — ${message}`);
        };
        player.addListener('initialization_error', onError);
        player.addListener('authentication_error', onError);
        player.addListener('account_error', onError);
        player.addListener('playback_error', onError);
        await player.connect();
      } catch (error) {
        if (!disposed) {
          setConnected(false);
          showError(`${deviceId}: ${error instanceof Error ? error.message : error}`);
        }
      }
    };

    void start();
    activateRef.current = () => {
      const currentPlayer = playerRef.current;
      const id = registrationRef.current;
      if (!currentPlayer || !id || disposed) return;
      let activation: Promise<void>;
      try {
        activation = currentPlayer.activateElement();
      } catch (error) {
        showError(`${deviceId}: ${error instanceof Error ? error.message : error}`);
        return;
      }
      void activation
        .then(() => apiSend(`${base}/players/${encodeURIComponent(id)}/activate`, 'POST'))
        .catch((error: unknown) =>
          showError(`${deviceId}: ${error instanceof Error ? error.message : error}`),
        );
    };

    return () => {
      disposed = true;
      if (heartbeat) clearInterval(heartbeat);
      const id = registrationRef.current;
      registrationRef.current = null;
      playerRegistrations.delete(deviceId);
      if (id) void apiSend(`${base}/players/${encodeURIComponent(id)}`, 'DELETE').catch(() => {});
      playerRef.current = null;
      sdkPlayers.delete(deviceId);
      activateRef.current = () => {};
      player?.disconnect();
    };
  }, [deviceId, deviceName, enabled, name]);

  return { connected, name, registrationId, activate: () => activateRef.current() };
}
