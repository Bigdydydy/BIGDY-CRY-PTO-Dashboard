#!/usr/bin/env node
/**
 * Optional webhook alert for the hourly data-health monitor.
 *
 *   node scripts/data_health_alert.js <report.json>
 *
 * DATA_HEALTH_WEBHOOK_URL unset -> logs "webhook not configured" and exits 0
 * (alerts are opt-in; nothing is faked). When configured the URL must be
 * https (or http://localhost for tests), must not embed credentials; a
 * single POST with a short text body and the redacted report summary is
 * sent with a 10s deadline, no retries, no redirects. The secret URL never
 * appears in logs, request bodies, or error messages — all failure logs use
 * fixed classifications, never raw error text.
 */

const fs = require('fs');
const { fetchWithTimeout } = require('../server/http_client');
const { MONITOR_CONTRACT } = require('../server/data_health_monitor_policy');

function loopbackUrl(url) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
}

/** Webhook URL: https only, or http to a loopback mock. No credentials. */
function validateWebhookUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (e) { return { error: 'invalid webhook URL' }; }
  const ok = url.protocol === 'https:' || (url.protocol === 'http:' && loopbackUrl(url));
  if (!ok) return { error: 'webhook must be https' };
  if (url.username || url.password) return { error: 'webhook URL must not embed credentials' };
  return { url: url.toString() };
}

/**
 * Fixed, URL-free failure classifications. The webhook URL is a secret and
 * routinely appears inside thrown error messages — those messages must
 * never reach logs or the returned reason.
 */
function classifyFailure(err) {
  if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) return 'request timed out';
  return 'request failed';
}

async function sendAlert({ reportPath, webhookUrl, fetcher = fetchWithTimeout } = {}) {
  if (!webhookUrl) {
    console.log('[data-health-alert] webhook not configured; skipping');
    return { sent: false, reason: 'webhook not configured' };
  }

  const checked = validateWebhookUrl(webhookUrl);
  if (checked.error) {
    console.error(`[data-health-alert] ${checked.error}; not sending`);
    return { sent: false, reason: checked.error };
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (err) {
    console.error('[data-health-alert] report unreadable; not sending');
    return { sent: false, reason: 'report unreadable' };
  }

  const state = report.overallHealth || 'UNKNOWN';
  const alerts = Array.isArray(report.alerts) ? report.alerts : [];
  const lines = alerts.slice(0, 12).map(a => `• ${a.id}: ${a.state}${a.reason ? ' — ' + a.reason : ''}`);
  const text = `Data health ${state}${alerts.length ? `\n${lines.join('\n')}` : ' — all checks healthy'}`;

  try {
    const resp = await fetcher(checked.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        report: {
          checkedAt: report.checkedAt || null,
          overallHealth: state,
          alerts
        }
      }),
      redirect: 'manual',
      timeout: MONITOR_CONTRACT.webhookTimeoutMs,
      retries: MONITOR_CONTRACT.webhookRetries
    });
    if (!resp || !resp.ok) {
      const status = resp && typeof resp.status === 'number' ? `HTTP ${resp.status}` : 'no response';
      console.error(`[data-health-alert] webhook POST failed (${status})`);
      return { sent: false, reason: status };
    }
    console.log(`[data-health-alert] webhook delivered (${state}, ${alerts.length} alert(s))`);
    return { sent: true };
  } catch (err) {
    const reason = classifyFailure(err);
    console.error(`[data-health-alert] webhook POST failed (${reason})`);
    return { sent: false, reason };
  }
}

if (require.main === module) {
  sendAlert({
    reportPath: process.argv[2],
    webhookUrl: process.env.DATA_HEALTH_WEBHOOK_URL || null
  }).then(res => {
    // Unconfigured is a clean no-op; a configured webhook that could not be
    // delivered is a real failure.
    process.exit(res.sent || res.reason === 'webhook not configured' ? 0 : 1);
  });
}

module.exports = { sendAlert, validateWebhookUrl };
