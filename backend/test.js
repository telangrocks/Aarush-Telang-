
const body1 = `{"code":-1022,"msg":"Signature for this request is not valid."}`;
const parsed1 = JSON.parse(body1);
console.log("Code is", parsed1.code);

const byCode = {
    "-2014": "INVALID_API_KEY",
    "-1022": "INVALID_SIGNATURE"
};

console.log("Lookup is", byCode[parsed1.code]);

