import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Stepper, type ScreenPath } from "./components/Stepper.js";
import { RequirementRail } from "./components/RequirementRail.js";
import { PrototypeBanner } from "./components/PrototypeBanner.js";
import { api, type Assessment } from "./lib/api.js";
import { useAuth } from "./lib/auth.js";
import { SignInPage } from "./pages/SignInPage.js";
import { PrivacyPage } from "./pages/PrivacyPage.js";
import { FilesPage } from "./pages/FilesPage.js";
import { PropertyLoanPage } from "./pages/PropertyLoanPage.js";
import { IdentityPage } from "./pages/IdentityPage.js";
import { BankPage, CreditPage, IrsPage, PayrollPage } from "./pages/ConnectPages.js";
import { UploadPage } from "./pages/UploadPage.js";
import { DecisionPage } from "./pages/DecisionPage.js";
import { ConsentPage } from "./pages/ConsentPage.js";

export function App() {
  const { status } = useAuth();

  // Render nothing rather than the sign-in page while the session is still
  // being resolved — a signed-in person should never see a sign-in flash.
  if (status === "loading") return <div className="min-h-screen bg-canvas" />;

  // The banner links here from the sign-in page too, so somebody deciding
  // whether to hand over their details can read what happens to them first.
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

      {/* Screen 1 runs before a file exists, so there is nothing to assess yet
          and no rail to show. Every later screen has both. */}
      <Route path="/f/new" element={<Shell screen="property" hideRail />}>
        <Route path="property" element={<PropertyLoanPage />} />
      </Route>

      <Route path="/f/:fileId" element={<FileShell />}>
        <Route path="identity" element={<IdentityPage />} />
        <Route path="credit" element={<CreditPage />} />
        <Route path="bank" element={<BankPage />} />
        <Route path="payroll" element={<PayrollPage />} />
        <Route path="irs" element={<IrsPage />} />
        <Route path="upload" element={<UploadPage />} />
        <Route path="decision" element={<DecisionPage />} />
        <Route path="consent" element={<ConsentPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/**
 * The rail is keyed on the current path as well as the file id, so moving
 * between screens refetches. A connector call in the previous step changes
 * what is outstanding in this one, and a cached rail would show satisfied work
 * as still needed — which reads as the product not noticing what you just did.
 */
function FileShell() {
  const { fileId } = useParams<{ fileId: string }>();
  const location = useLocation();
  const screen = (location.pathname.split("/").pop() ?? "identity") as ScreenPath;

  const { data } = useQuery({
    queryKey: ["assessment", fileId, screen],
    queryFn: () => api.get<Assessment>(`/requirements/${fileId}/assessment`),
    enabled: Boolean(fileId),
  });

  return <Shell screen={screen} assessment={data} />;
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
              <button className="text-subtle underline-offset-2 hover:underline" onClick={() => void signOut()}>
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
  assessment,
  hideRail = false,
}: {
  screen: ScreenPath;
  assessment?: Assessment;
  hideRail?: boolean;
}) {
  return (
    <div className="min-h-screen bg-canvas">
      <PrototypeBanner />
      <Header>
        <Stepper current={screen} />
      </Header>

      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-10 lg:flex-row">
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
        {!hideRail && <RequirementRail assessment={assessment} />}
      </main>
    </div>
  );
}
