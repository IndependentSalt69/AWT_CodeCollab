import React, { useEffect, useState, useRef } from 'react';
import {
  initClientSocket,
  resetClientSocket,
} from '../../realtime/client/socket';
import {
  SOCKET_EVENTS,
} from '../../realtime/client/events';
import CodeEditor from './components/editor/CodeEditor';
import Terminal from './components/terminal/Terminal';
import { submitCodeExecution } from './services/executionService';
import { ExecutionResult, ExecutionStatus } from './types/execution';
import { useAuth } from './context/AuthContext';
import LoginPage from './pages/Login/LoginPage';
import SignupPage from './pages/Signup/SignupPage';

type RoomMember = {
  socketId: string;
  user?: { name?: string; username?: string; _id?: string };
};

type ActivityItem = {
  id: string;
  text: string;
  timestamp: string;
};

const DEFAULT_PYTHON_CODE = `# Welcome to CodeCollab!
# Active Driver can write and execute Python code in an isolated container sandbox.

def compute_fibonacci(n):
    sequence = []
    a, b = 0, 1
    for _ in range(n):
        sequence.append(a)
        a, b = b, a + b
    return sequence

fib_10 = compute_fibonacci(10)
print("CodeCollab Python Execution Sandbox")
print(f"First 10 Fibonacci numbers: {fib_10}")
print(f"Sum of sequence: {sum(fib_10)}")
`;

