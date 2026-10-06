# Helpdesk: microservice demo app for a DevOps project
if you see that git diff works
A small ticketing system: people report problems, IT agents resolve them, everyone gets notified.
It is built to be the **subject** of a DevOps project (Docker, CI/CD, Kubernetes, GitOps, monitoring).
The app is intentionally simple; the interesting work is what you build around it.

## What it does

1. A user signs in (Google, or one-click demo login).
2. A **requester** creates a ticket (title, description, priority) and follows its status: Open, In progress, Resolved.
3. An **agent** sees the whole queue, assigns tickets, comments, changes status, and sees simple statistics.
4. Every important event (ticket created, assigned, status changed, commented) becomes a notification, delivered
   **asynchronously** through a queue and shown in the notification bell (and optionally posted to Discord).

## Architecture

```
Browser
   |
[ Vite dev server / Ingress ]   routes by path
   |-- /                 -> frontend             React (Vite)
   |-- /api/auth         -> auth-service         Node.js + Express      MySQL   (users)
   |-- /api/tickets      -> ticket-service       Node.js + Express      PostgreSQL (tickets, comments)
   |                              |  publishes events
   |                              v
   |                        Redis Stream  "helpdesk.ticket-events"
   |                              |  consumed by
   |-- /api/notifications -> notification-service Node.js worker + API  MySQL   (notifications)
```

| Service | Port | Owns | Talks to |
|---|---|---|---|
| frontend | 5173 (dev) | UI | the three APIs through `/api/*` |
| auth-service | 4001 | MySQL database `helpdesk_auth` | Google (token verification, optional) |
| ticket-service | 4002 | PostgreSQL database `helpdesk_tickets` | Redis (publishes events) |
| notification-service | 4003 | MySQL database `helpdesk_notifications` | Redis (consumes events), Discord (optional) |

Each service has its own database (database per service), and services only share the JWT signing secret.
Login tokens are JWTs issued by auth-service and verified by the other two.

Redis is used only as the message queue between ticket-service and notification-service.

## Prerequisites

- **Node.js 20.6 or newer** (developed and tested on Node 22). Check with `node -v`.
- **Docker with Docker Compose v2**, used only to run PostgreSQL, MySQL and Redis.
  (If you prefer, install those three locally and point the URLs in `.env` at them.)

## Quick start

```bash
# 1. create your local config (.env) from the template
npm run setup

# 2. install dependencies for the root and all four services
npm run install:all

# 3. start PostgreSQL, MySQL and Redis in Docker (waits until they are healthy)
npm run infra:up

# 4. start all four services with auto-reload
npm run dev
```

Open **http://localhost:5173**.

The default `AUTH_MODE=dev` shows demo login buttons, so no Google account is needed:

- **Sara** and **Omar** are requesters.
- **Ahmed** is an IT agent.

### Try the full flow (takes one minute)

1. Sign in as **Sara**, click **New ticket**, create a "high" priority ticket.
2. Sign out, sign in as **Ahmed**. The ticket is in the queue and the bell shows a notification (it refreshes every 10 seconds).
3. Open the ticket, click **Assign to me**, add a comment, then set the status to **Resolved**.
4. Sign back in as **Sara**. The bell shows that the ticket was assigned, commented on, and resolved.

### Check everything automatically

With the app running, in another terminal:

```bash
npm run smoke
```

It walks the whole user journey (login, create ticket, assign, comment, resolve, notifications, permission checks)
and prints PASS/FAIL for each step. To test through the frontend's single-origin routing instead of direct service
ports: `BASE_URL=http://localhost:5173 npm run smoke`.

### Stop and reset

```bash
# Ctrl+C stops the services, then:
npm run infra:down     # stop the databases (data is kept)
npm run infra:reset    # stop and delete all data
```

## Optional: real Google sign-in

1. In Google Cloud Console, open **APIs & Services > Credentials > Create credentials > OAuth client ID**, type **Web application**.
   Configure the consent screen first if asked (External, Testing mode, add your own Google account as a test user).
2. Add **http://localhost:5173** to **Authorized JavaScript origins**. (No redirect URI is needed, the app uses
   Google's sign-in button and verifies the returned token on the server.)
3. In `.env` set:
   ```
   AUTH_MODE=google
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   AGENT_EMAILS=your.email@gmail.com
   ```
   Emails listed in `AGENT_EMAILS` get the **agent** role; everyone else is a **requester**.
4. Restart `npm run dev`.

