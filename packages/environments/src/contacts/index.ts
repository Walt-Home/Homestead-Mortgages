/**
 * The contact center: the calls, phone-menu sessions, portal logins, texts,
 * e-mails and letters a subservicer's contact center would hold for a book
 * the life generator wrote, with call transcripts, the comment log, and
 * planted, labeled call and note defects for a call-QA environment.
 *
 * `contactCenter(book)` derives the rows and the notes; `transcriptOf` writes
 * a call's transcript on demand; `plantContactDefects` makes the defective
 * twin and its labels; `plantStaffErrors` makes a twin with a staff error (a
 * promise not tracked, a complaint not logged) and labels its root apart from
 * its symptoms; `complaintLog` reads the complaint system's cases off the
 * contact log. Everything is a function of the book's seed. See
 * docs/environments.md, "The contact center".
 */

export * from "./types.js";
export * from "./rates.js";
export * from "./record.js";
export * from "./derive.js";
export * from "./plan.js";
export * from "./writer.js";
export * from "./transcript.js";
export * from "./notes.js";
export * from "./defects.js";
export * from "./check.js";
export * from "./center.js";
export * from "./complaints.js";
export * from "./staff.js";
export { money, spokenDate, noteDate, noteMoney } from "./format.js";