export default function App() {
  const {
    user: authUser,
    token: authToken,
    isAuthenticated,
    isLoading: authLoading,
    logout,
  } = useAuth();

  const [authView, setAuthView] = useState<'login' | 'signup'>('login');

  const [backendStatus, setBackendStatus] = useState<string>('checking...');
  const [socketStatus, setSocketStatus] = useState<string>('disconnected');
  const [roomStatus, setRoomStatus] = useState<string>('not joined');
  const [roomMembers, setRoomMembers] = useState<RoomMember[]>([]);
  const [activityFeed, setActivityFeed] = useState<ActivityItem[]>([]);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [myId, setMyId] = useState<string>('');
  const [transferStatus, setTransferStatus] = useState<string>('');

  // Editor state
  const [code, setCode] = useState<string>(DEFAULT_PYTHON_CODE);
  const [language, setLanguage] = useState<string>('python');

  // Execution state
  const [isExecuting, setIsExecuting] = useState<boolean>(false);
  const [executionResult, setExecutionResult] = useState<ExecutionResult | null>(null);

  const socketRef = useRef<any>(null);
  const isIncomingUpdateRef = useRef<boolean>(false);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const roomId = 'test-room';

  const isDriver = Boolean(myId && driverId === myId);
  const isLanguageExecutable = language === 'python';

  const addActivity = (text: string) => {
    const newItem: ActivityItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text,
      timestamp: new Date().toLocaleTimeString(),
    };
    setActivityFeed((prev) => [newItem, ...prev].slice(0, 20));
  };

  const emitEditorChange = (newCode: string, newLang: string) => {
    if (!socketRef.current || !socketRef.current.connected) return;
    socketRef.current.emit(
      SOCKET_EVENTS.EDITOR.CHANGE,
      {
        roomId,
        code: newCode,
        language: newLang,
      },
      (res: { ok: boolean; error?: string }) => {
        if (!res?.ok) {
          console.warn('editor:change rejected by server:', res?.error);
        }
      }
    );
  };

  const handleCodeChange = (newCode: string | undefined) => {
    const nextVal = newCode || '';
    setCode(nextVal);

    if (isIncomingUpdateRef.current) {
      return;
    }

    if (!isDriver) return;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      emitEditorChange(nextVal, language);
    }, 250);
  };

  const handleLanguageChange = (newLang: string) => {
    setLanguage(newLang);
    if (isDriver) {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      emitEditorChange(code, newLang);
    }
  };

  const handleRunCode = async () => {
    if (!isDriver) {
      alert('Only the active room Driver can execute code.');
      return;
    }

    if (isExecuting) {
      return;
    }

    setIsExecuting(true);
    setExecutionResult({
      status: 'queued',
      stdout: '',
      stderr: '',
      language,
      roomId,
    });

    addActivity(`⚡ Triggered ${language} code execution...`);

    const response = await submitCodeExecution(
      {
        roomId,
        language,
        code,
        socketId: myId,
      },
      authToken
    );

    if (!response.ok) {
      setIsExecuting(false);
      setExecutionResult({
        status: 'failed',
        stdout: '',
        stderr: '',
        error: response.error || 'Code execution request failed',
        language,
        roomId,
      });
      addActivity(`❌ Code execution request rejected: ${response.error}`);
    } else if (response.result) {
      setIsExecuting(false);
      setExecutionResult({
        runId: response.runId,
        roomId,
        status: response.result.status,
        stdout: response.result.stdout || '',
        stderr: response.result.stderr || '',
        exitCode: response.result.exitCode,
        executionTimeMs: response.result.executionTimeMs,
        language,
      });
    }
  };

  const handleClearTerminal = () => {
    setExecutionResult(null);
    setIsExecuting(false);
  };

  const handleLogout = () => {
    resetClientSocket();
    logout();
  };

  useEffect(() => {
    if (!isAuthenticated) return;

    fetch('http://localhost:5000/health')
      .then((res) => res.json())
      .then((data) => setBackendStatus(data.status || 'connected'))
      .catch(() => setBackendStatus('offline'));

    // Authenticated socket connection with JWT
    const socket = initClientSocket('http://localhost:5000', {
      auth: { token: authToken },
    });
    socketRef.current = socket;

    const userPayload = {
      id: authUser?.id,
      name: authUser?.username,
      username: authUser?.username,
      email: authUser?.email,
    };

    const handleConnect = () => {
      console.log('Socket connected:', socket.id);
      setSocketStatus('connected');
      if (socket.id) {
        setMyId(socket.id);
      }

      socket.emit(
        SOCKET_EVENTS.ROOM.JOIN,
        {
          roomId,
          user: userPayload,
          token: authToken,
        },
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

    const handleEditorUpdate = (payload: {
      code: string;
      language: string;
      cursor?: object;
      updatedBy: string;
    }) => {
      if (payload.updatedBy === socket.id) return;

      isIncomingUpdateRef.current = true;
      if (payload.code !== undefined) {
        setCode(payload.code);
      }
      if (payload.language) {
        setLanguage(payload.language);
      }
      setTimeout(() => {
        isIncomingUpdateRef.current = false;
      }, 50);
    };

    // Execution Realtime Event Handlers
    const handleExecutionStarted = (payload: {
      runId: string;
      roomId: string;
      status: ExecutionStatus;
      language: string;
      triggeredBy: string;
    }) => {
      if (payload.roomId !== roomId) return;
      setIsExecuting(true);
      setExecutionResult((prev) => ({
        runId: payload.runId,
        roomId: payload.roomId,
        status: payload.status || 'queued',
        stdout: prev?.runId === payload.runId ? prev.stdout : '',
        stderr: prev?.runId === payload.runId ? prev.stderr : '',
        language: payload.language,
        triggeredBy: payload.triggeredBy,
      }));
    };

    const handleExecutionCompleted = (payload: {
      runId: string;
      roomId: string;
      status: ExecutionStatus;
      stdout: string;
      stderr: string;
      exitCode: number;
      executionTimeMs: number;
      language: string;
      triggeredBy: string;
    }) => {
      if (payload.roomId !== roomId) return;
      setIsExecuting(false);
      setExecutionResult({
        runId: payload.runId,
        roomId: payload.roomId,
        status: 'completed',
        stdout: payload.stdout || '',
        stderr: payload.stderr || '',
        exitCode: payload.exitCode ?? 0,
        executionTimeMs: payload.executionTimeMs ?? 0,
        language: payload.language,
        triggeredBy: payload.triggeredBy,
      });
      addActivity(`⚡ Execution completed (${payload.executionTimeMs}ms)`);
    };

    const handleExecutionFailed = (payload: {
      runId: string;
      roomId: string;
      status: ExecutionStatus;
      stdout: string;
      stderr: string;
      exitCode: number;
      executionTimeMs: number;
      language: string;
      triggeredBy: string;
      error?: string;
    }) => {
      if (payload.roomId !== roomId) return;
      setIsExecuting(false);
      setExecutionResult({
        runId: payload.runId,
        roomId: payload.roomId,
        status: payload.status || 'failed',
        stdout: payload.stdout || '',
        stderr: payload.stderr || '',
        exitCode: payload.exitCode ?? 1,
        executionTimeMs: payload.executionTimeMs ?? 0,
        language: payload.language,
        triggeredBy: payload.triggeredBy,
        error: payload.error,
      });
      addActivity(`❌ Execution ${payload.status === 'timeout' ? 'timed out' : 'failed'}`);
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    socket.on(SOCKET_EVENTS.ROOM.MEMBERS, handleMembers);
    socket.on(SOCKET_EVENTS.ROOM.USER_JOINED, handleUserJoined);
    socket.on(SOCKET_EVENTS.ROOM.USER_LEFT, handleUserLeft);
    socket.on(SOCKET_EVENTS.EDITOR.DRIVER_UPDATED, handleDriverUpdated);
    socket.on(SOCKET_EVENTS.EDITOR.UPDATE, handleEditorUpdate);
    socket.on(SOCKET_EVENTS.EXECUTION.STARTED, handleExecutionStarted);
    socket.on(SOCKET_EVENTS.EXECUTION.COMPLETED, handleExecutionCompleted);
    socket.on(SOCKET_EVENTS.EXECUTION.FAILED, handleExecutionFailed);

    if (!socket.connected) {
      socket.connect();
    } else {
      handleConnect();
    }

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
      socket.off(SOCKET_EVENTS.ROOM.MEMBERS, handleMembers);
      socket.off(SOCKET_EVENTS.ROOM.USER_JOINED, handleUserJoined);
      socket.off(SOCKET_EVENTS.ROOM.USER_LEFT, handleUserLeft);
      socket.off(SOCKET_EVENTS.EDITOR.DRIVER_UPDATED, handleDriverUpdated);
      socket.off(SOCKET_EVENTS.EDITOR.UPDATE, handleEditorUpdate);
      socket.off(SOCKET_EVENTS.EXECUTION.STARTED, handleExecutionStarted);
      socket.off(SOCKET_EVENTS.EXECUTION.COMPLETED, handleExecutionCompleted);
      socket.off(SOCKET_EVENTS.EXECUTION.FAILED, handleExecutionFailed);

      if (socket.connected) {
        socket.emit(SOCKET_EVENTS.ROOM.LEAVE, {
          roomId,
          user: userPayload,
        });
      }
      socket.disconnect();
    };
  }, [isAuthenticated, authToken]);

  const handleTransferDriver = (targetSocketId: string) => {
    if (!socketRef.current || !isDriver) return;
    setTransferStatus('Transferring...');
    socketRef.current.emit(
      SOCKET_EVENTS.EDITOR.DRIVER_CHANGE,
      { roomId, newDriverId: targetSocketId },
      (res: { ok: boolean; driverId?: string; error?: string }) => {
        if (res?.ok) {
          setTransferStatus(`Transferred to ${targetSocketId}`);
        } else {
          setTransferStatus(`Transfer failed: ${res?.error || 'Unknown error'}`);
        }
      }
    );
  };

  // 1. Session Restoration Loading View
  if (authLoading) {
    return (
      <div
        id="auth-loading-spinner"
        style={{
          fontFamily: 'system-ui, -apple-system, sans-serif',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '80vh',
          color: '#64748b',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', marginBottom: '10px' }}>⚡</div>
          <div style={{ fontSize: '1rem', fontWeight: 600, color: '#334155' }}>Loading CodeCollab...</div>
          <div style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: '4px' }}>Restoring authenticated session</div>
        </div>
      </div>
    );
  }

  // 2. Unauthenticated View (Login / Signup)
  if (!isAuthenticated) {
    return (
      <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif', background: '#f8fafc', minHeight: '100vh', padding: '2rem 1rem' }}>
        <header style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <h1 style={{ fontSize: '2rem', fontWeight: 800, margin: 0, color: '#0f172a' }}>CodeCollab</h1>
          <p style={{ margin: '6px 0 0', fontSize: '0.95rem', color: '#64748b' }}>
            Real-time collaborative code editor with sandboxed execution
          </p>
        </header>

        <main>
          {authView === 'login' ? (
            <LoginPage onSwitchToSignup={() => setAuthView('signup')} />
          ) : (
            <SignupPage onSwitchToLogin={() => setAuthView('login')} />
          )}
        </main>
      </div>
    );
  }

  // 3. Authenticated Collaborative Coding Interface
  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif', padding: '1.5rem', maxWidth: '1000px', margin: '0 auto', color: '#1e293b' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.6rem', fontWeight: 700, margin: 0, color: '#0f172a' }}>CodeCollab</h1>
          <p style={{ margin: '4px 0 0', fontSize: '0.875rem', color: '#64748b' }}>
            Real-time collaborative code editor with sandboxed execution
          </p>
        </div>

        {/* User Identity & Logout Action */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div
            id="user-profile-badge"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              backgroundColor: '#f1f5f9',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              fontSize: '0.85rem',
              color: '#334155',
              fontWeight: 500,
            }}
          >
            <span>👤</span>
            <strong>{authUser?.username}</strong>
            <span style={{ color: '#64748b', fontSize: '0.75rem' }}>({authUser?.email})</span>
          </div>

          <button
            id="logout-btn"
            onClick={handleLogout}
            style={{
              padding: '6px 12px',
              fontSize: '0.8rem',
              backgroundColor: '#fee2e2',
              color: '#991b1b',
              border: '1px solid #fecaca',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 600,
              transition: 'background-color 0.15s ease',
            }}
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* Status Banner */}
      <div style={{ background: '#f8fafc', padding: '1rem 1.25rem', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '1.25rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.5rem', fontSize: '0.875rem' }}>
          <div>Backend: <strong>{backendStatus}</strong></div>
          <div>Socket: <strong>{socketStatus}</strong></div>
          <div>Room: <strong>{roomStatus}</strong></div>
          <div>
            Role:{' '}
            <strong style={{ color: isDriver ? '#059669' : '#4f46e5' }}>
              {isDriver ? '👑 Driver (Can Edit & Run)' : '👀 Viewer (Read-Only)'}
            </strong>
          </div>
        </div>
        {transferStatus && <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '6px 0 0' }}>{transferStatus}</p>}
      </div>

      {/* Editor Section */}
      <div style={{ marginBottom: '1.25rem', background: '#ffffff', padding: '1rem 1.25rem', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
        {/* Editor Toolbar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Code Editor</h3>
            <span
              style={{
                fontSize: '0.75rem',
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

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {/* Language Selector */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <label htmlFor="lang-select" style={{ fontSize: '0.85rem', fontWeight: 600 }}>Language:</label>
              <select
                id="lang-select"
                value={language}
                disabled={!isDriver || isExecuting}
                onChange={(e) => handleLanguageChange(e.target.value)}
                style={{
                  padding: '5px 8px',
                  borderRadius: '4px',
                  border: '1px solid #cbd5e1',
                  fontSize: '0.85rem',
                  background: !isDriver ? '#f1f5f9' : '#fff',
                  cursor: !isDriver ? 'not-allowed' : 'pointer',
                }}
              >
                <option value="python">Python 3.11 (⚡ Container Sandbox)</option>
                <option value="javascript">JavaScript (Preview Only)</option>
                <option value="java">Java (Preview Only)</option>
                <option value="cpp">C++ (Preview Only)</option>
              </select>
            </div>

            {/* Run Code Button */}
            <button
              id="run-code-btn"
              onClick={handleRunCode}
              disabled={!isDriver || isExecuting || !isLanguageExecutable}
              title={
                !isDriver
                  ? 'Only the active Driver can run code'
                  : !isLanguageExecutable
                  ? 'Execution is currently supported for Python only'
                  : 'Execute code in container sandbox'
              }
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 14px',
                fontSize: '0.875rem',
                fontWeight: 600,
                color: '#ffffff',
                backgroundColor: !isDriver || !isLanguageExecutable ? '#94a3b8' : isExecuting ? '#eab308' : '#16a34a',
                border: 'none',
                borderRadius: '6px',
                cursor: !isDriver || isExecuting || !isLanguageExecutable ? 'not-allowed' : 'pointer',
                boxShadow: isDriver && !isExecuting && isLanguageExecutable ? '0 1px 2px 0 rgba(0, 0, 0, 0.05)' : 'none',
                transition: 'all 0.15s ease',
              }}
            >
              <span>{isExecuting ? '⏳' : '▶'}</span>
              <span>{isExecuting ? 'Running...' : 'Run Code'}</span>
            </button>
          </div>
        </div>

        {/* Non-python warning banner */}
        {!isLanguageExecutable && (
          <div
            style={{
              padding: '6px 12px',
              backgroundColor: '#eff6ff',
              border: '1px solid #bfdbfe',
              borderRadius: '6px',
              color: '#1e40af',
              fontSize: '0.8rem',
              marginBottom: '0.75rem',
            }}
          >
            ℹ️ <strong>{language.toUpperCase()}</strong> is currently in editor preview mode. Container execution is active for <strong>Python 3.11</strong>.
          </div>
        )}

        <CodeEditor
          value={code}
          language={language}
          readOnly={!isDriver}
          onChange={handleCodeChange}
          height="320px"
        />
      </div>

      {/* Terminal Output Section */}
      <div style={{ marginBottom: '1.25rem' }}>
        <Terminal
          result={executionResult}
          isRunning={isExecuting}
          onClear={handleClearTerminal}
          height="240px"
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
        {/* Active Users Section */}
        <div style={{ background: '#ffffff', padding: '1.25rem', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
          <h3 style={{ marginTop: 0, marginBottom: '1rem', borderBottom: '1px solid #f1f5f9', paddingBottom: '0.5rem', fontSize: '1.05rem' }}>
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
                <strong>{authUser?.username || 'You'} (You)</strong>{' '}
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
          <h3 style={{ marginTop: 0, marginBottom: '1rem', borderBottom: '1px solid #f1f5f9', paddingBottom: '0.5rem', fontSize: '1.05rem' }}>
            Recent Activity
          </h3>
          {activityFeed.length === 0 ? (
            <p style={{ color: '#94a3b8', fontStyle: 'italic', fontSize: '0.9rem' }}>No recent activity yet.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: '240px', overflowY: 'auto' }}>
              {activityFeed.map((item) => (
                <li
                  key={item.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.5rem 0.6rem',
                    borderBottom: '1px solid #f1f5f9',
                    fontSize: '0.875rem',
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
