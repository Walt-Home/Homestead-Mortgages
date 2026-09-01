import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Stepper, type ScreenPath } from "./components/Stepper.js";
import { RequirementRail } from "./components/RequirementRail.js";
import { api, type Assessment } from "./lib/api.js";
import { StartPage } from "./pages/StartPage.js";
import { PropertyLoanPage } from "./pages/PropertyLoanPage.js";
import { IdentityPage } from "./pages/IdentityPage.js";
import { BankPage, CreditPage, IrsPage, PayrollPage } from "./pages/ConnectPages.js";
import { UploadPage } from "./pages/UploadPage.js";
import { DecisionPage } from "./pages/DecisionPage.js";
import { ConsentPage } from "./pages/ConsentPage.js";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<StartPage />} />

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
 * The shell for a file that exists: stepper across the top, requirement rail
 * beside the form.
 *
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
      <header className="border-b border-line-light bg-app/70 backdrop-blur">
        <div className="mx-auto max-w-5xl px-6 py-4">
          <span className="font-brand text-[15px] font-bold tracking-tight text-gold">
            SuperMortgage
          </span>
          <div className="mt-3">
            <Stepper current={screen} />
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-10 lg:flex-row">
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
        {!hideRail && <RequirementRail assessment={assessment} />}
      </main>
    </div>
  );
}
