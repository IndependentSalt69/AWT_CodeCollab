# CodeCollab API Specification

## 1. Authentication Endpoints (`/api/auth`)

### 1.1 User Registration
Registers a new user account, securely hashes their password with bcrypt, and returns a signed JWT along with public profile details.

- **URL:** `POST /api/auth/register`
- **Authentication:** None (Public)
- **Headers:** `Content-Type: application/json`

#### Request Body
```json
{
  "username": "alice_dev",
  "email": "alice@example.com",
  "password": "securepassword123"
}
```

#### Request Fields
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `username` | `string` | **Yes** | Unique username (min 3 characters). |
| `email` | `string` | **Yes** | Valid, unique email address. |
| `password` | `string` | **Yes** | Account password (min 6 characters). Never stored in plaintext. |

#### Successful Response (`201 Created`)
```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "67056a1b2c3d4e5f6a7b8c01",
    "username": "alice_dev",
    "email": "alice@example.com",
    "createdAt": "2026-10-09T20:00:00.000Z"
  }
}
```

#### Error Responses
- **`400 Bad Request`**: Validation failure (missing fields, username < 3 chars, invalid email, password < 6 chars).
- **`409 Conflict`**: Account with username or email already exists.

---

### 1.2 User Login
Authenticates an existing user using username/email and password, returning a signed JWT.

- **URL:** `POST /api/auth/login`
- **Authentication:** None (Public)
- **Headers:** `Content-Type: application/json`

#### Request Body
```json
{
  "username": "alice_dev",
  "password": "securepassword123"
}
```
*(Or pass `"email": "alice@example.com"`)*

#### Successful Response (`200 OK`)
```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "67056a1b2c3d4e5f6a7b8c01",
    "username": "alice_dev",
    "email": "alice@example.com",
    "createdAt": "2026-10-09T20:00:00.000Z"
  }
}
```

#### Error Responses
- **`400 Bad Request`**: Missing credentials.
- **`401 Unauthorized`**: Invalid credentials (generic message; does not leak user existence).

---

### 1.3 Current User (`GET /api/auth/me`)
Retrieves the safe public profile of the currently authenticated user.

- **URL:** `GET /api/auth/me`
- **Authentication:** Required (`Bearer <JWT_TOKEN>`)

#### Successful Response (`200 OK`)
```json
{
  "ok": true,
  "user": {
    "id": "67056a1b2c3d4e5f6a7b8c01",
    "username": "alice_dev",
    "email": "alice@example.com",
    "createdAt": "2026-10-09T20:00:00.000Z"
  }
}
```

---

## 2. Room Management Endpoints (`/api/rooms`) — M0.8

### 2.1 Create Room
Creates a new persistent collaborative coding room. The authenticated creator automatically becomes the room owner and first persistent member.

- **URL:** `POST /api/rooms`
- **Authentication:** Required (`Bearer <JWT_TOKEN>`)
- **Headers:** `Content-Type: application/json`

#### Request Body
```json
{
  "name": "Algorithms Practice",
  "language": "python",
  "isPrivate": false
}
```

#### Request Fields
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `name` | `string` | **Yes** | Room name (1-100 characters). |
| `language` | `string` | Optional | Default editor language (`python`, `java`, `cpp`). Default: `python`. |
| `isPrivate` | `boolean` | Optional | Privacy flag. Default: `false`. |

#### Successful Response (`201 Created`)
```json
{
  "ok": true,
  "room": {
    "id": "67056a1b2c3d4e5f6a7b8c99",
    "roomId": "algorithms-practice-f4a2b1",
    "name": "Algorithms Practice",
    "language": "python",
    "isPrivate": false,
    "currentCode": "",
    "owner": {
      "id": "67056a1b2c3d4e5f6a7b8c01",
      "username": "alice_dev",
      "email": "alice@example.com"
    },
    "members": [
      {
        "id": "67056a1b2c3d4e5f6a7b8c01",
        "username": "alice_dev",
        "email": "alice@example.com"
      }
    ],
    "createdAt": "2026-10-10T12:00:00.000Z",
    "updatedAt": "2026-10-10T12:00:00.000Z"
  }
}
```

#### Error Responses
- **`400 Bad Request`**: Missing name or name exceeding 100 characters.
- **`401 Unauthorized`**: Missing or invalid Bearer token.
- **`500 Internal Server Error`**: Database error during creation.

---

### 2.2 List User's Rooms
Lists only the persistent rooms where the authenticated user is an owner or member. Does not expose rooms belonging exclusively to other users.

- **URL:** `GET /api/rooms`
- **Authentication:** Required (`Bearer <JWT_TOKEN>`)

