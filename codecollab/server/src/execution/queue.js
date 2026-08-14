// simple job queue placeholder
class Queue {
  constructor() { this.jobs = []; }
  add(job) { this.jobs.push(job); }
  async next() { return this.jobs.shift(); }
}
module.exports = new Queue();
