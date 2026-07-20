const fs = require('fs');

let content = fs.readFileSync('backend/src/trading-bot.ts', 'utf8');

// 1. Remove STRATEGY_CONFIG
content = content.replace(/const STRATEGY_CONFIG = \{[\s\S]*?\};\n\n/m, '');

// 2. Remove legacy interfaces
content = content.replace(/export interface IndicatorSet \{[\s\S]*?\}\n\n/m, '');
content = content.replace(/export interface Metrics \{[\s\S]*?\}\n\n/m, '');
content = content.replace(/export interface StrategyEvaluation \{[\s\S]*?\}\n\n/m, '');
content = content.replace(/export interface TimeframeAnalysis \{[\s\S]*?\}\n\n/m, '');
content = content.replace(/export interface ConfluenceResult \{[\s\S]*?\}\n\n/m, '');

// 3. Remove runAnalysisCycle and everything after it down to monitorOpenPositions
const runAnalysisStart = content.indexOf('  private async runAnalysisCycle() {');
const monitorStart = content.indexOf('  private async monitorOpenPositions() {');
if (runAnalysisStart !== -1 && monitorStart !== -1) {
    content = content.slice(0, runAnalysisStart) + content.slice(monitorStart);
}

// 4. Remove fallback calls to runAnalysisCycle
content = content.replace(/\s*\/\/ Phase 3A: Disable Legacy Execution flag\s*if \(this\.env\.USE_NEW_ENGINE !== 'true'\) \{\s*\/\/ Fallback: Run legacy analysis cycle so UI doesn't break during migration\s*await this\.runAnalysisCycle\(\);\s*\}/g, '');
content = content.replace(/\s*\/\/ The UI is a pure visualization of the most recent real analysis\s*\/\/ cycle\. If for some reason no snapshot exists yet, produce one now\.\s*let snapshot = \(await this\.state\.storage\.get\('analysis'\)\) as AnalysisSnapshot \| undefined;\s*if \(!snapshot\) \{\s*await this\.runAnalysisCycle\(\);\s*snapshot = \(await this\.state\.storage\.get\('analysis'\)\) as AnalysisSnapshot \| undefined;\s*\}\s*return new Response\(JSON\.stringify\(snapshot\), \{ status: 200 \}\);/g, '');

// 5. Update /analysis-status to always return newAnalysis
content = content.replace(/\/\/ Phase 1 \/ 3A: Toggle legacy and new engines\s*if \(this\.env\.USE_NEW_ENGINE === 'true'\) \{/g, '');
content = content.replace(/          if \(newAnalysis\) \{\s*return new Response\(JSON\.stringify\(newAnalysis\), \{ status: 200 \}\);\s*\}\s*return new Response\(JSON\.stringify\(\{ error: 'No new engine analysis available yet\.' \}\), \{ status: 404 \}\);\s*\}/g, '          if (newAnalysis) {\n             return new Response(JSON.stringify(newAnalysis), { status: 200 });\n          }\n          return new Response(JSON.stringify({ error: "No new engine analysis available yet." }), { status: 404 });');

// 6. Delete AnalysisSnapshot interface and imports if any?
// Not strictly required since it's just an interface, but let's leave it for now.

fs.writeFileSync('backend/src/trading-bot.ts', content);
console.log('Legacy code removed successfully.');