#### Successful Response (`200 OK`)
```json
{
  "ok": true,
  "rooms": [
    {
      "id": "67056a1b2c3d4e5f6a7b8c99",
      "roomId": "algorithms-practice-f4a2b1",
      "name": "Algorithms Practice",
      "language": "python",
      "isPrivate": false,
      "owner": { "id": "...", "username": "alice_dev" },
      "members": [{ "id": "...", "username": "alice_dev" }],
      "createdAt": "2026-10-10T12:00:00.000Z",
      "updatedAt": "2026-10-10T12:00:00.000Z"
    }
  ]
}
```

---

### 2.3 Get Room Details
Retrieves details for a specific room if and only if the authenticated user is a persistent member or owner.

- **URL:** `GET /api/rooms/:roomId`
- **Authentication:** Required (`Bearer <JWT_TOKEN>`)

#### Successful Response (`200 OK`)
```json
{
  "ok": true,
  "room": {
    "id": "67056a1b2c3d4e5f6a7b8c99",
    "roomId": "algorithms-practice-f4a2b1",
    "name": "Algorithms Practice",
    "language": "python",
    "owner": { "id": "...", "username": "alice_dev" },
    "members": [{ "id": "...", "username": "alice_dev" }, { "id": "...", "username": "bob" }],
    "createdAt": "2026-10-10T12:00:00.000Z",
    "updatedAt": "2026-10-10T12:00:00.000Z"
  }
}
```

#### Error Responses
- **`401 Unauthorized`**: Missing or invalid token.
- **`403 Forbidden`**: Requester is not a member of the requested room (`Access denied: You are not a member of this room`).
- **`404 Not Found`**: Room identifier does not match any existing room.

---

### 2.4 Join Existing Room
Adds the authenticated user to the persistent membership list of a room using its unique `roomId` or join code. Idempotent: repeated joins do not duplicate membership.

- **URL:** `POST /api/rooms/:roomId/join` or `POST /api/rooms/join` (with body `{ "roomId": "..." }` or `{ "joinCode": "..." }`)
- **Authentication:** Required (`Bearer <JWT_TOKEN>`)

#### Successful Response (`200 OK`)
```json
{
  "ok": true,
  "room": {
    "id": "67056a1b2c3d4e5f6a7b8c99",
    "roomId": "algorithms-practice-f4a2b1",
    "name": "Algorithms Practice",
    "members": [ ... ]
  }
}
```

#### Error Responses
- **`401 Unauthorized`**: Missing or invalid token.
- **`404 Not Found`**: Unknown room ID or join code.

---

### 2.5 Room History Pagination (shared)
The chat history and execution history endpoints use the same cursor pagination:

- Results are ordered **newest first**.
- `limit` (optional query): integer from 1 to 100. Default 50.
- `before` (optional query): the `nextCursor` value from the previous page. Returns items older than that item.
- `nextCursor` in the response is the id to pass as `before` for the next page, or `null` when there are no more items.
- Invalid `limit` or `before` values return `400 Bad Request`.

Room access follows the same rule as `GET /api/rooms/:roomId`: the caller must be the owner or a member. `:roomId` may be the room's `roomId` or its database `_id`.

---

### 2.6 Chat History
Returns persisted chat messages for a room. New messages arrive live through the `chat:message_received` socket event; each message has the same `id` in both places.

- **URL:** `GET /api/rooms/:roomId/messages?limit=50&before=<messageId>`
- **Authentication:** Required (`Bearer <JWT_TOKEN>`)

