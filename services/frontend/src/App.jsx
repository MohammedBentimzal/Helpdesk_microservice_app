import React, { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken } from './api.js';
import Login from './components/Login.jsx';
import Notifications from './components/Notifications.jsx';
import TicketList from './components/TicketList.jsx';
import NewTicket from './components/NewTicket.jsx';
import TicketDetail from './components/TicketDetail.jsx';

// Tiny hash router: #/ (list), #/new, #/tickets/12
function useRoute() {
  const [hash, setHash] = useState(window.location.hash || '#/');
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'new') return { name: 'new' };
  if (parts[0] === 'tickets' && parts[1]) return { name: 'detail', id: parts[1] };
  return { name: 'list' };
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  const route = useRoute();

  const logout = useCallback(() => { setToken(null); setUser(null); window.location.hash = '#/'; }, []);

  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener('auth-expired', onExpired);
    return () => window.removeEventListener('auth-expired', onExpired);
  }, []);

  useEffect(() => {
    (async () => {
      try { setConfig(await api.config()); } catch (e) { setConfigError('Cannot reach the auth service. Is it running?'); }
      if (getToken()) {
        try { setUser((await api.me()).user); } catch { setToken(null); }
      }
      setBooting(false);
    })();
  }, []);

  if (booting) return <div className="center muted">Loading...</div>;
  if (!user) return <Login config={config} error={configError} onLogin={(token, u) => { setToken(token); setUser(u); }} />;

  const isAgent = user.role === 'agent';
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">Helpdesk</a>
        <nav>
          <a href="#/">{isAgent ? 'Ticket queue' : 'My tickets'}</a>
          {!isAgent && <a href="#/new">New ticket</a>}
        </nav>
        <div className="spacer" />
        <Notifications />
        <span className="user">{user.name} <span className={`badge role-${user.role}`}>{user.role}</span></span>
        <button className="link" onClick={logout}>Sign out</button>
      </header>
      <main>
        {route.name === 'list' && <TicketList user={user} />}
        {route.name === 'new' && <NewTicket />}
        {route.name === 'detail' && <TicketDetail id={route.id} user={user} />}
      </main>
    </div>
  );
}
