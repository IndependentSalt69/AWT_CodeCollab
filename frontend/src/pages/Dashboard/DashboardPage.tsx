import React, { useState, useEffect } from 'react';
import { Room } from '../../types/room';
import { listRooms, createRoom, joinRoom } from '../../services/roomService';
import { useAuth } from '../../context/AuthContext';

interface DashboardPageProps {
  onSelectRoom: (room: Room) => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ onSelectRoom }) => {
  const { user, token } = useAuth();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Create room modal / form state
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [newRoomName, setNewRoomName] = useState<string>('');
  const [newRoomLang, setNewRoomLang] = useState<string>('python');
  const [isCreating, setIsCreating] = useState<boolean>(false);

  // Join room modal / form state
  const [showJoinModal, setShowJoinModal] = useState<boolean>(false);
  const [joinCodeInput, setJoinCodeInput] = useState<string>('');
  const [isJoining, setIsJoining] = useState<boolean>(false);

  const [copiedRoomId, setCopiedRoomId] = useState<string | null>(null);

  const fetchRooms = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await listRooms(token);
      if (res.ok && res.rooms) {
        setRooms(res.rooms);
      } else {
        setError(res.error || 'Failed to fetch rooms');
      }
    } catch (_) {
      setError('An error occurred while loading your rooms');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRooms();
  }, [token]);

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRoomName.trim()) return;

    setIsCreating(true);
    setError(null);
    try {
      const res = await createRoom(
        {
          name: newRoomName.trim(),
          language: newRoomLang,
        },
        token
      );

      if (res.ok && res.room) {
        setShowCreateModal(false);
        setNewRoomName('');
        setRooms((prev) => [res.room!, ...prev]);
        onSelectRoom(res.room);
      } else {
        setError(res.error || 'Failed to create room');
      }
    } catch (_) {
      setError('An error occurred while creating the room');
    } finally {
      setIsCreating(false);
    }
  };

  const handleJoinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinCodeInput.trim()) return;

    setIsJoining(true);
    setError(null);
    try {
      const res = await joinRoom(joinCodeInput.trim(), token);
      if (res.ok && res.room) {
        setShowJoinModal(false);
        setJoinCodeInput('');
        // Add if not already in state
        setRooms((prev) => {
          const exists = prev.some((r) => r.roomId === res.room!.roomId);
          return exists ? prev : [res.room!, ...prev];
        });
        onSelectRoom(res.room);
      } else {
        setError(res.error || 'Failed to join room');
      }
    } catch (_) {
      setError('An error occurred while joining the room');
    } finally {
      setIsJoining(false);
    }
  };

  const handleCopyCode = (roomId: string) => {
    navigator.clipboard?.writeText(roomId);
    setCopiedRoomId(roomId);
    setTimeout(() => {
      setCopiedRoomId(null);
    }, 2000);
  };

  return (
    <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '1rem 0' }}>
      {/* Action Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 700, margin: 0, color: '#0f172a' }}>
            Collaborative Rooms
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: '0.875rem', color: '#64748b' }}>
            Select a room to begin live coding or create a new room to collaborate
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            id="open-join-modal-btn"
            onClick={() => setShowJoinModal(true)}
            style={{
              padding: '8px 14px',
              fontSize: '0.875rem',
              fontWeight: 600,
              backgroundColor: '#f1f5f9',
              color: '#334155',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            🔗 Join with Code
          </button>

          <button
            id="open-create-modal-btn"
            onClick={() => setShowCreateModal(true)}
            style={{
              padding: '8px 16px',
              fontSize: '0.875rem',
              fontWeight: 600,
              backgroundColor: '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)',
              transition: 'background-color 0.15s ease',
            }}
          >
            + Create Room
          </button>
        </div>
      </div>

      {/* Global Error Notice */}
      {error && (
        <div
          id="dashboard-error-banner"
          style={{
            background: '#fef2f2',
            color: '#991b1b',
            border: '1px solid #fecaca',
            borderRadius: '6px',
            padding: '10px 14px',
            fontSize: '0.85rem',
            marginBottom: '1.25rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>⚠️ {error}</span>
          <button
            onClick={() => setError(null)}
            style={{ background: 'none', border: 'none', color: '#991b1b', cursor: 'pointer', fontWeight: 700 }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Create Room Modal */}
      {showCreateModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
        >
          <div
            style={{
              background: '#ffffff',
              borderRadius: '10px',
              padding: '1.75rem',
              maxWidth: '440px',
              width: '100%',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
            }}
          >
            <h3 style={{ margin: '0 0 1rem', fontSize: '1.2rem', color: '#0f172a' }}>Create New Room</h3>
            <form onSubmit={handleCreateRoom}>
              <div style={{ marginBottom: '1rem' }}>
                <label
                  htmlFor="new-room-name-input"
                  style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: '#334155', marginBottom: '6px' }}
                >
                  Room Name
                </label>
                <input
                  id="new-room-name-input"
                  type="text"
                  placeholder="e.g. Algorithms Practice"
                  value={newRoomName}
                  onChange={(e) => setNewRoomName(e.target.value)}
                  disabled={isCreating}
                  required
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.9rem',
                  }}
                />
              </div>

              <div style={{ marginBottom: '1.5rem' }}>
                <label
                  htmlFor="new-room-lang-select"
                  style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: '#334155', marginBottom: '6px' }}
                >
                  Default Language
                </label>
                <select
                  id="new-room-lang-select"
                  value={newRoomLang}
                  onChange={(e) => setNewRoomLang(e.target.value)}
                  disabled={isCreating}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.9rem',
                    backgroundColor: '#ffffff',
                  }}
                >
                  <option value="python">Python 3.11 (⚡ Container Sandbox)</option>
                  <option value="javascript">JavaScript (Preview)</option>
                  <option value="java">Java (Preview)</option>
                  <option value="cpp">C++ (Preview)</option>
                </select>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  disabled={isCreating}
                  style={{
                    padding: '8px 14px',
                    borderRadius: '6px',
                    border: '1px solid #cbd5e1',
                    backgroundColor: '#f8fafc',
                    color: '#475569',
                    fontSize: '0.875rem',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  id="submit-create-room-btn"
                  type="submit"
                  disabled={isCreating || !newRoomName.trim()}
                  style={{
                    padding: '8px 16px',
                    borderRadius: '6px',
                    border: 'none',
                    backgroundColor: '#2563eb',
                    color: '#ffffff',
                    fontSize: '0.875rem',
                    fontWeight: 600,
                    cursor: isCreating ? 'not-allowed' : 'pointer',
                  }}
                >
                  {isCreating ? 'Creating...' : 'Create & Enter'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Join Room Modal */}
      {showJoinModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
        >
          <div
            style={{
              background: '#ffffff',
              borderRadius: '10px',
              padding: '1.75rem',
              maxWidth: '440px',
              width: '100%',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
            }}
          >
            <h3 style={{ margin: '0 0 1rem', fontSize: '1.2rem', color: '#0f172a' }}>Join Existing Room</h3>
            <form onSubmit={handleJoinRoom}>
              <div style={{ marginBottom: '1.5rem' }}>
                <label
                  htmlFor="join-code-input"
                  style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: '#334155', marginBottom: '6px' }}
                >
                  Room ID or Join Code
                </label>
                <input
                  id="join-code-input"
                  type="text"
                  placeholder="e.g. algorithms-practice-f4a2"
                  value={joinCodeInput}
                  onChange={(e) => setJoinCodeInput(e.target.value)}
                  disabled={isJoining}
                  required
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.9rem',
                    fontFamily: 'monospace',
                  }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button
                  type="button"
                  onClick={() => setShowJoinModal(false)}
                  disabled={isJoining}
                  style={{
                    padding: '8px 14px',
                    borderRadius: '6px',
                    border: '1px solid #cbd5e1',
                    backgroundColor: '#f8fafc',
                    color: '#475569',
                    fontSize: '0.875rem',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  id="submit-join-room-btn"
                  type="submit"
                  disabled={isJoining || !joinCodeInput.trim()}
                  style={{
                    padding: '8px 16px',
                    borderRadius: '6px',
                    border: 'none',
                    backgroundColor: '#2563eb',
                    color: '#ffffff',
                    fontSize: '0.875rem',
                    fontWeight: 600,
                    cursor: isJoining ? 'not-allowed' : 'pointer',
                  }}
                >
                  {isJoining ? 'Joining...' : 'Join Room'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Room Listing Content */}
      {isLoading ? (
        <div
          id="dashboard-loading-state"
          style={{ textAlign: 'center', padding: '3rem 1rem', color: '#64748b' }}
        >
          <div style={{ fontSize: '1.8rem', marginBottom: '8px' }}>🔄</div>
          <div>Loading your rooms...</div>
        </div>
      ) : rooms.length === 0 ? (
        <div
          id="dashboard-empty-state"
          style={{
            background: '#ffffff',
            border: '2px dashed #cbd5e1',
            borderRadius: '10px',
            padding: '3rem 1.5rem',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '2.5rem', marginBottom: '10px' }}>📁</div>
          <h3 style={{ margin: '0 0 6px', fontSize: '1.15rem', color: '#1e293b' }}>No rooms joined yet</h3>
          <p style={{ margin: '0 0 1.25rem', fontSize: '0.875rem', color: '#64748b' }}>
            Create your first collaboration room or enter a join code shared by a teammate.
          </p>
          <button
            id="empty-create-room-btn"
            onClick={() => setShowCreateModal(true)}
            style={{
              padding: '8px 16px',
              fontSize: '0.875rem',
              fontWeight: 600,
              backgroundColor: '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            + Create Your First Room
          </button>
        </div>
      ) : (
        <div
          id="dashboard-room-list"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))',
            gap: '1rem',
          }}
        >
          {rooms.map((room) => {
            const memberCount = Array.isArray(room.members) ? room.members.length : 1;
            const isOwner =
              typeof room.owner === 'object'
                ? room.owner?.id === user?.id || (room.owner as any)?._id === user?.id
                : room.owner === user?.id;

            return (
              <div
                key={room.roomId}
                style={{
                  background: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: '10px',
                  padding: '1.25rem',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)',
                  transition: 'transform 0.1s ease, box-shadow 0.1s ease',
                }}
              >
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                    <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#0f172a', fontWeight: 600 }}>
                      {room.name}
                    </h3>
                    <span
                      style={{
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        padding: '2px 8px',
                        borderRadius: '4px',
                        background: '#eff6ff',
                        color: '#1d4ed8',
                        textTransform: 'uppercase',
                      }}
                    >
                      {room.language || 'python'}
                    </span>
                  </div>

                  {/* Room ID Badge with Copy Action */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      background: '#f8fafc',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      border: '1px solid #e2e8f0',
                      marginBottom: '10px',
                    }}
                  >
                    <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Code:</span>
                    <code style={{ fontSize: '0.8rem', fontFamily: 'monospace', color: '#334155', flex: 1 }}>
                      {room.roomId}
                    </code>
                    <button
                      onClick={() => handleCopyCode(room.roomId)}
                      title="Copy join code"
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: '2px 4px',
                        fontSize: '0.75rem',
                        color: copiedRoomId === room.roomId ? '#16a34a' : '#64748b',
                        cursor: 'pointer',
                        fontWeight: 600,
                      }}
                    >
                      {copiedRoomId === room.roomId ? '✓ Copied' : '📋'}
                    </button>
                  </div>

                  <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: '12px', display: 'flex', gap: '12px' }}>
                    <span>👥 {memberCount} {memberCount === 1 ? 'member' : 'members'}</span>
                    {isOwner && <span style={{ color: '#059669', fontWeight: 600 }}>👑 Owner</span>}
                  </div>
                </div>

                <button
                  id={`enter-room-${room.roomId}`}
                  onClick={() => onSelectRoom(room)}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: '0.875rem',
                    fontWeight: 600,
                    backgroundColor: '#2563eb',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    transition: 'background-color 0.15s ease',
                  }}
                >
                  Enter Room →
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default DashboardPage;
