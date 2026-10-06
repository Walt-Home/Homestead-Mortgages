/**
 * The schedules a page states are Terraform's, and this is what keeps the
 * copy honest: the defaults in `infra/variables.tf` are read off the file
 * and compared, so a job moved there without the words moving fails here.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BILLING_CLOSE_SCHEDULE,
  cadenceWire,
  LOAN_REVIEW_SCHEDULE,
  scheduleWords,
} from "../services/schedules.js";

const here = dirname(fileURLToPath(import.meta.url));
const variables = readFileSync(resolve(here, "../../../../infra/variables.tf"), "utf8");

function terraformDefault(name: string): string {
  const block = new RegExp(`variable "${name}" \\{[\\s\\S]*?default\\s*=\\s*"([^"]+)"`).exec(
    variables,
  );
  if (!block) throw new Error(`infra/variables.tf has no default for ${name}`);
  return block[1]!;
}

describe("the schedules a page states", () => {
  it("are the ones Terraform runs the jobs on", () => {
    expect(LOAN_REVIEW_SCHEDULE.cron).toBe(terraformDefault("loan_review_schedule"));
    expect(BILLING_CLOSE_SCHEDULE.cron).toBe(terraformDefault("billing_close_schedule"));
    // Both jobs are declared in America/New_York; the module hard-codes it.
    const stack = readFileSync(resolve(here, "../../../../infra/modules/stack/main.tf"), "utf8");
    const reviewZone =
      /google_cloud_scheduler_job" "loan_review"[\s\S]*?time_zone\s*=\s*"([^"]+)"/.exec(stack);
    expect(reviewZone?.[1]).toBe(LOAN_REVIEW_SCHEDULE.timeZone);
  });

  it("are said in words made from the expression, and a shape with no words is refused", () => {
    expect(scheduleWords(LOAN_REVIEW_SCHEDULE)).toBe("every morning at 7:00 AM Eastern");
    expect(scheduleWords(BILLING_CLOSE_SCHEDULE)).toBe("the 1st of each month at 6:00 AM Eastern");
    expect(scheduleWords({ cron: "30 13 * * *", timeZone: "America/New_York" })).toBe(
      "every day at 1:30 PM Eastern",
    );
    expect(scheduleWords({ cron: "0 0 22 * *", timeZone: "America/New_York" })).toBe(
      "the 22nd of each month at 12:00 AM Eastern",
    );
    expect(() => scheduleWords({ cron: "17 * * * *", timeZone: "America/New_York" })).toThrow(
      /no words/,
    );
    expect(() => scheduleWords({ cron: "0 7 * * 1", timeZone: "America/New_York" })).toThrow(
      /no words/,
    );
    expect(cadenceWire()).toEqual({
      review: {
        cron: "0 7 * * *",
        timeZone: "America/New_York",
        words: "every morning at 7:00 AM Eastern",
      },
      billingClose: {
        cron: "0 6 1 * *",
        timeZone: "America/New_York",
        words: "the 1st of each month at 6:00 AM Eastern",
      },
    });
  });
});
