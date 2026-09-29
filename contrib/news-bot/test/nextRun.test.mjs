import assert from "node:assert/strict";
import { test } from "node:test";

import { CHAIN_TITLE, decideNextRun } from "../lib/nextRun.mjs";

const NOW = Date.parse("2026-09-29T16:00:00Z");
const minutesAgo = (m) => new Date(NOW - m * 60 * 1000).toISOString();
const run = (databaseId, status, { chained = true, created = 15 } = {}) => ({
  databaseId,
  status,
  displayTitle: chained ? CHAIN_TITLE : "News Bot",
  createdAt: minutesAgo(created),
});

test("next run: a scheduled run starts the chain when none is alive", () => {
  const runs = [run(10, "in_progress", { chained: false, created: 1 }), run(9, "completed")];
  const decision = decideNextRun({
    runs,
    runId: 10,
    chained: false,
    onDefaultBranch: true,
    now: NOW,
  });
  assert.equal(decision.start, true);
});

test("next run: a scheduled run leaves a live chain alone", () => {
  for (const status of ["waiting", "queued", "pending", "requested", "in_progress"]) {
    const runs = [run(11, status), run(10, "in_progress", { chained: false, created: 1 })];
    const decision = decideNextRun({
      runs,
      runId: 10,
      chained: false,
      onDefaultBranch: true,
      now: NOW,
    });
    assert.equal(decision.start, false, status);
    assert.match(decision.reason, /run 11/);
  }
});

test("next run: a chained run that waited starts the next one", () => {
  const runs = [run(20, "in_progress", { created: 15 }), run(19, "completed", { created: 30 })];
  const decision = decideNextRun({
    runs,
    runId: 20,
    chained: true,
    onDefaultBranch: true,
    now: NOW,
  });
  assert.equal(decision.start, true);
});

test("next run: a chained run that didn't wait stops the chain (no wait timer set)", () => {
  const runs = [run(20, "in_progress", { created: 1 })];
  const decision = decideNextRun({
    runs,
    runId: 20,
    chained: true,
    onDefaultBranch: true,
    now: NOW,
  });
  assert.deepEqual(decision, { start: false, reason: "timer-missing" });
});

test("next run: of two chained runs in progress, only the newer one carries on", () => {
  const runs = [run(31, "in_progress"), run(30, "in_progress")];
  const older = decideNextRun({ runs, runId: 30, chained: true, onDefaultBranch: true, now: NOW });
  const newer = decideNextRun({ runs, runId: 31, chained: true, onDefaultBranch: true, now: NOW });
  assert.equal(older.start, false);
  assert.equal(newer.start, true);
});

test("next run: a chained run steps back when the next one is already lined up", () => {
  const runs = [run(41, "waiting", { created: 2 }), run(40, "in_progress")];
  const decision = decideNextRun({
    runs,
    runId: 40,
    chained: true,
    onDefaultBranch: true,
    now: NOW,
  });
  assert.equal(decision.start, false);
});

test("next run: finished and manual runs don't count as a live chain", () => {
  const runs = [
    run(50, "in_progress"),
    run(49, "completed"),
    run(48, "in_progress", { chained: false, created: 3 }),
  ];
  const decision = decideNextRun({
    runs,
    runId: 50,
    chained: true,
    onDefaultBranch: true,
    now: NOW,
  });
  assert.equal(decision.start, true);
});

test("next run: runs on other branches never start one", () => {
  const decision = decideNextRun({
    runs: [],
    runId: 1,
    chained: false,
    onDefaultBranch: false,
    now: NOW,
  });
  assert.equal(decision.start, false);
});

test("next run: a chained run missing from the list is treated as having waited", () => {
  const decision = decideNextRun({
    runs: [],
    runId: 60,
    chained: true,
    onDefaultBranch: true,
    now: NOW,
  });
  assert.equal(decision.start, true);
});
