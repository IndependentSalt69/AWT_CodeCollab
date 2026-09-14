import { io } from 'socket.io-client';

let socketInstance = null;

export const initClientSocket = (serverUrl = 'http://localhost:5000') => {
  if (!socketInstance) {
    socketInstance = io(serverUrl, {
      autoConnect: false,
      transports: ['websocket', 'polling'],
    });
  }
  return socketInstance;
};

export const getClientSocket = () => {
  return socketInstance || initClientSocket();
};
