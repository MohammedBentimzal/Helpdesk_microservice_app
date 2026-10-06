// All backend calls go through relative /api/* paths. In development Vite proxies them,
// in Kubernetes the Ingress routes them, so the frontend never needs to know service addresses.
const TOKEN_KEY = 'helpdesk_token';
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

const qs = (params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  return q ? `?${q}` : '';
};

async function request(path, { method = 'GET', body } = {}) {
  const token = getToken();
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && token) {
    setToken(null);
    window.dispatchEvent(new Event('auth-expired'));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

export const api = {
  config: () => request('/api/auth/config'),
  devLogin: (payload) => request('/api/auth/dev-login', { method: 'POST', body: payload }),
  googleLogin: (credential) => request('/api/auth/google', { method: 'POST', body: { credential } }),
  me: () => request('/api/auth/me'),
  agents: () => request('/api/auth/users?role=agent'),
  tickets: (params) => request(`/api/tickets${qs(params)}`),
  ticket: (id) => request(`/api/tickets/${id}`),
  createTicket: (body) => request('/api/tickets', { method: 'POST', body }),
  updateTicket: (id, body) => request(`/api/tickets/${id}`, { method: 'PATCH', body }),
  addComment: (id, body) => request(`/api/tickets/${id}/comments`, { method: 'POST', body: { body } }),
  stats: () => request('/api/tickets/stats'),
  notifications: () => request('/api/notifications'),
  markRead: () => request('/api/notifications/read-all', { method: 'POST' }),
};
