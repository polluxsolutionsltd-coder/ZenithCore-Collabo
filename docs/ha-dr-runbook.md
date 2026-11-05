# ZenithCore FMIS – High availability and disaster recovery runbook

Status: **target design for SIFMIS, with the parts already in this repository marked.** Figures in *italics* are proposals to be agreed with the Ministry of Finance in the technical proposal.

## 1. Topology

| Layer | Primary data centre | Disaster recovery (DR) site |
|---|---|---|
| Location | MoF primary data centre | **Physical** site in a different governorate, own power and network, ≥ *50 km* away |
| Load balancer | 2 × active/passive, health check `GET /api/health/deep` | 2 × same |
| Application | ≥ 2 API instances (stateless; any instance serves any request) | ≥ 2 instances, started on failover |
| Database | PostgreSQL 16 primary + synchronous standby (same site) | Asynchronous streaming replica |
| Backups | Nightly logical backup + continuous WAL archive | Copy of every backup and WAL segment |
| CBS link | Primary CBS connection | Secondary CBS connection, pre-approved by CBS |

The API keeps no session state (signed tokens) and every payment step is idempotent, so instances can be added, removed or restarted at any time.

## 2. Recovery objectives

| | Local failure (server, disk, instance) | Loss of the primary site |
|---|---|---|
| Recovery point objective (RPO) | 0 (synchronous standby) | ≤ *15 minutes* (asynchronous replica + WAL archive) |
| Recovery time objective (RTO) | ≤ *15 minutes* (automatic) | ≤ *4 hours* (declared, manual) |

## 3. What protects payments during a failure

- A payment order is claimed (`SENDING`) before it is sent and keeps one end-to-end ID for life. After any failure the system asks CBS for the status of that ID before sending again (`modules/payments/cbs.client.ts`). A failover can therefore never cause a double payment.
- Orders that could not be delivered go to the dead-letter queue and appear on the *Integration* screen for an operator to retry.
- The audit trail is hash-chained. `scripts/verify-db.ts` proves after any restore or failover that no entry was lost or altered, and that the ledger balances.

## 4. Backups (in this repository)

| Tool | What it does |
|---|---|
| `scripts/backup.sh` | `pg_dump` custom format, readability check, SHA-256 checksum, optional GPG encryption (`BACKUP_GPG_RECIPIENT`), retention (`BACKUP_KEEP_DAYS`, default 14) |
| `scripts/restore.sh <file> <target-url> [--force]` | Checks the checksum, refuses to overwrite a non-empty database without `--force`, restores, then runs `verify-db.ts` |
| `scripts/verify-db.ts` | Schema version, record counts, ledger balance, audit-chain integrity; exit code 1 if anything is wrong |

Schedule (proposal): logical backup nightly at 01:00 and WAL archiving continuously (`archive_command` to the backup store, copied to the DR site). Keep *14* daily, *8* weekly and *12* monthly backups. Encrypt every copy that leaves the data centre.

The automated test `apps/api/test/d5.test.ts` runs a backup, restores it into an empty database, verifies the audit chain and ledger, and checks that a tampered file and an accidental overwrite are both refused.

## 5. Procedures

### 5.1 Failover within the primary site (automatic)
1. The cluster manager (*Patroni or pg_auto_failover*) promotes the synchronous standby.
2. The load balancer keeps sending traffic to healthy API instances; they reconnect to the new primary through the cluster address.
3. Operations confirm `GET /api/health/deep` shows `"status": "ok"` and run `npm run verify:db` against the new primary.

### 5.2 Declaring a disaster and failing over to the DR site (manual)
1. **Decide.** The duty manager and the MoF IT director declare the disaster (primary site unreachable for more than *30 minutes*, or physically lost). Record the time.
2. **Freeze.** Stop payment sending at the primary if it is still partly reachable (`DEMO_MODE` is never used; set the load balancer to maintenance).
3. **Promote** the DR replica (`pg_ctl promote` or the cluster manager). Note the last replayed WAL position.
4. **Start** the API instances at the DR site with the DR `DATABASE_URL` and the DR `CBS_URL`.
5. **Verify**: `npm run verify:db` (audit chain valid, ledger balanced), `GET /api/health/deep` (database and CBS checks green).
6. **Reconcile in-flight payments**: on the *Integration* screen, retry every dead-lettered order. Each retry queries CBS first, so orders settled just before the disaster are recognised, not resent.
7. **Switch DNS / load balancer** to the DR site. Tell users through the agreed channel.
8. **Record** the incident: times, data-loss window (compare last WAL position with the primary's last known), decisions.

### 5.3 Restoring from backup (no replica available)
1. Create an empty database at the target site.
2. `scripts/restore.sh <latest backup> <target-url>`; it stops if the checksum does not match.
3. Replay archived WAL up to the last available segment (point-in-time recovery) if continuous archiving is in place.
4. Steps 4–8 of 5.2.

### 5.4 Failing back
Rebuild the primary site as a replica of the DR site, let it catch up, then switch over in a planned window using 5.2 steps 2–7 in the other direction.

## 6. Drills

| Drill | Frequency | Pass criteria |
|---|---|---|
| Restore the latest backup into a scratch database | Monthly | `verify-db.ts` exits 0; counts match production |
| Local failover (kill the primary database) | Quarterly | RTO and RPO for local failure met; no double payment |
| Full DR failover and failback | *Twice a year* | RTO ≤ 4 h, RPO ≤ 15 min, all dead letters resolved |

Every drill is written up with timings and any corrective actions.
