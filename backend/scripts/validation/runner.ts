#!/usr/bin/env node

/**
 * Production Validation Framework — CLI Entrypoint
 * Usage:
 *   npx tsx scripts/validation/runner.ts [--level=level1_public|level2_testnet|level3_prod_smoke] [--outDir=reports]
 */

import { ValidationEngine } from "./engine";
import { ValidationLevel } from "./models/ValidationPhase";

async function main() {
  const args = process.argv.slice(2);
  let level: ValidationLevel = "level1_public";
  let outDir = "reports";

  for (const arg of args) {
    if (arg.startsWith("--level=")) {
      const val = arg.split("=")[1] as ValidationLevel;
      if (val === "level1_public" || val === "level2_testnet" || val === "level3_prod_smoke") {
        level = val;
      }
    } else if (arg.startsWith("--outDir=")) {
      outDir = arg.split("=")[1];
    }
  }

  const engine = new ValidationEngine();
  const exitCode = await engine.run(level, outDir);
  process.exit(exitCode);
}

main().catch(err => {
  console.error("Unhandled error in Production Validation Runner:", err);
  process.exit(1);
});
