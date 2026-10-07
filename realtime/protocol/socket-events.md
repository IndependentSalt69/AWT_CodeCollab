# Real-Time Socket Events Specification

This document details the Socket.IO event contract between the CodeCollab client and server.

## 1. Room Events
- **`room:join`** (Client → Server)
  - Payload: `{ roomId: string, user: { name?: string, id?: string, username?: string } }`
  - Acknowledgment: `{ ok: true, roomId: string, socketId: string }` or `{ ok: false, error: string }` for an invalid room ID.
  - Every successful join (including a repeated join) sends a snapshot to the joining socket. Repeated joins do not broadcast another arrival.
- **`room:members`** (Server → Joining Client)
  - Payload: `{ roomId: string, members: Array<{ socketId: string, user: object }> }`
  - Complete membership snapshot including the joining client, sent before the join acknowledgment. The UI excludes its own socket ID when displaying other members.
  - Members are identified by socket ID; separate tabs with the same name remain separate members. The current in-memory adapter tracks membership on one server process.
- **`room:user_joined`** (Server → Room Broadcast)
  - Payload: `{ user: object, socketId: string }`
- **`room:leave`** (Client → Server)
  - Payload: `{ roomId: string }` (a legacy `user` field is accepted but ignored).
  - Acknowledgment: `{ ok: true, roomId: string, socketId: string }` or `{ ok: false, error: string }` for an invalid room ID.
- **`room:user_left`** (Server → Room Broadcast)
  - Payload: `{ user: object, socketId: string }`
  - Join/leave notifications go only to other clients in that room and preserve the user object provided on join (including `name`, if supplied).
  - Explicit leave and disconnect both notify remaining members using the stored user. Leaving an unjoined room has no broadcast; an explicit leave followed by disconnect does not duplicate the notification.

## 2. Editor Synchronization Events
- **`editor:change`** (Client/Driver → Server)
  - Payload: `{ roomId: string, code: string, language: string, cursor?: object }`
- **`editor:update`** (Server → Room Broadcast)
  - Payload: `{ code: string, language: string, cursor?: object, updatedBy: string }`
- **`editor:driver_change`** (Client/Owner → Server)
  - Payload: `{ roomId: string, newDriverId: string }`
- **`editor:driver_updated`** (Server → Room Broadcast)
  - Payload: `{ driverId: string }`

## 3. Presence & Heartbeat Events
- **`presence:ping`** (Client → Server)
  - Payload: `{ roomId: string, user: object }`
- **`presence:heartbeat`** (Server → Room Broadcast)
  - Payload: `{ user: object, timestamp: number }`
- **`presence:status`** (Client → Server)
  - Payload: `{ roomId: string, status: 'online' | 'idle' | 'away', user: object }`
- **`presence:status_changed`** (Server → Room Broadcast)
  - Payload: `{ user: object, status: string }`

## 4. Chat Events
- **`chat:message_send`** (Client → Server)
  - Payload: `{ roomId: string, message: { text: string, sender: object } }`
- **`chat:message_received`** (Server → Room Broadcast)
  - Payload: `{ text: string, sender: object, timestamp: string, socketId: string }`

## 5. Typing Indicator Events
- **`typing:start`** (Client → Server)
  - Payload: `{ roomId: string, user: object }`
- **`typing:user_typing`** (Server → Room Broadcast)
  - Payload: `{ user: object }`
- **`typing:stop`** (Client → Server)
  - Payload: `{ roomId: string, user: object }`
- **`typing:user_stopped`** (Server → Room Broadcast)
  - Payload: `{ user: object }`
