// Keeps the News Bot workflow running every 15 minutes. GitHub starts scheduled runs of small
// repositories only every few hours, so each run on the default branch starts the next one itself.
// The next run first waits in the "news-bot-timer" environment, whose wait timer (set once in the
// repository settings) does the waiting without holding a runner. Scheduled runs stay on as a
// backstop: they restart the chain whenever it breaks.

/** Title of the runs one run starts for the next (the workflow's run-name for chained runs). */
export const CHAIN_TITLE = "News Bot (every 15 min)";

/** A chained run that started sooner than this after it was queued did not wait for the timer. */
export const MIN_WAIT_MS = 10 * 60 * 1000;

/**
 * Decide whether this run should start the next one.
 *
 * Only one chain may be alive: a run steps back when another chained run is already lined up
 * (queued or waiting for the timer). When two chained runs are in progress together, the newer
 * one carries on and the older one steps back, so a doubled chain goes back to one.
 *
 * @param {object} options
 * @param {Array<{databaseId: number, status: string, displayTitle: string, createdAt: string}>} options.runs
 *   recent runs of the workflow on the default branch, as `gh run list --json` returns them
 * @param {number} options.runId this run's id
 * @param {boolean} options.chained whether the previous run started this one
 * @param {boolean} options.onDefaultBranch whether this run is on the default branch
 * @param {number} [options.now]
 * @returns {{start: boolean, reason: string}}
 */
export function decideNextRun({ runs, runId, chained, onDefaultBranch, now = Date.now() }) {
  if (!onDefaultBranch)
    return { start: false, reason: "only runs on the default branch keep going" };

  if (chained) {
    const self = runs.find((run) => run.databaseId === runId);
    const waited = self ? now - Date.parse(self.createdAt) : Infinity;
    if (waited < MIN_WAIT_MS) return { start: false, reason: "timer-missing" };
  }

  const lined = runs.find(
    (run) =>
      run.databaseId !== runId &&
      run.displayTitle === CHAIN_TITLE &&
      run.status !== "completed" &&
      (!chained || run.status !== "in_progress" || run.databaseId > runId)
  );
  if (lined) return { start: false, reason: `run ${lined.databaseId} already keeps it going` };

  return { start: true, reason: "no other run is lined up" };
}
