import { randomUUID } from 'node:crypto';
import type {
  Notification,
  NotificationInput,
  NotificationTypeDef,
} from './types.js';

type Subscriber = { dashboard: string; send: (n: Notification) => void };

export class NotificationCenter {
  private types = new Map<string, NotificationTypeDef>();
  private subscribers = new Set<Subscriber>();

  registerType(def: NotificationTypeDef): void {
    this.types.set(def.type, def);
  }

  emit(input: NotificationInput): Notification {
    const def = this.types.get(input.type);
    if (!def) throw new Error(`unregistered notification type "${input.type}"`);
    const n: Notification = {
      ...input,
      id: randomUUID(),
      ts: Date.now(),
      interactive: def.interactive ?? false,
    };
    const targets = input.targets && input.targets.length ? new Set(input.targets) : null;
    for (const sub of this.subscribers) {
      if (!targets || targets.has(sub.dashboard)) sub.send(n);
    }
    return n;
  }

  subscribe(dashboard: string, send: (n: Notification) => void): () => void {
    const sub: Subscriber = { dashboard, send };
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }
}