#### Successful Response (`200 OK`)
```json
{
  "ok": true,
  "messages": [
    {
      "id": "6713a9c2e4b0a1c2d3e4f501",
      "roomId": "algorithms-practice-f4a2b1",
      "content": "Let's try the two-pointer approach",
      "sender": { "id": "67056a1b2c3d4e5f6a7b8c02", "username": "bob" },
      "timestamp": "2026-10-19T10:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

#### Error Responses
- **`400 Bad Request`**: Invalid `limit` or `before`.
- **`401 Unauthorized`**: Missing or invalid token.
- **`403 Forbidden`**: Requester is not a member of the room.
- **`404 Not Found`**: Unknown room.
- **`500 Internal Server Error`**: `Failed to fetch chat history` (details are logged on the server only).

---

### 2.7 Execution History
Returns past code runs for a room. Every room member can see every run in the room, including other members' output, which matches what members already see live through the `execution:*` events. Submitted source code is not included.

- **URL:** `GET /api/rooms/:roomId/executions?limit=50&before=<runId>`
- **Authentication:** Required (`Bearer <JWT_TOKEN>`)

#### Successful Response (`200 OK`)
```json
{
  "ok": true,
  "runs": [
    {
      "id": "6713aa10e4b0a1c2d3e4f610",
      "roomId": "algorithms-practice-f4a2b1",
      "language": "python",
      "status": "completed",
      "exitCode": 0,
      "executionTimeMs": 182,
      "timedOut": false,
      "stdout": "Hello\n",
      "stderr": "",
      "triggeredBy": { "id": "67056a1b2c3d4e5f6a7b8c01", "username": "alice_dev" },
      "createdAt": "2026-10-19T10:05:00.000Z",
      "updatedAt": "2026-10-19T10:05:01.000Z"
    }
  ],
  "nextCursor": null
}
```

- `status` is one of `queued`, `running`, `completed`, `failed`, `timeout`. A run is only `completed` after its final result has been saved.
- `timedOut` is `true` when `status` is `timeout`.
- `stdout` and `stderr` are stored with the existing 64 KiB output limit, so long output may end with a truncation notice.

#### Error Responses
- **`400 Bad Request`**: Invalid `limit` or `before`.
- **`401 Unauthorized`**: Missing or invalid token.
- **`403 Forbidden`**: Requester is not a member of the room.
- **`404 Not Found`**: Unknown room.
- **`500 Internal Server Error`**: `Failed to fetch execution history`.

---

### 2.8 Voice Token (LiveKit)
Issues a short-lived LiveKit access token so a room member can join the room's voice channel. Audio is handled by LiveKit directly; the backend only checks access and signs the token.

- **URL:** `POST /api/rooms/:roomId/voice-token`
- **Authentication:** Required (`Bearer <JWT_TOKEN>`)
- **Rate limit:** 10 requests per IP per minute (`RATE_LIMIT_VOICE_TOKEN_MAX`).
- **Request body:** none. The voice room and identity come from the server, never from the client.

#### Successful Response (`200 OK`)
```json
{
  "ok": true,
  "token": "<LiveKit JWT>",
  "url": "wss://your-project.livekit.cloud",
  "roomName": "codecollab-algorithms-practice-f4a2b1",
  "identity": "67056a1b2c3d4e5f6a7b8c01",
  "expiresIn": 600
}
```

- `roomName` is always `codecollab-<roomId>`, so each CodeCollab room has exactly one voice room.
- `identity` is the CodeCollab user id; the participant display name is the username.
- The token grants join, publish and subscribe for that one voice room and expires after 10 minutes. It is only needed to connect; an active voice session continues after it expires.
- The client connects with the LiveKit client SDK using `url` and `token`.

#### Error Responses
- **`401 Unauthorized`**: Missing or invalid token.
- **`403 Forbidden`**: Requester is not a member of the room.
- **`404 Not Found`**: Unknown room.
- **`429 Too Many Requests`**: Rate limit exceeded.
- **`503 Service Unavailable`**: `Voice chat is not configured on this server` (LiveKit environment variables are missing).

#### Configuration
Set these on the backend only. Never expose the API secret to the frontend.

| Variable | Description |
| :--- | :--- |
| `LIVEKIT_URL` | LiveKit server WebSocket URL, e.g. `wss://your-project.livekit.cloud` or `ws://localhost:7880` for a local server |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret used to sign tokens |

For local testing, run a LiveKit server in dev mode (`livekit-server --dev`, which uses the key `devkey` and secret `secret`), set the variables above, then request a token and join it from the LiveKit client SDK or the LiveKit Meet sample app.

---

## 3. Execution Endpoints (`/api/execute`)

### 3.1 Execute Code
Executes submitted source code in a sandboxed, ephemeral container for the active room Driver.

- **URL:** `POST /api/execute`
- **Authentication:** Required (`Bearer <JWT_TOKEN>` in `Authorization` header)
- **Authorization:** Only the active **Driver** of the target room is permitted to trigger code execution.
- **Identity Binding:** The caller's authenticated user identity MUST match the verified user identity bound to the active driver socket. If driver metadata is missing, or identities do not match, the request fails closed (`403 Forbidden`).

#### Request Headers
| Header | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `Authorization` | `string` | **Yes** | `Bearer <JWT_TOKEN>` signed with backend `JWT_SECRET`. |
| `x-socket-id` | `string` | Optional | Client Socket ID to directly correlate driver session. |
| `Content-Type` | `string` | **Yes** | `application/json` |

#### Request Body
```json
{
  "roomId": "algorithms-practice-f4a2b1",
  "language": "python",
  "code": "print('Hello CodeCollab')\nprint(10 + 20)",
  "timeout": 5000,
  "memory": "256m"
}
```

#### Successful Response (`200 OK`)
```json
{
  "ok": true,
  "runId": "67056a1b2c3d4e5f6a7b8c9d",
  "status": "completed",
  "result": {
    "stdout": "Hello CodeCollab\n30\n",
    "stderr": "",
    "exitCode": 0,
    "executionTimeMs": 285,
    "status": "completed"
  },
  "run": {
    "_id": "67056a1b2c3d4e5f6a7b8c9d",
    "roomId": "algorithms-practice-f4a2b1",
    "triggeredBy": "67056a1b2c3d4e5f6a7b8c01",
    "language": "python",
    "status": "completed"
  }
}
```