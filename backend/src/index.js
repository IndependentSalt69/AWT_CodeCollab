require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const connectDB = require('./config/db');

const { initRealtimeServer } = require('../../realtime/server');

const app = express();
const httpServer = http.createServer(app);

connectDB();

// Middleware
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
}));
app.use(express.json());

// Routes
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// Initialize realtime layer
const io = initRealtimeServer(httpServer, {
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
});

// Start server
const PORT = process.env.PORT || 5000;

httpServer.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`Realtime server initialized`);
});

module.exports = { app, httpServer, io };