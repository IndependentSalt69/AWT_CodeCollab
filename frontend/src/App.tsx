import React, { useEffect, useState, useRef } from 'react';
import {
  initClientSocket,
} from '../../realtime/client/socket';
import {
  SOCKET_EVENTS,
} from '../../realtime/client/events';
import CodeEditor from './components/editor/CodeEditor';

type RoomMember = {
  socketId: string;
  user?: { name?: string; username?: string };
};

type ActivityItem = {
  id: string;
  text: string;
  timestamp: string;
};

export default function App() {
  const [backendStatus, setBackendStatus] = useState<string>('checking...');
  const [socketStatus, setSocketStatus] = useState<string>('disconnected');
  const [roomStatus, setRoomStatus] = useState<string>('not joined');
  const [roomMembers, setRoomMembers] = useState<RoomMember[]>([]);
  const [activityFeed, setActivityFeed] = useState<ActivityItem[]>([]);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [myId, setMyId] = useState<string>('');
  const [myName, setMyName] = useState<string>('');
  const [transferStatus, setTransferStatus] = useState<string>('');
  const [code, setCode] = useState<string>(
    '// CodeCollab Editor Preview\n// Active driver can edit; viewers are read-only.\n\nfunction main() {\n  console.log("Hello from CodeCollab!");\n}\n'
  );
  const [language, setLanguage] = useState<string>('javascript');
  const socketRef = useRef<any>(null);

  const isDriver = myId && driverId === myId;

  const addActivity = (text: string) => {
    const newItem: ActivityItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text,
      timestamp: new Date().toLocaleTimeString(),
    };
    setActivityFeed((prev) => [newItem, ...prev].slice(0, 20));
  };

  useEffect(() => {
    fetch('http://localhost:5000/health')
      .then((res) => res.json())
      .then((data) => setBackendStatus(data.status || 'connected'))
      .catch(() => setBackendStatus('offline'));

    const socket = initClientSocket('http://localhost:5000');
    socketRef.current = socket;

    const roomId = 'test-room';
    const generatedName = `User-${Math.random().toString(36).slice(2, 7)}`;
    setMyName(generatedName);
    const user = {
      name: generatedName,
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
      if (member.socketId !== socket.id) {
        const userName = member.user?.name || member.user?.username || member.socketId;
        setRoomMembers((current) =>
          [...current.filter((existing) => existing.socketId !== member.socketId), member]
        );
        addActivity(`🟢 ${userName} joined the room`);
      }
    };

    const handleUserLeft = (member: RoomMember) => {
      if (member.socketId !== socket.id) {
        const userName = member.user?.name || member.user?.username || member.socketId;
        setRoomMembers((current) =>
          current.filter((m) => m.socketId !== member.socketId)
        );
        addActivity(`🔴 ${userName} left the room`);
      }
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
    <div style={{ fontFamily: 'sans-serif', padding: '2rem', maxWidth: '900px', margin: '0 auto', color: '#1e293b' }}>
      <h1 style={{ fontSize: '1.75rem', marginBottom: '1.25rem' }}>CodeCollab — Collaborative Coding Platform</h1>

      <div style={{ background: '#f8fafc', padding: '1.25rem', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '1.5rem' }}>
        <p style={{ margin: '0.3rem 0' }}>Backend Status: <strong>{backendStatus}</strong></p>
        <p style={{ margin: '0.3rem 0' }}>Socket Status: <strong>{socketStatus}</strong></p>
        <p style={{ margin: '0.3rem 0' }}>Room Status: <strong>{roomStatus}</strong></p>
        <p style={{ margin: '0.3rem 0' }}>
          Your Role:{' '}
          <strong style={{ color: isDriver ? '#059669' : '#4f46e5' }}>
            {isDriver ? '👑 Driver (Editing Enabled)' : '👀 Viewer (Read-only)'}
          </strong>
        </p>
        <p style={{ margin: '0.3rem 0' }}>Active Driver Socket: <code style={{ background: '#e2e8f0', padding: '2px 6px', borderRadius: '4px' }}>{driverId || 'None'}</code></p>
        {transferStatus && <p style={{ fontSize: '0.9rem', color: '#64748b', marginTop: '0.5rem' }}>{transferStatus}</p>}
      </div>

      {/* Editor Section */}
      <div style={{ marginBottom: '1.5rem', background: '#ffffff', padding: '1.25rem', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <h3 style={{ margin: 0 }}>Code Editor</h3>
            <span
              style={{
                fontSize: '0.8rem',
                padding: '2px 8px',
                borderRadius: '4px',
                background: isDriver ? '#dcfce7' : '#f1f5f9',
                color: isDriver ? '#15803d' : '#475569',
                fontWeight: 600,
              }}
            >
              {isDriver ? '✍️ Editing Enabled' : '🔒 Read-Only (Viewer)'}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <label htmlFor="lang-select" style={{ fontSize: '0.85rem', fontWeight: 600 }}>Language:</label>
            <select
              id="lang-select"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              style={{
                padding: '4px 8px',
                borderRadius: '4px',
                border: '1px solid #cbd5e1',
                fontSize: '0.85rem',
                background: '#fff',
              }}
            >
              <option value="javascript">JavaScript</option>
              <option value="python">Python</option>
              <option value="java">Java</option>
              <option value="cpp">C++</option>
            </select>
          </div>
        </div>

        <CodeEditor
          value={code}
          language={language}
          readOnly={!isDriver}
          onChange={(val) => setCode(val || '')}
          height="350px"
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
        {/* Active Users Section */}
        <div style={{ background: '#ffffff', padding: '1.25rem', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
          <h3 style={{ marginTop: 0, marginBottom: '1rem', borderBottom: '1px solid #f1f5f9', paddingBottom: '0.5rem' }}>
            Active Users
          </h3>

          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {/* Current user */}
            <li
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.6rem 0.8rem',
                marginBottom: '0.5rem',
                background: '#f1f5f9',
                border: '1px solid #cbd5e1',
                borderRadius: '6px',
              }}
            >
              <span>
                <strong>{myName || 'You'} (You)</strong>{' '}
                <span>{isDriver ? '👑' : '👀'}</span>
              </span>
              <span style={{ fontSize: '0.8rem', fontWeight: 600, color: isDriver ? '#059669' : '#64748b' }}>
                {isDriver ? 'Driver' : 'Viewer'}
              </span>
            </li>

            {/* Other room members */}
            {roomMembers.map((member) => {
              const memberIsDriver = member.socketId === driverId;
              const name = member.user?.name || member.user?.username || member.socketId;
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
                    <strong>{name}</strong>{' '}
                    <span>{memberIsDriver ? '👑' : '👀'}</span>
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.8rem', color: memberIsDriver ? '#059669' : '#64748b' }}>
                      {memberIsDriver ? 'Driver' : 'Viewer'}
                    </span>
                    {isDriver && !memberIsDriver && (
                      <button
                        onClick={() => handleTransferDriver(member.socketId)}
                        style={{
                          padding: '3px 8px',
                          fontSize: '0.75rem',
                          background: '#4f46e5',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                        }}
                      >
                        Transfer
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Recent Activity Feed */}
        <div style={{ background: '#ffffff', padding: '1.25rem', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
          <h3 style={{ marginTop: 0, marginBottom: '1rem', borderBottom: '1px solid #f1f5f9', paddingBottom: '0.5rem' }}>
            Recent Activity
          </h3>
          {activityFeed.length === 0 ? (
            <p style={{ color: '#94a3b8', fontStyle: 'italic', fontSize: '0.9rem' }}>No recent activity yet.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: '320px', overflowY: 'auto' }}>
              {activityFeed.map((item) => (
                <li
                  key={item.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.5rem 0.6rem',
                    borderBottom: '1px solid #f1f5f9',
                    fontSize: '0.9rem',
                  }}
                >
                  <span>{item.text}</span>
                  <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>{item.timestamp}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
