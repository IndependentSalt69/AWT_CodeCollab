import axios, { AxiosError } from 'axios';
import {
  CreateRoomPayload,
  RoomResponse,
  RoomListResponse,
  Room,
} from '../types/room';

const API_BASE_URL =
  (import.meta as any).env?.VITE_API_URL || 'http://localhost:5000';

function getAuthHeaders(token?: string | null) {
  const authToken = token || (typeof window !== 'undefined' ? localStorage.getItem('token') : null);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken.trim()}`;
  }
  return headers;
}

export async function listRooms(token?: string | null): Promise<RoomListResponse> {
  try {
    const response = await axios.get<RoomListResponse>(`${API_BASE_URL}/api/rooms`, {
      headers: getAuthHeaders(token),
      timeout: 10000,
    });
    return response.data;
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const axiosErr = err as AxiosError<{ ok: boolean; error?: string }>;
      return {
        ok: false,
        error: axiosErr.response?.data?.error || axiosErr.message || 'Failed to list rooms',
      };
    }
    const msg = err instanceof Error ? err.message : 'Failed to list rooms';
    return { ok: false, error: msg };
  }
}

export async function createRoom(
  payload: CreateRoomPayload,
  token?: string | null
): Promise<RoomResponse> {
  try {
    const response = await axios.post<RoomResponse>(
      `${API_BASE_URL}/api/rooms`,
      payload,
      {
        headers: getAuthHeaders(token),
        timeout: 10000,
      }
    );
    return response.data;
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const axiosErr = err as AxiosError<{ ok: boolean; error?: string }>;
      return {
        ok: false,
        error: axiosErr.response?.data?.error || axiosErr.message || 'Failed to create room',
      };
    }
    const msg = err instanceof Error ? err.message : 'Failed to create room';
    return { ok: false, error: msg };
  }
}

export async function getRoomDetails(
  roomId: string,
  token?: string | null
): Promise<RoomResponse> {
  try {
    const response = await axios.get<RoomResponse>(
      `${API_BASE_URL}/api/rooms/${encodeURIComponent(roomId)}`,
      {
        headers: getAuthHeaders(token),
        timeout: 10000,
      }
    );
    return response.data;
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const axiosErr = err as AxiosError<{ ok: boolean; error?: string }>;
      return {
        ok: false,
        error: axiosErr.response?.data?.error || axiosErr.message || 'Failed to fetch room details',
      };
    }
    const msg = err instanceof Error ? err.message : 'Failed to fetch room details';
    return { ok: false, error: msg };
  }
}

export async function joinRoom(
  roomIdOrCode: string,
  token?: string | null
): Promise<RoomResponse> {
  try {
    const response = await axios.post<RoomResponse>(
      `${API_BASE_URL}/api/rooms/join`,
      { roomId: roomIdOrCode },
      {
        headers: getAuthHeaders(token),
        timeout: 10000,
      }
    );
    return response.data;
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const axiosErr = err as AxiosError<{ ok: boolean; error?: string }>;
      return {
        ok: false,
        error: axiosErr.response?.data?.error || axiosErr.message || 'Failed to join room',
      };
    }
    const msg = err instanceof Error ? err.message : 'Failed to join room';
    return { ok: false, error: msg };
  }
}
