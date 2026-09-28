import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import type { ReactNode } from "react";
import { AuthProvider, roleWord, useAuth } from "./lib/auth.js";
import { QUEUE_KINDS, type QueueKind } from "./lib/home.js";
import { Shell } from "./components/Shell.js";
import { Loading } from "./components/Loading.js";
import { EmptyState } from "./components/ui.js";
import { Page } from "./components/Page.js";
import { EntryPage } from "./pages/EntryPage.js";
import { PortalAuthProvider, usePortalAuth } from "./partners/auth.js";
import { PortalShell } from "./partners/Shell.js";
import { AcceptPage } from "./partners/pages/AcceptPage.js";
import { BookPage } from "./partners/pages/BookPage.js";
import { TeamPage } from "./partners/pages/TeamPage.js";
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
import { TapePage } from "./pages/TapePage.js";

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

/**
 * One hostname, one sign-in, two products. The entry page takes an e-mail
 * and sends it to the staff door or the servicer door by its domain; which
 * session comes back decides what renders — the ops console for staff, the
 * partner portal (`/portal`) for a servicer's team. An invitation link
 * (`/accept`) needs no session at all.
 */
function Routed() {
  const { status } = useAuth();
  const portal = usePortalAuth();
  const { pathname } = useLocation();
  if (pathname === "/accept") return <AcceptPage />;
  if (status === "loading" || portal.status === "loading") return <Loading />;
  if (status !== "signed-in" && portal.status === "signed-in") {
    return (
      <PortalShell>
        <Routes>
          <Route path="/portal" element={<BookPage />} />
          <Route path="/portal/team" element={<TeamPage />} />
          <Route path="*" element={<Navigate to="/portal" replace />} />
        </Routes>
      </PortalShell>
    );
  }
  if (status === "signed-out") return <EntryPage />;
  // The tape desk is its own experience: one job, no navigation around it.
  if (pathname === "/tape" || pathname.startsWith("/tape/")) {
    return (
      <Guard roles={OPS}>
        <TapePage />
      </Guard>
    );
  }
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
      <PortalAuthProvider>
        <Routed />
      </PortalAuthProvider>
    </AuthProvider>
  );
}
