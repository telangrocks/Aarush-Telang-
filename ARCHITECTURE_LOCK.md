# Architecture Lock

This document serves as the project's engineering contract. The following rules are non-negotiable constraints on the system architecture.

## Supported Exchange

* Binance only.

## Unsupported Exchanges

* Bybit
* Delta Exchange
* Any future exchange that cannot fully satisfy the required Spot trading workflow.

## Supported Trading Mode

* Spot trading only.

## Unsupported Trading Modes

* Futures
* Margin
* Perpetual
* Options
* Leverage
* Copy trading
* Any derivative product.

## Required Trade Lifecycle

1. Generate Spot BUY signal.
2. Place Binance Spot BUY order.
3. Wait until the BUY order is completely filled.
4. Create a native Binance Spot OCO order containing:
   * Take Profit
   * Stop Loss
5. Binance manages the exit automatically.
6. The bot records status updates only.

## Forbidden Behaviour

Never implement:

* Bot-managed OCO.
* Manual Stop Loss execution.
* Manual Take Profit execution.
* Price polling to close trades.
* Simulated OCO.
* Exchange-specific workarounds.
* Fallback execution paths for unsupported exchanges.

## Future Development Rule

Any future exchange may only be added if it satisfies all of the following:

* Official Spot trading support.
* Official Spot API support.
* Native exchange-managed Take Profit and Stop Loss (OCO or an officially supported equivalent).
* No bot-side simulation required.
* Compatible with the existing Spot-only architecture.

If any requirement is not met, the exchange must not be integrated.
