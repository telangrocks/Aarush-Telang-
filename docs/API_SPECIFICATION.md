# Crypto Pulse API Specification

**Version:** 1.0.0  
**Status:** Development (Phase 1)  
**Base URL:** `https://api.cryptopulse.workers.dev` (production) or `http://localhost:8787` (development)

---

## Overview

This document describes all API endpoints for the Crypto Pulse backend service. Endpoints are organized by feature and phase of development.

## Phase 1: Foundation Endpoints

### Health Check

```
GET /health
```

**Response:** 200 OK

```json
{
  "status": "ok",
  "timestamp": "2024-06-03T10:00:00Z",
  "environment": "development"
}
```

### Root Information

```
GET /
```

**Response:** 200 OK

```json
{
  "name": "Crypto Pulse Backend",
  "version": "1.0.0",
  "status": "running",
  "environment": "development"
}
```

---

## Phase 2: Core Crypto Endpoints

*To be implemented in Phase 3*

### Get Live Prices

```
GET /api/prices?limit=50&offset=0
```

### Get Price Details

```
GET /api/prices/:id
```

### Search Cryptocurrencies

```
GET /api/prices/search?q=bitcoin
```

### Get Price Chart Data

```
GET /api/prices/:id/chart?period=24h|7d|30d|1y
```

---

## Phase 3: Portfolio Endpoints

*To be implemented in Phase 4*

### Add Transaction

```
POST /api/portfolio/transactions
```

### Get Transactions

```
GET /api/portfolio/transactions
```

### Get Portfolio Summary

```
GET /api/portfolio/summary
```

---

## Phase 4: Watchlist & Alerts

*To be implemented in Phase 5*

### Add to Watchlist

```
POST /api/watchlist
```

### Get Watchlist

```
GET /api/watchlist
```

### Set Price Alert

```
POST /api/alerts
```

---

## Error Handling

All errors follow this format:

```json
{
  "error": "Error description",
  "statusCode": 400,
  "message": "Detailed error message"
}
```

## Status Codes

- `200 OK` - Successful request
- `400 Bad Request` - Invalid parameters
- `401 Unauthorized` - Missing/invalid authentication
- `404 Not Found` - Endpoint or resource not found
- `500 Internal Server Error` - Server error

---

## Authentication

Authentication will be implemented in Phase 6 using JWT tokens.

---

## Rate Limiting

Rate limiting will be implemented in Phase 3.

---

## Documentation Updates

This specification is updated as new features are implemented.
