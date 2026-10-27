import { useState } from 'react';
import { apiSend, setSession, type Session } from '../api';

export function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await apiSend<Session>('/api/login', 'POST', { username, password });
      setSession(s);
      window.location.href = `/dashboard/${encodeURIComponent(s.dashboard)}`;
    } catch {
      setError('Invalid username or password');
      setBusy(false);
    }
  };

  return (
    <main>
      <form className="card login" onSubmit={submit}>
        <h1>Fleetwood Home Automation</h1>
        <p className="muted">Temporary dev login — admin / admin or user / user</p>
        <input
          placeholder="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          type="password"
          placeholder="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          Log in
        </button>
        {error ? <p className="error">{error}</p> : null}
      </form>
    </main>
  );
}
