import { fileURLToPath } from 'node:url';

/**
 * Shlita Gateway Readiness Monitor & Webhook Dispatcher
 *
 * Continuously polls a target Shlita gateway's /ready endpoint.
 * When consecutive failed probes reach failureThreshold:
 *   - Transitions from HEALTHY/DEGRADED to OUTAGE
 *   - Dispatches a single structured 'gateway_outage' webhook notification
 *   - Suppresses duplicate outage notifications for the duration of the incident
 * When gateway recovers:
 *   - Transitions back to HEALTHY
 *   - Dispatches a single structured 'gateway_recovered' webhook notification
 *   - Resets incident state for future incidents
 */

export class ReadinessMonitor {
  constructor(options = {}) {
    this.targetUrl = (options.targetUrl || process.env.SHLITA_GATEWAY_URL || process.env.STAGING_GATEWAY_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
    this.webhookUrl = options.webhookUrl || process.env.SHLITA_ALERT_WEBHOOK_URL || null;
    this.intervalMs = Number(options.intervalMs ?? process.env.SHLITA_MONITOR_INTERVAL_MS ?? 5000);
    this.probeTimeoutMs = Number(options.probeTimeoutMs ?? process.env.SHLITA_PROBE_TIMEOUT_MS ?? 2500);
    this.failureThreshold = Number(options.failureThreshold ?? process.env.SHLITA_MONITOR_FAILURE_THRESHOLD ?? 3);
    this.recoveryThreshold = Number(options.recoveryThreshold ?? process.env.SHLITA_MONITOR_RECOVERY_THRESHOLD ?? 1);
    this.maxDeliveryRetries = Number(options.maxDeliveryRetries ?? 2);
    this.deliveryRetryBackoffMs = Number(options.deliveryRetryBackoffMs ?? 150);
    this.fetchImpl = options.fetchImpl || fetch;
    this.logger = options.logger || console.log;
    this.errorLogger = options.errorLogger || console.error;

    // Sanitize target URL to create safe gateway identifier (no credentials, no query params)
    try {
      const parsed = new URL(this.targetUrl);
      this.gatewayId = options.gatewayId || parsed.hostname + (parsed.port && parsed.port !== '80' && parsed.port !== '443' ? `:${parsed.port}` : '');
    } catch {
      this.gatewayId = options.gatewayId || 'unknown-shlita-gateway';
    }

    // State machine tracking
    this.state = 'HEALTHY'; // 'HEALTHY' | 'DEGRADED' | 'OUTAGE'
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.currentIncident = null;
    this.outageAlertDelivered = false;
    this.timer = null;
    this.isRunning = false;

    // Delivery log for inspection & testing
    this.deliveryHistory = [];
  }

  /**
   * Probes the gateway once and returns probe status
   */
  async probe() {
    const readyUrl = `${this.targetUrl}/ready`;
    const start = performance.now();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.probeTimeoutMs);
      const res = await this.fetchImpl(readyUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Shlita-Readiness-Monitor/1.0',
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const durationMs = Number((performance.now() - start).toFixed(2));
      if (!res.ok) {
        return { ok: false, status: res.status, error: `HTTP ${res.status}`, durationMs };
      }

      let data;
      try {
        data = await res.json();
      } catch {
        return { ok: false, status: res.status, error: 'Malformed JSON response', durationMs };
      }

      if (data?.status !== 'ready' && data?.status !== 'ok') {
        return { ok: false, status: res.status, error: `Readiness status not ready (got "${data?.status}")`, durationMs };
      }

      return { ok: true, status: res.status, data, durationMs };
    } catch (err) {
      const durationMs = Number((performance.now() - start).toFixed(2));
      const message = err.name === 'AbortError' ? `Probe timed out after ${this.probeTimeoutMs}ms` : (err.message || String(err));
      return { ok: false, status: 0, error: message, durationMs };
    }
  }

  /**
   * Delivers a webhook notification with bounded retries
   */
  async deliverNotification(payload) {
    if (!this.webhookUrl) {
      this.logger(`[Monitor] Webhook URL not configured. Skipped dispatching event: ${payload.event}`);
      return { success: false, reason: 'NO_WEBHOOK_URL' };
    }

    let lastError = null;
    for (let attempt = 0; attempt <= this.maxDeliveryRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        const res = await this.fetchImpl(this.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Shlita-Readiness-Monitor/1.0',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const record = {
            success: true,
            event: payload.event,
            incidentId: payload.incidentId,
            timestamp: payload.timestamp,
            attempts: attempt + 1,
          };
          this.deliveryHistory.push(record);
          this.logger(`[Monitor] Successfully delivered ${payload.event} notification (attempt ${attempt + 1})`);
          return record;
        }

        lastError = `HTTP ${res.status}: ${res.statusText || 'Webhook error'}`;
      } catch (err) {
        lastError = err.name === 'AbortError' ? 'Webhook delivery timed out' : (err.message || String(err));
      }

