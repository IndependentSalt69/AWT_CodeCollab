import React, { useEffect, useState } from 'react';
import {
  initClientSocket,
} from '../../realtime/client/socket';
import {
  SOCKET_EVENTS,
} from '../../realtime/client/events';

type RoomMember = {
  socketId: string;
  user?: { name?: string; username?: string };
};

export default function App() {
  const [backendStatus, setBackendStatus] = useState<string>('checking...');
  const [socketStatus, setSocketStatus] = useState<string>('disconnected');
  const [roomStatus, setRoomStatus] = useState<string>('not joined');
  const [roomMembers, setRoomMembers] = useState<RoomMember[]>([]);

  useEffect(() => {
    fetch('http://localhost:5000/health')
      .then((res) => res.json())
      .then((data) => setBackendStatus(data.status || 'connected'))
      .catch(() => setBackendStatus('offline'));

    const socket = initClientSocket('http://localhost:5000');

    const roomId = 'test-room';
    const user = {
      name: `User-${Math.random().toString(36).slice(2, 7)}`,
    };

    const handleConnect = () => {
      console.log('Socket connected:', socket.id);
      setSocketStatus('connected');

      socket.emit(
        SOCKET_EVENTS.ROOM.JOIN,
        { roomId, user },
        (response: {
          ok: boolean;
          roomId?: string;
          socketId?: string;
          error?: string;
        }) => {
          if (response?.ok) {
            setRoomStatus(`joined: ${response.roomId}`);
          } else {
            setRoomStatus(`join failed: ${response?.error || 'unknown error'}`);
          }
        }
      );
    };

    const handleDisconnect = (reason: string) => {
      console.log('Socket disconnected:', reason);
      setSocketStatus('disconnected');
      setRoomStatus('not joined');
      setRoomMembers([]);
    };

    const handleConnectError = (error: Error) => {
      console.error('Socket connection error:', error.message);
      setSocketStatus('error');
    };

    const handleMembers = (snapshot: { roomId: string; members: RoomMember[] }) => {
      if (snapshot.roomId === roomId) {
        setRoomMembers(snapshot.members.filter((member) => member.socketId !== socket.id));
      }
    };

    const handleUserJoined = (member: RoomMember) => {
      setRoomMembers((current) =>
        [...current.filter((existing) => existing.socketId !== member.socketId), member]
      );
    };

    const handleUserLeft = ({ socketId }: RoomMember) => {
      setRoomMembers((current) =>
        current.filter((member) => member.socketId !== socketId)
      );
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    socket.on(SOCKET_EVENTS.ROOM.MEMBERS, handleMembers);

    socket.on(
      SOCKET_EVENTS.ROOM.USER_JOINED,
      handleUserJoined
    );

    socket.on(
      SOCKET_EVENTS.ROOM.USER_LEFT,
      handleUserLeft
    );

    if (!socket.connected) {
      socket.connect();
    } else {
      handleConnect();
    }

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
      socket.off(SOCKET_EVENTS.ROOM.MEMBERS, handleMembers);

      socket.off(
        SOCKET_EVENTS.ROOM.USER_JOINED,
        handleUserJoined
      );

      socket.off(
        SOCKET_EVENTS.ROOM.USER_LEFT,
        handleUserLeft
      );

      if (socket.connected) {
        socket.emit(SOCKET_EVENTS.ROOM.LEAVE, {
          roomId,
          user,
        });

      }
      socket.disconnect();
    };
  }, []);

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
      <h1>CodeCollab — Collaborative Coding Platform</h1>

      <p>
        Backend Status: <strong>{backendStatus}</strong>
      </p>

      <p>
        Socket Status: <strong>{socketStatus}</strong>
      </p>

      <p>
        Room Status: <strong>{roomStatus}</strong>
      </p>

      <h3>Room Members</h3>

      {roomMembers.length === 0 ? (
        <p>No other members detected.</p>
      ) : (
        <ul>
          {roomMembers.map((member) => (
            <li key={member.socketId}>{member.user?.name || member.user?.username || member.socketId}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
