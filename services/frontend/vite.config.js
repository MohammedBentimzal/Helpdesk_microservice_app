import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the Vite server plays the role the Kubernetes Ingress plays later:
// it routes /api/<service> paths to the right backend service.
const target = (envName, fallback) => process.env[envName] || fallback;
const proxy = {
  '/api/auth': { target: target('AUTH_URL', 'http://localhost:4001'), changeOrigin: true },
  '/api/tickets': { target: target('TICKETS_URL', 'http://localhost:4002'), changeOrigin: true },
  '/api/notifications': { target: target('NOTIFICATIONS_URL', 'http://localhost:4003'), changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true, proxy },
  preview: { port: 4173, host: true, proxy },
});
