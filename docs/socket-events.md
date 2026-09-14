# Socket Events Specification

Please refer to the detailed protocol specification in [`realtime/protocol/socket-events.md`](../realtime/protocol/socket-events.md).

## Overview
- **Rooms**: Handled under `room:*` namespace
- **Editor Sync**: Broadcasts code updates and active driver control under `editor:*`
- **Presence**: Real-time member list and heartbeat under `presence:*`
- **Chat & Typing**: Messaging and live typing indicators under `chat:*` and `typing:*`
