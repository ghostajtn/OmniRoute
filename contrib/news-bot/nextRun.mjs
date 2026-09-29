#!/usr/bin/env node
// Starts the next News Bot run on GitHub Actions (see lib/nextRun.mjs). Run by the workflow's
// "next-run" job with GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_REF_NAME, WORKFLOW_FILE
// and CHAINED set.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { decideNextRun } from "./lib/nextRun.mjs";

const execFileAsync = promisify(execFile);

async function gh(args) {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

const env = process.env;
const repo = env.GITHUB_REPOSITORY;
const workflow = env.WORKFLOW_FILE || "news-bot.yml";

const defaultBranch = (await gh(["api", `repos/${repo}`, "--jq", ".default_branch"])).trim();
const runs = JSON.parse(
  await gh([
    "run",
    "list",
    "--repo",
    repo,
    "--workflow",
    workflow,
    "--branch",
    defaultBranch,
    "--limit",
    "30",
    "--json",
    "databaseId,status,displayTitle,createdAt",
  ])
);

const decision = decideNextRun({
  runs,
  runId: Number(env.GITHUB_RUN_ID),
  chained: env.CHAINED === "true",
  onDefaultBranch: env.GITHUB_REF_NAME === defaultBranch,
});

if (decision.reason === "timer-missing") {
  console.log(
    "::warning::This run didn't wait before starting, so the next one wasn't started. Open Settings → " +
      "Environments → news-bot-timer, tick Wait timer, enter 14 minutes and save. The scheduled runs will " +
      "then start the 15-minute chain again."
  );
} else if (!decision.start) {
  console.log(`Next run not started: ${decision.reason}.`);
} else {
  await gh([
    "workflow",
    "run",
    workflow,
    "--repo",
    repo,
    "--ref",
    defaultBranch,
    "-f",
    "chained=true",
  ]);
  console.log("Started the next run. It waits about 15 minutes in the news-bot-timer environment.");
}
