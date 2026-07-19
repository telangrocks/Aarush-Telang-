import { CircuitBreaker } from "../exchanges/CircuitBreaker";

async function runTest() {
  console.log("Starting Circuit Breaker Test...");
  const breaker = new CircuitBreaker(3, 2000); // Fail after 3, reset after 2 seconds

  console.log(`\n1. Initial State: ${breaker.check().allowed ? 'ALLOWED (CLOSED/HALF_OPEN)' : 'DENIED (OPEN)'}`);

  console.log("\n2. Recording 2 failures (Should remain ALLOWED)");
  breaker.recordFailure();
  breaker.recordFailure();
  console.log(`State: ${breaker.check().allowed ? 'ALLOWED' : 'DENIED'}`);

  console.log("\n3. Recording 3rd failure (Should trip to DENIED)");
  breaker.recordFailure();
  console.log(`State: ${breaker.check().allowed ? 'ALLOWED' : 'DENIED'}`);

  console.log("\n4. Recording success while open (Should remain DENIED because check() prevents it in real usage)");
  breaker.recordSuccess();
  console.log(`State: ${breaker.check().allowed ? 'ALLOWED' : 'DENIED'}`);

  console.log("\n5. Waiting 2.1 seconds for reset timeout...");
  await new Promise(resolve => setTimeout(resolve, 2100));

  console.log("\n6. Checking state after timeout (Should be ALLOWED -> HALF_OPEN)");
  console.log(`State: ${breaker.check().allowed ? 'ALLOWED' : 'DENIED'}`);

  console.log("\n7. Recording success in HALF_OPEN (Should transition to CLOSED)");
  breaker.recordSuccess();
  console.log(`State: ${breaker.check().allowed ? 'ALLOWED' : 'DENIED'}`);

  console.log("\n8. Recording 1 failure (Should NOT trip back to open since we reset)");
  breaker.recordFailure();
  console.log(`State: ${breaker.check().allowed ? 'ALLOWED' : 'DENIED'}`);
  
  console.log("\nTest Completed!");
}

runTest().catch(console.error);
