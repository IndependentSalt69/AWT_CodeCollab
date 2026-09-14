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
- [Node.js](https://nodejs.org/) v18+
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [MongoDB](https://www.mongodb.com/) (local or Atlas)
- [Redis](https://redis.io/) (local or via Docker)
- Git

### Installation

```bash
# Clone the repository
git clone https://github.com/IndependentSalt69/AWT_2026.git
cd AWT_2026

# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

### Environment Variables

Create a `.env` file based on `infrastructure/.env.example`:

```env
PORT=5000
MONGO_URI=mongodb://localhost:27017/codecollab
JWT_SECRET=your_jwt_secret
REDIS_URL=redis://localhost:6379
CLIENT_URL=http://localhost:3000
```

### Running Locally

```bash
# Start backend
cd backend
npm run dev

# Start frontend (in a separate terminal)
cd frontend
npm run dev
```

Or, using Docker Compose from the infrastructure directory:

```bash
docker-compose -f infrastructure/docker-compose.yml up --build
```

Visit `http://localhost:3000` to use the app.

---

## Running Tests

```bash
cd backend
npm test
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
