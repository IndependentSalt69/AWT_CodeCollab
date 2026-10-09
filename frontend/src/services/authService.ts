import axios, { AxiosError } from 'axios';
import {
  RegisterPayload,
  LoginPayload,
  AuthResponse,
  CurrentUserResponse,
  User,
} from '../types/auth';

const API_BASE_URL =
  (import.meta as any).env?.VITE_API_URL || 'http://localhost:5000';

const TOKEN_KEY = 'token';

export const getStoredToken = (): string | null => {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
};

export const setStoredToken = (token: string): void => {
  if (typeof window === 'undefined') return;
  if (token && token.trim()) {
    localStorage.setItem(TOKEN_KEY, token.trim());
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
};

export const removeStoredToken = (): void => {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(TOKEN_KEY);
};

export async function register(payload: RegisterPayload): Promise<AuthResponse> {
  try {
    const response = await axios.post<AuthResponse>(
      `${API_BASE_URL}/api/auth/register`,
      payload,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );

    if (response.data.ok && response.data.token) {
      setStoredToken(response.data.token);
    }

    return response.data;
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const axiosErr = err as AxiosError<{ ok: boolean; error?: string }>;
      return {
        ok: false,
        error:
          axiosErr.response?.data?.error ||
          axiosErr.message ||
          'Registration failed',
      };
    }
    const msg = err instanceof Error ? err.message : 'Registration failed';
    return { ok: false, error: msg };
  }
}

export async function login(payload: LoginPayload): Promise<AuthResponse> {
  try {
    const response = await axios.post<AuthResponse>(
      `${API_BASE_URL}/api/auth/login`,
      payload,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );

    if (response.data.ok && response.data.token) {
      setStoredToken(response.data.token);
    }

    return response.data;
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const axiosErr = err as AxiosError<{ ok: boolean; error?: string }>;
      return {
        ok: false,
        error:
          axiosErr.response?.data?.error ||
          axiosErr.message ||
          'Login failed',
      };
    }
    const msg = err instanceof Error ? err.message : 'Login failed';
    return { ok: false, error: msg };
  }
}

export async function getCurrentUser(token?: string | null): Promise<CurrentUserResponse> {
  const authToken = token || getStoredToken();
  if (!authToken) {
    return { ok: false, error: 'No authentication token provided' };
  }

  try {
    const response = await axios.get<CurrentUserResponse>(
      `${API_BASE_URL}/api/auth/me`,
      {
        headers: {
          Authorization: `Bearer ${authToken.trim()}`,
        },
        timeout: 10000,
      }
    );

    return response.data;
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const axiosErr = err as AxiosError<{ ok: boolean; error?: string }>;
      // If unauthorized, clear stored token
      if (axiosErr.response?.status === 401) {
        removeStoredToken();
      }
      return {
        ok: false,
        error:
          axiosErr.response?.data?.error ||
          axiosErr.message ||
          'Failed to authenticate user',
      };
    }
    const msg = err instanceof Error ? err.message : 'Failed to authenticate user';
    return { ok: false, error: msg };
  }
}
