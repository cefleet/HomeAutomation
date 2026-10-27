import fs from 'node:fs';
import path from 'node:path';
import type { MessageReply, MessageThread } from './types.js';

export type MessageLogEntry =
  | { op: 'create'; thread: MessageThread }
  | { op: 'reply'; threadId: string; reply: MessageReply }
  | { op: 'seen'; threadId: string; dashboard: string; ts: number }
  | { op: 'hide'; threadId: string; dashboard: string; ts: number };

/** Append-only JSON-lines log for one messenger device. Replayed at startup
 *  to rebuild thread and seen state. */
export class MessageLog {
  private readonly file: string;

  constructor(dir: string, deviceId: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `messenger-${deviceId}.jsonl`);
  }

  append(entry: MessageLogEntry): void {
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
  }

  entries(): MessageLogEntry[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MessageLogEntry);
  }
}
