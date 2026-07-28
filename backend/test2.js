
import { classifyExchangeResponse } from "./src/exchanges/errors.js";
const r1 = classifyExchangeResponse(400, `{"code":-1022,"msg":"Signature for this request is not valid."}`, "Binance");
console.log("-1022 ->", r1.code);
const r2 = classifyExchangeResponse(401, `{"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}`, "Binance");
console.log("-2015 ->", r2.code);

