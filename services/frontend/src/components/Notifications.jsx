import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

// If the notification service is down, the rest of the app keeps working (graceful degradation).
export default function Notifications() {
  const [data, setData] = useState({ items: [], unread: 0 });
  const [available, setAvailable] = useState(true);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try { setData(await api.notifications()); setAvailable(true); } catch { setAvailable(false); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && data.unread > 0) {
      try { await api.markRead(); setData((d) => ({ ...d, unread: 0 })); } catch { /* ignore */ }
    }
  };

  return (
    <div className="notif">
      <button className="link bell" onClick={toggle} title="Notifications">
        Notifications{available && data.unread > 0 && <span className="count">{data.unread}</span>}
        {!available && <span className="muted"> (unavailable)</span>}
      </button>
      {open && (
        <div className="dropdown card">
          {!available && <div className="muted">Notifications are temporarily unavailable.</div>}
          {available && data.items.length === 0 && <div className="muted">No notifications yet.</div>}
          {data.items.map((n) => (
            <a key={n.id} className="notif-item" href={n.ticket_id ? `#/tickets/${n.ticket_id}` : '#/'} onClick={() => setOpen(false)}>
              <div>{n.message}</div>
              <small className="muted">{new Date(n.created_at).toLocaleString()}</small>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
