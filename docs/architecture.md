# CodeCollab System Architecture

## 1. High-Level Architecture Overview

CodeCollab is a full-stack, real-time collaborative coding platform supporting synchronized editor state, sandboxed code execution, and multi-user room lifecycle management.

```text
┌────────────────────────────────────────────────────────┐
│                   React + Vite Frontend                │
│   (AuthContext, Dashboard, Monaco Editor, Terminal)    │
└───────────────▲────────────────────────▲───────────────┘
                │ HTTP (JWT Bearer)      │ WebSockets (Socket.IO)
                │                        │
┌───────────────▼────────────────────────▼───────────────┐
│                    Express Backend                     │
│  - /api/auth    (Registration, Login, Session)         │
│  - /api/rooms   (CRUD, Persistent Membership)          │
│  - /api/execute (Driver Auth, Code Submission)         │
└───────┬──────────────────┬─────────────────────┬───────┘
        │                  │                     │
        ▼                  ▼                     ▼
┌──────────────┐   ┌───────────────┐     ┌───────────────┐
│   MongoDB    │   │ Socket.IO     │     │ BullMQ +      │
│ (Atlas/Local)│   │ Realtime Hub  │     │ Redis Queue   │
│ - Users      │   │ - Room join   │     └───────┬───────┘
│ - Rooms      │   │ - Editor sync │             ▼
│ - Runs       │   │ - Presence    │     ┌───────────────┐
└──────────────┘   │ - Driver State│     │  Dockerode    │
                   └───────────────┘     │ Orchestrator  │
                                         │ (Python 3.11) │
                                         └───────────────┘
```

---

## 2. Core Architectural Subsystems

### 2.1 Authentication & Security (M0.7)
- **Password Protection:** `bcryptjs` with salt rounds = 10. Passwords and hashes are never returned.
- **Tokens:** Signed JWTs issued with 24-hour expiration (`expiresIn: '24h'`). Production environment enforces `JWT_SECRET`.
- **Identity Binding:** Socket connections verify JWT tokens during handshake or `room:join`, storing `socket.data.verifiedUser` on the server to prevent socket spoofing.

### 2.2 Room Lifecycle & Database Persistence (M0.8)
- **Persistent Model:** Backed by `database/models/Room.js` storing `name`, unique `roomId` (join code), `owner`, `members`, and timestamps.
- **Persistent Membership:** The room creator is automatically added to `members`. Joining a room adds the authenticated user to `members` idempotently.
- **Live Socket Gatekeeping:** When a client emits `room:join`, the server verifies that the socket's authenticated identity is an active member of the database room before calling `socket.join(roomId)`.
- **Session Disconnect Isolation:** Disconnecting a live socket clears transient presence and driver assignments, but preserves persistent database membership.

### 2.3 Realtime Collaboration & Transient Driver State
- **Driver State Machine:** Managed by `realtime/server/driverState.js`. The first active eligible socket in a room is promoted to Driver (`editor:driver_updated`), while subsequent participants enter as Viewers.
- **Fail-Closed Authorization:** Code execution (`POST /api/execute`) requires that the HTTP caller's JWT user identity matches the active driver socket's verified user identity. Missing or unauthenticated driver sessions fail closed (`403 Forbidden`).

### 2.4 Containerized Execution Subsystem (M0.5b–M0.5e)
- **Isolation:** Ephemeral container sandboxes orchestrated via Dockerode (`codecollab-runner-python:latest`). Hard limits: 256MB RAM, 0.5 CPU, network disabled (`NetworkMode: 'none'`), non-root user (`sandbox`, UID 1000).
- **Asynchronous Queue:** Redis 7 + BullMQ queue with bounded worker concurrency (2 workers) and FIFO scheduling.
- **Realtime Broadcasts:** Execution progress events (`execution:started`, `execution:completed`, `execution:failed`) broadcast only to active room members.