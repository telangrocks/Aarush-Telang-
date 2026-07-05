#!/usr/bin/env node

/**
 * Post-deployment smoke tests
 * Ensures Cloudflare Worker is responding correctly
 */

// Use global fetch (available in Node.js 18+)
const fetch = globalThis.fetch;

if (!fetch) {
  console.error("ERROR: fetch is not available. Node.js 18+ required.");
  process.exit(1);
}

const WORKER_URL = process.env.WORKER_URL || "http://localhost:8787";
const TIMEOUT = 10000; // 10 seconds

async function runSmokeTests() {
  console.log("🧪 Running post-deployment smoke tests...\n");

  const tests = [
    {
      name: "Health Check",
      endpoint: "/health",
      expectedStatus: 200,
    },
    {
      name: "Database Status",
      endpoint: "/db-status",
      expectedStatus: 200,
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT);

      const response = await fetch(`${WORKER_URL}${test.endpoint}`, {
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === test.expectedStatus) {
        console.log(`✅ ${test.name}: PASSED`);
        passed++;
      } else {
        console.error(
          `❌ ${test.name}: FAILED - Expected ${test.expectedStatus}, got ${response.status}`,
        );
        failed++;
      }
    } catch (error) {
      console.error(`❌ ${test.name}: ERROR - ${error.message}`);
      failed++;
    }
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }

  console.log("✨ All smoke tests passed!");
}

runSmokeTests();
