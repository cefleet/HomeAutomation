import mail from '../../assets/mail.png';

/** Built-in messages badge: opens the messages overlay and shows the
 *  resolved dashboard's unread thread count. */
export function MessagesBadge({ unread, onOpen }: { unread: number; onOpen: () => void }) {
  return (
    <button className="messages-badge" onClick={onOpen} aria-label="Messages">
      <img className="badge-icon" src={mail} alt="" />
      Messages
      {unread > 0 ? <span className="messages-count">{unread}</span> : null}
    </button>
  );
}
