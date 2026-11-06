import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { networkInterfaces } from 'node:os';
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
if (!!tlsCert !== !!tlsKey) throw new Error('TLS_CERT and TLS_KEY must be set together');

const { app, notifications } = createApp({
  configDir,
  clientDist,
  devOrigin,
  prod: process.env.NODE_ENV === 'production',
  dataDir: process.env.DATA_DIR,
});

const onReady = (server: http.Server | https.Server) => () => {
  const scheme = tlsCert && tlsKey ? 'https' : 'http';
  const address = server.address();
  const host =
    address && typeof address === 'object' && address.address && address.address !== '::' && address.address !== '0.0.0.0'
      ? address.address
      : (Object.values(networkInterfaces())
          .flatMap((addresses) => addresses ?? [])
          .find((info) => info.family === 'IPv4' && !info.internal)?.address ?? 'localhost');
  console.log(`[fleetwood] server listening on ${scheme}://${host}:${port}`);
  notifications.emit({
    type: 'announcement',
    targets: ['master'],
    title: 'Fleetwood Home Automation',
    body: 'Server started',
  });
};

if (tlsCert && tlsKey) {
  const server = https
    .createServer({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) }, app)
    .listen(port);
  server.on('listening', onReady(server));
} else {
  const server = app.listen(port);
  server.on('listening', onReady(server));
}
