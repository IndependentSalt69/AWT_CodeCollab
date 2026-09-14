# Real-Time Socket Events Specification

This document details the Socket.IO event contract between the CodeCollab client and server.

## 1. Room Events
- **`room:join`** (Client → Server)
  - Payload: `{ roomId: string, user: { id: string, username: string } }`
- **`room:user_joined`** (Server → Room Broadcast)
  - Payload: `{ user: { id: string, username: string }, socketId: string }`
- **`room:leave`** (Client → Server)
  - Payload: `{ roomId: string, user: { id: string, username: string } }`
- **`room:user_left`** (Server → Room Broadcast)
  - Payload: `{ user: { id: string, username: string }, socketId: string }`

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
