import axios, { AxiosError } from 'axios';
import { ExecuteCodePayload, ExecuteApiResponse } from '../types/execution';

const API_BASE_URL =
  (import.meta as any).env?.VITE_API_URL || 'http://localhost:5000';

/**
 * Sends a code execution request to the backend execution API (POST /api/execute).
 *
 * @param payload Execution parameters (roomId, language, code, timeout, memory, socketId)
 * @param token Optional JWT authentication token
 * @returns Promise resolving to the execution API response
 */
export async function submitCodeExecution(
  payload: ExecuteCodePayload,
  token?: string | null
): Promise<ExecuteApiResponse> {
  const authToken = token || (typeof window !== 'undefined' ? localStorage.getItem('token') : null);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken.trim()}`;
    }

    if (payload.socketId) {
      headers['x-socket-id'] = payload.socketId;
    }

    const response = await axios.post<ExecuteApiResponse>(
      `${API_BASE_URL}/api/execute`,
      payload,
      {
        headers,
        timeout: 15000,
      }
    );

    return response.data;
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const axiosErr = err as AxiosError<{ ok: boolean; error?: string }>;
      const errorMsg =
        axiosErr.response?.data?.error ||
        axiosErr.message ||
        'Failed to execute code';

      return {
        ok: false,
        error: errorMsg,
        status: 'failed',
      };
    }

    const fallbackMsg = err instanceof Error ? err.message : 'Unknown execution error occurred';
    return {
      ok: false,
      error: fallbackMsg,
      status: 'failed',
    };
  }
}