When you deploy later, add your real HTTPS origin to the authorized JavaScript origins. Google does not accept
a bare IP address, so use a hostname (for example `your-ip.sslip.io`) with TLS.

## Project layout

```
helpdesk-app/
  README.md
  package.json                 root scripts (setup, install:all, dev, test, smoke, infra:*)
  .env.example                 all configuration with comments
  docker-compose.infra.yml     PostgreSQL, MySQL, Redis only
  db/mysql-init.sql            creates the notifications database on first MySQL start
  scripts/
    setup.mjs                  copies .env.example to .env
    smoke.mjs                  end-to-end smoke test
  services/
    frontend/                  React + Vite (src/App.jsx, components/, api.js)
    auth-service/              src/{app,store,index}.js, test/
    ticket-service/            src/{app,store,events,index}.js, test/
    notification-service/      src/{app,store,rules,consumer,index}.js, test/
```

Each backend service is split the same way: `index.js` wires configuration and connections, `app.js` holds the HTTP
routes, `store.js` holds the database code. `src/common/` (logging, metrics, auth, chaos, utilities) is intentionally
copied into every service so each one can be built into its own container image without sharing files.

## API reference

All `/api/*` routes except login need `Authorization: Bearer <token>`.

| Method and path | Who | Description |
|---|---|---|
| GET `/api/auth/config` | public | Auth mode and Google client ID |
| POST `/api/auth/dev-login` | public (dev mode only) | `{email, name, role}` returns `{token, user}` |
| POST `/api/auth/google` | public (google mode only) | `{credential}` returns `{token, user}` |
| GET `/api/auth/me` | any user | Current user |
| GET `/api/auth/users?role=agent` | agent | List users (used for assignment) |
| POST `/api/tickets` | any user | Create ticket `{title, description, priority}` |
| GET `/api/tickets?status=&priority=&assignee=` | any user | Requesters see only their own; agents see all. `assignee` is `me`, `unassigned`, or an email |
| GET `/api/tickets/:id` | owner or agent | Ticket with comments |
| PATCH `/api/tickets/:id` | agent | `{status}` and/or `{assignee: "me" \| {email,name} \| null}` |
| POST `/api/tickets/:id/comments` | owner or agent | `{body}` |
| GET `/api/tickets/stats` | agent | Counts by status and priority, average resolution time |
| GET `/api/notifications` | any user | `{items, unread}` |
| POST `/api/notifications/read-all` | any user | Marks everything as read |

## Operational endpoints (for the DevOps work)

Every backend service exposes these at the root (they are **not** under `/api`, so an ingress that only routes
`/api/*` will not expose them publicly):

| Endpoint | Purpose | Kubernetes use |
|---|---|---|
| `GET /health` | Process is alive, no dependency checks | liveness probe |
| `GET /ready` | Database reachable (Redis status shown but not required) | readiness probe |
| `GET /metrics` | Prometheus metrics | ServiceMonitor scrape target |
| `POST /chaos` | Change failure-injection mode at runtime | reliability drills |

**Why Redis is not part of readiness:** if Redis stops, tickets can still be created and read. The
`ticket-service` and `notification-service` stay ready, and the failure shows up in metrics instead.

### Metrics

All services: `http_requests_total{method,route,status}`, `http_request_duration_seconds` (histogram), plus default
Node.js process metrics.

| Service | Business metrics |
|---|---|
| auth-service | `logins_total{method,role}` |
| ticket-service | `tickets_created_total{priority}`, `ticket_status_changes_total{status}`, `tickets_open{priority}`, `ticket_resolution_seconds` (histogram), `events_published_total{type}`, `events_publish_failures_total{type}` |
| notification-service | `events_processed_total{result}`, `notifications_created_total{type}`, `notification_queue_lag`, `notification_queue_pending`, `notifications_delivered_total{channel,result}` |

Good alert candidates: `notification_queue_lag` above 100 for 5 minutes, `events_publish_failures_total` increasing,
error rate above 5%, p95 latency above 500 ms.

### Logs

One JSON object per line on stdout (`level`, `time`, `service`, `msg`, plus request fields). Set `LOG_LEVEL`
to `debug` to also log probe and metrics requests.

