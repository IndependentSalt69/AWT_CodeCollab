#!/usr/bin/env node
/**
 * CodeCollab M1.1 — Linux Execution Resource Enforcement Verification Harness
 *
 * Standalone evaluation entrypoint. Inspects host and Docker capabilities,
 * runs bounded live resource-enforcement probes (Memory OOM, PID limits, CPU CFS quota),
 * explicitly tests gVisor (runsc) integration, and produces structured evidence artifacts.
 *
 * Usage:
 *   node eval/verify-enforcement.js [options]
 *   npm run eval:enforcement
 *
 * Options:
 *   --strict           Fail (exit 1) if environment cannot be qualified or checks fail
 *   --prod-pid         Include secondary PID probe at production limit (64 PIDs)
 *   --report-dir <dir> Custom directory for report artifacts (default: eval/reports)
 *   --json             Emit structured JSON report to stdout
 *   --no-save          Skip writing report artifacts to disk
 *   --allow-rootful    Permit running probes on rootful daemon (not recommended)
 *   --help             Show help message
 */

const fs = require('fs');
const path = require('path');
const { getDockerClient } = require('../execution/engine/executor');
const {
  detectHostEnvironment,
  probeDockerDaemon,
  evaluatePreflight,
} = require('./environment-probe');
const {
  EnforcementTracker,
  probeMemoryEnforcement,
  probePidEnforcement,
  probeCpuEnforcement,
  probeGvisorIntegration,
} = require('./resource-probes');
const {
  VERDICT_PASS,
  VERDICT_FAIL,
  VERDICT_BLOCKED,
  VERDICT_UNSUPPORTED,
  VERDICT_SKIPPED,
  STATUS_QUALIFIED,
  STATUS_NOT_QUALIFIED,
  classifyMemoryEnforcement,
  classifyPidEnforcement,
  classifyCpuEnforcement,
  classifyGvisorIntegration,
  resolveOverallVerdict,
  generateSummaryMarkdown,
  sanitizeDetails,
} = require('./enforcement-classifier');

