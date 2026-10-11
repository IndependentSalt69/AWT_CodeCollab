/**
 * Opt-in runner for live MongoDB integration tests.
 * Sets RUN_MONGO_INTEGRATION=true and triggers Jest.
 */
process.env.RUN_MONGO_INTEGRATION = 'true';
const { spawnSync } = require('child_process');

const result = spawnSync(
  'npx',
  ['jest', '--runInBand', 'testing/integration/mongo_integration.test.js', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    shell: true,
    env: process.env,
  }
);

process.exit(result.status ?? 0);
