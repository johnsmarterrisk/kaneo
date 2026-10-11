import * as Sentry from "@sentry/node";
import { Cron } from "croner";
import { runTableOutboxDrain } from "../operon-tables/outbox";
import { checkDueDateReminders } from "./due-date-reminders";
import { checkProjectWebhookReminders } from "./project-webhook-reminders";
import { reconcileWorkspaceSeats } from "./seat-reconciliation";
import { checkTrialReminders } from "./trial-reminders";

const jobs: Cron[] = [];

type JobOutcome = { degraded?: boolean };

// Cron jobs swallow their operational failures (per-item try/catch) so they
// can keep processing the rest of the batch. Reporting Sentry status purely
// from the thrown-rejection channel would always show "ok" for any partially
// failed run. Inspect the returned outcome instead so handled failures light
// up the monitor without aborting the rest of the work. Unexpected throws are
// captured as exception events and swallowed so one bad tick can't take down
// the scheduler via an unhandled rejection.
function withCheckIn<T>(name: string, fn: () => Promise<T>) {
  return async (): Promise<void> => {
    const checkInId = Sentry.captureCheckIn({
      monitorSlug: name,
      status: "in_progress",
    });
    try {
      const result = await fn();
      const degraded = Boolean(
        (result as JobOutcome | null | undefined)?.degraded,
      );
      Sentry.captureCheckIn({
        checkInId,
        monitorSlug: name,
        status: degraded ? "error" : "ok",
      });
    } catch (error) {
      Sentry.captureException(error, { tags: { area: "cron", job: name } });
      Sentry.captureCheckIn({
        checkInId,
        monitorSlug: name,
        status: "error",
      });
      console.error(`Cron job ${name} failed`, error);
    }
  };
}

export function initializeScheduler(): void {
  jobs.push(
    new Cron(
      "*/5 * * * *",
      withCheckIn("due-date-reminders", checkDueDateReminders),
    ),
  );
  jobs.push(
    new Cron(
      "*/5 * * * *",
      withCheckIn("project-webhook-reminders", checkProjectWebhookReminders),
    ),
  );
  jobs.push(
    new Cron(
      "17 * * * *",
      withCheckIn("seat-reconciliation", reconcileWorkspaceSeats),
    ),
  );
  jobs.push(
    new Cron("23 * * * *", withCheckIn("trial-reminders", checkTrialReminders)),
  );
  // Operon fork addition (Tables, docs/fork-discipline.md row 18, spec 7.4, OI-2): the Tables
  // outbox drain, every 5 seconds, one instance at a time under the Postgres job lease. Not
  // wrapped in `withCheckIn`: a check-in every 5 s would flood the monitor; the drain raises
  // its own Sentry alert when a record stalls past 15 minutes.
  jobs.push(
    new Cron("*/5 * * * * *", { protect: true }, async () => {
      try {
        await runTableOutboxDrain();
      } catch (error) {
        Sentry.captureException(error, {
          tags: { area: "cron", job: "tables-outbox" },
        });
        console.error("Cron job tables-outbox failed", error);
      }
    }),
  );
  console.log(
    "⏰ Scheduler started (reminders every 5 minutes, seat reconciliation and trial reminders hourly)",
  );
}

export function shutdownScheduler(): void {
  for (const job of jobs) {
    job.stop();
  }
  jobs.length = 0;
}
