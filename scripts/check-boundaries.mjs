// Boundary scanner: src/ must stay backend-independent and engine-decoupled.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Engine purity: src/ must not reach for persistence or app frameworks.
const FORBIDDEN = [
  /@doha\//,          // no monorepo workspace coupling
  /\bfrom\s+["']pg["']/,
  /\bfrom\s+["']fastify["']/,
  /\.\.\/\.\.\//
];

const walk = (dir) => {
  const out = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }

  return out;
};

let violations = 0;

for (const file of walk("src")) {
  const text = readFileSync(file, "utf8");

  for (const pattern of FORBIDDEN) {
    if (pattern.test(text)) {
      console.error(`BOUNDARY VIOLATION: ${file} matches ${pattern}`);
      violations += 1;
    }
  }
}

if (violations > 0) { console.error(`${violations} violation(s)`); process.exit(1); }

console.log("boundaries ok (src only)");
