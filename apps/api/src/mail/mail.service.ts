import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

export interface ThresholdAlertItem {
  toolName: string;
  vendor: string;
  barPct: number;
  thresholdPct: number;
  capAmount: number | null;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private resend: Resend;
  private from: string;
  private frontendUrl: string;

  constructor(private config: ConfigService) {
    this.resend = new Resend(config.get<string>('RESEND_API_KEY'));
    // Use verified domain sender if configured, else Resend's sandbox address
    this.from = config.get<string>('MAIL_FROM', 'Spend Management <onboarding@resend.dev>');
    this.frontendUrl = config.get<string>('FRONTEND_URL', 'http://localhost:3000');
  }

  /**
   * One recipient can have several tools breach their threshold in the same check
   * cycle - this sends ONE consolidated email listing all of them, rather than one
   * email per tool. Callers are responsible for grouping by recipient first (see
   * SchedulerService.checkThresholdAlerts).
   */
  async sendThresholdAlert(to: string, alerts: ThresholdAlertItem[]) {
    if (alerts.length === 0) return;

    const subject = alerts.length === 1
      ? `⚠️ Budget Alert: ${alerts[0].toolName} has reached ${alerts[0].barPct}% of its cap`
      : `⚠️ Budget Alert: ${alerts.length} tools have reached their alert threshold`;

    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject,
      html: this.thresholdHtml(alerts, to),
    });

    if (error) throw new Error(error.message);
    this.logger.log(`Threshold alert sent → ${to} (${alerts.map((a) => `${a.toolName} ${a.barPct}%`).join(', ')})`);
  }

  async sendRenewalReminder(
    to: string,
    toolName: string,
    vendor: string,
    renewalDate: Date,
    daysAway: number,
    monthlyAmount: number | null,
  ) {
    const urgencyColor = daysAway === 0 ? '#F85149' : '#F5A623';
    const urgencyLabel = daysAway === 0 ? 'today' : `in ${daysAway} day${daysAway === 1 ? '' : 's'}`;
    const dateStr = renewalDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject: `📅 Renewal Reminder: ${toolName} renews ${urgencyLabel}`,
      html: this.renewalHtml(toolName, vendor, dateStr, urgencyLabel, urgencyColor, monthlyAmount, to),
    });

    if (error) throw new Error(error.message);
    this.logger.log(`Renewal reminder sent → ${to} (${toolName} renews ${urgencyLabel})`);
  }

  // ── Email templates ───────────────────────────────────────────────

  private thresholdHtml(alerts: ThresholdAlertItem[], to: string) {
    const intro = alerts.length === 1
      ? `<strong style="color:#F2F3F5">${alerts[0].toolName}</strong> by ${alerts[0].vendor} has breached its alert threshold.`
      : `<strong style="color:#F2F3F5">${alerts.length} tools</strong> have breached their alert threshold.`;

    const cards = alerts.map((a) => {
      const barColor = a.barPct >= 90 ? '#F85149' : '#F5A623';
      return `
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0B0E;border:1px solid #1A1D24;border-radius:12px;margin-bottom:14px">
            <tr><td style="padding:18px 20px">
              <div style="font-size:13px;font-weight:600;color:#F2F3F5;margin-bottom:12px">${a.toolName} <span style="font-weight:400;color:#6b707b">· ${a.vendor}</span></div>
              <table width="100%" cellpadding="0" cellspacing="0"><tr>
                <td>
                  <div style="font-size:11px;color:#6b707b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Current Usage</div>
                  <div style="font-size:26px;font-weight:700;color:${barColor};letter-spacing:-.02em">${a.barPct}%</div>
                </td>
                <td align="right">
                  <div style="font-size:11px;color:#6b707b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Alert Threshold</div>
                  <div style="font-size:26px;font-weight:700;color:#cfd3da;letter-spacing:-.02em">${a.thresholdPct}%</div>
                </td>
              </tr></table>
              <div style="height:8px;border-radius:999px;background:#1B1E26;margin-top:14px;overflow:hidden">
                <div style="height:100%;width:${Math.min(100, a.barPct)}%;border-radius:999px;background:${barColor}"></div>
              </div>
              ${a.capAmount ? `<div style="font-size:11px;color:#6b707b;margin-top:8px">Budget cap: $${a.capAmount.toLocaleString('en-US')}</div>` : ''}
            </td></tr>
          </table>`;
    }).join('');

    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0A0B0E;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0B0E;padding:40px 20px">
    <tr><td align="center">
      <table width="540" cellpadding="0" cellspacing="0" style="background:#0F1116;border:1px solid #1E212A;border-radius:16px;overflow:hidden;max-width:100%">

        <tr><td style="background:#111318;padding:20px 28px;border-bottom:1px solid #1E212A">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td><span style="font-size:14px;font-weight:700;color:#F2F3F5">Spend Management</span>&nbsp;<span style="font-size:11px;color:#5E6AD2">· Life180 Labs</span></td>
            <td align="right"><span style="display:inline-block;padding:4px 10px;border-radius:20px;background:rgba(248,81,73,0.12);border:1px solid rgba(248,81,73,0.3);font-size:11px;font-weight:600;color:#F85149">⚠ Budget Alert${alerts.length > 1 ? ` · ${alerts.length}` : ''}</span></td>
          </tr></table>
        </td></tr>

        <tr><td style="padding:28px">
          <p style="margin:0 0 20px;font-size:15px;color:#9aa0ab">${intro}</p>

          ${cards}

          <p style="margin:20px 0 24px;font-size:13px;color:#767b86;line-height:1.6">
            Review usage and consider topping up or adjusting the budget cap before it is exhausted.
          </p>
          <a href="${this.frontendUrl}/dashboard" style="display:inline-block;padding:11px 22px;border-radius:9px;background:#5E6AD2;color:#fff;font-size:13px;font-weight:600;text-decoration:none">View Dashboard →</a>
        </td></tr>

        <tr><td style="padding:16px 28px;border-top:1px solid #1A1D24;font-size:11px;color:#4a4f59">
          ${to} is the alert contact for ${alerts.length === 1 ? alerts[0].toolName : `${alerts.length} tools`} · Spend Management, Life180 Labs
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
  }

  private renewalHtml(
    toolName: string, vendor: string, dateStr: string,
    urgencyLabel: string, urgencyColor: string,
    monthlyAmount: number | null, to: string,
  ) {
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0A0B0E;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0B0E;padding:40px 20px">
    <tr><td align="center">
      <table width="540" cellpadding="0" cellspacing="0" style="background:#0F1116;border:1px solid #1E212A;border-radius:16px;overflow:hidden;max-width:100%">

        <tr><td style="background:#111318;padding:20px 28px;border-bottom:1px solid #1E212A">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td><span style="font-size:14px;font-weight:700;color:#F2F3F5">Spend Management</span>&nbsp;<span style="font-size:11px;color:#5E6AD2">· Life180 Labs</span></td>
            <td align="right"><span style="display:inline-block;padding:4px 10px;border-radius:20px;background:rgba(245,166,35,0.12);border:1px solid rgba(245,166,35,0.35);font-size:11px;font-weight:600;color:#F5A623">📅 Renewal Reminder</span></td>
          </tr></table>
        </td></tr>

        <tr><td style="padding:28px">
          <p style="margin:0 0 20px;font-size:15px;color:#9aa0ab">
            Your subscription to <strong style="color:#F2F3F5">${toolName}</strong> by ${vendor} is coming up for renewal.
          </p>

          <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0B0E;border:1px solid rgba(245,166,35,0.25);border-radius:12px;margin-bottom:20px">
            <tr><td style="padding:18px 20px">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <div style="font-size:11px;color:#6b707b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Renewal Date</div>
                    <div style="font-size:20px;font-weight:700;color:#F2F3F5">${dateStr}</div>
                  </td>
                  <td align="right">
                    <div style="font-size:11px;color:#6b707b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Renews</div>
                    <div style="font-size:20px;font-weight:700;color:${urgencyColor}">${urgencyLabel}</div>
                  </td>
                </tr>
                ${monthlyAmount ? `<tr><td colspan="2" style="padding-top:14px;border-top:1px solid #1A1D24">
                  <div style="font-size:13px;color:#9aa0ab">Monthly charge: <strong style="color:#F2F3F5">$${monthlyAmount.toLocaleString('en-US')}</strong></div>
                </td></tr>` : ''}
              </table>
            </td></tr>
          </table>

          <p style="margin:0 0 24px;font-size:13px;color:#767b86;line-height:1.6">
            Make sure your payment method is up to date and the subscription is still needed before the renewal date.
          </p>
          <a href="${this.frontendUrl}/dashboard" style="display:inline-block;padding:11px 22px;border-radius:9px;background:#5E6AD2;color:#fff;font-size:13px;font-weight:600;text-decoration:none">View Dashboard →</a>
        </td></tr>

        <tr><td style="padding:16px 28px;border-top:1px solid #1A1D24;font-size:11px;color:#4a4f59">
          ${to} is the renewal contact for ${toolName} · Spend Management, Life180 Labs
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
  }
}
