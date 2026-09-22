import { Navigate, Route, Routes, useParams } from "react-router-dom";
import type { ReactNode } from "react";
import { AuthProvider, roleWord, useAuth } from "./lib/auth.js";
import { QUEUE_KINDS, type QueueKind } from "./lib/home.js";
import { Shell } from "./components/Shell.js";
import { EmptyState } from "./components/ui.js";
import { Page } from "./components/Page.js";
import { SignInPage } from "./pages/SignInPage.js";
import { QueuePage } from "./pages/QueuePage.js";
import { WorkItemsPage } from "./pages/WorkItemsPage.js";
import { LoansPage } from "./pages/LoansPage.js";
import { LoanPage } from "./pages/LoanPage.js";
import { PeoplePage } from "./pages/PeoplePage.js";
import { PartnerBookPage } from "./pages/PartnerBookPage.js";
import { CompliancePage } from "./pages/CompliancePage.js";
import { ControlsPage } from "./pages/ControlsPage.js";
import { AiPage } from "./pages/AiPage.js";
import { StaffPage } from "./pages/StaffPage.js";
import { AccessReviewPage } from "./pages/AccessReviewPage.js";

const OPS = ["ops_analyst", "officer", "compliance"];
const STAFF = [...OPS, "admin"];

/** A page some roles open; the others are told which. */
function Guard({ roles, children }: { roles: readonly string[]; children: ReactNode }) {
  const { holds } = useAuth();
  if (holds(...roles)) return <>{children}</>;
  return (
    <Page title="Not yours to open">
      <EmptyState icon="key" title="This needs a role you don't hold">
        It opens for {roles.map(roleWord).join(", ")}. An admin can change your roles.
      </EmptyState>
    </Page>
  );
}

function KindRoute() {
  const { kind } = useParams();
  if (!kind || !(QUEUE_KINDS as readonly string[]).includes(kind))
    return <Navigate to="/" replace />;
  return (
    <Guard roles={OPS}>
      <QueuePage kind={kind as QueueKind} />
    </Guard>
  );
}

function Routed() {
  const { status } = useAuth();
  if (status === "loading") return <div className="min-h-screen bg-canvas" />;
  if (status === "signed-out") return <SignInPage />;
  return (
    <Shell>
      <Routes>
        <Route index element={<QueuePage />} />
        <Route path="/work/:kind" element={<KindRoute />} />
        <Route
          path="/work-items"
          element={
            <Guard roles={STAFF}>
              <WorkItemsPage />
            </Guard>
          }
        />
        <Route
          path="/loans"
          element={
            <Guard roles={OPS}>
              <LoansPage />
            </Guard>
          }
        />
        <Route
          path="/loans/:id"
          element={
            <Guard roles={OPS}>
              <LoanPage />
            </Guard>
          }
        />
        <Route
          path="/people"
          element={
            <Guard roles={OPS}>
              <PeoplePage />
            </Guard>
          }
        />
        <Route
          path="/partner-book"
          element={
            <Guard roles={OPS}>
              <PartnerBookPage />
            </Guard>
          }
        />
        <Route
          path="/oversight/compliance"
          element={
            <Guard roles={OPS}>
              <CompliancePage />
            </Guard>
          }
        />
        <Route
          path="/oversight/controls"
          element={
            <Guard roles={STAFF}>
              <ControlsPage />
            </Guard>
          }
        />
        <Route
          path="/oversight/ai"
          element={
            <Guard roles={OPS}>
              <AiPage />
            </Guard>
          }
        />
        <Route
          path="/staff"
          element={
            <Guard roles={["admin"]}>
              <StaffPage />
            </Guard>
          }
        />
        <Route
          path="/staff/access-review"
          element={
            <Guard roles={["compliance", "admin"]}>
              <AccessReviewPage />
            </Guard>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Routed />
    </AuthProvider>
  );
}
