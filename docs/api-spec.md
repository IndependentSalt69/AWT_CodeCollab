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
  ```json
  {
    "ok": false,
    "error": "Password must be at least 6 characters long"
  }
  ```
- **`409 Conflict`**: Account with username or email already exists.
  ```json
  {
    "ok": false,
    "error": "Username already registered"
  }
  ```

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
*(Or pass `"email": "alice@example.com"` instead of `"username"`)*

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
  ```json
  {
    "ok": false,
    "error": "Invalid username/email or password"
  }
  ```

---

### 1.3 Current User (`GET /api/auth/me`)
Retrieves the safe public profile of the currently authenticated user.

- **URL:** `GET /api/auth/me`
- **Authentication:** Required (`Bearer <JWT_TOKEN>` in `Authorization` header)

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

#### Error Responses
- **`401 Unauthorized`**: Missing, invalid, or expired Bearer token.
  ```json
  {
    "ok": false,
    "error": "Invalid or expired token."
  }
  ```

---

## 2. Execution Endpoints (`/api/execute`)

### 2.1 Execute Code
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
  "roomId": "room-abc-123",
  "language": "python",
  "code": "print('Hello CodeCollab')\nprint(10 + 20)",
  "timeout": 5000,
  "memory": "256m"
}
```

#### Request Parameters
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `roomId` | `string` | **Yes** | ID of the room where code execution is triggered. |
| `language` | `string` | **Yes** | Target language (`python`, `java`, `cpp`). *Note: Container execution is currently active for `python`.* |
| `code` | `string` | **Yes** | Source code to execute in the sandbox. |
| `timeout` | `number` | Optional | Execution timeout in milliseconds (default: `5000`). |
| `memory` | `string` \| `number` | Optional | Memory limit string (default: `256m`). |

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
    "roomId": "room-abc-123",
    "triggeredBy": "67056a1b2c3d4e5f6a7b8c01",
    "language": "python",
    "code": "print('Hello CodeCollab')\nprint(10 + 20)",
    "status": "completed",
    "stdout": "Hello CodeCollab\n30\n",
    "stderr": "",
    "exitCode": 0,
    "executionTimeMs": 285,
    "createdAt": "2026-10-09T18:30:00.000Z",
    "updatedAt": "2026-10-09T18:30:00.285Z"
  }
}
```

#### Error Responses
- **`400 Bad Request`**: Missing `roomId`, `language`, `code`, or unsupported language.
- **`401 Unauthorized`**: Missing, invalid, or expired JWT.
- **`403 Forbidden`**:
  - Requester is not the active driver (`Only the active room driver can execute code`).
  - Driver socket has no verified identity (`Driver session is not authenticated with a verified user identity`).
  - Requester identity does not match driver socket (`Authenticated user does not match the active room driver session`).
- **`404 Not Found`**: Room does not exist or has no active driver assigned.
- **`500 Internal Server Error`**: Redis/BullMQ queue or container execution failure.