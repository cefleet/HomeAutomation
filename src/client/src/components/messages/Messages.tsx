import { useState } from 'react';
import { showError } from '../../errors';
import { useMessaging, useMessagingDevice } from '../../hooks/useApi';
import type { MessageThread } from '../../types';
import { MessagesBadge } from './MessagesBadge';
import { MessagesOverlay } from './MessagesOverlay';

const latest = (t: MessageThread) => t.replies.at(-1)?.body ?? t.body;

/** Built-in messaging chrome rendered on every dashboard: the unread badge,
 *  the messages overlay, and dismissible elements for unread threads.
 *  Messages act as the viewed `dashboard`. Renders nothing when no
 *  `messaging`-contract device is configured. */
export function Messages({ dashboard }: { dashboard: string }) {
  const device = useMessagingDevice();
  const { threads, unread, incoming, send, reply, markSeen, hide } = useMessaging(device, dashboard);
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);

  if (!device) return null;

  const act = (p: Promise<void>) => p.catch((e) => showError(String(e)));
  const openOverlay = (threadId: string | null) => {
    setFocus(threadId);
    setOpen(true);
  };

  return (
    <>
      <MessagesBadge unread={unread} onOpen={() => openOverlay(null)} />
      {open ? (
        <MessagesOverlay
          me={dashboard}
          focusThreadId={focus}
          threads={threads}
          onSend={(b, t) => act(send(b, t))}
          onReply={(id, b) => act(reply(id, b))}
          onMarkSeen={(id) => act(markSeen(id))}
          onHide={(id) => act(hide(id))}
          onClose={() => setOpen(false)}
        />
      ) : null}
      {incoming.length ? (
        <div className="notifications">
          {incoming.map((t) => (
            <div key={t.id} className="notification">
              <div className="notification-head">
                <strong>Message from {t.from}</strong>
                <button onClick={() => act(markSeen(t.id))} aria-label="dismiss">
                  ×
                </button>
              </div>
              <p>{latest(t)}</p>
              <div className="notification-actions">
                <button onClick={() => openOverlay(t.id)}>Reply</button>
                <button onClick={() => act(markSeen(t.id))}>Mark seen</button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
