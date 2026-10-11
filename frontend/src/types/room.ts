export interface RoomUser {
  id: string;
  _id?: string;
  username: string;
  email?: string;
}

export interface Room {
  id: string;
  _id?: string;
  roomId: string;
  name: string;
  language: string;
  isPrivate?: boolean;
  inviteCode?: string;
  currentCode?: string;
  owner: RoomUser | string;
  members: Array<RoomUser | string>;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateRoomPayload {
  name: string;
  language?: string;
  isPrivate?: boolean;
}

export interface JoinRoomPayload {
  roomId: string;
  inviteCode?: string;
}

export interface RoomResponse {
  ok: boolean;
  room?: Room;
  error?: string;
}

export interface RoomListResponse {
  ok: boolean;
  rooms?: Room[];
  error?: string;
}

export interface InviteResponse {
  ok: boolean;
  inviteCode?: string;
  error?: string;
}
