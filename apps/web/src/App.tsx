import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { ApplicationReceipt } from "@hm/shared";
import { Stepper } from "./components/Stepper.js";
import { ApplicationStanding } from "./components/ApplicationStanding.js";
import { DebugPanel, type RawLedgerRow } from "./components/DebugPanel.js";
import { Lockup } from "./components/Wordmark.js";
import { Footer } from "./components/Footer.js";
import { api, ApiError, type Assessment } from "./lib/api.js";
import { useAuth } from "./lib/auth.js";
import { StatesGalleryPage } from "./pages/StatesGalleryPage.js";
import {
  hasStopped,
  landingScreen,
  needsRepair,
  useLoanFile,
  type ApplicationStandingView,
} from "./lib/file.js";
import {
  REPAIR_SCREEN,
  STAGE_TO_SCREEN,
  debugEnabled,
  screenIndex,
  screenOwnsStanding,
  type ScreenPath,
} from "./lib/flow.js";
import { SignInPage } from "./pages/SignInPage.js";
import { LandingPage } from "./pages/LandingPage.js";
import { PrivacyPage } from "./pages/PrivacyPage.js";
import { BrandPage } from "./pages/BrandPage.js";
import { FilesPage } from "./pages/FilesPage.js";
import { PropertyLoanPage } from "./pages/PropertyLoanPage.js";
import { IdentityPage } from "./pages/IdentityPage.js";
import { IdentityReturnPage } from "./pages/IdentityReturnPage.js";
import { PlaidReturnPage } from "./pages/PlaidReturnPage.js";
import { BankPage } from "./pages/BankPage.js";
import { ReviewPage } from "./pages/ReviewPage.js";
import { IrsPage, PayrollPage } from "./pages/ConnectPages.js";
import { UploadPage } from "./pages/UploadPage.js";

