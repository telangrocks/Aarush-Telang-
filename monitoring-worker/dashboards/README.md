# CryptoPulse Grafana Cloud Monitoring & Observability

This directory contains production-ready Grafana configurations for the **CryptoPulse** centralized monitoring stack on Grafana Cloud (`boldpony2912`).

## Dashboard (`cryptopulse-monitoring-overview.json`)

Pre-configured dashboard using standard OpenTelemetry OTLP structured log records in Grafana Loki:

- **Key Metrics Row**: Total events ingested, failure/error count, Android Stage 9 active events, and trade executions.
- **Pipeline Activity Row**: Stacked time series breakdown across Stages 1–9, and distribution across journeys (`JOURNEY_A_DISCOVERY`, `JOURNEY_B_AUTONOMOUS`, `SYSTEM`).
- **Android Stage 9 Row**: Real-time event stream from Android mobile clients (`AndroidStage9Observer`).
- **Trade Execution Row**: Stage 7 trade dispatch, fills, and cancellation log records (`ExecutionEngine`).
- **Errors & Safety Violations**: Filtered stream of warnings, errors, circuit breaker trips, and safety gate rejections.

### How to Import Dashboard into Grafana Cloud
1. Navigate to **[https://boldpony2912.grafana.net/dashboard/import](https://boldpony2912.grafana.net/dashboard/import)**.
2. Click **Upload dashboard JSON file** and select `cryptopulse-monitoring-overview.json` (or paste the JSON content).
3. Select your Loki data source (e.g., `grafanacloud-boldpony2912-logs`).
4. Click **Import**.

---

## Alerting Rules (`cryptopulse-loki-alerts.json`)

Actionable Loki log-based alerts configured for production safety:

1. **`cp-alert-circuit-breaker`** (Critical): Fires immediately if any `CIRCUIT_BREAKER` trigger or `CRITICAL` severity event is detected.
2. **`cp-alert-execution-failures`** (Warning): Fires if more than 2 Stage 7 order execution failures occur within a 5-minute rolling window.
3. **`cp-alert-android-telemetry-error`** (Warning): Fires if more than 3 Android Stage 9 client telemetry errors occur within 10 minutes.

### How to Import Alert Rules
1. Navigate to **Alerting** → **Alert rules** in Grafana Cloud.
2. Click **New alert rule** → **Import** (or create under folder `CryptoPulse Alerts`).
3. Paste the expressions from `cryptopulse-loki-alerts.json`.

---

## Verified LogQL Queries for Grafana Explore

| Investigation Target | LogQL Query |
| :--- | :--- |
| **All Backend Events** | `{service_name="cryptopulse-backend"}` |
| **Android Stage 9 Events** | `{service_name="cryptopulse-backend"} \| json \| stage = 9 or component = "AndroidStage9Observer"` |
| **Trade Execution Logs** | `{service_name="cryptopulse-backend"} \| json \| stage = 7 or event_type =~ "(?i)ORDER.*\|TRADE.*"` |
| **Errors & Failures** | `{service_name="cryptopulse-backend"} \| json \| (detected_level =~ "(?i)error\|critical" or status = "FAIL")` |
| **Circuit Breaker Events** | `{service_name="cryptopulse-backend"} \| json \| event_type = "CIRCUIT_BREAKER"` |
