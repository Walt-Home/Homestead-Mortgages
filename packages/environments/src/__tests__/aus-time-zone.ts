/**
 * Run by aus.test.ts in a child process under a given TZ: draws a sample of
 * aus-decision tasks, decides each with the engine, and prints the zone the
 * process ran in and one hash over every task and every expected answer. A
 * grade that depended on the machine's time zone would hash differently.
 */

import { sha256, toJsonLine } from "../record.js";
import { ausSpecTasks, expectedAus, generateAusSuite } from "../aus/index.js";

const tasks = [...ausSpecTasks(), ...generateAusSuite("train", 5, 140)];
const lines = tasks.map((t) => toJsonLine({ task: t, answer: expectedAus(t) }));
console.log(
  JSON.stringify({
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offset: new Date("2026-06-30T23:30:00.000Z").getTimezoneOffset(),
    month: new Date("2026-06-30T23:30:00.000Z").getMonth(),
    tasks: tasks.length,
    sha256: sha256(lines.join("")),
  }),
);