      if (attempt < this.maxDeliveryRetries) {
        await new Promise((resolve) => setTimeout(resolve, this.deliveryRetryBackoffMs * (attempt + 1)));
      }
    }

    const failureRecord = {
      success: false,
      event: payload.event,
      incidentId: payload.incidentId,
      timestamp: payload.timestamp,
      error: lastError,
      attempts: this.maxDeliveryRetries + 1,
    };
    this.deliveryHistory.push(failureRecord);
    this.errorLogger(`[Monitor] FAILED delivering ${payload.event} after ${this.maxDeliveryRetries + 1} attempts: ${lastError}`);
    return failureRecord;
  }

  /**
   * Executes a single evaluation step and manages incident state transitions
   */
  async step() {
    const probeResult = await this.probe();

    if (probeResult.ok) {
      this.consecutiveSuccesses += 1;
      this.consecutiveFailures = 0;

      if (this.state === 'OUTAGE' && this.consecutiveSuccesses >= this.recoveryThreshold) {
        // State transition: OUTAGE -> HEALTHY
        const recoveryTimestamp = new Date().toISOString();
        const incidentDurationSeconds = this.currentIncident
          ? Number(((Date.now() - this.currentIncident.startedAt) / 1000).toFixed(1))
          : 0;

        this.logger(`[Monitor] Gateway RECOVERED at ${recoveryTimestamp} after ${incidentDurationSeconds}s downtime.`);

        const recoveryPayload = {
          event: 'gateway_recovered',
          gatewayId: this.gatewayId,
          timestamp: recoveryTimestamp,
          incidentId: this.currentIncident?.incidentId || `inc_${Date.now()}`,
          details: {
            downtimeSeconds: incidentDurationSeconds,
            lastProbeDurationMs: probeResult.durationMs,
          },
        };

        this.state = 'HEALTHY';
        this.currentIncident = null;
        this.outageAlertDelivered = false;

        const delivery = await this.deliverNotification(recoveryPayload);
        return { state: this.state, probeResult, transition: 'RECOVERED', delivery };
      }

      if (this.state === 'DEGRADED') {
        this.state = 'HEALTHY';
      }
      return { state: this.state, probeResult, transition: null };
    } else {
      // Failed probe
      this.consecutiveFailures += 1;
      this.consecutiveSuccesses = 0;

      if (this.state === 'HEALTHY' && this.consecutiveFailures < this.failureThreshold) {
        this.state = 'DEGRADED';
        this.logger(`[Monitor] Gateway degraded: probe failed (${this.consecutiveFailures}/${this.failureThreshold}): ${probeResult.error}`);
        return { state: this.state, probeResult, transition: 'DEGRADED' };
      }

      if (this.consecutiveFailures >= this.failureThreshold) {
        const wasOutage = this.state === 'OUTAGE';
        this.state = 'OUTAGE';

        if (!wasOutage) {
          // New incident transition
          const incidentId = `inc_${Date.now()}`;
          const outageTimestamp = new Date().toISOString();
          this.currentIncident = {
            incidentId,
            startedAt: Date.now(),
            initialError: probeResult.error,
          };

          this.logger(`[Monitor] Gateway OUTAGE detected at ${outageTimestamp} (${this.consecutiveFailures} consecutive failures).`);

          const outagePayload = {
            event: 'gateway_outage',
            gatewayId: this.gatewayId,
            timestamp: outageTimestamp,
            incidentId,
            details: {
              consecutiveFailures: this.consecutiveFailures,
              failureThreshold: this.failureThreshold,
              lastError: probeResult.error,
            },
          };

          const delivery = await this.deliverNotification(outagePayload);
          if (delivery.success) {
            this.outageAlertDelivered = true;
          }
          return { state: this.state, probeResult, transition: 'OUTAGE_TRIGGERED', delivery };
        } else {
          // Sustained outage: suppress repeated notifications if already delivered
          this.logger(`[Monitor] Gateway remains in OUTAGE (${this.consecutiveFailures} failures). Alert suppressed.`);
          return { state: this.state, probeResult, transition: 'OUTAGE_SUSTAINED' };
        }
      }

      return { state: this.state, probeResult, transition: null };
    }
  }

  /**
   * Starts periodic polling loop
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger(`[Monitor] Started monitoring ${this.targetUrl}/ready every ${this.intervalMs}ms (Threshold: ${this.failureThreshold})`);

    const loop = async () => {
      if (!this.isRunning) return;
      try {
        await this.step();
      } catch (err) {
        this.errorLogger(`[Monitor] Step error: ${err.message}`);
      }
      if (this.isRunning) {
        this.timer = setTimeout(loop, this.intervalMs);
      }
    };

    loop();
  }

  /**
   * Stops periodic polling loop
   */
  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger(`[Monitor] Stopped monitoring ${this.targetUrl}`);
  }
}

// CLI Direct Invocation
const isDirectRun = Boolean(process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]);
if (isDirectRun) {
  const args = process.argv.slice(2);
  const getArg = (flag, fallback) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };

  const targetUrl = getArg('--target-url', process.env.SHLITA_GATEWAY_URL || 'http://127.0.0.1:4000');
  const webhookUrl = getArg('--webhook-url', process.env.SHLITA_ALERT_WEBHOOK_URL || null);
  const intervalMs = Number(getArg('--interval-ms', '5000'));
  const failureThreshold = Number(getArg('--failure-threshold', '3'));

  const monitor = new ReadinessMonitor({
    targetUrl,
    webhookUrl,
    intervalMs,
    failureThreshold,
  });

  monitor.start();

  const shutdown = () => {
    monitor.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
