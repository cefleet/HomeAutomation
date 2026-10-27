import type { Response } from 'express';

export function sseInit(res: Response): (event: string, data: unknown) => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':ok\n\n');
  return (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function sseHeartbeat(res: Response, ms = 25000): NodeJS.Timeout {
  return setInterval(() => res.write(':hb\n\n'), ms);
}
