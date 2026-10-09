const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../../../database/models/User');
const { generateToken } = require('../middleware/auth');

/**
 * Validates email format with standard regex.
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Registers a new user.
 */
async function registerUser({ username, email, password }) {
  if (!username || typeof username !== 'string' || !username.trim()) {
    const error = new Error('Username is required');
    error.status = 400;
    throw error;
  }

  const trimmedUsername = username.trim();
  if (trimmedUsername.length < 3 || trimmedUsername.length > 30) {
    const error = new Error('Username must be between 3 and 30 characters');
    error.status = 400;
    throw error;
  }

  if (!email || typeof email !== 'string' || !email.trim()) {
    const error = new Error('Email is required');
    error.status = 400;
    throw error;
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!isValidEmail(normalizedEmail)) {
    const error = new Error('Invalid email format');
    error.status = 400;
    throw error;
  }

  if (!password || typeof password !== 'string') {
    const error = new Error('Password is required');
    error.status = 400;
    throw error;
  }

  if (password.length < 6) {
    const error = new Error('Password must be at least 6 characters long');
    error.status = 400;
    throw error;
  }

  // Check for existing username or email
  const existingUser = await User.findOne({
    $or: [{ username: trimmedUsername }, { email: normalizedEmail }],
  });

  if (existingUser) {
    const error = new Error(
      existingUser.username === trimmedUsername
        ? 'Username is already taken'
        : 'An account with this email already exists'
    );
    error.status = 409;
    throw error;
  }

  // Hash password
  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);

  const newUser = new User({
    username: trimmedUsername,
    email: normalizedEmail,
    passwordHash,
  });

  await newUser.save();

  const userPayload = {
    id: newUser._id.toString(),
    userId: newUser._id.toString(),
    username: newUser.username,
    email: newUser.email,
  };

  const token = generateToken(userPayload);

  return {
    token,
    user: {
      id: newUser._id.toString(),
      username: newUser.username,
      email: newUser.email,
      createdAt: newUser.createdAt,
    },
  };
}

/**
 * Authenticates user credentials and returns JWT token.
 */
async function loginUser({ email, username, emailOrUsername, password }) {
  const identifier = (emailOrUsername || email || username || '').trim();

  if (!identifier) {
    const error = new Error('Email or username is required');
    error.status = 400;
    throw error;
  }

  if (!password || typeof password !== 'string') {
    const error = new Error('Password is required');
    error.status = 400;
    throw error;
  }

  const user = await User.findOne({
    $or: [
      { email: identifier.toLowerCase() },
      { username: identifier },
    ],
  });

  if (!user) {
    const error = new Error('Invalid credentials');
    error.status = 401;
    throw error;
  }

  const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
  if (!isPasswordValid) {
    const error = new Error('Invalid credentials');
    error.status = 401;
    throw error;
  }

  const userPayload = {
    id: user._id.toString(),
    userId: user._id.toString(),
    username: user.username,
    email: user.email,
  };

  const token = generateToken(userPayload);

  return {
    token,
    user: {
      id: user._id.toString(),
      username: user.username,
      email: user.email,
      createdAt: user.createdAt,
    },
  };
}

/**
 * Resolves current authenticated user profile by ID.
 */
async function getCurrentUser(userId) {
  if (!userId) {
    const error = new Error('User ID is required');
    error.status = 400;
    throw error;
  }

  const user = await User.findById(userId).select('-passwordHash');
  if (!user) {
    const error = new Error('User not found');
    error.status = 404;
    throw error;
  }

  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    createdAt: user.createdAt,
  };
}

module.exports = {
  registerUser,
  loginUser,
  getCurrentUser,
  isValidEmail,
};
