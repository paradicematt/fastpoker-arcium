# Crank Service Architecture Plan

## Current State (v1 — In-Memory)

The crank service (`crank-service.ts`) runs as a single Node.js process with all state in memory:
- **Table tracking**: `Map<string, { phase, handNumber }>` — lost on restart
- **Processing locks**: `Set<string>` — prevents concurrent cranking of same table
- **Backoff/blocklist**: In-memory maps with TTL — lost on restart
- **Turn timers**: In-memory timeout tracking — lost on restart
- **Metrics**: Persisted to `crank-metrics.json` (only persistent state)

### Known Issues
1. **No persistence** — restart loses all table tracking, requires full L1 rescan
2. **No failed TX tracking** — can't distinguish "tried and failed" from "never tried"
3. **Sequential delegation** — seat delegation is sequential per table
4. **No admin control** — can't start/stop/restart from admin UI
5. **Metrics are flat file** — no querying, no time-series, no per-table history

---

## Proposed Architecture (v2 — Persistent State)

### Option A: SQLite (Recommended for Devnet)
- Zero infrastructure — single file, embedded in Node.js via `better-sqlite3`
- Fast reads/writes for crank state
- Schema:

```sql
CREATE TABLE tables (
  pubkey TEXT PRIMARY KEY,
  phase INTEGER,
  hand_number INTEGER,
  game_type INTEGER,
  max_players INTEGER,
  is_delegated BOOLEAN,
  last_cranked_at INTEGER,
  last_read_at INTEGER,
  fail_count INTEGER DEFAULT 0,
  last_error TEXT,
  blocked_until INTEGER DEFAULT 0,
  created_at INTEGER
);

CREATE TABLE crank_txs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_pubkey TEXT,
  label TEXT,
  chain TEXT,  -- 'ER' or 'L1'
  signature TEXT,
  success BOOLEAN,
  cost_lamports INTEGER DEFAULT 0,
  error TEXT,
  simulated BOOLEAN DEFAULT 0,
  sim_failed BOOLEAN DEFAULT 0,
  created_at INTEGER
);

CREATE TABLE crank_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

### Option B: MongoDB (For Production)
- Better for multi-instance crank (horizontal scaling)
- Time-series collections for TX history
- Change streams for real-time admin updates
- Requires infrastructure (MongoDB Atlas or self-hosted)

### Option C: Redis + PostgreSQL (Production at Scale)
- Redis for hot state (processing locks, backoff timers)
- PostgreSQL for persistent state and analytics
- Most complex but most scalable

### Recommendation
**Start with SQLite (Option A)** for devnet. Migrate to MongoDB when going to production.

---

## Optimization Plan

### Phase 1: Failed TX Prevention (DONE)
- [x] Simulate L1 TXs before sending (avoid wasting SOL)
- [x] Simulation errors surface in sendWithRetry logs

### Phase 2: Persistent Metrics (Next)
- [ ] Replace `crank-metrics.json` with SQLite `crank_txs` table
- [ ] Track per-TX: table, label, success/fail, cost, error, timestamp
- [ ] Track simulation saves: how many SOL saved by not sending failing TXs
- [ ] Admin API reads from SQLite for all-time stats + time-series

### Phase 3: Table State Persistence
- [ ] Store table states in SQLite `tables` table
- [ ] On restart, load from SQLite instead of full L1 rescan
- [ ] Track fail counts and backoff per table persistently
- [ ] Auto-blocklist tables that fail repeatedly (with reason)

### Phase 4: Admin Control API
- [ ] `POST /api/admin/crank/restart` — signal crank to restart
- [ ] `POST /api/admin/crank/pause` — pause cranking (finish current)
- [ ] `POST /api/admin/crank/resume` — resume cranking
- [ ] `GET /api/admin/crank/status` — live crank health + processing queue
- [ ] Communication via IPC file or HTTP endpoint on crank process

### Phase 5: Multi-Instance (Production)
- [ ] Migrate to MongoDB for shared state
- [ ] Distributed locking (Redis or MongoDB advisory locks)
- [ ] Multiple crank instances for different table groups
- [ ] Health monitoring and auto-restart

---

## Cost Optimization Summary

| Optimization | Status | Impact |
|---|---|---|
| L1 simulation before send | ✅ Done | Saves ~5000 lamports per failed TX |
| TEE TXs skip simulation | ✅ Done | TEE is free, no simulation needed |
| Backoff for transient failures | ✅ Existing | Reduces retry spam |
| Blocklist for permanent failures | ✅ Existing | Stops wasting on known-broken tables |
| Parallel cranking | ✅ Done | Faster throughput, same cost |
| Split undelegation (6+ seats) | ✅ Done | Fixes 9-max ComputeBudgetExceeded |
| Persistent fail tracking | 🔜 Phase 3 | Survives restarts |
| Per-TX cost analytics | 🔜 Phase 2 | Visibility into spend |
