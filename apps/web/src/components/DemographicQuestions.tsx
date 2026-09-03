/**
 * The fair-lending questions, in three lines instead of three screens' worth.
 *
 * Regulation B and HMDA require that we ASK. They do not require an answer —
 * declining is itself a valid, recorded response — and they do not require
 * fifteen radio buttons. The previous version rendered every option inline and
 * took more vertical space than the rest of the review screen combined, which
 * made the last thing before signing feel like the start of another form.
 *
 * Three selects, and a one-tap decline above them.
 *
 * One thing deliberately NOT done: "prefer not to say" is not pre-selected.
 * It is the first option, it is one tap, and the decline-all button sits right
 * there — but an untouched form must not record a decline the borrower never
 * made. This component's own history is the argument: demographics were once
 * hardcoded to "declined" for everyone, which satisfied APP-011 with a false
 * statement about a real person. Easy to decline is a design goal. Declined by
 * default is a fabricated answer.
 *
 * The aggregate categories here are the minimum. A production build needs the
 * disaggregated set (URLA lists eleven Asian and Pacific Islander subcategories
 * and four for Hispanic origin) and the visual-observation path for anything
 * taken face to face.
 */

import type { ChangeEvent } from "react";

export interface DemographicAnswers {
  ethnicity: string[] | "declined";
  race: string[] | "declined";
  sex: string | "declined";
  visualObservationNoted: boolean;
}

const DECLINED = "declined";

const ETHNICITY = ["Hispanic or Latino", "Not Hispanic or Latino"];
const RACE = [
  "American Indian or Alaska Native",
  "Asian",
  "Black or African American",
  "Native Hawaiian or Other Pacific Islander",
  "White",
];
const SEX = ["Female", "Male"];

export function DemographicQuestions({
  value,
  onChange,
}: {
  value: DemographicAnswers;
  onChange: (next: DemographicAnswers) => void;
}) {
  const allDeclined =
    value.ethnicity === DECLINED && value.race === DECLINED && value.sex === DECLINED;

  function declineAll() {
    onChange({
      ethnicity: DECLINED,
      race: DECLINED,
      sex: DECLINED,
      visualObservationNoted: false,
    });
  }

  /**
   * A select holds one value; ethnicity and race are multi-select on the URLA.
   * Choosing one option here records exactly that one, which is a real answer
   * rather than a complete one. The disaggregated multi-select belongs in the
   * production build alongside the subcategories.
   */
  function pickList(key: "ethnicity" | "race") {
    return (e: ChangeEvent<HTMLSelectElement>) => {
      const v = e.target.value;
      onChange({ ...value, [key]: v === "" ? [] : v === DECLINED ? DECLINED : [v] });
    };
  }

  const listValue = (v: string[] | "declined") => (v === DECLINED ? DECLINED : (v[0] ?? ""));

  return (
    <fieldset className="mt-6 border-t border-rule-soft pt-5">
      <legend className="sr-only">Demographic information</legend>

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-base text-ink">Three questions we have to ask</h2>
        <button type="button" onClick={declineAll} className="super-link text-sm">
          {allDeclined ? "Declined ✓" : "I'd rather not answer these"}
        </button>
      </div>

      <p className="mt-1.5 max-w-measure-prose text-sm text-ink-muted">
        The government asks lenders to collect this so it can check people are treated fairly. It is
        not used to decide your application, and you may decline.
      </p>

      <div className="mt-4 flex flex-col gap-3">
        <Row label="Ethnicity" htmlFor="d-ethnicity">
          <select
            id="d-ethnicity"
            className="super-input"
            value={listValue(value.ethnicity)}
            onChange={pickList("ethnicity")}
          >
            <option value="">Select…</option>
            <option value={DECLINED}>I&rsquo;d rather not say</option>
            {ETHNICITY.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Race" htmlFor="d-race">
          <select
            id="d-race"
            className="super-input"
            value={listValue(value.race)}
            onChange={pickList("race")}
          >
            <option value="">Select…</option>
            <option value={DECLINED}>I&rsquo;d rather not say</option>
            {RACE.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Sex" htmlFor="d-sex">
          <select
            id="d-sex"
            className="super-input"
            value={value.sex}
            onChange={(e) => onChange({ ...value, sex: e.target.value })}
          >
            <option value="">Select…</option>
            <option value={DECLINED}>I&rsquo;d rather not say</option>
            {SEX.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </Row>
      </div>
    </fieldset>
  );
}

function Row({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
      <label className="w-24 shrink-0 text-sm font-medium text-ink-soft" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="flex-1">{children}</div>
    </div>
  );
}
