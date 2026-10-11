/**
 * @jest-environment jsdom
 *
 * SEC-TEST-01: Real Frontend React Component Test Suite
 *
 * Validates real React component mounting, interactive behaviors, form validations,
 * authentication flows, private room workflows, and execution/terminal rendering.
 * Uses React Testing Library with jsdom to exercise real UI components.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import { LoginPage } from '../../frontend/src/pages/Login/LoginPage';
import { SignupPage } from '../../frontend/src/pages/Signup/SignupPage';
import { DashboardPage } from '../../frontend/src/pages/Dashboard/DashboardPage';
import { Terminal } from '../../frontend/src/components/terminal/Terminal';
import * as roomService from '../../frontend/src/services/roomService';
import * as authContext from '../../frontend/src/context/AuthContext';

// Mock the services and context
jest.mock('../../frontend/src/services/roomService');
jest.mock('../../frontend/src/context/AuthContext');

describe('SEC-TEST-01: Real Frontend React Component Verification', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('1. LoginPage Component Flow', () => {
    const mockLogin = jest.fn();
    const mockClearError = jest.fn();
    const mockOnSwitchToSignup = jest.fn();
    const mockOnSuccess = jest.fn();

    beforeEach(() => {
      authContext.useAuth.mockReturnValue({
        user: null,
        token: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
        login: mockLogin,
        register: jest.fn(),
        logout: jest.fn(),
        clearError: mockClearError,
      });
    });

    it('renders login form with inputs and switches to signup', () => {
      render(
        <LoginPage
          onSwitchToSignup={mockOnSwitchToSignup}
          onSuccess={mockOnSuccess}
        />
      );

      expect(screen.getByLabelText(/username or email/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/^password/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();

      const signupLink = screen.getByRole('button', { name: /create account/i });
      fireEvent.click(signupLink);
      expect(mockOnSwitchToSignup).toHaveBeenCalledTimes(1);
    });

    it('validates required identifier before submission', async () => {
      render(
        <LoginPage
          onSwitchToSignup={mockOnSwitchToSignup}
          onSuccess={mockOnSuccess}
        />
      );

      const submitBtn = screen.getByRole('button', { name: /sign in/i });
      fireEvent.submit(submitBtn.closest('form'));

      expect(screen.getByText(/please enter your username or email address/i)).toBeInTheDocument();
      expect(mockLogin).not.toHaveBeenCalled();
    });

    it('validates required password before submission', async () => {
      render(
        <LoginPage
          onSwitchToSignup={mockOnSwitchToSignup}
          onSuccess={mockOnSuccess}
        />
      );

      const identifierInput = screen.getByLabelText(/username or email/i);
      fireEvent.change(identifierInput, { target: { value: 'alice_coder' } });

      const submitBtn = screen.getByRole('button', { name: /sign in/i });
      fireEvent.submit(submitBtn.closest('form'));

      expect(screen.getByText(/please enter your password/i)).toBeInTheDocument();
      expect(mockLogin).not.toHaveBeenCalled();
    });

    it('submits valid credentials and triggers onSuccess on successful login', async () => {
      mockLogin.mockResolvedValueOnce(true);

      render(
        <LoginPage
          onSwitchToSignup={mockOnSwitchToSignup}
          onSuccess={mockOnSuccess}
        />
      );

      const identifierInput = screen.getByLabelText(/username or email/i);
      const passwordInput = screen.getByLabelText(/^password/i);
      const submitBtn = screen.getByRole('button', { name: /sign in/i });

      fireEvent.change(identifierInput, { target: { value: 'alice_coder' } });
      fireEvent.change(passwordInput, { target: { value: 'SecretPassword123!' } });
      fireEvent.click(submitBtn);

      expect(mockClearError).toHaveBeenCalled();
      expect(mockLogin).toHaveBeenCalledWith({
        username: 'alice_coder',
        password: 'SecretPassword123!',
      });

      await waitFor(() => {
        expect(mockOnSuccess).toHaveBeenCalledTimes(1);
      });
    });

    it('renders server authentication errors from context', () => {
      authContext.useAuth.mockReturnValue({
        user: null,
        token: null,
        isAuthenticated: false,
        isLoading: false,
        error: 'Invalid credentials. Please check your username and password.',
        login: mockLogin,
        register: jest.fn(),
        logout: jest.fn(),
        clearError: mockClearError,
      });

      render(
        <LoginPage
          onSwitchToSignup={mockOnSwitchToSignup}
          onSuccess={mockOnSuccess}
        />
      );

      expect(
        screen.getByText(/invalid credentials\. please check your username and password\./i)
      ).toBeInTheDocument();
    });
  });

  describe('2. SignupPage Component Flow', () => {
    const mockRegister = jest.fn();
    const mockClearError = jest.fn();
    const mockOnSwitchToLogin = jest.fn();
    const mockOnSuccess = jest.fn();

    beforeEach(() => {
      authContext.useAuth.mockReturnValue({
        user: null,
        token: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
        login: jest.fn(),
        register: mockRegister,
        logout: jest.fn(),
        clearError: mockClearError,
      });
    });

    it('renders signup form and switches to login', () => {
      render(
        <SignupPage
          onSwitchToLogin={mockOnSwitchToLogin}
          onSuccess={mockOnSuccess}
        />
      );

      expect(screen.getByLabelText(/^username/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/password \(min\. 6 characters\)/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();

      const switchBtn = screen.getByRole('button', { name: /sign in/i });
      fireEvent.click(switchBtn);
      expect(mockOnSwitchToLogin).toHaveBeenCalledTimes(1);
    });

    it('validates minimum username length and email format', async () => {
      render(
        <SignupPage
          onSwitchToLogin={mockOnSwitchToLogin}
          onSuccess={mockOnSuccess}
        />
      );

      const usernameInput = screen.getByLabelText(/^username/i);
      const submitBtn = screen.getByRole('button', { name: /create account/i });

      // Short username
      fireEvent.change(usernameInput, { target: { value: 'al' } });
      fireEvent.submit(submitBtn.closest('form'));
      expect(screen.getByText(/username must be at least 3 characters long/i)).toBeInTheDocument();

      // Invalid email
      fireEvent.change(usernameInput, { target: { value: 'alice_valid' } });
      const emailInput = screen.getByLabelText(/email address/i);
      fireEvent.change(emailInput, { target: { value: 'invalid-email-address' } });
      fireEvent.submit(submitBtn.closest('form'));
      expect(screen.getByText(/please provide a valid email address/i)).toBeInTheDocument();
    });

    it('validates password matching confirmation', async () => {
      render(
        <SignupPage
          onSwitchToLogin={mockOnSwitchToLogin}
          onSuccess={mockOnSuccess}
        />
      );

      fireEvent.change(screen.getByLabelText(/^username/i), { target: { value: 'alice_coder' } });
      fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'alice@example.com' } });
      fireEvent.change(screen.getByLabelText(/password \(min\. 6 characters\)/i), { target: { value: 'Password123!' } });
      fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'MismatchPassword!' } });

      const submitBtn = screen.getByRole('button', { name: /create account/i });
      fireEvent.submit(submitBtn.closest('form'));
      expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument();
      expect(mockRegister).not.toHaveBeenCalled();
    });

    it('submits valid registration and invokes onSuccess', async () => {
      mockRegister.mockResolvedValueOnce(true);

      render(
        <SignupPage
          onSwitchToLogin={mockOnSwitchToLogin}
          onSuccess={mockOnSuccess}
        />
      );

      fireEvent.change(screen.getByLabelText(/^username/i), { target: { value: 'alice_coder' } });
      fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'Alice@Example.COM' } });
      fireEvent.change(screen.getByLabelText(/password \(min\. 6 characters\)/i), { target: { value: 'Password123!' } });
      fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'Password123!' } });

      fireEvent.click(screen.getByRole('button', { name: /create account/i }));

      expect(mockRegister).toHaveBeenCalledWith({
        username: 'alice_coder',
        email: 'alice@example.com', // Normalized to lowercase
        password: 'Password123!',
      });

      await waitFor(() => {
        expect(mockOnSuccess).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('3. DashboardPage Component & Private Room Flow', () => {
    const mockUser = {
      id: 'usr_owner_1',
      username: 'alice_owner',
      email: 'alice@example.com',
    };
    const mockToken = 'mock_jwt_token_123';
    const mockOnSelectRoom = jest.fn();

    beforeEach(() => {
      authContext.useAuth.mockReturnValue({
        user: mockUser,
        token: mockToken,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });
      roomService.listRooms.mockResolvedValue({
        ok: true,
        rooms: [],
      });
    });

    it('renders empty state when user has no joined rooms', async () => {
      render(<DashboardPage onSelectRoom={mockOnSelectRoom} />);

      expect(await screen.findByText(/no rooms joined yet/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /\+ create your first room/i })).toBeInTheDocument();
    });

    it('renders public and private room cards with correct privacy badges', async () => {
      const mockRooms = [
        {
          id: 'room_1',
          roomId: 'algo-practice-1234',
          name: 'Public Algo Lab',
          language: 'python',
          isPrivate: false,
          owner: mockUser,
          members: [mockUser],
        },
        {
          id: 'room_2',
          roomId: 'secret-sys-5678',
          name: 'Private Kernel Lab',
          language: 'cpp',
          isPrivate: true,
          inviteCode: '0123456789abcdef0123456789abcdef', // 128-bit hex
          owner: mockUser,
          members: [mockUser],
        },
      ];

      roomService.listRooms.mockResolvedValueOnce({
        ok: true,
        rooms: mockRooms,
      });

      render(<DashboardPage onSelectRoom={mockOnSelectRoom} />);

      expect(await screen.findByText('Public Algo Lab')).toBeInTheDocument();
      expect(screen.getByText('Private Kernel Lab')).toBeInTheDocument();

      // Verify Private badge is rendered for private room
      expect(screen.getByTestId('room-private-badge-secret-sys-5678')).toBeInTheDocument();
      expect(screen.getByTestId('room-private-badge-secret-sys-5678')).toHaveTextContent(/private/i);

      // Verify owner sees copy invite button for private room
      expect(screen.getByTestId('copy-invite-btn-secret-sys-5678')).toBeInTheDocument();
    });

    it('handles complete private room creation flow with 128-bit invite code modal', async () => {
      const generatedInviteCode = 'e1a2b3c4d5e6f70891a2b3c4d5e6f708'; // 32 hex chars (128 bits)
      const createdPrivateRoom = {
        id: 'new_private_room_id',
        roomId: 'private-algo-f4a2',
        name: 'Private Algo Study',
        language: 'python',
        isPrivate: true,
        inviteCode: generatedInviteCode,
        owner: mockUser,
        members: [mockUser],
      };

      roomService.createRoom.mockResolvedValueOnce({
        ok: true,
        room: createdPrivateRoom,
      });

      render(<DashboardPage onSelectRoom={mockOnSelectRoom} />);

      // Open create room modal
      const openCreateBtn = await screen.findByRole('button', { name: /\+ create room/i });
      fireEvent.click(openCreateBtn);

      expect(screen.getByText(/create new room/i)).toBeInTheDocument();

      // Enter room details and check private checkbox
      const nameInput = screen.getByLabelText(/room name/i);
      fireEvent.change(nameInput, { target: { value: 'Private Algo Study' } });

      const privateCheckbox = screen.getByLabelText(/private room/i);
      expect(privateCheckbox).not.toBeChecked();
      fireEvent.click(privateCheckbox);
      expect(privateCheckbox).toBeChecked();

      // Submit creation
      const submitBtn = screen.getByRole('button', { name: /create & enter/i });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(roomService.createRoom).toHaveBeenCalledWith(
          {
            name: 'Private Algo Study',
            language: 'python',
            isPrivate: true,
          },
          mockToken
        );
      });

      // Verify Private Room Created Modal appears with the 128-bit invite code
      expect(await screen.findByText(/private room created!/i)).toBeInTheDocument();
      expect(screen.getAllByText(generatedInviteCode).length).toBeGreaterThanOrEqual(1);

      // Clicking Enter Room selects room
      const enterBtn = document.getElementById('enter-created-room-btn');
      fireEvent.click(enterBtn);

      expect(mockOnSelectRoom).toHaveBeenCalledWith(createdPrivateRoom);
    });

    it('handles private room joining with invite code', async () => {
      const joinedRoom = {
        id: 'joined_room_id',
        roomId: 'teammate-room-1234',
        name: 'Teammates Room',
        language: 'python',
        isPrivate: true,
        owner: { id: 'usr_other', username: 'bob' },
        members: [mockUser],
      };

      roomService.joinRoom.mockResolvedValueOnce({
        ok: true,
        room: joinedRoom,
      });

      render(<DashboardPage onSelectRoom={mockOnSelectRoom} />);

      // Open Join modal
      const openJoinBtn = await screen.findByRole('button', { name: /join with code/i });
      fireEvent.click(openJoinBtn);

      expect(screen.getByText(/join existing room/i)).toBeInTheDocument();

      // Fill in room ID and invite code
      const roomIdInput = screen.getByLabelText(/room id or join code/i);
      const inviteCodeInput = screen.getByLabelText(/invite code/i);

      fireEvent.change(roomIdInput, { target: { value: 'teammate-room-1234' } });
      fireEvent.change(inviteCodeInput, { target: { value: '32characterhexinvitecodetoken1234' } });

      const submitJoinBtn = screen.getByRole('button', { name: /join room/i });
      fireEvent.click(submitJoinBtn);

      await waitFor(() => {
        expect(roomService.joinRoom).toHaveBeenCalledWith(
          'teammate-room-1234',
          mockToken,
          '32characterhexinvitecodetoken1234'
        );
        expect(mockOnSelectRoom).toHaveBeenCalledWith(joinedRoom);
      });
    });

    it('displays error banner when room join fails', async () => {
      roomService.joinRoom.mockResolvedValueOnce({
        ok: false,
        error: 'Invalid invite code for private room',
      });

      render(<DashboardPage onSelectRoom={mockOnSelectRoom} />);

      const openJoinBtn = await screen.findByRole('button', { name: /join with code/i });
      fireEvent.click(openJoinBtn);

      const roomIdInput = screen.getByLabelText(/room id or join code/i);
      const inviteCodeInput = screen.getByLabelText(/invite code/i);

      fireEvent.change(roomIdInput, { target: { value: 'private-room-target' } });
      fireEvent.change(inviteCodeInput, { target: { value: 'wrong-guess-token' } });

      fireEvent.click(screen.getByRole('button', { name: /join room/i }));

      expect(await screen.findByText(/invalid invite code for private room/i)).toBeInTheDocument();
      expect(mockOnSelectRoom).not.toHaveBeenCalled();
    });
  });

  describe('4. Terminal Component Execution States', () => {
    it('renders idle status badge when no execution result is present', () => {
      render(<Terminal result={null} isRunning={false} />);

      expect(screen.getByText(/ready/i)).toBeInTheDocument();
      expect(screen.getByText(/run code/i)).toBeInTheDocument();
    });

    it('renders running state when isRunning is true', () => {
      render(<Terminal result={null} isRunning={true} />);

      expect(screen.getByText(/running\.\.\./i)).toBeInTheDocument();
      expect(screen.getByText(/running in isolated container/i)).toBeInTheDocument();
    });

    it('renders successful execution output with stdout and execution time', () => {
      const mockResult = {
        status: 'completed',
        stdout: 'Hello CodeCollab Sandboxed World!\nComputed result: 42',
        stderr: '',
        exitCode: 0,
        executionTimeMs: 145,
      };

      render(<Terminal result={mockResult} isRunning={false} />);

      expect(screen.getByText(/completed/i)).toBeInTheDocument();
      expect(screen.getByText(/145ms/i)).toBeInTheDocument();
      expect(screen.getByText(/exit code:/i)).toBeInTheDocument();
      expect(screen.getByText('0')).toBeInTheDocument();
      expect(screen.getByText(/Hello CodeCollab Sandboxed World!/)).toBeInTheDocument();
      expect(screen.getByText(/Computed result: 42/)).toBeInTheDocument();
    });

    it('renders failed execution with stderr output', () => {
      const mockResult = {
        status: 'failed',
        stdout: '',
        stderr: 'Traceback (most recent call last):\nZeroDivisionError: division by zero',
        exitCode: 1,
        executionTimeMs: 65,
      };

      render(<Terminal result={mockResult} isRunning={false} />);

      expect(screen.getByText(/failed/i)).toBeInTheDocument();
      expect(screen.getByText(/exit code:/i)).toBeInTheDocument();
      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText(/ZeroDivisionError: division by zero/)).toBeInTheDocument();
    });

    it('renders timeout state with timeout badge', () => {
      const mockResult = {
        status: 'timeout',
        stdout: '',
        stderr: 'Execution timed out after 10000ms',
        exitCode: 124,
        executionTimeMs: 10000,
      };

      render(<Terminal result={mockResult} isRunning={false} />);

      expect(screen.getByText(/timeout/i)).toBeInTheDocument();
      expect(screen.getByText(/Execution timed out after 10000ms/)).toBeInTheDocument();
    });

    it('triggers onClear callback when clear button is clicked', () => {
      const mockClear = jest.fn();
      const mockResult = {
        status: 'completed',
        stdout: 'Sample Output',
        stderr: '',
        exitCode: 0,
        executionTimeMs: 50,
      };

      render(<Terminal result={mockResult} isRunning={false} onClear={mockClear} />);

      const clearBtn = screen.getByRole('button', { name: /clear/i });
      fireEvent.click(clearBtn);

      expect(mockClear).toHaveBeenCalledTimes(1);
    });
  });
});
