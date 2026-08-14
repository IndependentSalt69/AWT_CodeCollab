import React from 'react';

export default function App() {
  return <div>CodeCollab Client</div>;
}

useEffect(() => {
  fetch('http://localhost:5000/health')
    .then(res => res.json())
    .then(data => console.log(data));
}, []);
