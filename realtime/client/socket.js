import { io } from 'socket.io-client';

let socketInstance = null;

export const initClientSocket = (serverUrl = 'http://localhost:5000', options = {}) => {
  if (!socketInstance) {
    socketInstance = io(serverUrl, {
      autoConnect: false,
      transports: ['websocket', 'polling'],
      ...options,
    });
  } else if (options && Object.keys(options).length > 0) {
    if (options.auth) {
      socketInstance.auth = { ...socketInstance.auth, ...options.auth };
    }
  }
  return socketInstance;
};

export const getClientSocket = () => {
  return socketInstance || initClientSocket();
};

export const resetClientSocket = () => {
  if (socketInstance) {
    socketInstance.disconnect();
    socketInstance = null;
  }
};
