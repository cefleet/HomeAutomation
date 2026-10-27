const API_ORIGIN: string =
  import.meta.env.VITE_API_ORIGIN ?? 'http://localhost:3001';

export const apiUrl = (path: string) => `${API_ORIGIN}${path}`;

export interface Session {
  role: string;
  dashboard: string;
}

const SESSION_KEY = 'ha.session';

export function getSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function setSession(s: Session): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

function roleHeaders(): Record<string, string> {
  const s = getSession();
  return s ? { 'x-automation-roles': s.role } : {};
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), { headers: roleHeaders() });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function apiSend<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: {
      ...roleHeaders(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`${method} ${path}: ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  return res.json() as Promise<T>;
}

/** POST a binary body (e.g. a MediaRecorder chunk); no JSON response. */
export async function apiPostRaw(path: string, body: Blob): Promise<void> {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { ...roleHeaders(), 'Content-Type': 'application/octet-stream' },
    body,
  });
  if (!res.ok) throw new Error(`POST ${path}: ${res.status}`);
}
