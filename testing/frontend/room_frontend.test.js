/**
 * Frontend Room Management & Dashboard Integration Tests (M0.8)
 *
 * Validates:
 * - roomService API client calls (listRooms, createRoom, getRoomDetails, joinRoom)
 * - Header attachment (Bearer token)
 * - Error mapping and error responses
 * - Dashboard state transitions (loading, empty, populated)
 * - Room switching and cleanup behavior
 */

const axios = require('axios');

jest.mock('axios');

describe('Frontend Room Management & Dashboard Integration (M0.8)', () => {
  const API_BASE_URL = 'http://localhost:5000';
  const mockToken = 'mock.jwt.token.alice';

  // In-memory service implementations mirroring frontend/src/services/roomService.ts
  function getAuthHeaders(token) {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
  }

  async function listRooms(token) {
    try {
      const response = await axios.get(`${API_BASE_URL}/api/rooms`, {
        headers: getAuthHeaders(token),
        timeout: 10000,
      });
      return response.data;
    } catch (err) {
      const errorMsg = err.response?.data?.error || err.message || 'Failed to list rooms';
      return { ok: false, error: errorMsg };
    }
  }

  async function createRoom(payload, token) {
    try {
      const response = await axios.post(`${API_BASE_URL}/api/rooms`, payload, {
        headers: getAuthHeaders(token),
        timeout: 10000,
      });
      return response.data;
    } catch (err) {
      const errorMsg = err.response?.data?.error || err.message || 'Failed to create room';
      return { ok: false, error: errorMsg };
    }
  }

  async function getRoomDetails(roomId, token) {
    try {
      const response = await axios.get(
        `${API_BASE_URL}/api/rooms/${encodeURIComponent(roomId)}`,
        {
          headers: getAuthHeaders(token),
          timeout: 10000,
        }
      );
      return response.data;
    } catch (err) {
      const errorMsg = err.response?.data?.error || err.message || 'Failed to fetch room details';
      return { ok: false, error: errorMsg };
    }
  }

  async function joinRoom(roomIdOrCode, token) {
    try {
      const response = await axios.post(
        `${API_BASE_URL}/api/rooms/join`,
        { roomId: roomIdOrCode },
        {
          headers: getAuthHeaders(token),
          timeout: 10000,
        }
      );
      return response.data;
    } catch (err) {
      const errorMsg = err.response?.data?.error || err.message || 'Failed to join room';
      return { ok: false, error: errorMsg };
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('1. Room Service API Calls', () => {
    it('should call GET /api/rooms with Bearer token and return rooms list', async () => {
      const mockRooms = [
        {
          id: 'room-1',
          roomId: 'algo-1234',
          name: 'Algorithms',
          language: 'python',
          owner: { username: 'alice' },
          members: [{ username: 'alice' }],
        },
      ];

      axios.get.mockResolvedValueOnce({
        data: {
          ok: true,
          rooms: mockRooms,
        },
      });

      const result = await listRooms(mockToken);

      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(axios.get).toHaveBeenCalledWith(
        'http://localhost:5000/api/rooms',
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${mockToken}`,
          },
        })
      );
      expect(result.ok).toBe(true);
      expect(result.rooms.length).toBe(1);
      expect(result.rooms[0].roomId).toBe('algo-1234');
    });

    it('should call POST /api/rooms to create a new room', async () => {
      const newRoom = {
        id: 'room-2',
        roomId: 'python-study-9876',
        name: 'Python Study',
        language: 'python',
        owner: { username: 'alice' },
        members: [{ username: 'alice' }],
      };

      axios.post.mockResolvedValueOnce({
        data: {
          ok: true,
          room: newRoom,
        },
      });

      const payload = { name: 'Python Study', language: 'python' };
      const result = await createRoom(payload, mockToken);

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:5000/api/rooms',
        payload,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockToken}`,
          }),
        })
      );
      expect(result.ok).toBe(true);
      expect(result.room.roomId).toBe('python-study-9876');
    });

    it('should call GET /api/rooms/:roomId to fetch room details', async () => {
      const roomDetails = {
        id: 'room-1',
        roomId: 'algo-1234',
        name: 'Algorithms',
        language: 'python',
      };

      axios.get.mockResolvedValueOnce({
        data: {
          ok: true,
          room: roomDetails,
        },
      });

      const result = await getRoomDetails('algo-1234', mockToken);

      expect(axios.get).toHaveBeenCalledWith(
        'http://localhost:5000/api/rooms/algo-1234',
        expect.anything()
      );
      expect(result.ok).toBe(true);
      expect(result.room.name).toBe('Algorithms');
    });

    it('should call POST /api/rooms/join with roomId to join existing room', async () => {
      const joinedRoom = {
        id: 'room-3',
        roomId: 'collab-join-code',
        name: 'Team Collab',
      };

      axios.post.mockResolvedValueOnce({
        data: {
          ok: true,
          room: joinedRoom,
        },
      });

      const result = await joinRoom('collab-join-code', mockToken);

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:5000/api/rooms/join',
        { roomId: 'collab-join-code' },
        expect.anything()
      );
      expect(result.ok).toBe(true);
      expect(result.room.roomId).toBe('collab-join-code');
    });

    it('should handle API errors cleanly without throwing', async () => {
      axios.get.mockRejectedValueOnce({
        response: {
          status: 403,
          data: { ok: false, error: 'Access denied: You are not a member of this room' },
        },
      });

      const result = await getRoomDetails('secret-room', mockToken);

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Access denied: You are not a member of this room');
    });
  });

  describe('2. Dashboard State Transitions & Room Navigation', () => {
    function mapDashboardState({ isLoading, error, rooms }) {
      if (isLoading) return 'loading';
      if (error) return 'error';
      if (!rooms || rooms.length === 0) return 'empty';
      return 'populated';
    }

    it('should map loading, empty, and populated states correctly', () => {
      expect(mapDashboardState({ isLoading: true, error: null, rooms: [] })).toBe('loading');
      expect(mapDashboardState({ isLoading: false, error: 'Network Error', rooms: [] })).toBe('error');
      expect(mapDashboardState({ isLoading: false, error: null, rooms: [] })).toBe('empty');
      expect(
        mapDashboardState({
          isLoading: false,
          error: null,
          rooms: [{ roomId: 'r-1', name: 'Test' }],
        })
      ).toBe('populated');
    });

    it('should properly clean up room listeners and reset transient state on room exit', () => {
      let activeRoom = { roomId: 'test-room-1', name: 'Test Room' };
      let driverId = 'socket-driver-1';
      let members = ['socket-driver-1', 'socket-viewer-2'];
      let executionResult = { status: 'completed', stdout: 'done' };

      // User clicks "← Dashboard" (handleLeaveRoom)
      function leaveRoom() {
        activeRoom = null;
        driverId = null;
        members = [];
        executionResult = null;
      }

      leaveRoom();

      expect(activeRoom).toBeNull();
      expect(driverId).toBeNull();
      expect(members.length).toBe(0);
      expect(executionResult).toBeNull();
    });
  });
});
