/**
 * CLI: `pnpm --filter @doha/browser-crawler crawl -- --file recipe.json`
 * Reads a JSON or JSONL instruction file (or `-` stdin), prints the
 * RunReport JSON to stdout, a human summary to stderr. Exit codes:
 * 0 ok · 2 validation · 3 politeness deny · 4 step failure.
 */

import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import type { RobotsFetchOutcome } from "../src/politeness/robots";
import { loadConfig } from "@doha/browser-crawler";
import { parseInstructionInput, validateInstructionSet } from "@doha/browser-crawler";
import { runInstructions, type BrowserCrawlerCapabilities } from "@doha/browser-crawler";

interface CliArgs {
  file?: string;
  config?: string;
  cassetteDir?: string;
  replay?: boolean;
  "strict-replay"?: boolean;
  label?: string;
}

/** Named owner contract for parsed CLI flag storage. */
interface FlagBag {
  [flag: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const args: FlagBag = {};

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];

    if (!key?.startsWith("--")) continue;

    // SAFETY: shape guaranteed by the owning boundary above.
    // Normalize kebab-case flags to camelCase keys (--cassette-dir → cassetteDir).
    const name = key.slice(2).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()) as keyof CliArgs;
    const value = argv[i + 1];

    if (name === "replay" || name === "strict-replay") {
      args[name] = true;
    } else {
      // SAFETY: values are CLI strings read once at the boundary.
      args[name] = value;
      i += 1;
    }
  }

  // SAFETY: flags were written under known names only.
  return args as CliArgs;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const raw = args.file === "-" || args.file === undefined
    ? readFileSync(0, "utf8")
    : readFileSync(args.file, "utf8");

  let parsed;

  try {
    // SAFETY: raw CLI text flows through the schema validator.
    parsed = validateInstructionSet(parseInstructionInput(raw));
  } catch (error) {
    process.stderr.write(`validation error: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }

  // Default to the package's shipped instance config (allowlist lives there).
  const configPath = args.config ?? new URL("../browser-crawler.config.json", import.meta.url).pathname;

  const config = loadConfig(configPath, parsed.instructionSet.config);

  const capabilities: BrowserCrawlerCapabilities = {
    clock: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)),
    fetchRobotsText: async (origin): Promise<RobotsFetchOutcome | null> => {
      try {
        const response = await fetch(`${origin}/robots.txt`, {
          headers: { "user-agent": config.userAgent },
          signal: AbortSignal.timeout(20000),
        });

        return { status: response.status, text: await response.text() };
      } catch {
        return null;
      }
    },
    browserFactory: async (browserConfig) => chromium.launch({
      headless: browserConfig.headless,
      slowMo: browserConfig.rendering.slowMoMs,
    }),
    logger: (message) => process.stderr.write(`[browser-crawler] ${message}\n`),
  };

  if (args.cassetteDir) {
    const mode = args["strict-replay"] ? "strict-replay" : args.replay ? "replay" : "record";

    capabilities.cassette = { dir: args.cassetteDir, mode };
  }

  const report = await runInstructions(parsed, config, capabilities);

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(
    `\n${report.ok ? "ok" : "FAILED"} · steps ${report.steps.filter((s) => s.status === "ok").length}/${report.steps.length}` +
    ` · rows ${report.extracted.rows.length} · jsonLd ${report.extracted.jsonLd.length}` +
    ` · links ${report.extracted.links.length} · ${report.durationMs}ms` +
    (report.cassettePath ? ` · cassette ${report.cassettePath}` : "") + "\n",
  );

  if (!report.ok) {
    const politenessDeny = report.steps.some((s) => s.error && /ROBOTS|SSRF|ALLOWED|BUDGET|SCHEME/.test(s.error.code));

    process.exit(politenessDeny ? 3 : 4);
  }
}

void main();
