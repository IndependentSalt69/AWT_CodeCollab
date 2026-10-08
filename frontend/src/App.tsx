import React, { useEffect, useState, useRef } from 'react';
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
  const [driverId, setDriverId] = useState<string | null>(null);
  const [myId, setMyId] = useState<string>('');
  const [transferStatus, setTransferStatus] = useState<string>('');
  const socketRef = useRef<any>(null);

  const isDriver = myId && driverId === myId;

  useEffect(() => {
    fetch('http://localhost:5000/health')
      .then((res) => res.json())
      .then((data) => setBackendStatus(data.status || 'connected'))
      .catch(() => setBackendStatus('offline'));

    const socket = initClientSocket('http://localhost:5000');
    socketRef.current = socket;

    const roomId = 'test-room';
    const user = {
      name: `User-${Math.random().toString(36).slice(2, 7)}`,
    };

    const handleConnect = () => {
      console.log('Socket connected:', socket.id);
      setSocketStatus('connected');
      if (socket.id) {
        setMyId(socket.id);
      }

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
      setDriverId(null);
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

    const handleDriverUpdated = (payload: { driverId: string; roomId?: string }) => {
      console.log('Driver updated:', payload.driverId);
      setDriverId(payload.driverId);
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    socket.on(SOCKET_EVENTS.ROOM.MEMBERS, handleMembers);
    socket.on(SOCKET_EVENTS.ROOM.USER_JOINED, handleUserJoined);
    socket.on(SOCKET_EVENTS.ROOM.USER_LEFT, handleUserLeft);
    socket.on(SOCKET_EVENTS.EDITOR.DRIVER_UPDATED, handleDriverUpdated);

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
      socket.off(SOCKET_EVENTS.ROOM.USER_JOINED, handleUserJoined);
      socket.off(SOCKET_EVENTS.ROOM.USER_LEFT, handleUserLeft);
      socket.off(SOCKET_EVENTS.EDITOR.DRIVER_UPDATED, handleDriverUpdated);

      if (socket.connected) {
        socket.emit(SOCKET_EVENTS.ROOM.LEAVE, {
          roomId,
          user,
        });
      }
      socket.disconnect();
    };
  }, []);

  const handleTransferDriver = (targetSocketId: string) => {
    if (!socketRef.current || !isDriver) return;
    setTransferStatus('Transferring...');
    socketRef.current.emit(
      SOCKET_EVENTS.EDITOR.DRIVER_CHANGE,
      { roomId: 'test-room', newDriverId: targetSocketId },
      (res: { ok: boolean; driverId?: string; error?: string }) => {
        if (res?.ok) {
          setTransferStatus(`Transferred to ${targetSocketId}`);
        } else {
          setTransferStatus(`Transfer failed: ${res?.error || 'Unknown error'}`);
        }
      }
    );
  };

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '2rem', maxWidth: '700px', margin: '0 auto' }}>
      <h1>CodeCollab — Collaborative Coding Platform</h1>

      <div style={{ background: '#f5f5f7', padding: '1rem', borderRadius: '8px', marginBottom: '1.5rem' }}>
        <p>Backend Status: <strong>{backendStatus}</strong></p>
        <p>Socket Status: <strong>{socketStatus}</strong></p>
        <p>Room Status: <strong>{roomStatus}</strong></p>
        <p>
          Your Role:{' '}
          <strong style={{ color: isDriver ? '#10b981' : '#6366f1' }}>
            {isDriver ? '⚡ Driver (Editing Enabled)' : '👀 Viewer (Read-only)'}
          </strong>
        </p>
        <p>Active Driver Socket: <code>{driverId || 'None'}</code></p>
        {transferStatus && <p style={{ fontSize: '0.9rem', color: '#666' }}>{transferStatus}</p>}
      </div>

      <h3>Room Members</h3>
      {roomMembers.length === 0 ? (
        <p>No other members in this room.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {roomMembers.map((member) => {
            const memberIsDriver = member.socketId === driverId;
            return (
              <li
                key={member.socketId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.6rem 0.8rem',
                  marginBottom: '0.5rem',
                  border: '1px solid #e2e8f0',
                  borderRadius: '6px',
                }}
              >
                <span>
                  <strong>{member.user?.name || member.user?.username || member.socketId}</strong>{' '}
                  <span style={{ fontSize: '0.85rem', color: memberIsDriver ? '#10b981' : '#64748b' }}>
                    ({memberIsDriver ? 'Driver' : 'Viewer'})
                  </span>
                </span>
                {isDriver && !memberIsDriver && (
                  <button
                    onClick={() => handleTransferDriver(member.socketId)}
                    style={{
                      padding: '4px 10px',
                      background: '#4f46e5',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                    }}
                  >
                    Transfer Driver
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
