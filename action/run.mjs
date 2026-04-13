#!/usr/bin/env node
// GitHub Action runner: invokes the deploy-rehearsal engine, renders a
// markdown report, upserts a single PR comment, sets job exit code.
// Scope is intentionally minimal: no artifacts, no Slack, no annotations.

import { runRehearsal } from "../dist/tools/runRehearsal.js";
import { appendFileSync } from "node:fs";

const COMMENT_MARKER = "<!-- deploy-rehearsal-mcp:pr-comment -->";

const env = (k, def = "") => (process.env[k] ?? def).trim();
const cwd = env("INPUT_WORKING_DIRECTORY", ".") || ".";
const explicitRef = env("BASE_REF");
const defaultBase = env("DEFAULT_BASE_BRANCH");
const baseRef = explicitRef || (defaultBase ? `origin/${defaultBase}` : "");
const mode = env("MODE", "merge-base") || "merge-base";
const failOnBlock = env("FAIL_ON_BLOCK", "true") !== "false";
const shouldComment = env("SHOULD_COMMENT", "true") !== "false";
const token = env("GH_TOKEN");
const repo = env("REPO_FULL");
const prNumber = env("PR_NUMBER");
const ghOutput = env("GITHUB_OUTPUT");

function log(msg) {
  process.stderr.write(msg + "\n");
}

function setOutput(key, value) {
  if (!ghOutput) return;
  // GitHub Actions multi-line-safe output writer.
  const v = String(value ?? "");
  appendFileSync(ghOutput, `${key}=${v}\n`);
}

function summaryHeader(r) {
  const v = r.verdict;
  const badge = v === "GO" ? "✅" : v === "CAUTION" ? "⚠️" : "⛔";
  const cv = r.changeVerdict
    ? `\n**Change verdict:** ${r.changeVerdict}${r.changeVerdictReason ? ` _(${r.changeVerdictReason})_` : ""}`
    : "";
  const ref = r.baselineDisplayRef
    ? `\n**Compared against:** \`${r.baselineDisplayRef}\` _(mode: ${r.baselineMode})_, resolved baseline \`${(r.baselineResolvedRef ?? "").slice(0, 10)}\``
    : r.baselineError
      ? `\n**Baseline unavailable:** \`${r.baselineError.reason}\` — ${r.baselineError.detail ?? ""}`
      : "";
  return `${badge} **${v}** — score ${r.score} _(via ${r.verdictReason})_${cv}${ref}`;
}

async function gh(method, url, body) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "deploy-rehearsal-mcp-action",
    ...(body ? { "Content-Type": "application/json" } : {}),
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 400)}`);
  }
  return res.status === 204 ? null : await res.json();
}

async function upsertPrComment(body) {
  if (!shouldComment) {
    log("comment=false → skipping PR comment");
    return;
  }
  if (!token || !repo || !prNumber) {
    log("Missing GH_TOKEN / REPO / PR_NUMBER → skipping PR comment");
    return;
  }
  const finalBody = `${COMMENT_MARKER}\n\n${body}`;
  const baseUrl = `https://api.github.com/repos/${repo}`;
  let existing = null;
  let page = 1;
  while (page <= 5) {
    const list = await gh("GET", `${baseUrl}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(list) || list.length === 0) break;
    existing = list.find((c) => typeof c.body === "string" && c.body.startsWith(COMMENT_MARKER));
    if (existing) break;
    if (list.length < 100) break;
    page++;
  }
  if (existing) {
    await gh("PATCH", `${baseUrl}/issues/comments/${existing.id}`, { body: finalBody });
    log(`Updated PR comment ${existing.id}`);
  } else {
    await gh("POST", `${baseUrl}/issues/${prNumber}/comments`, { body: finalBody });
    log("Created PR comment");
  }
}

async function main() {
  log(`baseRef=${baseRef || "(none)"} mode=${mode} cwd=${cwd}`);
  const result = await runRehearsal({
    cwd,
    ...(baseRef ? { baselineRef: baseRef, baselineRefMode: mode } : {}),
    report: "markdown",
  });

  const summary = summaryHeader(result);
  log(summary.replace(/\n/g, " | "));

  setOutput("verdict", result.verdict);
  setOutput("change-verdict", result.changeVerdict ?? "");
  setOutput("score", String(result.score));

  const md = `${summary}\n\n${result.reportMarkdown ?? "_(engine returned no markdown body)_"}`;
  try {
    await upsertPrComment(md);
  } catch (e) {
    // Don't fail the job just because the comment failed — verdict still applies.
    log(`PR comment failed: ${e?.message ?? e}`);
  }

  if (failOnBlock && result.verdict === "BLOCK") {
    log("verdict=BLOCK and fail-on-block=true → exit 1");
    process.exit(1);
  }
  log(`verdict=${result.verdict} → exit 0`);
  process.exit(0);
}

main().catch((e) => {
  log(`Action runner failed: ${e?.stack ?? e}`);
  process.exit(2);
});
