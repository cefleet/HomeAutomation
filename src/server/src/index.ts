import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const port = Number(process.env.PORT ?? 3001);
const configDir = process.env.CONFIG_DIR ?? path.join(root, 'config');
const clientDist = process.env.CLIENT_DIST ?? path.resolve(root, '../client/dist');
const devOrigin =
  process.env.NODE_ENV === 'production' ? undefined : (process.env.DEV_ORIGIN ?? 'http://localhost:5173');
const tlsCert = process.env.TLS_CERT;
const tlsKey = process.env.TLS_KEY;

const { app, notifications } = createApp({
  configDir,
  clientDist,
  devOrigin,
  prod: process.env.NODE_ENV === 'production',
  dataDir: process.env.DATA_DIR,
});

const onReady = () => {
  const scheme = tlsCert && tlsKey ? 'https' : 'http';
  console.log(`[fleetwood] server listening on ${scheme}://localhost:${port}`);
  notifications.emit({
    type: 'announcement',
    targets: ['master'],
    title: 'Fleetwood Home Automation',
    body: 'Server started',
  });
};

if (tlsCert && tlsKey) {
  https
    .createServer({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) }, app)
    .listen(port, onReady);
} else {
  app.listen(port, onReady);
}
