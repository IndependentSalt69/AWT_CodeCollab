/**
 * Asynchronous job queue for code execution runs.
 */
class ExecutionQueue {
  constructor() {
    this.jobs = [];
    this.isProcessing = false;
  }

  add(job) {
    this.jobs.push(job);
  }

  async next() {
    return this.jobs.shift();
  }

  get length() {
    return this.jobs.length;
  }
}

module.exports = new ExecutionQueue();
