# CodeCollab — Collaborative Online Coding Platform

A full-stack web application that lets multiple users create shared coding rooms, communicate via real-time chat, and compile/execute code together in Python, Java, and C++ — all from the browser, with no third-party compiler APIs.

CodeCollab combines the functionality of an online compiler with a real-time messaging system into a single integrated platform, giving developers, students, and interviewers a live space to code, test, and collaborate together.

---

## Problem Statement

Developers often need to collaborate on code in real time — for pair programming, technical interviews, teaching, or debugging together — but existing solutions either rely on third-party platforms, lack live communication, or don't support secure server-side code execution. CodeCollab builds this experience from the ground up.

---

## Features

- **User Authentication & Authorization** — secure signup/login with JWT-based sessions
- **Coding Rooms** — create a room and invite others via a shareable link
- **Live Code Editor** — shared view with real-time updates broadcast to all room members
- **Multi-Language Execution** — run Python, Java, and C++ code in isolated Docker containers
- **Live Terminal / Output Panel** — see compiled output, errors, and runtime info instantly
- **Integrated Real-Time Chat** — text messaging with typing indicators and live delivery per room
- **Execution History** — past code runs saved and viewable per room and per user
- **Sandboxed Execution** — CPU/memory/time-limited Docker containers, fully isolated from the host
- **Cloud Deployment** — hosted on AWS/Azure/Heroku

> **Scope note:** This version supports one active "driver" per room at a time — the room owner or current driver writes/runs code while others watch live updates and chat alongside. Full simultaneous multi-cursor editing (CRDT/OT) is intentionally out of scope for this build.

---

## Tech Stack

**Frontend**
- React 18 + TypeScript
- Monaco Editor (code editor component)
- Socket.io-client (real-time communication)

**Backend**
- Node.js + Express
- Socket.io (WebSocket server)
- dockerode (Docker orchestration from Node)
- BullMQ + Redis (execution job queue)

**Execution Engine**
- Docker containers — one per language runtime (Python, Java, C++)
- Resource-limited, network-isolated sandboxes per run

**Database**
- MongoDB (users, rooms, chat history, execution history)

**Deployment**
- Docker Compose (local orchestration)
- AWS EC2 / Azure / Heroku (cloud hosting)

---

## Project Structure

```
CodeCollab/
│
├── frontend/                       # React + TypeScript frontend
│   ├── src/
│   │   ├── components/             # editor, chat, terminal, room
│   │   ├── pages/                  # Login, Signup, Dashboard, Room, History
│   │   ├── hooks/
│   │   ├── context/
│   │   ├── services/
│   │   ├── types/
│   │   └── App.tsx
│   └── package.json
│
├── backend/                        # Node.js + Express backend API
│   ├── src/
│   │   ├── routes/
│   │   ├── controllers/
│   │   ├── middleware/
│   │   ├── services/
│   │   ├── config/
│   │   └── index.js
│   └── package.json
│
├── database/                       # Database models and seed scripts
│   ├── models/                     # User, Room, Message, ExecutionRun
│   ├── seeds/
│   └── README.md
│
├── realtime/                       # Real-time WebSocket layer
│   ├── server/                     # Socket handlers (rooms, editorSync, presence, chat, typing)
│   ├── client/                     # Socket client instance & event constants
│   └── protocol/                   # Socket event specification
│
├── execution/                      # Code execution engine & sandboxes
│   ├── engine/                     # executeCode, executor, queue, resultParser, sandboxConfig
│   ├── runners/                    # Dockerfiles & runners for python, java, cpp
│   └── README.md
│
├── infrastructure/                 # Deployment & orchestration
│   ├── docker/
│   ├── docker-compose.yml
│   ├── .env.example
│   └── deployment/
│
├── testing/                        # Test suites
│   ├── backend/
│   ├── realtime/
│   ├── execution/
│   ├── frontend/
│   └── security/
│
├── docs/                           # Architecture, API & security documentation
│   ├── architecture.md
│   ├── api-spec.md
│   ├── socket-events.md
│   └── security-notes.md
│
├── demo/                           # Demo walkthrough and seed data
│   ├── seed_users.js
│   ├── seed_rooms.js
│   └── demo_script.md
│
├── eval/                           # Security & load evaluation notes
│   ├── sandbox_escape_tests.md
│   └── load_test_notes.md
│
├── README.md
└── CURRENT_STATUS.md
```

## Getting Started

### Prerequisites
- Windows PowerShell
- Docker Desktop configured for Linux containers
- Internet access for initial image pulls and builds
- Git, if you need to clone or update the repository
- Node.js 18+ only for host-based development commands and tests

MongoDB and Redis are started by Docker Compose; they do not need to be installed separately for this workflow.

### First-Time Setup and Startup (Windows / PowerShell)

Open PowerShell in the repository root (`AWT_2026`) and run these commands in order: `.\setup.ps1`, `.\start.ps1`, then `.\verify.ps1`.

- **`setup.ps1`** creates `infrastructure\.env` with unique local secrets if the file is missing. It preserves an existing file. Keep the file private and never commit it.
- **`start.ps1`** builds the application and Python, C++, and Java runner images before changing the running stack. It transfers the runner images to the isolated execution daemon, verifies them, and starts the execution worker.
- **`verify.ps1`** checks all six Compose services, the frontend and backend HTTP endpoints, and all three runner images inside the execution daemon. It is read-only and does not start, stop, or rebuild services.

Open **http://localhost:3000** on the same laptop. The backend health endpoint is **http://localhost:5000/health**.

If startup fails, read the first reported error before retrying. Check that Docker Desktop is running and configured for Linux containers. Initial builds require network access to image registries and package repositories.

### Local Development and Multi-Device Testing

This Docker Desktop configuration is for trusted local development. It warns that inner cgroup enforcement is not production-qualified; passing local health checks does not prove production sandbox security.

Do not expose this development stack to the public internet. On another device, `localhost` refers to that device, not the CodeCollab laptop. LAN access may require configuring the frontend API and realtime URLs, along with the backend's allowed client origin. Keep the execution daemon API (ports 2375/2376), MongoDB, and Redis private; do not expose them to the LAN.
## Running Tests

```bash
# Run all standard automated test suites (21 passing suites, 278 passing tests, 3 skipped)
npm test

# Run opt-in live MongoDB integration tests against local disposable instance (1 suite, 3 tests)
npm run test:integration:mongo

# Run frontend production build check
npm run build
```

---

## Security Notes

Each code submission runs in a fresh, isolated Docker container with:
- No network access (`--network none`)
- CPU and memory limits
- Execution timeout enforcement
- No access to the host filesystem beyond a temporary code file

See [`docs/security-notes.md`](./docs/security-notes.md) for full sandbox hardening details.

---

## Roadmap

- [ ] Auth & session handling
- [ ] Room creation & join-by-link
- [ ] Real-time chat with typing indicators
- [ ] Live shared code editor
- [ ] Multi-language sandboxed execution (Python, Java, C++)
- [ ] Execution history per room/user
- [ ] Cloud deployment

---

## License

This project is for academic purposes as part of a semester-scale full-stack development project.

---
