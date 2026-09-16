/**
 * The reader, against documents that are at least the right KIND of document.
 *
 * Every fixture below is a MISMO 3.4 `MESSAGE` validated by `xmllint` against
 * the vendored DU wrapper, which is the one thing that can be checked about a
 * response format nobody here has ever seen. It does not make the shape right —
 * DU may answer in its own proprietary format, or with a job id to poll — but
 * it does mean these tests are not written against XML somebody invented to
 * make a parser pass. Every element name in them is in
 * `MISMO_3.4.0_B324.xsd`.
 *
 * `xmllint` is shelled out to rather than imported, the way
 * `apps/api/src/__tests__/du-submission.test.ts` does it, so that
 * `@hm/connectors` keeps the one dependency it has. It THROWS when xmllint is
 * missing rather than reporting success: a green tick for a check that did not
 * run is worse than no check.
 *
 * The negative cases are the point of the file. A response is the input to two
 * write-once facts — `applications.du_casefile_id` and an append-only
 * `du_responses` row — so a reader that salvages what it half-understands
 * writes a row nobody can replace.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DU_RECOMMENDATIONS, UnknownDuRecommendationError } from "@hm/shared";
import {
  DU_FINDINGS_CATEGORY,
  DuResponseFormatError,
  MAX_DU_RESPONSE_CHARACTERS,
  mismoAusResponseReader,
} from "../index.js";

const DU_WRAPPER_XSD = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../du-schema/xsd/DU_Wrapper_3.4.0_B324.xsd",
);

/** What libxml2 says about a document. Empty means it validated. */
function xmllintErrors(xml: string): string[] {
  const directory = mkdtempSync(join(tmpdir(), "hm-du-response-"));
  const file = join(directory, "answer.xml");
  try {
    writeFileSync(file, xml);
    const run = spawnSync("xmllint", ["--noout", "--schema", DU_WRAPPER_XSD, file], {
      encoding: "utf8",
    });
    if (run.error) {
      throw new Error(
        `xmllint could not be run (${run.error.message}). Install libxml2 rather than letting ` +
          "this check pass by not happening.",
      );
    }
    if (run.status === 0) return [];
    return (run.stderr ?? "")
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.endsWith(" validates"))
      .map((line) => line.replace(file, "answer.xml"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<MESSAGE xmlns="http://www.mismo.org/residential/2009/schemas" ' +
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
  'MISMOReferenceModelIdentifier="3.4.032420160128" ' +
  'xsi:schemaLocation="http://www.mismo.org/residential/2009/schemas DU_Wrapper_3.4.0_B324.xsd">' +
  "<ABOUT_VERSIONS><ABOUT_VERSION>" +
  "<AboutVersionIdentifier>DU Spec 1.9.3</AboutVersionIdentifier>" +
  "<CreatedDatetime>2026-09-16T12:00:00Z</CreatedDatetime>" +
  "</ABOUT_VERSION></ABOUT_VERSIONS>";

/** The DEAL's own `LOANS`, where a submission states the case it is resubmitting. */
function dealLoans(children: string): string {
  return (
    '<LOANS><LOAN LoanRoleType="SubjectLoan"><UNDERWRITING><AUTOMATED_UNDERWRITINGS>' +
    `<AUTOMATED_UNDERWRITING>${children}</AUTOMATED_UNDERWRITING>` +
    "</AUTOMATED_UNDERWRITINGS></UNDERWRITING></LOAN></LOANS>"
  );
}

/** The response's own container, which carries a `LOANS` of its own. */
function service(messages: string, responseLoans = ""): string {
  return (
    "<SERVICES><SERVICE><AUTOMATED_UNDERWRITING_SYSTEM><AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE>" +
    (messages === ""
      ? ""
      : `<AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE_MESSAGES>${messages}` +
        "</AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE_MESSAGES>") +
    responseLoans +
    "</AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE></AUTOMATED_UNDERWRITING_SYSTEM></SERVICE></SERVICES>"
  );
}

function message(text: string, code?: string, sequence?: number): string {
  return (
    `<AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE_MESSAGE${
      sequence === undefined ? "" : ` SequenceNumber="${sequence}"`
    }>` +
    `<AutomatedUnderwritingSystemMessageDescription>${text}` +
    "</AutomatedUnderwritingSystemMessageDescription>" +
    (code === undefined
      ? ""
      : `<AutomatedUnderwritingSystemMessageValue>${code}` +
        "</AutomatedUnderwritingSystemMessageValue>") +
    "</AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE_MESSAGE>"
  );
}

/** A whole document. `LOANS` precedes `SERVICES`, which is the DEAL's own order. */
function document(loans: string, services: string): string {
  return `${HEADER}<DEAL_SETS><DEAL_SET><DEALS><DEAL>${loans}${services}</DEAL></DEALS></DEAL_SET></DEAL_SETS></MESSAGE>`;
}

const RECEIVED_AT = new Date("2026-09-16T12:34:56.000Z");

function read(body: string, contentType: string | null = "application/xml") {
  return mismoAusResponseReader({ status: 200, contentType, body, receivedAt: RECEIVED_AT });
}

const answered = (recommendation: string, caseId = "1234567890") =>
  document(
    dealLoans(
      `<AutomatedUnderwritingCaseIdentifier>${caseId}</AutomatedUnderwritingCaseIdentifier>` +
        `<AutomatedUnderwritingRecommendationDescription>${recommendation}` +
        "</AutomatedUnderwritingRecommendationDescription>",
    ),
    service(message("The loan is eligible for delivery to Fannie Mae.", "0001", 1)),
  );

describe("an answer the reader accepts", () => {
  it("reads all six of DU's own spellings", () => {
    for (const recommendation of DU_RECOMMENDATIONS) {
      const response = read(answered(recommendation));
      expect(response.status).toBe("answered");
      if (response.status !== "answered") throw new Error("unreachable");
      expect(response.recommendation).toBe(recommendation);
      expect(response.duCasefileId).toBe("1234567890");
    }
  });

  it("stamps our own clock on it, not a timestamp from the document", () => {
    // A vendor timestamp's zone and meaning are two more things the corpus does
    // not give, and `received_at` is a fact about us.
    expect(read(answered("Approve/Eligible")).respondedAt).toBe("2026-09-16T12:34:56.000Z");
  });

  it("finds the verdict in the response's OWN loans, not only the deal's", () => {
    // `AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE` declares a `LOANS` child of its
    // own, so the schema permits the verdict at two XPaths and nothing vendored
    // says which one DU uses.
    const xml = document(
      "",
      service(
        message("Eligible.", undefined, 1),
        dealLoans(
          "<AutomatedUnderwritingCaseIdentifier>9876543210</AutomatedUnderwritingCaseIdentifier>" +
            "<AutomatedUnderwritingRecommendationDescription>Refer/Eligible" +
            "</AutomatedUnderwritingRecommendationDescription>",
        ),
      ),
    );
    const response = read(xml);
    if (response.status !== "answered") throw new Error("unreachable");
    expect(response.recommendation).toBe("Refer/Eligible");
    expect(response.duCasefileId).toBe("9876543210");
  });

  it("accepts the two agreeing, which is what an echoed submission looks like", () => {
    const both =
      "<AutomatedUnderwritingCaseIdentifier>1234567890</AutomatedUnderwritingCaseIdentifier>" +
      "<AutomatedUnderwritingRecommendationDescription>Approve/Eligible" +
      "</AutomatedUnderwritingRecommendationDescription>";
    const xml = document(dealLoans(both), service(message("Eligible.", undefined, 1), dealLoans(both)));
    const response = read(xml);
    expect(response.status).toBe("answered");
  });

  it("keeps the findings in order and lets a message carry no code", () => {
    const xml = document(
      dealLoans(
        "<AutomatedUnderwritingCaseIdentifier>1234567890</AutomatedUnderwritingCaseIdentifier>" +
          "<AutomatedUnderwritingRecommendationDescription>Approve/Eligible" +
          "</AutomatedUnderwritingRecommendationDescription>",
      ),
      service(
        message("First.", "0001") + message("Second.") + message("Third.", "0003"),
      ),
    );
    // Not every message is numbered here, so document order is the order.
    const response = read(xml);
    expect(response.messages.map((m) => m.text)).toEqual(["First.", "Second.", "Third."]);
    expect(response.messages.map((m) => m.code)).toEqual(["0001", null, "0003"]);
    expect(response.messages.every((m) => m.category === DU_FINDINGS_CATEGORY)).toBe(true);
  });

  it("sorts by SequenceNumber when every message carries one", () => {
    const xml = document(
      dealLoans(
        "<AutomatedUnderwritingCaseIdentifier>1234567890</AutomatedUnderwritingCaseIdentifier>" +
          "<AutomatedUnderwritingRecommendationDescription>Approve/Eligible" +
          "</AutomatedUnderwritingRecommendationDescription>",
      ),
      service(message("Third.", "3", 3) + message("First.", "1", 1) + message("Second.", "2", 2)),
    );
    expect(read(xml).messages.map((m) => m.text)).toEqual(["First.", "Second.", "Third."]);
  });

  it("reads an errored answer DU opened no case for", () => {
    const xml = document("", service(message("The casefile could not be evaluated.", "0900", 1)));
    const response = read(xml);
    expect(response.status).toBe("errored");
    expect(response.duCasefileId).toBeNull();
    expect(response.messages).toHaveLength(1);
  });

  it("reads an errored answer that still names a case", () => {
    // DU opened a case and then could not evaluate it. A resubmission has to
    // carry that number or it opens a second one.
    const xml = document(
      dealLoans(
        "<AutomatedUnderwritingCaseIdentifier>1234567890</AutomatedUnderwritingCaseIdentifier>",
      ),
      service(message("Missing employment information.", "0901", 1)),
    );
    const response = read(xml);
    expect(response.status).toBe("errored");
    expect(response.duCasefileId).toBe("1234567890");
  });

  it("reads text through the five XML predefines and a numeric reference", () => {
    const xml = document(
      "",
      service(message("Income &lt; debt &amp; &#82;atio too high.", undefined, 1)),
    );
    expect(read(xml).messages[0]!.text).toBe("Income < debt & Ratio too high.");
  });

  it("validates every one of those fixtures against the vendored wrapper", () => {
    // The one check available on a format nobody here has seen: the fixtures
    // are at least documents the DU schema chain accepts.
    const fixtures = [
      answered("Approve/Eligible"),
      document("", service(message("The casefile could not be evaluated.", "0900", 1))),
      document(
        dealLoans(
          "<AutomatedUnderwritingCaseIdentifier>1234567890</AutomatedUnderwritingCaseIdentifier>",
        ),
        service(message("Missing employment information.", "0901", 1)),
      ),
      document(
        "",
        service(
          message("Eligible.", undefined, 1),
          dealLoans(
            "<AutomatedUnderwritingCaseIdentifier>9876543210</AutomatedUnderwritingCaseIdentifier>" +
              "<AutomatedUnderwritingRecommendationDescription>Refer/Eligible" +
              "</AutomatedUnderwritingRecommendationDescription>",
          ),
        ),
      ),
    ];
    for (const fixture of fixtures) expect(xmllintErrors(fixture)).toEqual([]);
  });
});

describe("an answer the reader refuses", () => {
  it("refuses a verdict this system has never decided about", () => {
    // Through `parseDuRecommendation`, which throws rather than passing the
    // string on. Nothing is returned, so nothing is stored and nothing claims
    // the write-once casefile column.
    expect(() => read(answered("Approve With Conditions"))).toThrow(UnknownDuRecommendationError);
  });

  it("refuses a verdict with no case identifier", () => {
    // Recording this as "errored" would file a verdict DU gave as an
    // evaluation that never happened — and the resubmission after it would
    // open a second case.
    const xml = document(
      dealLoans(
        "<AutomatedUnderwritingRecommendationDescription>Approve/Eligible" +
          "</AutomatedUnderwritingRecommendationDescription>",
      ),
      service(message("Eligible.", undefined, 1)),
    );
    expect(() => read(xml)).toThrow(DuResponseFormatError);
  });

  it("refuses two containers that disagree", () => {
    const xml = document(
      dealLoans(
        "<AutomatedUnderwritingCaseIdentifier>1111111111</AutomatedUnderwritingCaseIdentifier>",
      ),
      service(
        message("Eligible.", undefined, 1),
        dealLoans(
          "<AutomatedUnderwritingCaseIdentifier>2222222222</AutomatedUnderwritingCaseIdentifier>",
        ),
      ),
    );
    expect(() => read(xml)).toThrow(/different values/);
  });

  it("refuses a case identifier the column cannot hold", () => {
    // `applications.du_casefile_id` is a VARCHAR(30) and DU_FORMATS says String
    // 30. Truncating here would store a number that is not the case.
    expect(() => read(answered("Approve/Eligible", "1".repeat(31)))).toThrow(
      DuResponseFormatError,
    );
    expect(read(answered("Approve/Eligible", "1".repeat(30))).duCasefileId).toHaveLength(30);
  });

  it("refuses an empty case identifier", () => {
    const xml = document(
      dealLoans("<AutomatedUnderwritingCaseIdentifier></AutomatedUnderwritingCaseIdentifier>"),
      service(message("Eligible.", undefined, 1)),
    );
    expect(() => read(xml)).toThrow(DuResponseFormatError);
  });

  it("refuses a valid document with no verdict and no findings in it", () => {
    // What a 200 from the wrong endpoint looks like when the wrong endpoint
    // also speaks XML.
    expect(() => read(document("", ""))).toThrow(DuResponseFormatError);
  });

  it("refuses a findings message with no description", () => {
    const xml = document(
      "",
      service(
        "<AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE_MESSAGE>" +
          "<AutomatedUnderwritingSystemMessageValue>0001" +
          "</AutomatedUnderwritingSystemMessageValue>" +
          "</AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE_MESSAGE>",
      ),
    );
    expect(() => read(xml)).toThrow(DuResponseFormatError);
  });

  it("refuses messages where only some carry a sequence number", () => {
    const xml = document(
      "",
      service(message("First.", undefined, 1) + message("Second.")),
    );
    expect(() => read(xml)).toThrow(/partial order/);
  });

  it("refuses anything that is not served as XML", () => {
    expect(() => read(answered("Approve/Eligible"), "text/html; charset=utf-8")).toThrow(
      DuResponseFormatError,
    );
    expect(() => read(answered("Approve/Eligible"), "application/json")).toThrow(
      DuResponseFormatError,
    );
    expect(() => read(answered("Approve/Eligible"), null)).toThrow(DuResponseFormatError);
    // And accepts the three spellings a real server might use.
    expect(() => read(answered("Approve/Eligible"), "text/xml")).not.toThrow();
    expect(() => read(answered("Approve/Eligible"), "application/mismo+xml")).not.toThrow();
    expect(() =>
      read(answered("Approve/Eligible"), "Application/XML; charset=UTF-8"),
    ).not.toThrow();
  });

  it("refuses a body past the cap before it parses anything", () => {
    const enormous = "<".repeat(MAX_DU_RESPONSE_CHARACTERS + 1);
    // Unparseable as well as too long: the refusal has to be the length, which
    // is what says the check happened first.
    expect(() => read(enormous)).toThrow(/past the/);
  });

  it("refuses a document type declaration rather than resolving it", () => {
    // The whole of the XXE and billion-laughs answer: there is no DTD to
    // expand, because a DTD is refused at the door.
    const xxe =
      '<?xml version="1.0"?>' +
      '<!DOCTYPE MESSAGE [<!ENTITY secret SYSTEM "file:///etc/passwd">]>' +
      "<MESSAGE><AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE_MESSAGE>" +
      "<AutomatedUnderwritingSystemMessageDescription>&secret;" +
      "</AutomatedUnderwritingSystemMessageDescription>" +
      "</AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE_MESSAGE></MESSAGE>";
    expect(() => read(xxe)).toThrow(/document type or entity declaration/);
  });

  it("refuses an entity reference it has no declaration for", () => {
    const xml = document("", service(message("&secret;", undefined, 1)));
    expect(() => read(xml)).toThrow(/will not resolve/);
  });

  it("refuses XML that is not well formed", () => {
    expect(() => read('<MESSAGE xmlns="x"><DEAL></MESSAGE>')).toThrow(DuResponseFormatError);
    expect(() => read("<MESSAGE/><MESSAGE/>")).toThrow(DuResponseFormatError);
    expect(() => read("not xml at all")).toThrow(DuResponseFormatError);
  });
});
