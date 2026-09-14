import React, { useEffect, useState } from 'react';

export default function App() {
  const [backendStatus, setBackendStatus] = useState<string>('checking...');

  useEffect(() => {
    fetch('http://localhost:5000/health')
      .then((res) => res.json())
      .then((data) => setBackendStatus(data.status || 'connected'))
      .catch(() => setBackendStatus('offline'));
  }, []);

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
      <h1>CodeCollab — Collaborative Coding Platform</h1>
      <p>Backend Status: <strong>{backendStatus}</strong></p>
    </div>
  );
}
