#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { analyzeDiff } from "./tools/analyzeDiff.js";
import { compareEnv } from "./tools/compareEnv.js";
import { checkOAuth } from "./tools/checkOAuth.js";
import { preflightChecklist } from "./tools/preflightChecklist.js";
import { scoreRisk } from "./tools/scoreRisk.js";
import { runRehearsal } from "./tools/runRehearsal.js";

const TOOLS: Tool[] = [
  {
    name: "analyze_diff",
    description:
      "Analyze git diff for risk signals (migrations, auth, payment, env usage, routing, CI config, secrets). Returns grouped signals with severity.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Repository root." },
        baseRef: { type: "string", description: "Base ref. Default HEAD.", default: "HEAD" },
        headRef: {
          type: "string",
          description: "Head ref. Use 'WORKING' for uncommitted changes. Default WORKING.",
          default: "WORKING",
        },
        includePatch: { type: "boolean", default: false },
      },
      required: ["cwd"],
    },
  },
  {
    name: "compare_env",
    description:
      "Compare 2+ .env files and report missing keys, empty values, divergent values, and keys present in only one file. Flags secret-looking keys.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          description: "Paths to env files (e.g., .env, .env.production).",
        },
      },
      required: ["files"],
    },
  },
  {
    name: "check_oauth_redirects",
    description:
      "Scan source for OAuth redirect/callback URLs. Flags localhost in non-test files, plain http, and domains not in expectedDomains.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        expectedDomains: {
          type: "array",
          items: { type: "string" },
          description: "Allowlist of production domains (e.g., ['myapp.com']).",
          default: [],
        },
      },
      required: ["cwd"],
    },
  },
  {
    name: "preflight_checklist",
    description:
      "Run pre-deploy checklist: git state, build/test scripts, lockfile, .env.example, .env gitignored, CI config present.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
      required: ["cwd"],
    },
  },
  {
    name: "run_rehearsal",
    description:
      "Single-entry orchestrator. Runs diff + env + OAuth + preflight, applies deploy-rehearsal.config.json (allowedDomains, requiredEnvKeys, ignorePatterns, suppress, severityWeights, blockedSecretPatterns, thresholds), and returns a structured verdict (GO/CAUTION/BLOCK) with findings[], blockers, warnings, and an optional Markdown report.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Repository root." },
        baseRef: { type: "string", default: "HEAD" },
        headRef: { type: "string", default: "WORKING" },
        envFiles: {
          type: "array",
          items: { type: "string" },
          description: "Optional env files to compare. Falls back to config.envFiles. Skipped if fewer than 2 are available.",
        },
        configPath: {
          type: "string",
          description: "Path to config JSON (default: deploy-rehearsal.config.json in cwd).",
        },
        report: {
          type: "string",
          enum: ["none", "markdown"],
          default: "none",
          description: "Include a Markdown report under reportMarkdown.",
        },
        baselinePath: {
          type: "string",
          description: "Override path for baseline snapshot file. Default: config.baseline.path.",
        },
        saveBaseline: {
          type: "boolean",
          default: false,
          description: "If true, writes the current result to the baseline path after rehearsal.",
        },
        baselineRef: {
          type: "string",
          description: "Compare against this git ref (e.g. 'origin/main', 'HEAD^', '<sha>'). Takes precedence over file-mode baseline. If omitted, config.baseline.defaultGitRef is used when set.",
        },
        baselineRefMode: {
          type: "string",
          enum: ["direct", "merge-base"],
          description: "Interpretation of baselineRef. 'merge-base' (default) compares against merge-base(HEAD, ref). 'direct' compares against the ref itself.",
        },
      },
      required: ["cwd"],
    },
  },
  {
    name: "score_deploy_risk",
    description:
      "Aggregate diff signals + preflight into a single GO / CAUTION / BLOCK verdict with a numeric risk score and reasons.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        baseRef: { type: "string", default: "HEAD" },
        headRef: { type: "string", default: "WORKING" },
      },
      required: ["cwd"],
    },
  },
];

const AnalyzeDiffSchema = z.object({
  cwd: z.string(),
  baseRef: z.string().optional(),
  headRef: z.string().optional(),
  includePatch: z.boolean().optional(),
});

const CompareEnvSchema = z.object({
  files: z.array(z.string()).min(2),
});

const CheckOAuthSchema = z.object({
  cwd: z.string(),
  expectedDomains: z.array(z.string()).optional(),
});

const PreflightSchema = z.object({ cwd: z.string() });

const ScoreRiskSchema = z.object({
  cwd: z.string(),
  baseRef: z.string().optional(),
  headRef: z.string().optional(),
});

const RunRehearsalSchema = z.object({
  cwd: z.string(),
  baseRef: z.string().optional(),
  headRef: z.string().optional(),
  envFiles: z.array(z.string()).optional(),
  configPath: z.string().optional(),
  report: z.enum(["none", "markdown"]).optional(),
  baselinePath: z.string().optional(),
  saveBaseline: z.boolean().optional(),
  baselineRef: z.string().optional(),
  baselineRefMode: z.enum(["direct", "merge-base"]).optional(),
});

function asText(obj: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
  };
}

function asError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}

async function main() {
  const server = new Server(
    { name: "deploy-rehearsal-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      switch (name) {
        case "analyze_diff": {
          const parsed = AnalyzeDiffSchema.parse(args ?? {});
          return asText(await analyzeDiff(parsed));
        }
        case "compare_env": {
          const parsed = CompareEnvSchema.parse(args ?? {});
          const result = await compareEnv(parsed);
          const { detail, ...summary } = result;
          return asText({
            ...summary,
            detail: detail.map((d) => ({
              key: d.key,
              presence: d.presence,
              valueDiverges: d.valueDiverges,
              secretLike: d.secretLike,
            })),
          });
        }
        case "check_oauth_redirects": {
          const parsed = CheckOAuthSchema.parse(args ?? {});
          return asText(await checkOAuth(parsed));
        }
        case "preflight_checklist": {
          const parsed = PreflightSchema.parse(args ?? {});
          return asText(await preflightChecklist(parsed));
        }
        case "score_deploy_risk": {
          const parsed = ScoreRiskSchema.parse(args ?? {});
          return asText(await scoreRisk(parsed));
        }
        case "run_rehearsal": {
          const parsed = RunRehearsalSchema.parse(args ?? {});
          return asText(await runRehearsal(parsed));
        }
        default:
          return asError(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return asError(err);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("deploy-rehearsal-mcp ready on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
