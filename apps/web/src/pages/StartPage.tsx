import { Link } from "react-router-dom";
import { PrototypeBanner } from "../components/PrototypeBanner.js";

export function StartPage() {
  return (
    <>
      <PrototypeBanner />
      <div className="mx-auto max-w-2xl px-6 py-20">
        <h1 className="font-brand text-[34px] font-semibold leading-tight text-ink-editorial">
          Find out what you qualify for, today.
        </h1>
        <p className="mt-4 font-prose text-[18px] leading-relaxed text-ink-prose">
          Two short forms and four connections. Most of what underwriting needs, we can retrieve
          ourselves — you should not be uploading bank statements in 2026.
        </p>
        <Link to="/f/new/property" className="btn-primary mt-8 inline-block">
          Start
        </Link>
        <p className="mt-12 text-[13px] leading-relaxed text-subtle">
          Takes about two minutes. Nothing you enter is verified against a real bureau, bank or
          employer — every connection returns sample data.
        </p>
      </div>
    </>
  );
}
