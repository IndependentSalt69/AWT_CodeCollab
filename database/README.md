# Database Models & Seeds

This directory contains Mongoose schemas and seed scripts for CodeCollab.

## Models
- `User.js` — User accounts, hashed passwords, credentials, avatars.
- `Room.js` — Collaborative coding rooms, owner, active driver, active code, and language.
- `Message.js` — Real-time and persisted chat messages per room.
- `ExecutionRun.js` — Execution logs, language, submitted code, stdout/stderr, execution time, and exit status.

## Seeds
Place seed data and generation scripts inside `seeds/`.
