const fs = require('fs');
let content = fs.readFileSync('src/trading-bot.ts', 'utf-8');

// Find the corrupt section and remove the alarm handler code that got spliced into execute-trade
const startMarker = '               }\n                 // Check if we recently added this alert to avoid spamming the queue';
const endMarker = '        }\n      } catch (err) {\n        console.error(\'Orchestrator cycle failed:\', err);\n      }';

const startIdx = content.indexOf(startMarker);
const endIdx = content.indexOf(endMarker);

if (startIdx === -1 || endIdx === -1) {
  console.log('Markers not found. startIdx:', startIdx, 'endIdx:', endIdx);
  process.exit(1);
}

const replacement = `               }
             } catch (e) {
               orderResult = { success: false, message: (e as any).message || 'Trade execution failed' };
             }

             target.status = orderResult.success ? 'executed' : 'failed';
             await this.state.storage.put('alerts', this.pruneAlerts(alerts));

             if (orderResult.success) {
               const refPrice = target.targetEntryPrice || target.signalPrice || target.entryPrice;
               let averageFillPrice = orderResult.price;
               if (!averageFillPrice || averageFillPrice <= 0) {
                 const fallbackTicker = await adapter.fetchTicker(orderSymbol).catch(() => null);
                 averageFillPrice = fallbackTicker?.last?.toNumber() || refPrice;
               }
               await this.logAuditEvent(userId, 'TRADE_FILLED', { symbol: orderSymbol, side, orderId: orderResult.orderId, price: averageFillPrice, quantity: orderResult.quantity, strategy: target.strategy });
               await this.state.storage.put('tradeActive', true);
               await this.state.storage.put('tradeEntryTimestamp', new Date().toISOString());
               await this.state.storage.put('lastSuccessfulTradeAt', Date.now());
             } else {
               await this.logAuditEvent(userId, 'TRADE_FAILED', { symbol: orderSymbol, side, message: orderResult.message, clientOrderId });
             }

             return new Response(JSON.stringify({ success: orderResult.success, message: orderResult.message, side, order: orderResult }), { status: 200 });
           } finally {
             this.isExecutingTrade = false;
             await this.state.storage.put('isExecutingTrade', false);
           }
         });
       }`;

content = content.slice(0, startIdx) + replacement + content.slice(endIdx + endMarker.length);
fs.writeFileSync('src/trading-bot.ts', content);
console.log('Patch applied. File length now:', content.length);
