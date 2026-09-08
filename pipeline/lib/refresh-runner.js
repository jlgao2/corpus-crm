// Step runner for the nightly refresh — failure-isolated, order-preserving.
// A step: { name, run: async fn, critical?: boolean }. Non-critical failures
// report and continue; a critical failure (e.g. build-db) skips the rest so
// a broken build is never published.

export async function runSteps(steps, { log }) {
  const report = [];
  let aborted = false;
  for (const step of steps) {
    if (aborted) {
      report.push({ name: step.name, skipped: true });
      continue;
    }
    const started = Date.now();
    try {
      log(`[refresh] ${step.name}…`);
      await step.run();
      report.push({ name: step.name, ok: true, ms: Date.now() - started });
    } catch (e) {
      report.push({ name: step.name, ok: false, ms: Date.now() - started, error: e.message });
      log(`[refresh] ${step.name} FAILED: ${e.message}`);
      if (step.critical) aborted = true;
    }
  }
  return report;
}

/** Per-source staleness: days behind vs a threshold in days. */
export function computeFreshness(sourceRows, thresholdDays, now) {
  const day = 86_400_000;
  return sourceRows.map(({ source, newest_ts }) => {
    const daysBehind = Math.round((now - Number(newest_ts)) / day);
    const threshold = thresholdDays[source] ?? 30;
    return {
      source,
      newest_ts: Number(newest_ts),
      days_behind: daysBehind,
      threshold_days: threshold,
      stale: daysBehind > threshold,
    };
  });
}
