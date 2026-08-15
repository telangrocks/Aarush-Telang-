import { BybitAdapter } from './src/infrastructure/exchange/adapters/BybitAdapter';
// Using native fetch

async function main() {
  const linearUrl = 'https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1';
  const spotUrl = 'https://api.bybit.com/v5/market/instruments-info?category=spot&limit=1';
  
  const linearRes = await fetch(linearUrl).then(res => res.json());
  console.log("LINEAR lotSizeFilter:", linearRes.result.list[0].lotSizeFilter);
  console.log("LINEAR priceFilter:", linearRes.result.list[0].priceFilter);
  
  const spotRes = await fetch(spotUrl).then(res => res.json());
  console.log("SPOT lotSizeFilter:", spotRes.result.list[0].lotSizeFilter);
  console.log("SPOT priceFilter:", spotRes.result.list[0].priceFilter);
}

main();
