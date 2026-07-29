/**
 * Production Validation Framework — Core Engine Orchestrator
 */

import { ValidationPhase, PhaseResult, ValidationLevel } from "./models/ValidationPhase";
import { ValidationContext } from "./models/ValidationContext";
import { ReportGenerator } from "./utils/ReportGenerator";

import { Phase0Environment } from "./phases/Phase0Environment";
import { Phase1Infrastructure } from "./phases/Phase1Infrastructure";
import { Phase2Auth } from "./phases/Phase2Auth";
import { Phase3Exchange } from "./phases/Phase3Exchange";
import { Phase4MarketData } from "./phases/Phase4MarketData";
import { Phase5Strategy } from "./phases/Phase5Strategy";
import { Phase6Risk } from "./phases/Phase6Risk";
import { Phase7Orders } from "./phases/Phase7Orders";
import { Phase8Persistence } from "./phases/Phase8Persistence";
import { Phase9Recovery } from "./phases/Phase9Recovery";
import { Phase10Security } from "./phases/Phase10Security";

export class ValidationEngine {
  private phases: ValidationPhase[] = [];

  constructor() {
    this.registerPhases();
  }

  private registerPhases(): void {
    this.phases.push(new Phase0Environment());
    this.phases.push(new Phase1Infrastructure());
    this.phases.push(new Phase2Auth());
    this.phases.push(new Phase3Exchange());
    this.phases.push(new Phase4MarketData());
    this.phases.push(new Phase5Strategy());
    this.phases.push(new Phase6Risk());
    this.phases.push(new Phase7Orders());
    this.phases.push(new Phase8Persistence());
    this.phases.push(new Phase9Recovery());
    this.phases.push(new Phase10Security());
  }

  public async run(level: ValidationLevel, outDir: string = "reports"): Promise<number> {
    const exchangeLabel = process.env.VALIDATION_EXCHANGE
      ? `${process.env.VALIDATION_EXCHANGE} (override)`
      : `${level === "level3_prod_smoke" ? "kucoin" : "binance"} (default)`;

    console.log(`\n🛡️ Crypto Pulse Production Validation Framework (v3.0.0)`);
    console.log(`Level: ${level.toUpperCase()} | Exchange: ${exchangeLabel} | Worker URL: ${process.env.WORKER_URL || "default"}\n`);

    const context = new ValidationContext(level);
    const phaseResults: PhaseResult[] = [];
    let halted = false;

    for (const phase of this.phases) {
      if (halted) {
        phaseResults.push({
          phaseId: phase.phaseId,
          phaseName: phase.phaseName,
          level,
          status: "SKIP",
          assertions: [{ name: "Gate Bypass", passed: false, details: "Skipped due to preceding dependent phase failure" }],
          metrics: { durationMs: 0 },
        });
        continue;
      }

      console.log(`▶ Running Phase ${phase.phaseId}: ${phase.phaseName}...`);
      try {
        const result = await phase.execute(context);
        phaseResults.push(result);

        const icon = result.status === "PASS" ? "✅" : "❌";
        console.log(`${icon} [Phase ${phase.phaseId}] ${phase.phaseName} — ${result.status} (${result.metrics.durationMs.toFixed(0)}ms)`);

        for (const ass of result.assertions) {
          const assIcon = ass.passed ? "  └─ ✅" : "  └─ ❌";
          console.log(`${assIcon} ${ass.name}: ${ass.details}`);
        }

        if (result.status === "FAIL" && phase.isDependentGate) {
          console.error(`\n🚨 DEPENDENT PHASE GATE FAILED AT PHASE ${phase.phaseId}: ${phase.phaseName}`);
          halted = true;
        }
      } catch (err: any) {
        console.error(`❌ Exception in Phase ${phase.phaseId} (${phase.phaseName}):`, err);
        phaseResults.push({
          phaseId: phase.phaseId,
          phaseName: phase.phaseName,
          level,
          status: "FAIL",
          assertions: [{ name: "Unhandled Exception", passed: false, details: err.message || String(err) }],
          metrics: { durationMs: 0 },
        });

        if (phase.isDependentGate) {
          halted = true;
        }
      }
    }

    // Generate Reports
    const { masterReport, decision } = await ReportGenerator.generateReports(context, phaseResults, outDir);

    console.log(`\n================================================================`);
    console.log(`🏆 DEPLOYMENT GATE DECISION: [ ${decision} ]`);
    console.log(`Passed Phases: ${masterReport.summary.passedPhases}/${masterReport.summary.totalPhases}`);
    console.log(`Total Execution Time: ${masterReport.summary.totalDurationMs}ms`);
    console.log(`Reports exported to directory: '${outDir}'`);
    console.log(`================================================================\n`);

    return decision === "BLOCKED" ? 1 : 0;
  }
}
