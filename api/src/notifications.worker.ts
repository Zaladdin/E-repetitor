import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CONFIG, Config } from './config';
import { Database } from './database';
import { notifyLesson } from './notifications.events';
import { NOTIFICATION_MAIL, NotificationMailDelivery } from './notifications.mail';
import { notificationJoins, notificationScope, timelyEmailScope } from './notifications.shared';

type Claim = { notification_id: string; claim_token: string; attempts: number };
@Injectable()
export class NotificationsWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private current?: Promise<void>;
  private stopping = false;
  constructor(private readonly db: Database, @Inject(CONFIG) private readonly config: Config,
    @Inject(NOTIFICATION_MAIL) private readonly mail: NotificationMailDelivery) {}
  onModuleInit() {
    if (!this.config.notificationWorkerEnabled) return;
    this.timer = setInterval(() => this.tick(), 30000); this.timer.unref(); this.tick();
  }
  isRunning() { return this.timer !== undefined; }
  private tick() {
    if (this.stopping || this.current) return;
    const task = this.runOnce().catch(() => { console.error(JSON.stringify({ event: 'notification_worker_failed' })); });
    this.current = task; this.db.trackBackground(task);
    void task.finally(() => { if (this.current === task) this.current = undefined; });
  }
  async onModuleDestroy() { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.current; }
  async runOnce() {
    await this.generateReminders();
    for (let i = 0; i < 20 && !this.stopping; i++) if (!await this.deliverOne()) break;
  }
  async generateReminders() {
    await this.db.transaction(async client => {
      const lock = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext('e-repetitor-notification-reminders')) AS acquired");
      if (!lock.rows[0]!.acquired) return;
      const rows = await client.query<{ id: string }>(`SELECT l.id FROM lessons l JOIN enrollments e ON e.id=l.enrollment_id
        JOIN student_profiles s ON s.id=e.student_id JOIN users su ON su.id=s.user_id
        WHERE l.status='scheduled' AND l.starts_at>clock_timestamp() AND l.starts_at<=clock_timestamp()+interval '60 minutes'
          AND e.status='active' AND su.status='active'
          AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.type='lesson_reminder' AND n.event_key=l.id)
        ORDER BY l.starts_at,l.id LIMIT 200`);
      for (const lesson of rows.rows) await notifyLesson(client, lesson.id, 'lesson_reminder');
    });
  }
  private async claim(): Promise<Claim | undefined> {
    return this.db.transaction(async client => {
      // Recover a dead process's final lease without resetting the attempt count.
      await client.query(`UPDATE notification_email_deliveries SET claim_token=NULL,lease_until=NULL,status='failed',last_error='attempt_limit',updated_at=clock_timestamp()
        WHERE status IN ('queued','failed') AND attempts>=5 AND lease_until<=clock_timestamp()`);
      const result = await client.query<Claim>(`WITH candidate AS (
        SELECT notification_id FROM notification_email_deliveries WHERE status IN ('queued','failed') AND attempts<5
          AND next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
        ORDER BY next_attempt_at,notification_id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE notification_email_deliveries d SET claim_token=$1,lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1,updated_at=clock_timestamp()
        FROM candidate c WHERE d.notification_id=c.notification_id RETURNING d.notification_id,d.claim_token,d.attempts`, [randomUUID()]);
      return result.rows[0];
    });
  }
  async deliverOne(): Promise<boolean> {
    const claim = await this.claim(); if (!claim) return false;
    // Reauthorize immediately before SMTP. No transaction crosses network I/O.
    // Revocation after this check cannot recall an in-flight generic email.
    const ready = await this.db.query<{ email: string }>(`SELECT recipient.email ${notificationJoins}
      JOIN notification_preferences pref ON pref.user_id=n.recipient_user_id AND pref.type=n.type AND pref.email
      JOIN notification_email_deliveries d ON d.notification_id=n.id
      WHERE n.id=$1 AND d.claim_token=$2 AND d.lease_until>clock_timestamp() AND d.status IN ('queued','failed')
        AND ${notificationScope} AND ${timelyEmailScope}`, [claim.notification_id, claim.claim_token]);
    if (!ready.rows[0]) {
      await this.db.query(`UPDATE notification_email_deliveries SET status='cancelled',claim_token=NULL,lease_until=NULL,last_error=NULL,updated_at=clock_timestamp()
        WHERE notification_id=$1 AND claim_token=$2`, [claim.notification_id, claim.claim_token]);
      return true;
    }
    try {
      await this.mail.send({ email: ready.rows[0].email, messageId: `<notification-${claim.notification_id}@e-repetitor.local>` });
    } catch {
      await this.db.query(`UPDATE notification_email_deliveries SET status='failed',last_error='smtp_unavailable',claim_token=NULL,lease_until=NULL,
        next_attempt_at=clock_timestamp()+make_interval(secs=>$3),updated_at=clock_timestamp() WHERE notification_id=$1 AND claim_token=$2`,
      [claim.notification_id, claim.claim_token, 60 * 2 ** (claim.attempts - 1)]);
      return true;
    }
    // Stable identity prevents business duplication, but SMTP acceptance followed
    // by a process/DB failure still has at-least-once delivery semantics.
    await this.db.query(`UPDATE notification_email_deliveries SET status='sent',sent_at=clock_timestamp(),claim_token=NULL,lease_until=NULL,last_error=NULL,updated_at=clock_timestamp()
      WHERE notification_id=$1 AND claim_token=$2`, [claim.notification_id, claim.claim_token]);
    return true;
  }
}
