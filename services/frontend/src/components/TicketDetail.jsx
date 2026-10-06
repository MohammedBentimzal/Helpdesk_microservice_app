import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { StatusBadge, PriorityBadge } from './TicketList.jsx';

export default function TicketDetail({ id, user }) {
  const isAgent = user.role === 'agent';
  const [data, setData] = useState(null);
  const [agents, setAgents] = useState([]);
  const [comment, setComment] = useState('');
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try { setData(await api.ticket(id)); setError(null); } catch (e) { setError(e.message); }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (isAgent) api.agents().then((r) => setAgents(r.users)).catch(() => {}); }, [isAgent]);

  const update = async (body) => {
    try { await api.updateTicket(id, body); await load(); } catch (e) { setError(e.message); }
  };
  const sendComment = async (e) => {
    e.preventDefault();
    if (!comment.trim()) return;
    try { await api.addComment(id, comment); setComment(''); await load(); } catch (err) { setError(err.message); }
  };

  if (error && !data) return <div className="error">{error} <a href="#/">Back</a></div>;
  if (!data) return <div className="muted">Loading...</div>;
  const { ticket, comments } = data;

  return (
    <div>
      <a href="#/">&larr; Back to tickets</a>
      {error && <div className="error">{error}</div>}
      <div className="card ticket">
        <div className="row">
          <h2>#{ticket.id} {ticket.title}</h2>
          <div className="spacer" />
          <PriorityBadge priority={ticket.priority} /> <StatusBadge status={ticket.status} />
        </div>
        <p className="desc">{ticket.description || <span className="muted">No description.</span>}</p>
        <small className="muted">
          Requested by {ticket.requester_name} on {new Date(ticket.created_at).toLocaleString()}
          {ticket.assignee_name && <> &middot; Assigned to {ticket.assignee_name}</>}
        </small>
        {isAgent && (
          <div className="row actions">
            <button className="btn" onClick={() => update({ assignee: 'me' })} disabled={ticket.assignee_email === user.email}>Assign to me</button>
            <select value={ticket.assignee_email || ''} onChange={(e) => {
              const a = agents.find((x) => x.email === e.target.value);
              update({ assignee: a ? { email: a.email, name: a.name } : null });
            }}>
              <option value="">Unassigned</option>
              {agents.map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
            </select>
            <select value={ticket.status} onChange={(e) => update({ status: e.target.value })}>
              <option value="open">Open</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option>
            </select>
          </div>
        )}
      </div>

      <h3>Comments</h3>
      {comments.length === 0 && <div className="muted">No comments yet.</div>}
      {comments.map((c) => (
        <div key={c.id} className={`card comment ${c.author_role}`}>
          <b>{c.author_name}</b> <span className={`badge role-${c.author_role}`}>{c.author_role}</span>{' '}
          <small className="muted">{new Date(c.created_at).toLocaleString()}</small>
          <div>{c.body}</div>
        </div>
      ))}
      <form className="card form" onSubmit={sendComment}>
        <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Write a comment..." />
        <button className="btn">Add comment</button>
      </form>
    </div>
  );
}
