/**
 * Screen 3 — where you live, and the questions only you can answer.
 *
 * The fourteen lettered questions of URLA Section 5, their three follow-ups,
 * and the residence history. Everything on this screen is a statement by the
 * borrower: no connector output reaches it, and nothing it collects is
 * inferred from anything we pulled. That is the whole reason it exists as a
 * screen rather than as a block of derived checkmarks on the last one.
 *
 * It is a STEP and not a branch. The branches render outstanding work the
 * engine reports, and the engine can only report work that has a requirement —
 * so these questions have rows in the sheet, a stage of their own, and a place
 * in the step count. A borrower who stops halfway comes back here.
 *
 * The submit is all-or-nothing, because the route is: twelve of these columns
 * are NOT NULL and a half-answered declaration completed with `false` is a
 * false statement on a document somebody signs. So the button says what is
 * still unanswered rather than posting and translating a refusal.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type {
  BankruptcyChapter,
  PriorPropertyTitle,
  PriorPropertyUsage,
  PropertyEstateType,
} from "@hm/shared";
import { api, ApiError } from "../lib/api.js";
import { PERSONA_READ_ONLY } from "../lib/auth.js";
import { SAMPLE_FILE_START_YOUR_OWN } from "../lib/home-copy.js";
import { useLoanFile } from "../lib/file.js";
import { primaryBorrower } from "../lib/borrowers.js";
import { Why } from "../components/Why.js";
import { YesNoQuestion } from "../components/YesNoQuestion.js";
import {
  BANKRUPTCY_CHAPTERS,
  BASIS_LABELS,
  BORROWED_FUNDS_AMOUNT,
  CHAPTER_LABELS,
  HOMEOWNER_PAST_THREE_YEARS,
  INTENT_TO_OCCUPY,
  PRIOR_PROPERTY_TITLE,
  PRIOR_PROPERTY_USAGE,
  SECTION_5A,
  SECTION_5B,
  TITLE_LABELS,
  USAGE_LABELS,
  asked,
  blankForm,
  bodyFrom,
  ESTATE_LABELS,
  EXPLAINABLE,
  formFrom,
  missingFrom,
  priorResidenceNeeded,
  PROPERTY_ESTATE_TYPE,
  type BooleanField,
  type DeclarationForm,
  type Question,
  type ResidenceForm,
  type YesNo,
} from "../lib/declarations.js";

export function DeclarationsPage() {
  const { fileId } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useLoanFile(fileId);
  const file = data?.file;
  const readOnly = file?.isDemo === true;

  const [form, setForm] = useState<DeclarationForm>(blankForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMissing, setShowMissing] = useState(false);

  /*
   * Seeded once, from what was already answered.
   *
   * A borrower coming back to change one answer must not meet an empty form —
   * this screen refuses a partial submit, so an empty one means retyping
   * seventeen answers to correct a single month. Once, because a seed that
   * watched the file would put the stored answer back over what they are
   * currently typing.
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !file) return;
    seeded.current = true;
    // The applicant's own stored answers, not the file's. This screen posts
    // without naming a borrower, which the route reads as Borrower 1 — so
    // seeding from anybody else would put one person's answers into a form
    // that saves as another's.
    const me = primaryBorrower(file);
    // The estate comes off the FILE rather than off this person: it is one
    // answer about one house, so a co-borrower who answered first has already
    // given it and this form shows it back rather than asking again.
    const estate = file.property?.estateType ?? null;
    if (estate || (me && (me.declaration || me.residences.length > 0))) {
      setForm(formFrom(me?.declaration ?? null, me?.residences ?? [], estate));
    }
  }, [file]);

  const purchase = file?.loan?.purpose === "purchase";
  const missing = missingFrom(form, purchase);

  const setAnswer = (field: BooleanField, value: YesNo) =>
    setForm((f) => ({ ...f, answers: { ...f.answers, [field]: value } }));
  const setExplanation = (letter: string, text: string) =>
    setForm((f) => ({ ...f, explanations: { ...f.explanations, [letter]: text } }));
  const setCurrent = (patch: Partial<ResidenceForm>) =>
    setForm((f) => ({ ...f, current: { ...f.current, ...patch } }));
  const setPrior = (patch: Partial<ResidenceForm>) =>
    setForm((f) => ({ ...f, prior: { ...f.prior, ...patch } }));
  const toggleChapter = (chapter: BankruptcyChapter) =>
    setForm((f) => ({
      ...f,
      bankruptcyChapters: f.bankruptcyChapters.includes(chapter)
        ? f.bankruptcyChapters.filter((c) => c !== chapter)
        : [...f.bankruptcyChapters, chapter],
    }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!fileId) return;
    if (missing.length > 0) {
      setShowMissing(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post(`/files/${fileId}/declaration`, bodyFrom(form, purchase));
      await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
      await queryClient.invalidateQueries({ queryKey: ["assessment"] });
      navigate(`/f/${fileId}/bank`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "DEMO_FILE_READ_ONLY") {
        setError(SAMPLE_FILE_START_YOUR_OWN);
      } else if (err instanceof ApiError && err.code === "PERSONA_READ_ONLY") {
        setError(PERSONA_READ_ONLY);
      } else {
        setError(err instanceof Error ? err.message : "That did not save.");
      }
    } finally {
      setSaving(false);
    }
  }

  const question = (q: Question) =>
    asked(q, purchase) && (
      <YesNoQuestion
        key={q.letter}
        id={`q-${q.letter}`}
        prompt={q.prompt}
        value={form.answers[q.field]}
        onChange={(value) => setAnswer(q.field, value)}
      >
        {form.answers[q.field] === "yes" && EXPLAINABLE.includes(q.field) && (
          <div className="mt-3">
            <label className="super-label" htmlFor={`why-${q.letter}`}>
              Tell us about it
            </label>
            <input
              id={`why-${q.letter}`}
              className="super-input"
              value={form.explanations[q.letter] ?? ""}
              onChange={(e) => setExplanation(q.letter, e.target.value)}
            />
          </div>
        )}
        {q.field === "undisclosedBorrowedFunds" && form.answers[q.field] === "yes" && (
          <div className="mt-3">
            <label className="super-label" htmlFor="borrowed-amount">
              {BORROWED_FUNDS_AMOUNT}
            </label>
            <input
              id="borrowed-amount"
              className="super-input"
              inputMode="decimal"
              placeholder="0"
              value={form.undisclosedBorrowedFundsAmount}
              onChange={(e) =>
                setForm((f) => ({ ...f, undisclosedBorrowedFundsAmount: e.target.value }))
              }
            />
          </div>
        )}
        {q.field === "bankruptcy" && form.answers[q.field] === "yes" && (
          <fieldset className="mt-3">
            <legend className="super-label">{BANKRUPTCY_CHAPTERS}</legend>
            <div className="mt-1 flex flex-col gap-2">
              {(Object.keys(CHAPTER_LABELS) as BankruptcyChapter[]).map((chapter) => (
                <label key={chapter} className="flex items-center gap-3 text-base text-ink-soft">
                  <input
                    type="checkbox"
                    checked={form.bankruptcyChapters.includes(chapter)}
                    onChange={() => toggleChapter(chapter)}
                  />
                  <span>{CHAPTER_LABELS[chapter]}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </YesNoQuestion>
    );

  return (
    <form onSubmit={submit} className="super-card">
      <h1 className="font-display text-2xl text-ink sm:text-3xl">A few questions</h1>
      <p className="mt-2 text-base text-ink-soft">
        These are the answers only you can give. Nobody can look them up for you, and every lender
        has to ask them.
      </p>

      {/* 1 — Where you live now, and where you lived before that. */}
      <section className="mt-7 border-t border-rule-soft pt-6">
        <h2 className="font-display text-lg text-ink">Where you live now</h2>
        <Residence
          idPrefix="current"
          value={form.current}
          onChange={setCurrent}
          askAddress={false}
        />
        <Why>
          Two years of address history goes on every application. If you have been where you are for
          less than that, we will ask for the one before it.
        </Why>

        {priorResidenceNeeded(form) && (
          <div className="mt-6 border-t border-rule-soft pt-6">
            <h2 className="font-display text-lg text-ink">Where you lived before that</h2>
            <Residence idPrefix="prior" value={form.prior} onChange={setPrior} askAddress={true} />
          </div>
        )}
      </section>

      {/* 2 — Section 5a, and the two follow-ups behind question A. */}
      <section className="mt-7 border-t border-rule-soft pt-6">
        <h2 className="font-display text-lg text-ink">About this property and this loan</h2>

        {/*
          The one question here that is not about the person answering, and the
          only thing on this screen the county could not have told us. Most
          homes come with their land; the ones that do not are a different loan
          to underwrite, and nothing we can look up says which this is.
        */}
        <div className="mb-5">
          <label className="super-label" htmlFor="estate-type">
            {PROPERTY_ESTATE_TYPE}
          </label>
          <select
            id="estate-type"
            className="super-input"
            value={form.propertyEstateType}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                propertyEstateType: e.target.value as PropertyEstateType,
              }))
            }
          >
            <option value="">Choose one</option>
            {(Object.keys(ESTATE_LABELS) as PropertyEstateType[]).map((estate) => (
              <option key={estate} value={estate}>
                {ESTATE_LABELS[estate]}
              </option>
            ))}
          </select>
        </div>

        <YesNoQuestion
          id="q-A"
          prompt={INTENT_TO_OCCUPY.prompt}
          value={form.intentToOccupy}
          onChange={(value) =>
            setForm((f) => ({
              ...f,
              intentToOccupy: value,
              // Both follow-ups are cleared when their trigger stops being
              // yes. The route refuses an answer to a question its trigger
              // says was never put, in both directions, and a stale answer
              // left sitting in state is exactly that.
              homeownerPastThreeYears: value === "yes" ? f.homeownerPastThreeYears : "",
              priorPropertyUsage: value === "yes" ? f.priorPropertyUsage : "",
              priorPropertyTitle: value === "yes" ? f.priorPropertyTitle : "",
            }))
          }
        >
          {form.intentToOccupy === "yes" && (
            <div className="mt-3 border-l border-rule-soft pl-4">
              <YesNoQuestion
                id="q-A1"
                prompt={HOMEOWNER_PAST_THREE_YEARS}
                value={form.homeownerPastThreeYears}
                onChange={(value) =>
                  setForm((f) => ({
                    ...f,
                    homeownerPastThreeYears: value,
                    priorPropertyUsage: value === "yes" ? f.priorPropertyUsage : "",
                    priorPropertyTitle: value === "yes" ? f.priorPropertyTitle : "",
                  }))
                }
              >
                {form.homeownerPastThreeYears === "yes" && (
                  <div className="mt-3 flex flex-col gap-4">
                    <div>
                      <label className="super-label" htmlFor="prior-usage">
                        {PRIOR_PROPERTY_USAGE}
                      </label>
                      <select
                        id="prior-usage"
                        className="super-input"
                        value={form.priorPropertyUsage}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            priorPropertyUsage: e.target.value as PriorPropertyUsage,
                          }))
                        }
                      >
                        <option value="">Choose one</option>
                        {(Object.keys(USAGE_LABELS) as PriorPropertyUsage[]).map((usage) => (
                          <option key={usage} value={usage}>
                            {USAGE_LABELS[usage]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="super-label" htmlFor="prior-title">
                        {PRIOR_PROPERTY_TITLE}
                      </label>
                      <select
                        id="prior-title"
                        className="super-input"
                        value={form.priorPropertyTitle}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            priorPropertyTitle: e.target.value as PriorPropertyTitle,
                          }))
                        }
                      >
                        {/* Optional in DU and bound to no condition, so it is
                            offered and never demanded. */}
                        <option value="">Rather not say</option>
                        {(Object.keys(TITLE_LABELS) as PriorPropertyTitle[]).map((title) => (
                          <option key={title} value={title}>
                            {TITLE_LABELS[title]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </YesNoQuestion>
            </div>
          )}
        </YesNoQuestion>

        {SECTION_5A.map(question)}
      </section>

      {/* 3 — Section 5b. */}
      <section className="mt-7 border-t border-rule-soft pt-6">
        <h2 className="font-display text-lg text-ink">About your finances</h2>
        {SECTION_5B.map(question)}
      </section>

      {error && <p className="mt-4 text-sm text-danger">{error}</p>}

      {showMissing && missing.length > 0 && (
        <div className="super-notice mt-6">
          <p className="text-sm font-medium text-ink">
            {missing.length === 1 ? "One thing is still unanswered" : "A few things are unanswered"}
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {missing.map((item) => (
              <li key={item} className="text-sm text-ink-soft">
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      <button className="super-btn super-btn-primary mt-7" disabled={saving || readOnly}>
        {saving ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}

/** Basis, months, and the rent — plus an address, on the prior one only. */
function Residence({
  idPrefix,
  value,
  onChange,
  askAddress,
}: {
  idPrefix: string;
  value: ResidenceForm;
  onChange: (patch: Partial<ResidenceForm>) => void;
  askAddress: boolean;
}) {
  return (
    <div className="mt-4 flex flex-col gap-4">
      <div>
        <label className="super-label" htmlFor={`${idPrefix}-basis`}>
          Do you own, rent, or live there rent free?
        </label>
        <select
          id={`${idPrefix}-basis`}
          className="super-input"
          value={value.basis}
          onChange={(e) =>
            onChange({
              basis: e.target.value as ResidenceForm["basis"],
              // The rent goes with the renting. An amount on a home the
              // borrower owns is refused by the route and by the column.
              monthlyRent: e.target.value === "Rent" ? value.monthlyRent : "",
            })
          }
        >
          <option value="">Choose one</option>
          {(Object.keys(BASIS_LABELS) as (keyof typeof BASIS_LABELS)[]).map((basis) => (
            <option key={basis} value={basis}>
              {BASIS_LABELS[basis]}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="super-label" htmlFor={`${idPrefix}-months`}>
          How many months have you been there?
        </label>
        <input
          id={`${idPrefix}-months`}
          className="super-input"
          inputMode="numeric"
          placeholder="0"
          value={value.durationMonths}
          onChange={(e) => onChange({ durationMonths: e.target.value.replace(/\D/g, "") })}
        />
      </div>

      {value.basis === "Rent" && (
        <div>
          <label className="super-label" htmlFor={`${idPrefix}-rent`}>
            What is the rent each month?
          </label>
          <input
            id={`${idPrefix}-rent`}
            className="super-input"
            inputMode="decimal"
            placeholder="0"
            value={value.monthlyRent}
            onChange={(e) => onChange({ monthlyRent: e.target.value })}
          />
        </div>
      )}

      {askAddress && (
        <>
          <div>
            <label className="super-label" htmlFor={`${idPrefix}-line1`}>
              Street address
            </label>
            <input
              id={`${idPrefix}-line1`}
              className="super-input"
              maxLength={50}
              value={value.addressLineText}
              onChange={(e) => onChange({ addressLineText: e.target.value })}
            />
          </div>
          <div>
            <label className="super-label" htmlFor={`${idPrefix}-unit`}>
              Apartment or unit
            </label>
            <input
              id={`${idPrefix}-unit`}
              className="super-input"
              maxLength={11}
              value={value.addressUnit}
              onChange={(e) => onChange({ addressUnit: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="col-span-2">
              <label className="super-label" htmlFor={`${idPrefix}-city`}>
                City
              </label>
              <input
                id={`${idPrefix}-city`}
                className="super-input"
                maxLength={35}
                value={value.cityName}
                onChange={(e) => onChange({ cityName: e.target.value })}
              />
            </div>
            <div>
              <label className="super-label" htmlFor={`${idPrefix}-state`}>
                State
              </label>
              <input
                id={`${idPrefix}-state`}
                className="super-input"
                maxLength={2}
                value={value.stateCode}
                onChange={(e) => onChange({ stateCode: e.target.value.toUpperCase() })}
              />
            </div>
            <div>
              <label className="super-label" htmlFor={`${idPrefix}-postal`}>
                ZIP code
              </label>
              <input
                id={`${idPrefix}-postal`}
                className="super-input"
                inputMode="numeric"
                maxLength={9}
                value={value.postalCode}
                onChange={(e) => onChange({ postalCode: e.target.value.replace(/\D/g, "") })}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