### Failure injection (chaos)

 `CHAOS_MODE` in `.env` (or in a container's environment) for any service:

| Mode | Effect | Drill it supports |
|---|---|---|
| `none` | normal | |
| `slow` | adds `CHAOS_DELAY_MS` (default 2000) to every request | latency alerts, timeouts |
| `error` | returns HTTP 500 for a fraction `CHAOS_ERROR_RATE` (default 0.5) of requests | error-rate alerts, rollbacks |
| `crash` | the process exits on the first request | CrashLoopBackOff, restarts |

Health, ready and metrics endpoints are never affected. To change the mode at runtime, set `CHAOS_TOKEN` and call:

```bash
curl -X POST http://localhost:4002/chaos -H "x-chaos-token: $CHAOS_TOKEN" \
     -H "content-type: application/json" -d '{"mode":"error","errorRate":0.8}'
```

Other useful drills: stop Redis (`docker compose -f docker-compose.infra.yml stop redis`) and watch tickets keep
working while `events_publish_failures_total` rises; stop `notification-service`, create tickets, start it again and
watch `notification_queue_lag` drain.

## Configuration

Everything is configured with environment variables (see `.env.example` for the full annotated list).
For containers and Kubernetes each service just needs its own values; when running locally they all read the shared `.env`.

| Variable | Used by | Meaning |
|---|---|---|
| `JWT_SECRET` (required) | all backends | Signs and verifies login tokens |
| `DATABASE_URL` | all backends | Connection string. Locally the services fall back to `AUTH_DB_URL`, `TICKET_DB_URL`, `NOTIFICATIONS_DB_URL` |
| `REDIS_URL` | ticket, notification | Queue connection |
| `PORT` | all backends | Listen port (fallback: `AUTH_PORT`, `TICKET_PORT`, `NOTIFICATION_PORT`) |
| `AUTH_MODE`, `GOOGLE_CLIENT_ID`, `AGENT_EMAILS` | auth | Login mode and roles |
| `SEED_DEMO_DATA` | ticket | Insert 3 sample tickets into an empty database |
| `EVENTS_STREAM`, `CONSUMER_GROUP` | ticket, notification | Redis stream and consumer group names |
| `DISCORD_WEBHOOK_URL` | notification | Optional external delivery |
| `LOG_LEVEL`, `CHAOS_*` | all backends | Logging and failure injection |

Services fail fast with a clear message when a required variable is missing, and they retry database connections
at startup, so start order does not matter.

## Tests

```bash
npm test            # unit tests for the three backend services (Node's built-in test runner)
npm run build:frontend
npm run smoke       # end-to-end, needs the running stack
```

## Design notes and known simplifications

- **Schema is created at startup** with `CREATE TABLE IF NOT EXISTS`. Fine for a demo; real systems use migrations
  (a Kubernetes Job or an init step is a good DevOps exercise). ticket-service uses a Postgres advisory lock so several
  replicas can start at once.
- **Events are published best effort.** If Redis is down when a ticket is created, the ticket is saved but its
  notification is lost (counted in `events_publish_failures_total`). The production fix is the *outbox pattern*, a nice stretch goal.
- **Delivery is at-least-once and idempotent.** notification-service acknowledges a message only after storing it,
  reclaims messages abandoned by crashed replicas, and a unique key prevents duplicate notifications.
- **Auth is deliberately small.** One shared HS256 secret, 8-hour tokens, no refresh tokens. `AUTH_MODE=dev`
  is for local use only and logs a warning.
- **No Dockerfiles yet, on purpose.** Containerizing each service is your first DevOps task.

## Next: the DevOps steps

Facts you need when you containerize and deploy:

| Service | Build | Run command | Port | Probes |
|---|---|---|---|---|
| auth-service | `npm ci --omit=dev` | `node src/index.js` | 4001 | `/health`, `/ready` |
| ticket-service | `npm ci --omit=dev` | `node src/index.js` | 4002 | `/health`, `/ready` |
| notification-service | `npm ci --omit=dev` | `node src/index.js` | 4003 | `/health`, `/ready` |
| frontend | `npm ci && npm run build` (output in `dist/`) | serve `dist/` with Nginx | 80 | `/` |

- In containers set `PORT` and `DATABASE_URL` per service instead of the local variable names.
- The frontend only calls relative `/api/...` paths. In Docker Compose or Kubernetes, put a reverse proxy or Ingress in front
  that routes `/api/auth`, `/api/tickets`, `/api/notifications` to the services and `/` to the frontend
  (the same job `vite.config.js` does in development).
- Run notification-service with more than one replica to see consumer groups share the work.
- Follow your blueprint from Week 1: Dockerfiles, a full docker-compose file, GitHub Actions, then Kubernetes and ArgoCD.