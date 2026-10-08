# CodeCollab Frontend Status

**Audit Date:** October 8, 2026  
**Status Version:** 1.0.0  
**Source of Truth:** Current workspace filesystem (`frontend/`, `realtime/`, `backend/`)

---

## 1. Current Frontend Overview

The CodeCollab frontend is currently a **functional monolithic development harness** built on **React 18 + TypeScript + Vite**. It communicates in real-time with the Node.js / Socket.IO backend to provide live room membership, driver role management, and a presence activity feed.

### Architecture vs. Current State Breakdown

- **Actual Implementation:**
  - A single-component harness ([`frontend/src/App.tsx`](file:///d:/AWT_CodeCollab/frontend/src/App.tsx)) mounted via [`frontend/src/main.tsx`](file:///d:/AWT_CodeCollab/frontend/src/main.tsx).
  - Direct consumption of the shared real-time client singleton ([`realtime/client/socket.js`](file:///d:/AWT_CodeCollab/realtime/client/socket.js)) and event constants ([`realtime/client/events.js`](file:///d:/AWT_CodeCollab/realtime/client/events.js)).
  - Live socket connection, join/leave management for room `test-room`, dynamic username generation (`User-xxxxx`), real-time active users list with Driver (`👑`) vs. Viewer (`👀`) badges, driver transfer controls, and a live presence activity feed.
  - Backend health checking against `/health`.

- **Planned Architecture:**
  - Modular component hierarchy under `frontend/src/components/` (`editor/`, `chat/`, `room/`, `terminal/`).
  - Multi-page application structure under `frontend/src/pages/` (`Login/`, `Signup/`, `Dashboard/`, `Room/`, `History/`).
  - Centralized state management via Context providers (`SocketContext`, `AuthContext`, `RoomContext`) and custom hooks (`useSocket`, `useEditor`, `usePresence`).
  - Client-side routing via `react-router-dom`.
  - Integrated Monaco editor (`@monaco-editor/react`) for multi-language code editing.

- **Temporary Test / Demo Code:**
  - Hardcoded room identifier (`test-room`) in `App.tsx`.
  - Ephemeral randomized user names generated on client mount.
  - Hardcoded backend URL (`http://localhost:5000`).
  - Inline CSS styling for development layout.

---

## 2. Directory Tree

```
frontend/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── src/
    ├── App.tsx
    ├── main.tsx
    ├── components/
    │   ├── chat/
    │   │   └── .gitkeep
    │   ├── editor/
    │   │   └── .gitkeep
    │   ├── room/
    │   │   └── .gitkeep
    │   └── terminal/
    │       └── .gitkeep
    ├── context/
    │   └── .gitkeep
    ├── hooks/
    │   └── .gitkeep
    ├── pages/
    │   ├── Dashboard/
    │   │   └── .gitkeep
    │   ├── History/
    │   │   └── .gitkeep
    │   ├── Login/
    │   │   └── .gitkeep
    │   ├── Room/
    │   │   └── .gitkeep
    │   └── Signup/
    │       └── .gitkeep
    ├── services/
    │   └── .gitkeep
    └── types/
        └── .gitkeep
```

---

## 3. File-by-File Responsibility Map

| File / Directory | Current Purpose | Implementation Status | Owner | Notes |
|---|---|---|---|---|
| [`frontend/index.html`](file:///d:/AWT_CodeCollab/frontend/index.html) | Root HTML shell mounting `<div id="root"></div>` | **Working** | Frontend | Loads module `/src/main.tsx`. |
| [`frontend/package.json`](file:///d:/AWT_CodeCollab/frontend/package.json) | Package dependencies and NPM scripts | **Working** | Frontend | Vite configured for dev/build; contains leftover legacy CRA scripts. |
| [`frontend/tsconfig.json`](file:///d:/AWT_CodeCollab/frontend/tsconfig.json) | TypeScript compiler options | **Working** | Frontend | Configured for ES2020/ESNext bundler; includes `src` and `../realtime/client`. |
| [`frontend/vite.config.ts`](file:///d:/AWT_CodeCollab/frontend/vite.config.ts) | Vite build tool configuration | **Working** | Frontend | Uses `@vitejs/plugin-react`. |
| [`frontend/src/main.tsx`](file:///d:/AWT_CodeCollab/frontend/src/main.tsx) | React application entry point | **Working** | Frontend | Renders `<App />` into DOM root within `React.StrictMode`. |
| [`frontend/src/App.tsx`](file:///d:/AWT_CodeCollab/frontend/src/App.tsx) | Monolithic test harness and UI | **Working** *(Prototype)* | Frontend | Manages health polling, socket lifecycle, room state, active users, driver transfer, and presence feed. |
| `frontend/src/components/chat/` | Room chat UI component | **Placeholder** | Frontend | Contains only `.gitkeep`. |
| `frontend/src/components/editor/` | Code editor component | **Placeholder** | Frontend | Contains only `.gitkeep`. Monaco is installed but not imported. |
| `frontend/src/components/room/` | Room layout / controls component | **Placeholder** | Frontend | Contains only `.gitkeep`. |
| `frontend/src/components/terminal/` | Output & execution terminal component | **Placeholder** | Frontend | Contains only `.gitkeep`. |
| `frontend/src/context/` | React Context providers | **Placeholder** | Frontend | Contains only `.gitkeep`. No `SocketContext` or `AuthContext` yet. |
| `frontend/src/hooks/` | Reusable custom React hooks | **Placeholder** | Frontend | Contains only `.gitkeep`. |
| `frontend/src/pages/Dashboard/` | User dashboard page | **Placeholder** | Frontend | Contains only `.gitkeep`. |
| `frontend/src/pages/History/` | Execution history page | **Placeholder** | Frontend | Contains only `.gitkeep`. |
| `frontend/src/pages/Login/` | Authentication Login page | **Placeholder** | Frontend | Contains only `.gitkeep`. |
| `frontend/src/pages/Room/` | Collaborative Room page | **Placeholder** | Frontend | Contains only `.gitkeep`. |
| `frontend/src/pages/Signup/` | User registration page | **Placeholder** | Frontend | Contains only `.gitkeep`. |
| `frontend/src/services/` | REST API service layer | **Placeholder** | Frontend | Contains only `.gitkeep`. Axios installed but unconfigured. |
| `frontend/src/types/` | Shared TypeScript type declarations | **Placeholder** | Frontend | Contains only `.gitkeep`. Types currently declared locally in `App.tsx`. |

---

## 4. Package / Tooling Status

### Installed Dependencies ([`frontend/package.json`](file:///d:/AWT_CodeCollab/frontend/package.json))

- **React:** `^18.2.0` (Core UI library)
- **React DOM:** `^18.2.0` (DOM renderer)
- **TypeScript:** `^5.3.3` (with `@types/react` `^18.2.55`, `@types/react-dom` `^18.2.19`)
- **Vite:** `^8.3.0` (with `@vitejs/plugin-react` `^6.1.1`)
- **Socket.io Client:** `^4.8.3` (Active dependency for real-time layer)
- **Monaco Editor React:** `@monaco-editor/react` `^4.6.0` (*Installed in `node_modules`, but unimported in application code*)
- **Axios:** `^1.6.7` (*Installed in `node_modules`, but unimported in application code*)

### Available Scripts

| Script | Command | Status | Notes |
|---|---|---|---|
| `dev` | `vite` | **Working** | Runs local dev server on `http://localhost:5173`. |
| `build` | `tsc && vite build` | **Working** | Compiles TypeScript and builds production bundle to `frontend/dist`. |
| `preview` | `vite preview` | **Working** | Previews production build locally. |
| `start` | `react-scripts start` | **Broken / Legacy** | Leftover Create-React-App script (`react-scripts` not installed). |
| `test` | `react-scripts test` | **Broken / Legacy** | Leftover CRA script (`react-scripts` not installed). |

### Root Workspace Tooling

- `npm run test:realtime` runs `jest --runInBand testing/realtime` at workspace root.
- `npm run build` triggers `npm run build --workspace frontend`.

---

## 5. Application Entry Flow

```
frontend/index.html
   │ (Mounts <div id="root"> and loads /src/main.tsx)
   ▼
frontend/src/main.tsx
   │ (Initializes ReactDOM root and wraps <App /> in React.StrictMode)
   ▼
frontend/src/App.tsx
   │
   ├── 1. fetch('http://localhost:5000/health') -> sets backendStatus
   ├── 2. initClientSocket('http://localhost:5000') -> connects Socket.io singleton
   ├── 3. Generates ephemeral name (User-xxxxx)
   ├── 4. Binds socket listeners (connect, disconnect, room:members, room:user_joined,
   │       room:user_left, editor:driver_updated)
   ├── 5. On connect: emits 'room:join' ({ roomId: 'test-room', user })
   └── 6. Renders live status cards, Active Users list, and Recent Activity feed
```

---

## 6. Current `App.tsx` Responsibilities

[`frontend/src/App.tsx`](file:///d:/AWT_CodeCollab/frontend/src/App.tsx) currently acts as a central monolithic container managing all frontend behaviors:

1. **Backend Health Polling:** Calls `http://localhost:5000/health` on mount.
2. **Socket.io Connection Lifecycle:** Listens for `connect`, `disconnect`, `connect_error`.
3. **Room Joining & Membership State:** Manages `roomStatus` and `roomMembers` list from `room:members`, `room:user_joined`, and `room:user_left`.
4. **Presence Activity Feed:** Maintains an in-memory queue (`activityFeed`) capped at 20 events for join/leave notifications.
5. **Driver Role Tracking:** Listens to `editor:driver_updated` to store `driverId` and calculate `isDriver = myId && driverId === myId`.
6. **Driver Transfer Execution:** Emits `editor:driver_change` when the driver clicks "Transfer Driver" next to another member.
7. **UI Layout & Styling:** Renders the header, system status cards, Active Users list, and Recent Activity feed using inline CSS styles.

*Recommended future refactoring target:* Extract socket networking into `context/SocketContext.tsx`, room state into `context/RoomContext.tsx`, and feed UI into `components/room/PresenceActivityFeed.tsx`.

---

## 7. Realtime Client Integration

The frontend integrates directly with the shared client scripts in `realtime/client/`:

```
Frontend (src/App.tsx)
       │
       ▼
realtime/client/socket.js  ───>  initClientSocket() returns io() singleton
realtime/client/events.js  ───>  SOCKET_EVENTS dictionary
       │
       ▼
Socket.IO Server (Backend :5000)
```

### Event Consumption Map

| Namespace | Event Constant | Emitted by Frontend? | Consumed by Frontend? | Handler in `App.tsx` |
|---|---|---|---|---|
| **Room** | `SOCKET_EVENTS.ROOM.JOIN` | **Yes** (on connect) | — | Joins `test-room` with username |
| **Room** | `SOCKET_EVENTS.ROOM.LEAVE` | **Yes** (on unmount) | — | Leaves `test-room` |
| **Room** | `SOCKET_EVENTS.ROOM.MEMBERS` | — | **Yes** | Populates `roomMembers` snapshot |
| **Room** | `SOCKET_EVENTS.ROOM.USER_JOINED` | — | **Yes** | Adds peer to `roomMembers` & pushes to `activityFeed` |
| **Room** | `SOCKET_EVENTS.ROOM.USER_LEFT` | — | **Yes** | Removes peer from `roomMembers` & pushes to `activityFeed` |
| **Editor** | `SOCKET_EVENTS.EDITOR.DRIVER_UPDATED` | — | **Yes** | Updates `driverId` |
| **Editor** | `SOCKET_EVENTS.EDITOR.DRIVER_CHANGE` | **Yes** (on button click) | — | Requests driver role transfer |
| **Editor** | `SOCKET_EVENTS.EDITOR.CHANGE` | *No* | — | *Not yet integrated in frontend* |
| **Editor** | `SOCKET_EVENTS.EDITOR.UPDATE` | — | *No* | *Not yet integrated in frontend* |
| **Presence** | `SOCKET_EVENTS.PRESENCE.*` | *No* | *No* | *Not yet integrated in frontend* |
| **Chat** | `SOCKET_EVENTS.CHAT.*` | *No* | *No* | *Not yet integrated in frontend* |
| **Typing** | `SOCKET_EVENTS.TYPING.*` | *No* | *No* | *Not yet integrated in frontend* |

---

## 8. Current Room / Collaboration UI

The current UI rendered in `App.tsx` provides:

- **System Status Bar:** Displays live indicators for Backend Status (`ok`), Socket Status (`connected`), Room Status (`joined: test-room`), Active Role (`👑 Driver` / `👀 Viewer`), and Active Driver Socket ID.
- **Active Users List:** Displays the local user (`You`) and all connected peer users with their current driver/viewer designations. When the local user is the Driver, "Transfer" buttons appear next to all viewer peers.
- **Recent Activity Feed:** Chronologically lists member arrivals (`🟢 <name> joined the room`) and departures (`🔴 <name> left the room`) with formatted timestamps. Local client events are suppressed from echoing in the feed.

*Note:* This UI is functional for testing presence and driver state, but is currently a test harness rather than a production room layout.

---

## 9. Editor Status

> [!IMPORTANT]
> Although `@monaco-editor/react` is listed in `package.json` dependencies and the backend real-time synchronization contract is fully hardened and tested, **no editor component or editor logic exists in the frontend source code today.**

| Capability | Status | Evidence / Notes |
|---|---|---|
| **Monaco Package** | **Installed** | `@monaco-editor/react: ^4.6.0` present in `package.json`. |
| **Editor Component** | **Absent** | `frontend/src/components/editor/` contains only `.gitkeep`. |
| **Editor State in React** | **Absent** | No `code`, `language`, or `cursor` state variables exist in `App.tsx`. |
| **Language Selection** | **Absent** | No UI dropdown or state exists for language switching. |
| **Read-only Toggle** | **Absent** | `isDriver` boolean exists in `App.tsx`, but is not attached to an editor instance. |
| **`editor:change` Emission** | **Absent** | Frontend does not emit code changes. |
| **`editor:update` Reception** | **Absent** | Frontend does not listen for incoming code changes. |
| **Cursor Sync** | **Absent** | No cursor synchronization logic exists in the frontend. |
| **Multi-browser Code Sync** | **Backend Ready / Frontend Missing** | Backend server and tests pass, but cannot be used in browser without an editor component. |

---

## 10. Frontend State Management

- **Context Providers (`frontend/src/context/`):** Empty (`.gitkeep`). No React Contexts exist.
- **Custom Hooks (`frontend/src/hooks/`):** Empty (`.gitkeep`). No custom hooks exist.
- **API Services (`frontend/src/services/`):** Empty (`.gitkeep`). Axios is installed but unused. Direct `fetch()` is used in `App.tsx`.
- **Type Definitions (`frontend/src/types/`):** Empty (`.gitkeep`). `RoomMember` and `ActivityItem` types are defined inline within `App.tsx`.

---

## 11. Pages / Navigation

- **Routing:** **Absent**. `react-router-dom` is not installed; no `<BrowserRouter>`, `<Routes>`, or `<Route>` elements exist.
- **Page Placeholders:**
  - `frontend/src/pages/Login/` (`.gitkeep`) — **Placeholder**
  - `frontend/src/pages/Signup/` (`.gitkeep`) — **Placeholder**
  - `frontend/src/pages/Dashboard/` (`.gitkeep`) — **Placeholder**
  - `frontend/src/pages/Room/` (`.gitkeep`) — **Placeholder**
  - `frontend/src/pages/History/` (`.gitkeep`) — **Placeholder**

---

## 12. Backend / API Integration

| Endpoint | Subsystem | Frontend Status | Implementation |
|---|---|---|---|
| `GET /health` | Backend Core | **Implemented** | Queried via `fetch()` on `App.tsx` mount. |
| `POST /api/auth/register` | Backend Auth | **Missing / Unused** | Route exists in backend plans, no frontend call. |
| `POST /api/auth/login` | Backend Auth | **Missing / Unused** | Route exists in backend plans, no frontend call. |
| `POST /api/rooms` | Backend Room | **Missing / Unused** | No REST room creation call in frontend. |
| `GET /api/rooms/:id` | Backend Room | **Missing / Unused** | No REST room lookup call in frontend. |
| `POST /api/execute` | Code Execution | **Missing / Unused** | No code execution call in frontend. |
| `GET /api/history` | Execution History | **Missing / Unused** | No history fetch call in frontend. |

---

## 13. Current Verification

### Verified by Execution

1. **Frontend Dev Server:** Running `npm run dev` in `frontend/` starts Vite on `http://localhost:5173` without compile errors.
2. **Production Bundle Build:** Running `npm run build` (`tsc && vite build`) succeeds in ~60ms and produces clean output in `frontend/dist/`.
3. **Backend Health Endpoint:** `http://localhost:5000/health` returns `{ "status": "ok", "timestamp": "..." }`.
4. **Realtime Socket Connection:** `socket.io-client` successfully connects to `http://localhost:5000`.
5. **Room Joining & Presence:** Multi-client socket joining and member list synchronization verified by automated test suites.
6. **Driver Role & Failover:** Active driver assignment, transfer, and disconnect failover verified by [`testing/realtime/driver.test.js`](file:///d:/AWT_CodeCollab/testing/realtime/driver.test.js).
7. **Presence Activity Feed:** Join/leave activity generation and self-suppression verified by [`testing/realtime/presence_activity.test.js`](file:///d:/AWT_CodeCollab/testing/realtime/presence_activity.test.js).
8. **Editor Sync Contract:** Driver edit authority, viewer rejection, language/cursor propagation, and room isolation verified by [`testing/realtime/editor_sync.test.js`](file:///d:/AWT_CodeCollab/testing/realtime/editor_sync.test.js) (16/16 tests passing).

### Inferred from Source Code

1. `@monaco-editor/react` package is ready for direct import into React components without extra webpack/rollup plugins.
2. Axios is available in `node_modules` for constructing REST API services.

---

## 14. Current Frontend Risks / Technical Debt

| Risk / Debt | Severity | Impact | Recommendation |
|---|---|---|---|
| **Monolithic `App.tsx`** | **High** | Networking, state, and UI logic are tightly coupled in one file. | Extract into `SocketContext`, custom hooks, and discrete UI components during upcoming milestones. |
| **No Editor Component** | **High** | Monaco is not wired up; users cannot write or sync code in the UI. | Implement `CodeEditor.tsx` in milestone M0.4c. |
| **No Client-Side Routing** | **Medium** | Cannot navigate between `/login`, `/dashboard`, and `/room/:id`. | Install `react-router-dom` when multi-page navigation is introduced. |
| **Hardcoded Room & URL** | **Medium** | Room ID is locked to `test-room` and backend is locked to `localhost:5000`. | Utilize URL params (`/room/:roomId`) and `import.meta.env.VITE_BACKEND_URL`. |
| **No Frontend Component Tests** | **Medium** | No Jest/Vitest test runner configured inside `frontend/`. | Configure Vitest + React Testing Library for frontend component tests. |
| **Legacy CRA Scripts in `package.json`** | **Low** | `start` and `test` scripts refer to `react-scripts` which is absent. | Clean up `scripts` in `frontend/package.json` to only reference Vite / Vitest. |

---

## 15. Frontend ↔ Other Subsystem Boundaries

| Frontend Area | External Dependency | Interface | Current State |
|---|---|---|---|
| **Health Check** | Backend HTTP Server | REST `GET /health` | **Connected & Active** |
| **Realtime Sockets** | Realtime Server (`:5000`) | Socket.IO protocol via `realtime/client/socket.js` | **Connected & Active** |
| **Room Management** | Backend Rooms / Socket.IO | `room:join`, `room:leave`, `room:members` | **Connected & Active** |
| **Editor Sync** | Realtime Server Editor Handlers | `editor:change`, `editor:update`, `editor:driver_*` | **Protocol ready, UI absent** |
| **Code Execution** | Execution Engine (`execution/`) | REST `POST /api/execute` | **Not yet connected** |
| **User Authentication** | Backend Auth Routes | REST `POST /api/auth/*` | **Not yet connected** |

---

## 16. Frontend Ownership Map

| Path | Frontend Owner? | Shared? | Other Owner | Notes |
|---|---|---|---|---|
| `frontend/src/*` | **Yes** | No | — | Entirely owned by frontend. |
| `frontend/package.json` | **Yes** | No | — | Owned by frontend. |
| `frontend/vite.config.ts` | **Yes** | No | — | Owned by frontend. |
| `frontend/tsconfig.json` | **Yes** | No | — | Owned by frontend. |
| `realtime/client/socket.js` | Partial | **Yes** | Realtime Subsystem | Client connection singleton consumed by frontend. |
| `realtime/client/events.js` | Partial | **Yes** | Realtime Subsystem | Event constant contract shared between client & server. |
| `realtime/protocol/socket-events.md` | Read-only | **Yes** | Realtime Subsystem | Protocol specification document. |
| `backend/src/*` | **No** | No | Backend Subsystem | Backend API & server entry points. |
| `execution/*` | **No** | No | Execution Subsystem | Compiler/execution sandbox engine. |

---

## 17. Recommended Next Frontend Milestone

### Recommended Milestone: **M0.4c — Monaco Editor Integration**

The backend real-time synchronization contract (M0.4b) is fully hardened, tested, and passing. The socket layer already supports driver/viewer restrictions, language switching, and cursor propagation. Therefore, the next logical step is integrating `@monaco-editor/react` into the frontend.

#### Objective
Mount the Monaco Editor inside `App.tsx` (or a dedicated component `components/editor/CodeEditor.tsx`), bind its document model to local React state, enforce driver editing vs. viewer read-only mode, and synchronize code live via `editor:change` and `editor:update`.

#### Files Affected
- `frontend/src/components/editor/CodeEditor.tsx` (*New component*)
- `frontend/src/App.tsx` (*Import and layout embedding*)

#### Dependencies
- `@monaco-editor/react` (already installed)
- `realtime/client/events.js` (`SOCKET_EVENTS.EDITOR.*`)
- `realtime/client/socket.js`

#### Expected Behavior
1. Active Driver can type freely in Monaco; Viewers have `readOnly: true` applied to Monaco editor options.
2. When the Driver types, `editor:change` is emitted (with debounce/throttling).
3. When Viewers receive `editor:update`, the Monaco editor model value updates without jumping the cursor.
4. Language selector allows switching language (`python`, `javascript`, `cpp`, `java`) and broadcasts language change.
5. When driver role is transferred, Monaco editor options dynamically toggle `readOnly` state for both users.

#### Verification Criteria
- Open two browser windows on `http://localhost:5173`.
- Verify Driver window can type and code appears in real time in Viewer window.
- Verify Viewer window is locked to read-only.
- Transfer driver to Viewer window and verify editing permissions invert instantly.

---

## 18. Final Status Summary

### What is Working
- Vite dev server & production bundling (`tsc && vite build`).
- Socket.io connection to backend server.
- Room join and leave protocol for `test-room`.
- Active Users list with Driver (`👑`) vs. Viewer (`👀`) badges.
- Driver transfer execution via socket acknowledgment.
- Real-time Presence Activity Feed with join/leave notifications.
- Complete backend socket test suite (16/16 tests passing across 4 test suites).

### What is Implemented but Temporary
- `App.tsx` acting as a single monolithic harness holding networking, state, and UI.
- Hardcoded room ID (`test-room`) and generated username (`User-xxxxx`).
- Hardcoded backend endpoint URL.

### What is Partially Implemented
- Socket event listeners (Room & Driver events consumed; Editor code sync, Chat, and Typing events unconsumed).

### What is Missing
- Monaco editor component and code synchronization UI.
- Language selection controls.
- Client-side routing (`react-router-dom`).
- Authentication pages and forms (`Login`, `Signup`).
- Chat, Terminal, and Dashboard components.
- React Context providers and custom hooks.

### What is Broken
- CRA scripts (`"start": "react-scripts start"`, `"test": "react-scripts test"`) in `frontend/package.json`.

---

### Current Frontend Maturity Scores (0–5 Scale)

| Subsystem / Area | Score | Rating | Reason |
|---|---|---|---|
| **Tooling & Build** | **4 / 5** | Stable | Vite + TypeScript build cleanly in <100ms; minor CRA script cleanup needed. |
| **Application Shell** | **2 / 5** | Partially Functional | Single-page harness renders status and user cards; lacks modular layout. |
| **Routing** | **0 / 5** | Absent | No client-side router installed or configured. |
| **Room UI** | **2 / 5** | Partially Functional | Active users and presence feed work; chat, terminal, and room controls missing. |
| **Realtime Integration** | **3 / 5** | Functional but Incomplete | Room and Driver events fully hooked up; Editor and Chat events pending. |
| **Editor** | **0 / 5** | Absent | Monaco package is installed but completely unintegrated in application code. |
| **State Management** | **1 / 5** | Prototype | Local `useState` in `App.tsx`; no React Contexts or custom hooks. |
| **API Integration** | **1 / 5** | Prototype | `/health` check working; auth, room, and execution APIs missing. |
| **Frontend Testing** | **0 / 5** | Absent | No component test runner or frontend tests configured. |

---

## 19. Recommended First Concrete Action

**Action Item:** Create [`frontend/src/components/editor/CodeEditor.tsx`](file:///d:/AWT_CodeCollab/frontend/src/components/editor/CodeEditor.tsx) utilizing `@monaco-editor/react`.  
Embed it in `App.tsx` with `readOnly={!isDriver}`, connect `onChange` to emit `SOCKET_EVENTS.EDITOR.CHANGE`, and subscribe to `SOCKET_EVENTS.EDITOR.UPDATE` to update the editor content for viewers.
