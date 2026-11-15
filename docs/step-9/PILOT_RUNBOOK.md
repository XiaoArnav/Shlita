# Shlita — Step 9: Pilot Runbook

**Purpose:** Operational guide for launching, configuring, and managing a controlled Shlita pilot with external developer partners.

---

## Pre-Pilot Checklist

- [ ] All automated tests pass (24 test suites, 145+ tests across core, gateway, SDK, browser, and rehearsal tests)
- [ ] Container image tagged and pushed to GHCR (`ghcr.io/xiaoarnav/shlita-gateway:staging`)
- [ ] VM provisioned with persistent storage
- [ ] TLS certificate active (Caddy auto-renewal)
- [ ] Environment variables configured (see section 2.1)
- [ ] Backup schedule and volume verified
- [ ] Log forwarding active without credential leakage
- [ ] Alert webhooks verified
- [ ] Pilot partner list finalized (max 3 organizations)
- [ ] Emergency contacts documented

---

## 1. Infrastructure Provisioning

```bash
# 1.1 Provision VM (example: Fly.io or Hetzner)
# Minimum: 2 vCPU, 4GB RAM, 50GB NVMe SSD
# OS: Ubuntu 24.04 LTS with Docker CE installed

# 1.2 Pull the verified container image
docker pull ghcr.io/xiaoarnav/shlita-gateway:staging

# 1.3 Create persistent data directories
sudo mkdir -p /var/lib/shlita/data
sudo mkdir -p /var/lib/shlita/backups
sudo chown -R 1000:1000 /var/lib/shlita
```

---

## 2. Gateway Deployment

```bash
# 2.1 Create environment configuration
cat > /opt/shlita/.env <<'EOF'
NODE_ENV=production
SHLITA_ENV=production
PORT=4000
SHLITA_DB_PATH=/var/lib/shlita/data/ledger.db
SHLITA_STATE_DIR=/var/lib/shlita/data
SHLITA_BACKUP_DIR=/var/lib/shlita/backups
SHLITA_OPERATOR_KEY=<generated-operator-key-at-least-32-chars>
SHLITA_OPERATOR_ORG=org_pilot_alpha
SHLITA_ALLOW_SIMULATION=false
# Provider credentials:
# HELIUS_API_KEY=<key>
# TAVILY_API_KEY=<key>
EOF

# 2.2 Start with Docker Compose
cd /opt/shlita
docker compose up -d

# 2.3 Verify health
curl -s http://localhost:4000/ready
# Expected: HTTP 200, {"status":"ok"}
```

---

## 3. TLS Termination (Caddy)

```bash
# 3.1 Install Caddy
sudo apt install caddy

# 3.2 Configure reverse proxy
cat > /etc/caddy/Caddyfile <<'EOF'
gateway.pilot.shlita.xyz {
    reverse_proxy localhost:4000
    log {
        output file /var/log/caddy/shlita.log
    }
}
EOF

# 3.3 Start Caddy (auto-provisions TLS via Let's Encrypt)
sudo systemctl restart caddy

# 3.4 Verify HTTPS
curl -s -I https://gateway.pilot.shlita.xyz/ready
# Expected: HTTP/2 200 with valid TLS
```

---

## 4. Partner Onboarding

```bash
# 4.1 Enroll pilot partner agent via operator API
curl -X POST https://gateway.pilot.shlita.xyz/v1/agents \
  -H "x-shlita-operator-key: $OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "partner-alpha-agent-1",
    "periodBudgetMicroUsdc": "100000",
    "maxPerCallMicroUsdc": "25000",
    "allowedVendors": ["api.helius.xyz", "api.openai.com"]
  }'
# Response returns {"agentId":"partner-alpha-agent-1","apiKey":"shlt_live_...","credentialStatus":"issued"}

# 4.2 Distribute to partner:
# - Agent API key (secure channel only; never sent in plaintext emails)
# - Scoped gateway URL: https://gateway.pilot.shlita.xyz
# - Packaged SDK archive or installation instructions: docs/sdk/quickstart.md
```

---

## 5. Monitoring & Alerting

