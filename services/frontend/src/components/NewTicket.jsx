import React, { useState } from 'react';
import { api } from '../api.js';

export default function NewTicket() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const { ticket } = await api.createTicket({ title, description, priority });
      window.location.hash = `#/tickets/${ticket.id}`;
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <div className="card form">
      <h2>New ticket</h2>
      {error && <div className="error">{error}</div>}
      <form onSubmit={submit}>
        <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Short summary of the problem" required /></label>
        <label>Description<textarea rows={6} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What happened? What did you try?" /></label>
        <label>Priority
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
          </select>
        </label>
        <button className="btn" disabled={busy}>{busy ? 'Submitting...' : 'Submit ticket'}</button>
      </form>
    </div>
  );
}
