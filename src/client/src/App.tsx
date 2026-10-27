import { DashboardPage } from './components/DashboardPage';
import { LoginPage } from './components/LoginPage';

export function App() {
  const path = window.location.pathname;
  if (path === '/') return <LoginPage />;
  const match = path.match(/^\/dashboard(?:\/([^/]+))?\/?$/);
  if (match) return <DashboardPage id={match[1]} />;
  return (
    <main>
      <p className="error">Not found: {path}</p>
      <a href="/">Go to dashboard</a>
    </main>
  );
}