```bash
# 5.1 Health check (every 60 seconds)
# Configure uptime monitor to poll:
# GET https://gateway.pilot.shlita.xyz/ready

# 5.2 Prometheus metrics
# Scrape endpoint: GET https://gateway.pilot.shlita.xyz/metrics
# Key metrics:
#   shlita_operations_total — total operation count
#   shlita_operations_approved — approved reservations
#   shlita_operations_rejected — policy rejections
#   shlita_circuit_breaker_trips — circuit breaker activations

# 5.3 Log monitoring
# Tail structured JSON logs from Docker:
docker logs -f shlita-gateway --since 1h | jq .
```

---

## 6. Daily Operations

### 6.1 Backup (Run Daily)
```bash
# Online hot backup using SQLite WAL backup API (does not stop server)
docker exec shlita-gateway node dist/backup-cli.js
# Output: {"event":"backup","integrity":"ok"}

# Copy backup to off-site storage
cp /var/lib/shlita/backups/latest.db /backup/shlita-$(date +%Y%m%d).db
```

### 6.2 Spend & Ledger Review
```bash
# Check aggregate spend across all pilot agents
curl -s https://gateway.pilot.shlita.xyz/v1/operations \
  -H "x-shlita-operator-key: $OPERATOR_KEY" | jq '.summary'
```

### 6.3 Freeze Agent (Emergency)
```bash
# Immediately halt all spending for a specific agent:
curl -X POST https://gateway.pilot.shlita.xyz/v1/agents/<agent-id>/freeze \
  -H "x-shlita-operator-key: $OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Emergency freeze"}'
# (Note: x-shlita-csrf is only required for browser cookie session auth, not operator key header auth)
```

---

## 7. Incident Response Quick Reference

| Severity | Trigger | Action |
|---|---|---|
| **SEV-1** | Overspend detected | Freeze all agents → backup database → investigate ledger |
| **SEV-1** | Gateway unreachable | Check VM, Docker status, disk space |
| **SEV-2** | Circuit breaker trips | Review agent behavior → reset circuit if false positive |
| **SEV-2** | Database lock timeout | Verify single-instance deployment (no duplicate writers) |
| **SEV-3** | Partner reports SDK error | Check agent enrollment, API key validity, policy allowlist |

**Full incident response playbook:** `docs/step-8/INCIDENT_RESPONSE.md`

---

## 8. Pilot Exit Criteria

The pilot is considered successful when:

- [ ] At least 2 external developers have connected agents via the SDK
- [ ] At least 100 financial operations have been processed without overspend
- [ ] Zero security incidents (unauthorized access, credential leaks)
- [ ] Uptime ≥ 99% over the pilot period
- [ ] Backup/restore cycle tested at least once
- [ ] All circuit breaker trips were genuine (no false positives)
- [ ] Partner feedback collected and documented

---

## 9. Pilot Shutdown Procedure

```bash
# 9.1 Notify all partners of shutdown window
# 9.2 Final backup
docker exec shlita-gateway node dist/backup-cli.js

# 9.3 Freeze all agents (prevent new operations)
# 9.4 Wait for in-flight operations to complete (30 seconds)
sleep 30

# 9.5 Stop gateway
docker compose down

# 9.6 Archive database and logs
tar czf shlita-pilot-archive-$(date +%Y%m%d).tar.gz /var/lib/shlita/
```

---

## 10. Rollback Procedure

If a critical issue is discovered during the pilot:

1. **Freeze all agents** immediately via operator API or dashboard.
2. **Create emergency backup** of the current database.
3. **Stop the gateway** container (`docker compose stop gateway`).
4. **Restore from known-good backup** using restore CLI:
   ```bash
   node dist/restore-cli.js /var/lib/shlita/backups/latest.db /var/lib/shlita/data/ledger.db
   ```
5. **Restart the gateway** and verify `/ready` returns HTTP 200.
6. **Notify partners** of the incident and resolution.

---

## 11. Staging & Pilot Status

- **Step 16 Local Rehearsal**: Verified. Packaged SDK, external install, all 6 developer/operator scenarios pass with persistent SQLite storage and zero secret leaks.
- **Step 12 Hosted Staging**: Tracked in PR #19 pending approval of an accessible Linux host (`gateway.staging.shlita.xyz`).
- **Step 15 Live Gemini Smoke Test**: Verified deterministically; live smoke test is tracked separately pending external `GEMINI_API_KEY`.
