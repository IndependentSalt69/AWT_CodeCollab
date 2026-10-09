# CodeCollab API Specification

## 1. Execution Endpoints (`/api/execute`)

### Execute Code
Executes submitted source code in a sandboxed, ephemeral container for the active room Driver.

- **URL:** `POST /api/execute`
- **Authentication:** Required (`Bearer <JWT_TOKEN>` in `Authorization` header)
- **Authorization:** Only the active **Driver** of the target room is permitted to trigger code execution.

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
| `language` | `string` | **Yes** | Target language (`python`, `java`, `cpp`). *Note: Dynamic container execution is currently enabled for `python` (M0.5d).* |
| `code` | `string` | **Yes** | Source code to execute in the sandbox. |
| `timeout` | `number` | Optional | Execution timeout in milliseconds (default: `5000`). |
| `memory` | `string` \| `number` | Optional | Memory limit string (e.g. `256m`, `512m`) or bytes (default: `256m`). |

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
    "triggeredBy": "67056a1b2c3d4e5f6a7b8c00",
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
  ```json
  {
    "ok": false,
    "error": "roomId is required and must be a non-empty string"
  }
  ```
- **`401 Unauthorized`**: Missing, invalid, or expired JWT.
  ```json
  {
    "ok": false,
    "error": "Authentication required. No token provided."
  }
  ```
- **`403 Forbidden`**: Requester is not the active driver of the room.
  ```json
  {
    "ok": false,
    "error": "Only the active room driver can execute code"
  }
  ```
- **`404 Not Found`**: Room does not exist or has no active session.
  ```json
  {
    "ok": false,
    "error": "Room not found or no active driver assigned"
  }
  ```
- **`500 Internal Server Error`**: Redis/BullMQ queue or infrastructure failure.
  ```json
  {
    "ok": false,
    "error": "Execution queue failure: ..."
  }
  ```

---

## 2. Health Check (`/health`)

- **URL:** `GET /health`
- **Authentication:** None
- **Response:**
  ```json
  {
    "status": "ok",
    "timestamp": "2026-10-09T18:30:00.000Z"
  }
  ```