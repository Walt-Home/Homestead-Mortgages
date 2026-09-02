import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Stepper } from "./components/Stepper.js";
import { PrototypeBanner } from "./components/PrototypeBanner.js";
import { DebugPanel } from "./components/DebugPanel.js";
import { api, ApiError, type Assessment } from "./lib/api.js";
import { useAuth } from "./lib/auth.js";
import { useLoanFile } from "./lib/file.js";
import { STAGE_TO_SCREEN, debugEnabled, screenIndex, type ScreenPath } from "./lib/flow.js";
import { SignInPage } from "./pages/SignInPage.js";
import { PrivacyPage } from "./pages/PrivacyPage.js";
import { FilesPage } from "./pages/FilesPage.js";
import { PropertyLoanPage } from "./pages/PropertyLoanPage.js";
import { IdentityPage } from "./pages/IdentityPage.js";
import { IdentityReturnPage } from "./pages/IdentityReturnPage.js";
import { BankPage } from "./pages/BankPage.js";
import { ReviewPage } from "./pages/ReviewPage.js";
import { IrsPage, PayrollPage } from "./pages/ConnectPages.js";
import { UploadPage } from "./pages/UploadPage.js";

export function App() {
  const { status } = useAuth();

  // Render nothing rather than the sign-in page while the session is still
  // being resolved — a signed-in person should never see a sign-in flash.
  if (status === "loading") return <div className="min-h-screen bg-canvas" />;

  if (status === "signed-out") {
    return (
      <Routes>
        <Route path="/privacy" element={<Chrome />}>
          <Route index element={<PrivacyPage />} />
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
  if (isLoading) return <p className="text-[13px] text-subtle">Finding your place…</p>;
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
    <div className="min-h-screen bg-canvas">
      <PrototypeBanner />
      <Header />
      <div className="mx-auto max-w-2xl px-5 py-16 sm:px-6">
        <h1 className="font-brand text-[24px] font-semibold text-ink-editorial">
          We can&rsquo;t find that file
        </h1>
        <p className="mt-3 font-prose text-[16px] leading-relaxed text-ink-prose">
          It may belong to a different account, or it may have been deleted. Files are private to
          whoever started them, so a link to one will not open for anybody else.
        </p>
        <a href="/" className="btn-primary mt-6 inline-block">
          Back to your files
        </a>
      </div>
    </div>
  );
}

function Chrome() {
  return (
    <div className="min-h-screen bg-canvas">
      <PrototypeBanner />
      <Header />
      <Outlet />
    </div>
  );
}

function Header({ children }: { children?: React.ReactNode }) {
  const { user, signOut } = useAuth();
  return (
    <header className="border-b border-line-light bg-app/70 backdrop-blur">
      <div className="mx-auto max-w-2xl px-5 py-4 sm:px-6">
        <div className="flex items-center justify-between gap-4">
          <a href="/" className="font-brand text-[15px] font-bold tracking-tight text-gold">
            Homestead Mortgages
          </a>
          {user && (
            <div className="flex items-center gap-3 text-[12px]">
              <span className="hidden text-meta sm:inline">{user.email}</span>
              <button
                className="text-subtle underline-offset-2 hover:underline"
                onClick={() => void signOut()}
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
    <div className="min-h-screen bg-canvas">
      <PrototypeBanner />
      <Header>
        <Stepper current={screen} fileId={fileId} reached={reached} />
      </Header>

      {isDemo && (
        <div className="border-b border-olive-border bg-olive-light">
          <p className="mx-auto max-w-2xl px-5 py-2 text-[12px] text-olive sm:px-6">
            A sample borrower, shared with everyone and read-only.
          </p>
        </div>
      )}

      <main className="mx-auto max-w-2xl px-5 py-8 sm:px-6 sm:py-10">
        <Outlet />
        {debug && <DebugPanel assessment={assessment} failed={assessmentFailed} file={file} />}
      </main>
    </div>
  );
}
