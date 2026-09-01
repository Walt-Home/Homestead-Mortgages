/**
 * URLA Section 7 — the demographic questions.
 *
 * These were a hardcoded literal: every borrower was recorded as having
 * DECLINED to answer all three, and APP-011 — a requirement whose severity in
 * Drew's sheet is "Regulatory violation" — was marked satisfied on the
 * strength of it. Nothing else in this codebase asserted something false about
 * a person.
 *
 * The regulation is about the ASKING. Regulation B (12 CFR 1002.13) requires a
 * creditor to request this information on a dwelling-secured application, and
 * to record that the applicant declined if they do. "Declined" is a real
 * answer to a real question, and recording it for a question nobody was shown
 * is not a shortcut — it is a false statement in a compliance record.
 *
 * The categories below are the aggregate ones. A production build needs the
 * full disaggregated set (six Asian subcategories, four Pacific Islander,
 * three Hispanic origins) and the "collected on the basis of visual
 * observation or surname" path for in-person applications.
 */

export interface DemographicAnswers {
  ethnicity: string[] | "declined";
  race: string[] | "declined";
  sex: string | "declined";
  visualObservationNoted: boolean;
}

const ETHNICITY = ["Hispanic or Latino", "Not Hispanic or Latino"];
const RACE = [
  "American Indian or Alaska Native",
  "Asian",
  "Black or African American",
  "Native Hawaiian or Other Pacific Islander",
  "White",
];
const SEX = ["Female", "Male"];

const DECLINE = "I do not wish to provide this information";

export function DemographicQuestions({
  value,
  onChange,
}: {
  value: DemographicAnswers;
  onChange: (next: DemographicAnswers) => void;
}) {
  function toggleMulti(field: "ethnicity" | "race", option: string) {
    const current = value[field];
    if (current === "declined") {
      onChange({ ...value, [field]: [option] });
      return;
    }
    const next = current.includes(option)
      ? current.filter((x) => x !== option)
      : [...current, option];
    onChange({ ...value, [field]: next });
  }

  return (
    <fieldset className="mt-6 border-t border-line-light pt-5">
      <legend className="sr-only">Demographic information</legend>
      <h2 className="font-brand text-[16px] font-semibold text-ink-editorial">
        About you, for fair lending
      </h2>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">
        The government asks lenders to collect this so it can check that people are treated
        fairly. It is <span className="font-medium">not</span> used to decide your application, and
        you may decline any of it. We have to ask either way.
      </p>

      <Question label="Ethnicity">
        {ETHNICITY.map((option) => (
          <Choice
            key={option}
            type="checkbox"
            label={option}
            checked={value.ethnicity !== "declined" && value.ethnicity.includes(option)}
            onChange={() => toggleMulti("ethnicity", option)}
          />
        ))}
        <Choice
          type="radio"
          label={DECLINE}
          checked={value.ethnicity === "declined"}
          onChange={() => onChange({ ...value, ethnicity: "declined" })}
        />
      </Question>

      <Question label="Race">
        {RACE.map((option) => (
          <Choice
            key={option}
            type="checkbox"
            label={option}
            checked={value.race !== "declined" && value.race.includes(option)}
            onChange={() => toggleMulti("race", option)}
          />
        ))}
        <Choice
          type="radio"
          label={DECLINE}
          checked={value.race === "declined"}
          onChange={() => onChange({ ...value, race: "declined" })}
        />
      </Question>

      <Question label="Sex">
        {SEX.map((option) => (
          <Choice
            key={option}
            type="radio"
            label={option}
            checked={value.sex === option}
            onChange={() => onChange({ ...value, sex: option })}
          />
        ))}
        <Choice
          type="radio"
          label={DECLINE}
          checked={value.sex === "declined"}
          onChange={() => onChange({ ...value, sex: "declined" })}
        />
      </Question>
    </fieldset>
  );
}

function Question({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <p className="field-label">{label}</p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Choice({
  type,
  label,
  checked,
  onChange,
}: {
  type: "checkbox" | "radio";
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex items-start gap-2.5 text-[13px] leading-relaxed text-ink-soft">
      <input type={type} className="mt-0.5" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}
