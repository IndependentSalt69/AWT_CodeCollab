const mongoose = require('mongoose');

const executionRunSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      index: true,
    },
    triggeredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    language: {
      type: String,
      enum: ['python', 'java', 'cpp'],
      required: true,
    },
    code: {
      type: String,
      required: true,
    },
    stdout: {
      type: String,
      default: '',
    },
    stderr: {
      type: String,
      default: '',
    },
    exitCode: {
      type: Number,
      default: 0,
    },
    executionTimeMs: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ['queued', 'running', 'completed', 'failed', 'timeout'],
      default: 'queued',
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.models.ExecutionRun || mongoose.model('ExecutionRun', executionRunSchema);
