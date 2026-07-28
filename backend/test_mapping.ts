
import { classifyExchangeResponse } from "./src/exchanges/errors.ts";

const responses = [
  { status: 400, body: `{"code":-1022,"msg":"Signature for this request is not valid."}` },
  { status: 401, body: `{"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}` },
  { status: 401, body: `{"code":-2014,"msg":"API-key format invalid."}` },
  { status: 400, body: `{"code":-1021,"msg":"Timestamp for this request is outside of the recvWindow."}` }
];

for (const r of responses) {
  const err = classifyExchangeResponse(r.status, r.body, "Binance");
  console.log(`${JSON.parse(r.body).code} -> ${err.code}`);
}

