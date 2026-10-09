import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
} from 'react';
import { User, LoginPayload, RegisterPayload } from '../types/auth';
import {
  login as apiLogin,
  register as apiRegister,
  getCurrentUser as apiGetCurrentUser,
  getStoredToken,
  removeStoredToken,
} from '../services/authService';

interface AuthContextType {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (payload: LoginPayload) => Promise<boolean>;
  register: (payload: RegisterPayload) => Promise<boolean>;
  logout: () => void;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Restore session from localStorage on initial mount
  useEffect(() => {
    let isMounted = true;

    async function restoreSession() {
      const storedToken = getStoredToken();
      if (!storedToken) {
        if (isMounted) {
          setIsLoading(false);
        }
        return;
      }

      try {
        const response = await apiGetCurrentUser(storedToken);
        if (isMounted) {
          if (response.ok && response.user) {
            setUser(response.user);
            setToken(storedToken);
          } else {
            removeStoredToken();
            setUser(null);
            setToken(null);
          }
        }
      } catch (_) {
        if (isMounted) {
          removeStoredToken();
          setUser(null);
          setToken(null);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    restoreSession();

    return () => {
      isMounted = false;
    };
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const login = useCallback(async (payload: LoginPayload): Promise<boolean> => {
    setError(null);
    const res = await apiLogin(payload);
    if (res.ok && res.user && res.token) {
      setUser(res.user);
      setToken(res.token);
      return true;
    } else {
      setError(res.error || 'Login failed');
      return false;
    }
  }, []);

  const register = useCallback(async (payload: RegisterPayload): Promise<boolean> => {
    setError(null);
    const res = await apiRegister(payload);
    if (res.ok && res.user && res.token) {
      setUser(res.user);
      setToken(res.token);
      return true;
    } else {
      setError(res.error || 'Registration failed');
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    removeStoredToken();
    setUser(null);
    setToken(null);
    setError(null);
  }, []);

  const value: AuthContextType = {
    user,
    token,
    isAuthenticated: Boolean(user && token),
    isLoading,
    error,
    login,
    register,
    logout,
    clearError,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
