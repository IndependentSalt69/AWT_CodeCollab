# Real-Time Socket Events Specification

This document details the Socket.IO event contract between the CodeCollab client and server.

## 1. Room Events
- **`room:join`** (Client → Server)
  - Payload: `{ roomId: string, user?: { name?: string, id?: string, username?: string }, token?: string }`
  - Acknowledgment: `{ ok: true, roomId: string, socketId: string }` or `{ ok: false, error: string }`.
  - **Database Room Authorization (M0.8):** For database-backed persistent rooms, joining clients must be authenticated (via handshake or `token` payload) and must be an owner or persistent member of the room. Unauthenticated clients receive `{ ok: false, error: 'Authentication required to join this room' }`. Authenticated non-members receive `{ ok: false, error: 'Access denied: You are not a member of this room' }`.
  - Every successful join sends a membership snapshot (`room:members`) to the joining socket before acknowledgment.
- **`room:members`** (Server → Joining Client)
  - Payload: `{ roomId: string, members: Array<{ socketId: string, user: object }> }`
  - Complete membership snapshot including the joining client, sent before the join acknowledgment. The UI excludes its own socket ID when displaying other members.
  - Members are identified by socket ID; separate tabs with the same name remain separate members.
- **`room:user_joined`** (Server → Room Broadcast)
  - Payload: `{ user: object, socketId: string }`
- **`room:leave`** (Client → Server)
  - Payload: `{ roomId: string, user?: object }`
  - Acknowledgment: `{ ok: true, roomId: string, socketId: string }` or `{ ok: false, error: string }`.
  - **Live Session vs. Persistent Membership:** Leaving a live socket room removes the socket from the active Socket.IO room and updates presence/Driver state. It does NOT delete the user's permanent database membership.
- **`room:user_left`** (Server → Room Broadcast)
  - Payload: `{ user: object, socketId: string }`
  - Join/leave notifications go only to other clients in that room. Explicit leave and disconnect both notify remaining members using the stored user.

## 2. Editor Synchronization & Driver Lifecycle Events
- **`editor:change`** (Client/Driver → Server)
  - Payload: `{ roomId: string, code: string, language: string, cursor?: object }`
  - Acknowledgment: `{ ok: true }` or `{ ok: false, error: string }`.
  - Edits are validated (membership, string types, non-empty language) and accepted/broadcast only from the active Driver. Edits from Viewers or non-members are rejected with `{ ok: false, error: string }`.
- **`editor:update`** (Server → Room Broadcast)
  - Payload: `{ code: string, language: string, cursor?: object, updatedBy: string }`
  - Broadcast to peers in the room (sender does not receive its own update). Preserves code, language, cursor, and updatedBy.
- **`editor:driver_change`** (Client/Driver → Server)
  - Payload: `{ roomId: string, newDriverId: string }`
  - Acknowledgment: `{ ok: true, driverId: string }` or `{ ok: false, error: string }`.
  - Allowed by current Driver to transfer control to another active room member.
- **`editor:driver_updated`** (Server → Room Broadcast & Joining Client)
  - Payload: `{ driverId: string, roomId?: string }`
  - Broadcast whenever the active driver changes, or sent to a joining client to declare the current driver.

### Driver Lifecycle State Machine
1. **Room empty**: No driver assigned (`driverState` is `null`).
2. **User A joins**: First user in room automatically becomes **Driver** (`editor:driver_updated` broadcast with User A's ID).
3. **Users B & C join**: Subsequent joiners become **Viewers**; User A remains Driver.
4. **Transfer Driver**: Current Driver transfers control to another room member via `editor:driver_change`. The target user becomes **Driver**; all others become **Viewers**.
5. **Driver Disconnects/Leaves**: Server automatically promotes one of the remaining room members to **Driver** and broadcasts `editor:driver_updated`.
6. **Last User Leaves**: When the room becomes empty, all driver state for the room is completely cleared.

## 3. Execution Lifecycle Events (`execution:*`)
- **`execution:started`** (Server → Room Broadcast)
  - Payload:
    ```typescript
    {
      runId: string;
      roomId: string;
      status: 'queued' | 'running';
      language: string;
      triggeredBy: string;
      createdAt: string;
    }
    ```
  - Broadcast to all room members immediately when a code execution job is enqueued by the Driver.
- **`execution:completed`** (Server → Room Broadcast)
  - Payload:
    ```typescript
    {
      runId: string;
      roomId: string;
      status: 'completed';
      stdout: string;
      stderr: string;
      exitCode: 0;
      executionTimeMs: number;
      language: string;
      triggeredBy: string;
    }
    ```
  - Broadcast to all room members when container execution finishes successfully with exit code 0.
- **`execution:failed`** (Server → Room Broadcast)
  - Payload:
    ```typescript
    {
      runId: string;
      roomId: string;
      status: 'failed' | 'timeout';
      stdout: string;
      stderr: string;
      exitCode: number;
      executionTimeMs: number;
      language: string;
      triggeredBy: string;
      error?: string;
    }
    ```
  - Broadcast to all room members when user code produces runtime exceptions, syntax errors, or container timeouts.

## 4. Presence & Heartbeat Events
- **`presence:ping`** (Client → Server)
  - Payload: `{ roomId: string, user: object }`
- **`presence:heartbeat`** (Server → Room Broadcast)
  - Payload: `{ user: object, timestamp: number }`
- **`presence:status`** (Client → Server)
  - Payload: `{ roomId: string, status: 'online' | 'idle' | 'away', user: object }`
- **`presence:status_changed`** (Server → Room Broadcast)
  - Payload: `{ user: object, status: string }`

## 5. Chat Events
- **`chat:message_send`** (Client → Server)
  - Payload: `{ roomId: string, message: { text: string, sender: object } }`
- **`chat:message_received`** (Server → Room Broadcast)
  - Payload: `{ text: string, sender: object, timestamp: string, socketId: string }`

## 6. Typing Indicator Events
- **`typing:start`** (Client → Server)
  - Payload: `{ roomId: string, user: object }`
- **`typing:user_typing`** (Server → Room Broadcast)
  - Payload: `{ user: object }`
- **`typing:stop`** (Client → Server)
  - Payload: `{ roomId: string, user: object }`
- **`typing:user_stopped`** (Server → Room Broadcast)
  - Payload: `{ user: object }`

