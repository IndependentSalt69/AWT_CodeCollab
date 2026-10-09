import React from 'react';
import { ExecutionResult, ExecutionStatus } from '../../types/execution';

export interface TerminalProps {
  result: ExecutionResult | null;
  isRunning?: boolean;
  onClear?: () => void;
  className?: string;
  height?: string | number;
}

const statusBadgeConfig: Record<
  ExecutionStatus,
  { label: string; bg: string; color: string; border: string; icon: string }
> = {
  idle: {
    label: 'Ready',
    bg: '#334155',
    color: '#cbd5e1',
    border: '#475569',
    icon: '●',
  },
  queued: {
    label: 'Queued',
    bg: '#3b82f620',
    color: '#60a5fa',
    border: '#3b82f640',
    icon: '⏳',
  },
  running: {
    label: 'Running...',
    bg: '#eab30820',
    color: '#facc15',
    border: '#eab30840',
    icon: '⚡',
  },
  completed: {
    label: 'Completed',
    bg: '#22c55e20',
    color: '#4ade80',
    border: '#22c55e40',
    icon: '✓',
  },
  failed: {
    label: 'Failed',
    bg: '#ef444420',
    color: '#f87171',
    border: '#ef444440',
    icon: '✕',
  },
  timeout: {
    label: 'Timeout',
    bg: '#f9731620',
    color: '#fb923c',
    border: '#f9731640',
    icon: '⏱',
  },
};

export const Terminal: React.FC<TerminalProps> = ({
  result,
  isRunning = false,
  onClear,
  className,
  height = '280px',
}) => {
  const currentStatus: ExecutionStatus = isRunning
    ? result?.status === 'queued'
      ? 'queued'
      : 'running'
    : result?.status || 'idle';

  const badge = statusBadgeConfig[currentStatus] || statusBadgeConfig.idle;
  const hasStdout = Boolean(result?.stdout && result.stdout.trim().length > 0);
  const hasStderr = Boolean(result?.stderr && result.stderr.trim().length > 0);
  const hasError = Boolean(result?.error);
  const hasRun = Boolean(result && (result.runId || hasStdout || hasStderr || hasError || result.status !== 'idle'));

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#0f172a',
        color: '#f8fafc',
        borderRadius: '8px',
        border: '1px solid #1e293b',
        overflow: 'hidden',
        boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.2), 0 2px 4px -2px rgba(0, 0, 0, 0.2)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        height,
      }}
    >
      {/* Terminal Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 14px',
          backgroundColor: '#1e293b',
          borderBottom: '1px solid #334155',
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', color: '#94a3b8' }}>❯_</span>
          <span style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0', letterSpacing: '0.02em' }}>
            Terminal Output
          </span>

          {/* Status Badge */}
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '11px',
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: '9999px',
              backgroundColor: badge.bg,
              color: badge.color,
              border: `1px solid ${badge.border}`,
            }}
          >
            <span>{badge.icon}</span>
            <span>{badge.label}</span>
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* Metadata: Execution Time */}
          {result?.executionTimeMs !== undefined && result.executionTimeMs !== null && (
            <span style={{ fontSize: '11px', color: '#94a3b8' }}>
              Duration: <strong style={{ color: '#cbd5e1' }}>{result.executionTimeMs}ms</strong>
            </span>
          )}

          {/* Metadata: Exit Code */}
          {result?.exitCode !== undefined && result.exitCode !== null && (
            <span style={{ fontSize: '11px', color: '#94a3b8' }}>
              Exit Code:{' '}
              <strong style={{ color: result.exitCode === 0 ? '#4ade80' : '#f87171' }}>
                {result.exitCode}
              </strong>
            </span>
          )}

          {/* Clear Button */}
          {onClear && (
            <button
              onClick={onClear}
              title="Clear terminal output"
              style={{
                background: 'transparent',
                border: '1px solid #475569',
                borderRadius: '4px',
                color: '#94a3b8',
                cursor: 'pointer',
                fontSize: '11px',
                padding: '2px 8px',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#f8fafc';
                e.currentTarget.style.borderColor = '#64748b';
                e.currentTarget.style.backgroundColor = '#334155';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#94a3b8';
                e.currentTarget.style.borderColor = '#475569';
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Terminal Body */}
      <div
        style={{
          flex: 1,
          padding: '12px 16px',
          overflowY: 'auto',
          fontSize: '13px',
          lineHeight: '1.6',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {/* Running / Queued indicator */}
        {isRunning && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              color: currentStatus === 'queued' ? '#60a5fa' : '#facc15',
              marginBottom: '8px',
              fontStyle: 'italic',
            }}
          >
            <span>{currentStatus === 'queued' ? '⏳ Queued in worker pool...' : '⚡ Running in isolated container...'}</span>
          </div>
        )}

        {/* API / Auth / System Error Message */}
        {hasError && (
          <div
            style={{
              padding: '8px 12px',
              backgroundColor: '#ef444415',
              border: '1px solid #ef444440',
              borderRadius: '6px',
              color: '#f87171',
              marginBottom: '10px',
              fontSize: '12.5px',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: '2px' }}>⚠️ Execution Error:</div>
            <div>{result?.error}</div>
          </div>
        )}

        {/* Standard Output */}
        {hasStdout && (
          <pre
            style={{
              margin: 0,
              padding: 0,
              fontFamily: 'inherit',
              color: '#f1f5f9',
              whiteSpace: 'pre-wrap',
            }}
          >
            {result?.stdout}
          </pre>
        )}

        {/* Standard Error / Runtime Exception */}
        {hasStderr && (
          <pre
            style={{
              margin: hasStdout ? '8px 0 0 0' : 0,
              padding: 0,
              fontFamily: 'inherit',
              color: '#f87171',
              whiteSpace: 'pre-wrap',
            }}
          >
            {result?.stderr}
          </pre>
        )}

        {/* Empty output case for completed run with no stdout/stderr */}
        {hasRun && !isRunning && !hasStdout && !hasStderr && !hasError && (
          <div style={{ color: '#64748b', fontStyle: 'italic' }}>
            (Process finished with exit code {result?.exitCode ?? 0} and produced no console output)
          </div>
        )}

        {/* Initial Idle state */}
        {!hasRun && !isRunning && (
          <div style={{ color: '#64748b', fontStyle: 'italic' }}>
            Click &quot;Run Code&quot; (Driver only) to execute code in a secure sandboxed container.
            {'\n'}Output and realtime execution status will appear here.
          </div>
        )}
      </div>
    </div>
  );
};

export default Terminal;
