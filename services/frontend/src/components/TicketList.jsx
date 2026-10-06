import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

export const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };
export const StatusBadge = ({ status }) => <span className={`badge status-${status}`}>{STATUS_LABEL[status] || status}</span>;
export const PriorityBadge = ({ priority }) => <span className={`badge prio-${priority}`}>{priority}</span>;

function Stats() {
  const [stats, setStats] = useState(null);
  useEffect(() => { api.stats().then(setStats).catch(() => setStats(null)); }, []);
  if (!stats) return null;
  const hours = stats.avgResolutionSeconds ? (stats.avgResolutionSeconds / 3600).toFixed(1) : '-';
  return (
    <div className="stats">
      <div className="card stat"><b>{stats.byStatus.open}</b><span>Open</span></div>
      <div className="card stat"><b>{stats.byStatus.in_progress}</b><span>In progress</span></div>
      <div className="card stat"><b>{stats.byStatus.resolved}</b><span>Resolved</span></div>
      <div className="card stat"><b>{stats.openByPriority.high}</b><span>High priority open</span></div>
      <div className="card stat"><b>{hours}</b><span>Avg hours to resolve</span></div>
    </div>
  );
}

export default function TicketList({ user }) {
  const isAgent = user.role === 'agent';
  const [filter, setFilter] = useState('');
  const [tickets, setTickets] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const params = {};
    if (filter === 'unassigned') params.assignee = 'unassigned';
    else if (filter === 'mine') params.assignee = 'me';
    else if (filter) params.status = filter;
    try { setTickets((await api.tickets(params)).tickets); setError(null); } catch (e) { setError(e.message); }
  }, [filter]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div>
      {isAgent && <Stats />}
      <div className="row">
        <h2>{isAgent ? 'Ticket queue' : 'My tickets'}</h2>
        <div className="spacer" />
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All</option>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="resolved">Resolved</option>
          {isAgent && <option value="unassigned">Unassigned</option>}
          {isAgent && <option value="mine">Assigned to me</option>}
        </select>
        {!isAgent && <a className="btn" href="#/new">New ticket</a>}
      </div>
      {error && <div className="error">Could not load tickets: {error}</div>}
      {!tickets && !error && <div className="muted">Loading...</div>}
      {tickets && tickets.length === 0 && <div className="card muted">No tickets here yet.</div>}
      {tickets && tickets.length > 0 && (
        <table className="card">
          <thead><tr><th>#</th><th>Title</th><th>Priority</th><th>Status</th>{isAgent && <th>Requester</th>}<th>Assignee</th><th>Created</th></tr></thead>
          <tbody>
            {tickets.map((t) => (
              <tr key={t.id}>
                <td>{t.id}</td>
                <td><a href={`#/tickets/${t.id}`}>{t.title}</a></td>
                <td><PriorityBadge priority={t.priority} /></td>
                <td><StatusBadge status={t.status} /></td>
                {isAgent && <td>{t.requester_name}</td>}
                <td>{t.assignee_name || <span className="muted">-</span>}</td>
                <td>{new Date(t.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
