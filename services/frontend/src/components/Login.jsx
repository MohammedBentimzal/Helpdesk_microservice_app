import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const DEMO_USERS = [
  { email: 'sara@example.com', name: 'Sara', role: 'requester', label: 'Sign in as Sara (requester)' },
  { email: 'omar@example.com', name: 'Omar', role: 'requester', label: 'Sign in as Omar (requester)' },
  { email: 'ahmed@example.com', name: 'Ahmed', role: 'agent', label: 'Sign in as Ahmed (IT agent)' },
];

function GoogleButton({ clientId, onLogin, onError }) {
  const ref = useRef(null);
  useEffect(() => {
    const init = () => {
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async ({ credential }) => {
          try { const { token, user } = await api.googleLogin(credential); onLogin(token, user); } catch (e) { onError(e.message); }
        },
      });
      window.google.accounts.id.renderButton(ref.current, { theme: 'outline', size: 'large', text: 'signin_with' });
    };
    if (window.google?.accounts) return init();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = init;
    s.onerror = () => onError('Could not load Google sign-in.');
    document.head.appendChild(s);
  }, [clientId]);
  return <div ref={ref} />;
}

export default function Login({ config, error: initialError, onLogin }) {
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);

  const devLogin = async (u) => {
    setBusy(true); setError(null);
    try { const { token, user } = await api.devLogin(u); onLogin(token, user); } catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <div className="center">
      <div className="card login">
        <h1>Helpdesk</h1>
        <p className="muted">Report a problem, track it, get it solved.</p>
        {error && <div className="error">{error}</div>}
        {config?.mode === 'google' && <GoogleButton clientId={config.googleClientId} onLogin={onLogin} onError={setError} />}
        {config?.mode === 'dev' && (
          <>
            <div className="notice">Demo mode: no Google account needed.</div>
            {DEMO_USERS.map((u) => (
              <button key={u.email} className="btn full" disabled={busy} onClick={() => devLogin(u)}>{u.label}</button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