// Parse CLI flags
function parseArgs(argv) {
  const options = {
    strict: false,
    prodPid: false,
    reportDir: path.resolve(__dirname, 'reports'),
    json: false,
    save: true,
    allowRootful: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--strict') options.strict = true;
    else if (arg === '--prod-pid') options.prodPid = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-save') options.save = false;
    else if (arg === '--allow-rootful') options.allowRootful = true;
    else if (arg === '--report-dir' && argv[i + 1]) {
      options.reportDir = path.resolve(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
CodeCollab M1.1 — Resource Enforcement Evaluation Harness

Usage:
  node eval/verify-enforcement.js [options]
  npm run eval:enforcement

Options:
  --strict           Fail (exit 1) if qualification cannot be demonstrated
  --prod-pid         Include secondary PID probe at production limit (64 PIDs)
  --report-dir <dir> Directory to store JSON and Markdown reports (default: eval/reports)
  --json             Print JSON report to stdout
  --no-save          Do not write report files to disk
  --allow-rootful    Permit live probes on a rootful daemon (not recommended)
  --help             Show this help message
`);
      process.exit(0);
    }
  }

  return options;
}

async function runHarness(cliOptions = {}) {
  const options = { ...cliOptions };
  const tracker = new EnforcementTracker();
  let dockerClient = null;

  try {
    dockerClient = getDockerClient();
  } catch (_) {
    // Docker client creation may fail if DOCKER_HOST is malformed
  }

  // Interruption cleanup safety net
  const cleanupHandler = async () => {
    if (dockerClient && tracker.createdContainerIds.size > 0) {
      try {
        await tracker.cleanup(dockerClient);
      } catch (_) {}
    }
  };

  const sigintHandler = async () => {
    await cleanupHandler();
    process.exit(130);
  };
  const sigtermHandler = async () => {
    await cleanupHandler();
    process.exit(143);
  };

  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigtermHandler);

  try {
    const timestamp = new Date().toISOString();
    const environment = detectHostEnvironment();
    const daemon = await probeDockerDaemon(dockerClient);
    const preflight = evaluatePreflight(environment, daemon, options);

    const results = {
      preflight: {
        canRunLiveProbes: preflight.canRunLiveProbes,
        skipReason: preflight.skipReason,
        warnings: preflight.warnings,
      },
      memory: null,
      pid: null,
      cpu: null,
      gvisor: null,
    };

    if (preflight.canRunLiveProbes && dockerClient) {
      if (!options.json) {
        console.log(`[CodeCollab M1.1] Starting live resource-enforcement probes (Run ID: ${tracker.runId})...`);
      }

      // 1. Memory Probe
      try {
        if (!options.json) process.stdout.write('  → Probing memory enforcement (128 MiB boundary)... ');
        const memRaw = await probeMemoryEnforcement(dockerClient, tracker);
        results.memory = classifyMemoryEnforcement(memRaw);
        if (!options.json) console.log(`[${results.memory.status}]`);
      } catch (err) {
        results.memory = classifyMemoryEnforcement({ error: err.message });
        if (!options.json) console.log(`[FAIL: ${err.message}]`);
      }

      // 2. PID Probe
      try {
        if (!options.json) process.stdout.write('  → Probing PID limit enforcement (10 PIDs)... ');
        const pidRaw = await probePidEnforcement(dockerClient, tracker, { pidsLimit: 10 });
        results.pid = classifyPidEnforcement(pidRaw);
        if (!options.json) console.log(`[${results.pid.status}]`);
      } catch (err) {
        results.pid = classifyPidEnforcement({ error: err.message });
        if (!options.json) console.log(`[FAIL: ${err.message}]`);
      }

      // Optional Production PID Check
      if (options.prodPid) {
        try {
          if (!options.json) process.stdout.write('  → Probing production PID limit (64 PIDs)... ');
          const pid64Raw = await probePidEnforcement(dockerClient, tracker, { pidsLimit: 64 });
          results.pidProduction = classifyPidEnforcement(pid64Raw);
          if (!options.json) console.log(`[${results.pidProduction.status}]`);
        } catch (err) {
          results.pidProduction = classifyPidEnforcement({ error: err.message });
          if (!options.json) console.log(`[FAIL: ${err.message}]`);
        }
      }

      // 3. CPU Quota Probe
      try {
        if (!options.json) process.stdout.write('  → Probing CPU quota enforcement (0.5 CPU CFS quota)... ');
        const cpuRaw = await probeCpuEnforcement(dockerClient, tracker);
        results.cpu = classifyCpuEnforcement(cpuRaw);
        if (!options.json) console.log(`[${results.cpu.status}]`);
      } catch (err) {
        results.cpu = classifyCpuEnforcement({ error: err.message });
        if (!options.json) console.log(`[FAIL: ${err.message}]`);
      }

      // 4. gVisor Integration Probe
      try {
        if (!options.json) process.stdout.write('  → Probing gVisor (runsc) OCI integration... ');
        const gvisorRaw = await probeGvisorIntegration(dockerClient, tracker, daemon);
        results.gvisor = classifyGvisorIntegration(gvisorRaw);
        if (!options.json) console.log(`[${results.gvisor.status}]`);
      } catch (err) {
        results.gvisor = classifyGvisorIntegration({ startupError: err.message });
        if (!options.json) console.log(`[FAIL: ${err.message}]`);
      }
    } else {
      // Probes skipped due to preflight policy
      const reason = preflight.skipReason || 'Skipped by preflight policy.';
      results.memory = { status: VERDICT_SKIPPED, explanation: reason };
      results.pid = { status: VERDICT_SKIPPED, explanation: reason };
      results.cpu = { status: VERDICT_SKIPPED, explanation: reason };
      results.gvisor = { status: VERDICT_SKIPPED, explanation: reason };
    }

    // Ensure any tracked containers are cleaned up
    await tracker.cleanup(dockerClient);

    const combinedEnv = {
      ...environment,
      dockerVersion: daemon.serverVersion,
      cgroupDriver: daemon.cgroupDriver,
      cgroupVersion: daemon.cgroupVersion,
      isRootless: daemon.isRootless,
      cgroupControllersEnforced: daemon.cgroupControllersEnforced,
      hasRunsc: daemon.hasRunsc,
      connected: daemon.connected,
    };

    const verdict = resolveOverallVerdict(combinedEnv, daemon, results);

    const report = {
      runId: tracker.runId,
      timestamp,
      environment: {
        platform: environment.platform,
        arch: environment.arch,
        kernelRelease: environment.kernelRelease,
        distribution: environment.distribution,
        isWsl: environment.isWsl,
        dockerVersion: daemon.serverVersion,
        cgroupDriver: daemon.cgroupDriver,
        cgroupVersion: daemon.cgroupVersion,
        isRootless: daemon.isRootless,
        cgroupControllersEnforced: daemon.cgroupControllersEnforced,
        hasRunsc: daemon.hasRunsc,
        availableControllers: environment.availableControllers,
      },
      preflight: results.preflight,
      results: {
        memory: results.memory,
        pid: results.pid,
        ...(results.pidProduction ? { pidProduction: results.pidProduction } : {}),
        cpu: results.cpu,
        gvisor: results.gvisor,
      },
      verdict,
    };

    const sanitizedReport = sanitizeDetails(report);
    const markdownSummary = generateSummaryMarkdown(sanitizedReport);

    // Write reports to disk if requested
    if (options.save) {
      try {
        fs.mkdirSync(options.reportDir, { recursive: true });
        const safeTime = timestamp.replace(/[:.]/g, '-');
        const jsonPath = path.join(options.reportDir, `enforcement_report_${safeTime}.json`);
        const mdPath = path.join(options.reportDir, `enforcement_summary_${safeTime}.md`);

        fs.writeFileSync(jsonPath, JSON.stringify(sanitizedReport, null, 2), 'utf8');
        fs.writeFileSync(mdPath, markdownSummary, 'utf8');

        sanitizedReport.artifacts = {
          json: jsonPath,
          markdown: mdPath,
        };
      } catch (saveErr) {
        if (!options.json) {
          console.warn(`[WARN] Failed to write report artifacts to disk: ${saveErr.message}`);
        }
      }
    }

    // Print results
    if (options.json) {
      console.log(JSON.stringify(sanitizedReport, null, 2));
    } else {
      console.log('\n' + markdownSummary);
      if (sanitizedReport.artifacts) {
        console.log(`Report artifacts saved to:`);
        console.log(`  JSON: ${sanitizedReport.artifacts.json}`);
        console.log(`  Markdown: ${sanitizedReport.artifacts.markdown}\n`);
      }
    }

    // Determine exit status
    if (options.strict && verdict !== STATUS_QUALIFIED) {
      return { exitCode: 1, report: sanitizedReport };
    }

    const anyFail = Object.values(sanitizedReport.results).some((r) => r && r.status === VERDICT_FAIL);
    if (anyFail) {
      return { exitCode: 1, report: sanitizedReport };
    }

    return { exitCode: 0, report: sanitizedReport };
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
    if (dockerClient) {
      await tracker.cleanup(dockerClient);
    }
  }
}

// CLI entrypoint execution
if (require.main === module) {
  const cliOptions = parseArgs(process.argv);
  runHarness(cliOptions)
    .then(({ exitCode }) => {
      process.exit(exitCode);
    })
    .catch((err) => {
      console.error(`[FATAL] Harness execution error: ${err.message}`);
      process.exit(1);
    });
}

module.exports = {
  runHarness,
  parseArgs,
};