export function App() {
  const { status, config } = useAuth();

  // Render nothing rather than the sign-in page while the session is still
  // being resolved — a signed-in person should never see a sign-in flash.
  if (status === "loading") return <div className="min-h-screen bg-ground" />;

  if (status === "signed-out") {
    return (
      <Routes>
        {/*
          The public tree. `/` is the marketing page with sign-in on it, which
          is what a stranger arriving at the site should get — before this they
          got a bare sign-in form and never saw the product.

          Everything else still falls through to SignInPage, rendered IN PLACE
          rather than redirected, so a deep link like /f/:id/bank keeps its URL
          and signing in lands on the file that was asked for.
        */}
        <Route path="/" element={<Chrome />}>
          <Route index element={<LandingPage />} />
          {/*
            /privacy and /brand are listed in BOTH auth trees on purpose. They
            are public, and a route that existed only in the signed-in tree
            would send an anonymous visitor to the sign-in fallback instead —
            which is exactly where the footer links them.
          */}
          <Route path="privacy" element={<PrivacyPage />} />
          <Route path="brand" element={<BrandPage />} />
        </Route>
        <Route path="*" element={<SignInPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<Chrome />}>
        <Route index element={<FilesPage />} />
        <Route path="privacy" element={<PrivacyPage />} />
        <Route path="brand" element={<BrandPage />} />
        {/*
          The state gallery. Only in the signed-in tree, and only when the
          server says so: it is a design surface rather than a feature, and
          most of the states it renders have no column behind them yet. With
          the flag off it falls through to the catch-all, which is the same
          answer any unknown path gets.
        */}
        {config?.stateGalleryEnabled && <Route path="states" element={<StatesGalleryPage />} />}
        {/*
          Where an OAuth bank returns the borrower.

          Top level, not under /f/:fileId, because Plaid forbids query
          parameters on a redirect URI and requires it registered verbatim in
          the dashboard — so the path cannot carry a file id. The page
          recovers it from the stored attempt instead. Without this route the
          catch-all below would silently redirect the borrower to their file
          list, mid-handoff, with no explanation.
        */}
        <Route path="plaid/return" element={<PlaidReturnPage />} />
      </Route>

      {/* Screen 1 runs before a file exists. */}
      <Route path="/f/new" element={<Shell screen="property" />}>
        <Route path="property" element={<PropertyLoanPage />} />
      </Route>

      <Route path="/f/:fileId" element={<FileShell />}>
        <Route index element={<ResumeToStage />} />
        {/* The four screens. */}
        <Route path="property" element={<PropertyLoanPage />} />
        <Route path="identity" element={<IdentityPage />} />
        {/* Where a hosted identity vendor returns the borrower. */}
        <Route path="identity/return" element={<IdentityReturnPage />} />
        <Route path="bank" element={<BankPage />} />
        <Route path="review" element={<ReviewShim />} />
        {/*
          The three branches. Reachable, routable, resumable — and absent from
          `SCREENS`, so they never appear in the step nav or the step count.
        */}
        <Route path="payroll" element={<PayrollPage />} />
        <Route path="irs" element={<IrsPage />} />
        <Route path="documents" element={<UploadPage />} />
        {/*
          Old paths. Screens 3–7 of the previous flow were bookmarkable and
          somebody has those links open; a 404 for "credit" would read as a
          lost file rather than a moved screen.
        */}
        <Route path="credit" element={<Navigate to="../identity" replace />} />
        <Route path="upload" element={<Navigate to="../documents" replace />} />
        <Route path="decision" element={<Navigate to="../review" replace />} />
        <Route path="consent" element={<Navigate to="../review" replace />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/**
 * Sends a bare /f/:id to wherever the file actually got to.
 *
 * A file that failed to load never reaches this: FileShell sends a file that
 * needs repair to screen 2 before rendering anything under it, and a file
 * that is not theirs to NotYours. What is left with no stage is a load that
 * failed for some other reason, and the file list is the honest place for it.
 *
 * A file whose application has ended or is held never reaches this either.
 * FileShell sends it to the review screen from wherever it was opened, which
 * includes this route.
 */
function ResumeToStage() {
  const { fileId } = useParams<{ fileId: string }>();
  const { data, isLoading } = useLoanFile(fileId);
  if (isLoading) return <p className="text-sm text-ink-faint">Finding your place…</p>;
  const stage = data?.file.stage;
  if (!stage) return <Navigate to="/" replace />;
  return <Navigate to={`/f/${fileId}/${STAGE_TO_SCREEN[stage]}`} replace />;
}

/**
 * The review screen needs the assessment to decide which branches to offer.
 * It is the only screen that does, which is why the query lives here rather
 * than in the shell — every other screen used to pay for a rail it now has no
 * use for.
 */
function ReviewShim() {
  const { fileId } = useParams<{ fileId: string }>();
  const assessment = useQuery({
    queryKey: ["assessment", fileId, "review"],
    queryFn: () => api.get<Assessment>(`/requirements/${fileId}/assessment`),
    enabled: Boolean(fileId),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
  return <ReviewPage assessment={assessment.data} />;
}

function FileShell() {
  const { fileId } = useParams<{ fileId: string }>();
  const location = useLocation();
  const last = location.pathname.split("/").pop() ?? "property";
  // Branch paths are not steps. While on one, the nav keeps showing the step
  // the borrower is actually inside — which is the review screen they came
  // from and will go back to.
  const screen = (screenIndex(last) === -1 ? "review" : last) as ScreenPath;

  const file = useLoanFile(fileId);
  const debug = debugEnabled(location.search);

  const assessment = useQuery({
    queryKey: ["assessment", fileId, "debug"],
    queryFn: () => api.get<Assessment>(`/requirements/${fileId}/assessment`),
    // Only fetched for the debug surface. The borrower flow does not need it.
    enabled: Boolean(fileId) && debug,
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });

  /*
   * The ledger with its causes — reason codes, requirement ids, principal ids.
   * Fetched only for `?debug=1`, because that is the only surface any of it may
   * appear on. The borrower's own timeline reads `applicationState`, which
   * carries none of it.
   */
  const ledger = useQuery({
    queryKey: ["ledger", fileId],
    queryFn: () => api.get<{ ledger: RawLedgerRow[] }>(`/files/${fileId}/ledger`),
    enabled: Boolean(fileId) && debug,
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });

  if (file.error instanceof ApiError && file.error.status === 404) {
    return <NotYours />;
  }

  /*
   * The repair path, from anywhere a file is loaded.
   *
   * When a required identity fact is unusable, GET /files/:id throws before
   * any screen has data. Screen 2 is the one screen that can fix that, and
   * it used to be reachable only after a connector on screen 3 failed — a
   * bare /f/:id fell through to the file list, and the file list's own link
   * went to the stage's screen, which rendered with nothing. Every route
   * under /f/:id passes through here, so this is where the redirect lives.
   * Screen 2 itself is exempt, or it could never render to do the repair.
   */
  if (needsRepair(file.error) && last !== REPAIR_SCREEN) {
    return <Navigate to={`/f/${fileId}/${REPAIR_SCREEN}`} replace />;
  }

  /*
   * A file that has ended, or is held, is not a file to do work on.
   *
   * It lives here rather than on the bare /f/:id route because nothing in the
   * product links there: the file list links straight at /f/:id/<screen>, so a
   * check that only guarded the index guarded the one door nobody uses, and a
   * withdrawn file still opened the bank screen. Every route under /f/:id
   * passes through here.
   */
  const landing = landingScreen(file.data?.applicationState, last);
  if (landing) return <Navigate to={`/f/${fileId}/${landing}`} replace />;

  return (
    <Shell
      screen={screen}
      fileId={fileId}
      reached={file.data?.file.stage}
      isDemo={file.data?.file.isDemo}
      debug={debug}
      assessment={assessment.data}
      assessmentFailed={Boolean(assessment.error)}
      file={file.data?.file}
      receipt={file.data ? (file.data.file.application ?? null) : undefined}
      // Undefined until the file has been read, null once it has been read and
      // there is none. "No application on record" is a claim about a regulated
      // record, and it cannot be made while the record is still loading.
      standing={file.data ? (file.data.applicationState ?? null) : undefined}
      standingInHeader={!screenOwnsStanding(last)}
      ledger={ledger.data?.ledger}
    />
  );
}

function NotYours() {
  return (
    <div className="flex min-h-screen flex-col bg-ground">
      <Header />
      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-16 sm:px-6">
        <h1 className="font-display text-2xl text-ink">We can&rsquo;t find that file</h1>
        <p className="mt-3 text-base text-ink-soft">
          It may belong to a different account, or it may have been deleted. Files are private to
          whoever started them, so a link to one will not open for anybody else.
        </p>
        {/* A Link, not an <a>, for the reason the header's home link gives:
            an anchor throws away the SPA and reloads the whole app. */}
        <Link to="/" className="super-btn super-btn-primary mt-6">
          Back to your files
        </Link>
      </main>
      <Footer />
    </div>
  );
}

function Chrome() {
  return (
    <div className="flex min-h-screen flex-col bg-ground">
      <Header />
      {/*
        flex-1 so a short page still pushes the footer to the bottom, and a
        flex column so a page can decide WHERE its slack goes — the front door
        gives it to the hero, which drops the street to just above the footer
        the way the prototype does.
      */}
      <main className="flex flex-1 flex-col">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

function Header({ children }: { children?: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  return (
    <header className="border-b border-rule-soft bg-ground/70 backdrop-blur">
      <div className="mx-auto max-w-2xl px-5 py-4 sm:px-6">
        <div className="flex items-center justify-between gap-4">
          {/* A Link, not an <a>: an anchor here threw away the SPA and
              reloaded the whole app, which the footer's home link never did. */}
          <Link to="/">
            <Lockup className="text-accent" />
          </Link>
          {user && (
            <div className="flex items-center gap-3 text-xs">
              <span className="hidden text-ink-muted sm:inline">{user.email}</span>
              {/*
                Land on `/` rather than staying put. Signing out from
                /f/:id/bank used to leave you on a private URL behind the
                sign-in wall; now that `/` is public there is somewhere
                sensible to go.
              */}
              <button
                className="super-link-quiet"
                onClick={() => void signOut().then(() => navigate("/"))}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
        {children && <div className="mt-4">{children}</div>}
      </div>
      <PersonaBanner />
    </header>
  );
}

/**
 * Who is signed in, when that is nobody real.
 *
 * In the header rather than on one page, because a sample borrower's session
 * is the same session everywhere and the sentence stops being true nowhere. A
 * tester who opened a persona's file from a link should not have to work out
 * why the buttons refuse them.
 *
 * The file screens carry their own "this is a sample file" line as well. They
 * are different claims — one is about the file, which is shared with everyone,
 * and this is about the session, which cannot change anything at all.
 */
function PersonaBanner() {
  const { user } = useAuth();
  if (!user?.persona) return null;
  return (
    <div className="border-t border-rule-soft bg-ground">
      <p className="mx-auto max-w-2xl px-5 py-2 text-xs text-ink-muted sm:px-6">
        {user.persona.name
          ? `You are signed in as ${user.persona.name}, a sample borrower. Nothing can be changed.`
          : "You are signed in as a sample borrower. Nothing can be changed."}
      </p>
    </div>
  );
}

/**
 * One card, centred, single column. No rail.
 *
 * `max-w-2xl` rather than the old `max-w-5xl`: that width existed to seat a
 * 20rem sidebar beside the content, and without it a form line grows past a
 * comfortable measure.
 */
function Shell({
  screen,
  fileId,
  reached,
  isDemo,
  debug,
  assessment,
  assessmentFailed,
  file,
  receipt,
  standing,
  standingInHeader = true,
  ledger,
}: {
  screen: ScreenPath;
  fileId?: string;
  reached?: import("./lib/flow.js").FlowStage;
  isDemo?: boolean;
  debug?: boolean;
  assessment?: Assessment;
  assessmentFailed?: boolean;
  file?: unknown;
  receipt?: ApplicationReceipt | null;
  standing?: ApplicationStandingView | null;
  /** False on the one screen that renders the standing itself — see `screenOwnsStanding`. */
  standingInHeader?: boolean;
  ledger?: RawLedgerRow[];
}) {
  return (
    <div className="flex min-h-screen flex-col bg-ground">
      <Header>
        {/*
          Four segments with one lit is a claim that there are steps left. On a
          file that has ended or is held there are none, and the line used to
          paint itself in the accent directly above a pill reading "Withdrawn".
          The shell has already sent such a file here to read where it stands,
          so what belongs above that is the standing and nothing else.
        */}
        {!hasStopped(standing) && <Stepper current={screen} fileId={fileId} reached={reached} />}
        {/*
          Where the file stands, on every screen that does not say it itself.
          It sits under the step nav because the two answer different questions
          — the nav says which screen you are on, this says what the
          application is doing — and a borrower who comes back a week later
          needs the second one first.

          Screen 1 has no file yet, so it has no standing to show. The review
          screen has one and renders it, once, above its own heading, where it
          can also override the line the state cannot get right; a second copy
          here said the un-overridden line 150px higher and contradicted it.
        */}
        {fileId && standingInHeader && (
          <div className="mt-3">
            <ApplicationStanding standing={standing} />
          </div>
        )}
      </Header>

      {isDemo && (
        <div className="border-b border-ok/30 bg-ok/10">
          <p className="mx-auto max-w-2xl px-5 py-2 text-xs text-ok sm:px-6">
            A sample borrower, shared with everyone and read-only.
          </p>
        </div>
      )}

      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-8 sm:px-6 sm:py-10">
        <Outlet />
        {debug && (
          <DebugPanel
            assessment={assessment}
            failed={assessmentFailed}
            file={file}
            ledger={ledger}
            receipt={receipt}
            standing={standing}
          />
        )}
      </main>
      <Footer />
    </div>
  );
}
