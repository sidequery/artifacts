import { CronExpressionParser } from "cron-parser";

export type ScheduleTiming = { interval_seconds?: number; cron?: string; timezone?: string };
/** Five-field cron has minute precision; intervals are elapsed time independent of timezone. */
export function normalizeTiming(input: ScheduleTiming): ScheduleTiming {
  if ((input.interval_seconds !== undefined) === (input.cron !== undefined)) throw new Error("Provide exactly one of interval_seconds or cron");
  if (input.interval_seconds !== undefined) {
    if (!Number.isSafeInteger(input.interval_seconds) || input.interval_seconds < 60 || input.interval_seconds > 31536000) throw new Error("interval_seconds must be between 60 and 31536000");
    if (input.timezone !== undefined) throw new Error("timezone applies only to cron schedules");
    return { interval_seconds: input.interval_seconds };
  }
  if (typeof input.cron !== "string" || input.cron.length > 256 || input.cron.trim().split(/\s+/).length !== 5 || /[H?]/.test(input.cron)) throw new Error("cron must be a deterministic five-field expression");
  const timezone=input.timezone??"UTC";
  new Intl.DateTimeFormat("en",{timeZone:timezone});
  const timing={cron:input.cron.trim(),timezone};
  nextOccurrence(timing);
  return timing;
}
export function nextOccurrence(timing: ScheduleTiming, now=Date.now()): number {
  if (timing.interval_seconds !== undefined) return now+timing.interval_seconds*1000;
  return CronExpressionParser.parse(timing.cron!, {currentDate:now,tz:timing.timezone??"UTC"}).next().getTime();
}
