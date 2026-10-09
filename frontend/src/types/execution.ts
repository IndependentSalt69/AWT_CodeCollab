export type ExecutionStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout';

export interface ExecutionResult {
  runId?: string;
  roomId?: string;
  status: ExecutionStatus;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  executionTimeMs?: number | null;
  language?: string;
  triggeredBy?: string;
  error?: string;
  createdAt?: string;
}

export interface ExecuteCodePayload {
  roomId: string;
  language: string;
  code: string;
  timeout?: number;
  memory?: string;
  socketId?: string;
}

export interface ExecuteApiResponse {
  ok: boolean;
  runId?: string;
  status?: ExecutionStatus;
  result?: {
    stdout: string;
    stderr: string;
    exitCode: number;
    executionTimeMs: number;
    status: ExecutionStatus;
  };
  error?: string;
}
