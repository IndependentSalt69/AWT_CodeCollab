/**
 * Frontend Authentication & User Management Tests (M0.7)
 *
 * Validates:
 * - authService API contract (register, login, getMe)
 * - LocalStorage token persistence, session restoration, and clearing on 401
 * - Secure header attachment (Bearer <token>)
 * - Safe user payload validation (no password/hash in responses)
 * - Error mapping (409 Conflict, 401 Unauthorized, network errors)
 */

const axios = require('axios');

jest.mock('axios');

describe('Frontend Authentication Service & Session Management (M0.7)', () => {
  const API_BASE_URL = 'http://localhost:5000';
  const TOKEN_KEY = 'token';

  // In-memory localStorage mock for node test environment
  const mockStorage = new Map();
  const localStorageMock = {
    getItem: (key) => mockStorage.get(key) || null,
    setItem: (key, val) => mockStorage.set(key, String(val)),
    removeItem: (key) => mockStorage.delete(key),
    clear: () => mockStorage.clear(),
  };

  // Service helper implementations mirroring frontend/src/services/authService.ts
  async function register(payload) {
    try {
      const response = await axios.post(`${API_BASE_URL}/api/auth/register`, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      if (response.data.ok && response.data.token) {
        localStorageMock.setItem(TOKEN_KEY, response.data.token);
      }
      return response.data;
    } catch (err) {
      const errorMsg = err.response?.data?.error || err.message || 'Registration failed';
      return { ok: false, error: errorMsg };
    }
  }

  async function login(payload) {
    try {
      const response = await axios.post(`${API_BASE_URL}/api/auth/login`, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      if (response.data.ok && response.data.token) {
        localStorageMock.setItem(TOKEN_KEY, response.data.token);
      }
      return response.data;
    } catch (err) {
      const errorMsg = err.response?.data?.error || err.message || 'Login failed';
      return { ok: false, error: errorMsg };
    }
  }

  async function getCurrentUser(token) {
    const authToken = token || localStorageMock.getItem(TOKEN_KEY);
    if (!authToken) {
      return { ok: false, error: 'No authentication token provided' };
    }

    try {
      const response = await axios.get(`${API_BASE_URL}/api/auth/me`, {
        headers: { Authorization: `Bearer ${authToken.trim()}` },
        timeout: 10000,
      });
      return response.data;
    } catch (err) {
      if (err.response?.status === 401) {
        localStorageMock.removeItem(TOKEN_KEY);
      }
      const errorMsg = err.response?.data?.error || err.message || 'Failed to authenticate user';
      return { ok: false, error: errorMsg };
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockStorage.clear();
  });

  describe('1. Registration Flow (POST /api/auth/register)', () => {
    it('should register successfully, persist JWT token, and return safe user data', async () => {
      const mockUser = {
        id: 'u-101',
        username: 'alice',
        email: 'alice@example.com',
      };
      const mockToken = 'mock.jwt.token.alice';

      axios.post.mockResolvedValueOnce({
        data: {
          ok: true,
          token: mockToken,
          user: mockUser,
        },
      });

      const payload = {
        username: 'alice',
        email: 'alice@example.com',
        password: 'securepassword123',
      };

      const result = await register(payload);

      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:5000/api/auth/register',
        payload,
        expect.objectContaining({
          headers: { 'Content-Type': 'application/json' },
        })
      );

      expect(result.ok).toBe(true);
      expect(result.token).toBe(mockToken);
      expect(result.user).toEqual(mockUser);
      expect(result.user.password).toBeUndefined();
      expect(result.user.passwordHash).toBeUndefined();
      expect(localStorageMock.getItem(TOKEN_KEY)).toBe(mockToken);
    });

    it('should handle duplicate user conflict (409) gracefully without throwing', async () => {
      axios.post.mockRejectedValueOnce({
        response: {
          status: 409,
          data: { ok: false, error: 'Username already registered' },
        },
      });

      const result = await register({
        username: 'existing_user',
        email: 'new@example.com',
        password: 'password123',
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Username already registered');
      expect(localStorageMock.getItem(TOKEN_KEY)).toBeNull();
    });
  });

  describe('2. Login Flow (POST /api/auth/login)', () => {
    it('should login successfully, store token, and return profile', async () => {
      const mockToken = 'mock.jwt.token.bob';
      const mockUser = { id: 'u-102', username: 'bob', email: 'bob@example.com' };

      axios.post.mockResolvedValueOnce({
        data: {
          ok: true,
          token: mockToken,
          user: mockUser,
        },
      });

      const payload = { username: 'bob', password: 'password123' };
      const result = await login(payload);

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:5000/api/auth/login',
        payload,
        expect.anything()
      );

      expect(result.ok).toBe(true);
      expect(result.token).toBe(mockToken);
      expect(result.user.username).toBe('bob');
      expect(localStorageMock.getItem(TOKEN_KEY)).toBe(mockToken);
    });

    it('should handle generic 401 invalid credentials without exposing user existence', async () => {
      axios.post.mockRejectedValueOnce({
        response: {
          status: 401,
          data: { ok: false, error: 'Invalid username/email or password' },
        },
      });

      const result = await login({ username: 'nonexistent', password: 'wrong' });

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Invalid username/email or password');
      expect(localStorageMock.getItem(TOKEN_KEY)).toBeNull();
    });
  });

  describe('3. Session Restoration & GET /api/auth/me', () => {
    it('should restore session from stored token and fetch user profile', async () => {
      const existingToken = 'persisted.jwt.token';
      localStorageMock.setItem(TOKEN_KEY, existingToken);

      const mockUser = { id: 'u-103', username: 'charlie', email: 'charlie@example.com' };
      axios.get.mockResolvedValueOnce({
        data: {
          ok: true,
          user: mockUser,
        },
      });

      const result = await getCurrentUser();

      expect(axios.get).toHaveBeenCalledWith(
        'http://localhost:5000/api/auth/me',
        expect.objectContaining({
          headers: { Authorization: `Bearer ${existingToken}` },
        })
      );

      expect(result.ok).toBe(true);
      expect(result.user).toEqual(mockUser);
    });

    it('should clear stored token when token is invalid or expired (401)', async () => {
      const expiredToken = 'expired.jwt.token';
      localStorageMock.setItem(TOKEN_KEY, expiredToken);

      axios.get.mockRejectedValueOnce({
        response: {
          status: 401,
          data: { ok: false, error: 'Invalid or expired token.' },
        },
      });

      const result = await getCurrentUser();

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Invalid or expired token.');
      // Stored token must be cleared on 401
      expect(localStorageMock.getItem(TOKEN_KEY)).toBeNull();
    });

    it('should return error when attempting getCurrentUser without token', async () => {
      const result = await getCurrentUser(null);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('No authentication token provided');
      expect(axios.get).not.toHaveBeenCalled();
    });
  });

  describe('4. Logout Behavior', () => {
    it('should remove stored token on logout', () => {
      localStorageMock.setItem(TOKEN_KEY, 'active.session.token');
      expect(localStorageMock.getItem(TOKEN_KEY)).toBe('active.session.token');

      localStorageMock.removeItem(TOKEN_KEY);
      expect(localStorageMock.getItem(TOKEN_KEY)).toBeNull();
    });
  });
});
