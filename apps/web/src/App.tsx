import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Stepper, type ScreenPath } from "./components/Stepper.js";
import { RequirementRail } from "./components/RequirementRail.js";
import { PrototypeBanner } from "./components/PrototypeBanner.js";
import { api, ApiError, type Assessment } from "./lib/api.js";
import { useAuth } from "./lib/auth.js";
import { STAGE_TO_PATH, useLoanFile } from "./lib/file.js";
import { SignInPage } from "./pages/SignInPage.js";
import { PrivacyPage } from "./pages/PrivacyPage.js";
import { FilesPage } from "./pages/FilesPage.js";
import { PropertyLoanPage } from "./pages/PropertyLoanPage.js";
import { Step2IdentityCredit } from "./pages/Step2IdentityCredit.js";
import { Step3Bank } from "./pages/Step3Bank.js";
import { Step4Confirm } from "./pages/Step4Confirm.js";
import { PayrollPage } from "./pages/ConnectPages.js";
import { UploadPage } from "./pages/UploadPage.js";
import { DecisionPage } from "./pages/DecisionPage.js";
import { ConsentPage } from "./pages/ConsentPage.js";

export function App() {
  const { status } = useAuth();

  // Render nothing rather than the sign-in page while the session is still
  // being resolved — a signed-in person should never see a sign-in flash.
  if (status === "loading") return <div className="min-h-screen bg-canvas" />;

  if (status === "signed-out") {
    return (
      <Routes>
        {/* The banner links here from the sign-in page too, so somebody deciding
            whether to hand over their details can read what happens to them. */}
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

      {/* Screen 1 runs before a file exists, so there is nothing to assess yet
          and no rail to show. Every later screen has both. */}
      <Route path="/f/new" element={<Shell screen="property" hideRail />}>
        <Route path="property" element={<PropertyLoanPage />} />
      </Route>

      <Route path="/f/:fileId" element={<FileShell />}>
        {/* Bare /f/:id used to render an empty shell. It now resumes. */}
        <Route index element={<ResumeToStage />} />
        {/* Four steps. `payroll` and `documents` are forks off step 3, not
            steps of their own; `result` is the outcome, not a fifth step. */}
        <Route path="property" element={<PropertyLoanPage />} />
        <Route path="identity" element={<Step2IdentityCredit />} />
        <Route path="bank" element={<Step3Bank />} />
        <Route path="confirm" element={<Step4Confirm />} />
        <Route path="result" element={<DecisionPage />} />
        <Route path="payroll" element={<PayrollPage />} />
        <Route path="documents" element={<UploadPage />} />
        <Route path="consent" element={<ConsentPage />} />
        {/* Links minted by the nine-screen flow still resolve. */}
        <Route path="credit" element={<Navigate to="../identity" replace />} />
        <Route path="irs" element={<Navigate to="../bank" replace />} />
        <Route path="upload" element={<Navigate to="../documents" replace />} />
        <Route path="decision" element={<Navigate to="../result" replace />} />
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
  return <Navigate to={`/f/${fileId}/${STAGE_TO_PATH[stage]}`} replace />;
}

/**
 * The shell for a file that exists.
 *
 * The rail is keyed on the path as well as the file, so moving between screens
 * refetches — a connector call on the previous screen changes what is
 * outstanding on this one, and a cached rail reads as the product not noticing
 * what you just did.
 */
function FileShell() {
  const { fileId } = useParams<{ fileId: string }>();
  const location = useLocation();
  const screen = (location.pathname.split("/").pop() ?? "identity") as ScreenPath;

  const file = useLoanFile(fileId);
  const assessment = useQuery({
    queryKey: ["assessment", fileId, screen],
    queryFn: () => api.get<Assessment>(`/requirements/${fileId}/assessment`),
    enabled: Boolean(fileId),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });

  // A 404 on the file means it is not this account's, which is exactly what a
  // shared link produces. Saying so beats a blank screen and a console error.
  if (file.error instanceof ApiError && file.error.status === 404) {
    return <NotYours />;
  }

  return (
    <Shell
      screen={screen}
      fileId={fileId}
      reached={file.data?.file.stage}
      assessment={assessment.data}
      assessmentFailed={Boolean(assessment.error)}
      isDemo={file.data?.file.isDemo}
    />
  );
}

function NotYours() {
  return (
    <div className="min-h-screen bg-canvas">
      <PrototypeBanner />
      <Header />
      <div className="mx-auto max-w-2xl px-6 py-16">
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

/** Header and banner without the flow chrome, for pages outside a file. */
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
      <div className="mx-auto max-w-5xl px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <a href="/" className="font-brand text-[15px] font-bold tracking-tight text-gold">
            Homestead Mortgages
          </a>
          {user && (
            <div className="flex items-center gap-3 text-[12px]">
              <span className="text-meta">{user.email}</span>
              <button
                className="text-subtle underline-offset-2 hover:underline"
                onClick={() => void signOut()}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
        {children && <div className="mt-3">{children}</div>}
      </div>
    </header>
  );
}

function Shell({
  screen,
  fileId,
  reached,
  assessment,
  assessmentFailed,
  isDemo,
  hideRail = false,
}: {
  screen: ScreenPath;
  fileId?: string;
  reached?: import("./lib/file.js").FlowStage;
  assessment?: Assessment;
  assessmentFailed?: boolean;
  isDemo?: boolean;
  hideRail?: boolean;
}) {
  return (
    <div className="min-h-screen bg-canvas">
      <PrototypeBanner />
      <Header>
        <Stepper current={screen} fileId={fileId} reached={reached} />
      </Header>

      {isDemo && (
        <div className="border-b border-olive-border bg-olive-light">
          <p className="mx-auto max-w-5xl px-6 py-2 text-[12px] text-olive">
            A sample borrower, shared with everyone and read-only. Start your own file to walk
            through the flow.
          </p>
        </div>
      )}

      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-10 lg:flex-row">
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
        {!hideRail && <RequirementRail assessment={assessment} failed={assessmentFailed} />}
      </main>
    </div>
  );
}
