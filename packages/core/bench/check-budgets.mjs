// Fails (exit 1) when any benchmark's median exceeds its budget in budgets.json, when a
// benchmark has no budget, or when a budget has no benchmark. Usage: check-budgets.mjs <vitest bench JSON>
import { readFileSync } from "node:fs";

const resultsFile = process.argv[2];
if (!resultsFile) throw new Error("usage: check-budgets.mjs <bench-results.json>");

const budgets = JSON.parse(readFileSync(new URL("./budgets.json", import.meta.url), "utf8"));
const results = JSON.parse(readFileSync(resultsFile, "utf8"));

const measured = new Map();
for (const file of results.files) {
  for (const group of file.groups) {
    for (const b of group.benchmarks) measured.set(`${group.fullName} > ${b.name}`, b.median);
  }
}

const failures = [];
for (const [name, median] of measured) {
  const budget = budgets[name];
  if (!budget) {
    failures.push(`no budget for "${name}" (add it to bench/budgets.json)`);
    continue;
  }
  const verdict = median <= budget.maxMedianMs ? "ok" : "OVER BUDGET";
  console.log(`${verdict.padEnd(11)} ${name}: median ${median.toFixed(3)} ms, budget ${budget.maxMedianMs} ms`);
  if (verdict !== "ok") failures.push(`"${name}" median ${median.toFixed(3)} ms > ${budget.maxMedianMs} ms`);
}
for (const name of Object.keys(budgets)) {
  if (!measured.has(name)) failures.push(`budget "${name}" has no matching benchmark`);
}

if (failures.length > 0) {
  console.error(`\nPerformance budget check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nAll ${measured.size} benchmarks within budget.`);
