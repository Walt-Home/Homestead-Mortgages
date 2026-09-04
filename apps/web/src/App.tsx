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
import { Stepper } from "./components/Stepper.js";
import { DebugPanel } from "./components/DebugPanel.js";
import { Lockup } from "./components/Wordmark.js";
import { Footer } from "./components/Footer.js";
import { api, ApiError, type Assessment } from "./lib/api.js";
import { useAuth } from "./lib/auth.js";
import { StatesGalleryPage } from "./pages/StatesGalleryPage.js";
import { useLoanFile } from "./lib/file.js";
import { STAGE_TO_SCREEN, debugEnabled, screenIndex, type ScreenPath } from "./lib/flow.js";
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

/** Sends a bare /f/:id to wherever the file actually got to. */
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

  if (file.error instanceof ApiError && file.error.status === 404) {
    return <NotYours />;
  }

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
        <a href="/" className="super-btn super-btn-primary mt-6">
          Back to your files
        </a>
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
    </header>
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
}: {
  screen: ScreenPath;
  fileId?: string;
  reached?: import("./lib/flow.js").FlowStage;
  isDemo?: boolean;
  debug?: boolean;
  assessment?: Assessment;
  assessmentFailed?: boolean;
  file?: unknown;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-ground">
      <Header>
        <Stepper current={screen} fileId={fileId} reached={reached} />
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
        {debug && <DebugPanel assessment={assessment} failed={assessmentFailed} file={file} />}
      </main>
      <Footer />
    </div>
  );
}
