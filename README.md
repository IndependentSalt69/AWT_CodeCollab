# CodeCollab — Collaborative Online Coding Platform

A full-stack web application that lets multiple users create shared coding rooms, communicate via real-time chat, and compile/execute code together in Python, Java, and C++ — all from the browser, with no third-party compiler APIs.

CodeCollab combines the functionality of an online compiler with a real-time messaging system into a single integrated platform, giving developers, students, and interviewers a live space to code, test, and collaborate together.

---

## 🚀 Problem Statement

Developers often need to collaborate on code in real time — for pair programming, technical interviews, teaching, or debugging together — but existing solutions either rely on third-party platforms, lack live communication, or don't support secure server-side code execution. CodeCollab builds this experience from the ground up.

---

## ✨ Features

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

## 🛠️ Tech Stack

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

## 📁 Project Structures

codecollab/
├── docker-compose.yml
├── client/ # React + TypeScript frontend
│ └── src/
│ ├── components/ # editor, chat, terminal, room UI
│ ├── pages/ # Login, Signup, Dashboard, Room, History
│ ├── hooks/ # useSocket, useAuth, useRoom
│ ├── context/ # AuthContext, SocketContext
│ └── services/ # REST + socket client setup
├── server/ # Node.js + Express backend
│ └── src/
│ ├── models/ # User, Room, Message, ExecutionRun
│ ├── routes/ # /auth, /rooms, /execute, /history
│ ├── controllers/ # Route handlers
│ ├── sockets/ # chat, editorSync, presence, typing
│ └── execution/ # Docker-based code execution engine
├── runners/ # Dockerfiles for Python, Java, C++ sandboxes
├── docs/ # Architecture decisions, API spec
├── demo/ # Seed data & demo walkthrough
└── eval/ # Load & security testing notes

---

## ⚙️ Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) v18+
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [MongoDB](https://www.mongodb.com/) (local or Atlas)
- [Redis](https://redis.io/) (local or via Docker)
- Git

### Installation

```bash
# Clone the repository
git clone https://github.com/<your-username>/codecollab.git
cd codecollab

# Install backend dependencies
cd server
npm install

# Install frontend dependencies
cd ../client
npm install
```

### Environment Variables

Create a `.env` file in `server/` based on `.env.example`:

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
cd server
npm run dev

# Start frontend (in a separate terminal)
cd client
npm start
```

Or, once Docker Compose is configured:

```bash
docker-compose up --build
```

Visit `http://localhost:3000` to use the app.

---

## 🧪 Running Tests

```bash
cd server
npm test
```

---

## 🔒 Security Notes

Each code submission runs in a fresh, isolated Docker container with:
- No network access (`--network none`)
- CPU and memory limits
- Execution timeout enforcement
- No access to the host filesystem beyond a temporary code file

See [`docs/security-notes.md`](./docs/security-notes.md) for full sandbox hardening details.

---

## 🗺️ Roadmap

- [ ] Auth & session handling
- [ ] Room creation & join-by-link
- [ ] Real-time chat with typing indicators
- [ ] Live shared code editor
- [ ] Multi-language sandboxed execution (Python, Java, C++)
- [ ] Execution history per room/user
- [ ] Cloud deployment

---

## 📄 License

This project is for academic purposes as part of a semester-scale full-stack development project.

---
