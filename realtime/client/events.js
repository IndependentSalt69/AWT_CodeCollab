export const SOCKET_EVENTS = {
  ROOM: {
    JOIN: 'room:join',
    LEAVE: 'room:leave',
    USER_JOINED: 'room:user_joined',
    USER_LEFT: 'room:user_left',
  },
  EDITOR: {
    CHANGE: 'editor:change',
    UPDATE: 'editor:update',
    DRIVER_CHANGE: 'editor:driver_change',
    DRIVER_UPDATED: 'editor:driver_updated',
  },
  PRESENCE: {
    PING: 'presence:ping',
    HEARTBEAT: 'presence:heartbeat',
    STATUS: 'presence:status',
    STATUS_CHANGED: 'presence:status_changed',
  },
  CHAT: {
    SEND: 'chat:message_send',
    RECEIVED: 'chat:message_received',
  },
  TYPING: {
    START: 'typing:start',
    STOP: 'typing:stop',
    USER_TYPING: 'typing:user_typing',
    USER_STOPPED: 'typing:user_stopped',
  },
};
