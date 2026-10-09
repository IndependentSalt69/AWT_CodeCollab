export interface User {
  id: string;
  username: string;
  email: string;
  createdAt?: string;
}

export interface RegisterPayload {
  username: string;
  email: string;
  password: string;
}

export interface LoginPayload {
  username?: string;
  email?: string;
  password: string;
}

export interface AuthResponse {
  ok: boolean;
  token?: string;
  user?: User;
  error?: string;
}

export interface CurrentUserResponse {
  ok: boolean;
  user?: User;
  error?: string;
}
