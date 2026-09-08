import {expect,test} from "bun:test";
import {normalizeTiming,nextOccurrence} from "./schedule";
test("interval and timezone cron next occurrences, including DST",()=>{
  expect(nextOccurrence(normalizeTiming({interval_seconds:60}),1000)).toBe(61000);
  expect(new Date(nextOccurrence(normalizeTiming({cron:"0 9 * * *",timezone:"America/Los_Angeles"}),Date.parse("2026-03-07T18:00:00Z"))).toISOString()).toBe("2026-03-08T16:00:00.000Z");
  expect(new Date(nextOccurrence(normalizeTiming({cron:"0 9 * * *"}),Date.parse("2026-09-07T00:00:00Z"))).toISOString()).toBe("2026-09-07T09:00:00.000Z");
});
test("invalid and ambiguous schedules are rejected",()=>{
  for(const input of [{},{interval_seconds:60,cron:"* * * * *"},{interval_seconds:59},{interval_seconds:1.5},{interval_seconds:60,timezone:"UTC"},{cron:"* * * * * *"},{cron:"H * * * *"},{cron:"bad * * * *"},{cron:"* * * * *",timezone:"Unknown/Zone"}])expect(()=>normalizeTiming(input)).toThrow();
});
