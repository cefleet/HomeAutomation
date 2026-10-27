import { useEffect, useState } from 'react';
import { useDashboards } from '../../hooks/useApi';
import type { MessageThread } from '../../types';

const lastActivity = (t: MessageThread) => t.replies.at(-1)?.ts ?? t.ts;
const latest = (t: MessageThread) => t.replies.at(-1)?.body ?? t.body;
const recipients = (t: MessageThread) => t.targets.filter((d) => d !== t.from).join(', ');
const fmt = (ts: number) => new Date(ts).toLocaleString();

/** Messages overlay: a thread list (each thread selectable into its
 *  conversation) plus compose-to-dashboards. The conversation view shows
 *  the thread's message and replies with reply + mark-seen controls. */
export function MessagesOverlay({
  me,
  focusThreadId,
  threads,
  onSend,
  onReply,
  onMarkSeen,
  onHide,
  onClose,
}: {
  me: string;
  focusThreadId?: string | null;
  threads: MessageThread[];
  onSend: (body: string, targets: string[]) => Promise<void>;
  onReply: (threadId: string, body: string) => Promise<void>;
  onMarkSeen: (threadId: string) => Promise<void>;
  onHide: (threadId: string) => Promise<void>;
  onClose: () => void;
}) {
  // Fetched on open so disabled/added dashboards are always current.
  const dashboards = useDashboards() ?? [];
  const [openId, setOpenId] = useState<string | null>(focusThreadId ?? null);
  const [draft, setDraft] = useState('');
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [replyDraft, setReplyDraft] = useState('');
  const sorted = [...threads].sort((a, b) => lastActivity(b) - lastActivity(a));
  const unread = (t: MessageThread) => !t.seenBy.includes(me);
  const current = openId ? threads.find((t) => t.id === openId) : undefined;

  useEffect(() => {
    if (focusThreadId) setOpenId(focusThreadId);
  }, [focusThreadId]);

  const toggle = (id: string) =>
    setTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const send = async () => {
    await onSend(draft, [...targets]);
    setDraft('');
    setTargets(new Set());
  };

  const reply = async () => {
    if (!current) return;
    await onReply(current.id, replyDraft);
    setReplyDraft('');
  };

  const hide = async (threadId: string) => {
    await onHide(threadId);
    if (openId === threadId) setOpenId(null);
  };

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="overlay" onClick={(e) => e.stopPropagation()}>
        <div className="overlay-header">
          {current ? <button onClick={() => setOpenId(null)}>‹ Threads</button> : null}
          <h2>{current ? `From ${current.from}` : 'Messages'}</h2>
          <button onClick={onClose}>Close</button>
        </div>

        {current ? (
          <div className="thread">
            <p className="muted">
              to {recipients(current) || 'self'} · {fmt(current.ts)}
            </p>
            <p>{current.body}</p>
            {current.replies.length ? (
              <div className="thread-replies">
                {current.replies.map((rep) => (
                  <div key={rep.id}>
                    <strong>{rep.from}</strong> <span className="muted">{fmt(rep.ts)}</span>
                    <div>{rep.body}</div>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="reply-row">
              <input
                value={replyDraft}
                placeholder="Reply…"
                onChange={(e) => setReplyDraft(e.target.value)}
              />
              <button onClick={reply} disabled={!replyDraft.trim()}>
                Reply
              </button>
              {unread(current) ? (
                <button onClick={() => onMarkSeen(current.id)}>Mark seen</button>
              ) : null}
              <button onClick={() => hide(current.id)}>Hide</button>
            </div>
          </div>
        ) : (
          <>
            <div className="msg-compose">
              <textarea
                value={draft}
                placeholder="Write a message…"
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="msg-targets">
                {dashboards
                  .filter((d) => !d.disabled?.includes('messages'))
                  .map((d) => (
                    <label key={d.id}>
                      <input
                        type="checkbox"
                        checked={targets.has(d.id)}
                        onChange={() => toggle(d.id)}
                      />
                      {d.title}
                    </label>
                  ))}
              </div>
              <div>
                <button onClick={send} disabled={!draft.trim() || !targets.size}>
                  Send
                </button>
              </div>
            </div>
            <div className="messages-list">
              {sorted.length === 0 ? <p className="muted">No messages.</p> : null}
              {sorted.map((t) => (
                <div
                  key={t.id}
                  className={`thread summary${unread(t) ? ' unread' : ''}`}
                  onClick={() => setOpenId(t.id)}
                  role="button"
                >
                  <div className="thread-head">
                    <strong>{t.from}</strong>
                    <span className="muted">
                      to {recipients(t) || 'self'} · {fmt(lastActivity(t))}
                    </span>
                  </div>
                  <p className="thread-snippet">
                    {unread(t) ? <span className="unread-dot">●</span> : null}
                    {latest(t)}
                    {t.replies.length ? (
                      <span className="muted"> · {t.replies.length} replies</span>
                    ) : null}
                  </p>
                  <button
                    className="thread-hide"
                    onClick={(e) => {
                      e.stopPropagation();
                      hide(t.id);
                    }}
                  >
                    Hide
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
