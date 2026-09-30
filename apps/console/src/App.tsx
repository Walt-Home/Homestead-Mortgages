import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth.js";
import { QUEUE_KINDS, type QueueKind } from "./lib/home.js";
import { Shell } from "./components/Shell.js";
import { Loading } from "./components/Loading.js";
import { EntryPage } from "./pages/EntryPage.js";
import { PortalAuthProvider, usePortalAuth } from "./partners/auth.js";
import { PortalShell } from "./partners/Shell.js";
import { AcceptPage } from "./partners/pages/AcceptPage.js";
import { BookPage } from "./partners/pages/BookPage.js";
import { PortalLoanPage } from "./partners/pages/LoanPage.js";
import { PortalBillingPage, PortalInvoicePage } from "./partners/pages/BillingPage.js";
import { TeamPage } from "./partners/pages/TeamPage.js";
import { QueuePage } from "./pages/QueuePage.js";
import { WorkItemsPage } from "./pages/WorkItemsPage.js";
import { LoansPage } from "./pages/LoansPage.js";
import { LoanPage } from "./pages/LoanPage.js";
import { PeoplePage } from "./pages/PeoplePage.js";
import { PartnerBookPage } from "./pages/PartnerBookPage.js";
import { ServicerPage, ServicersPage } from "./pages/ServicersPage.js";
import { BillingPage, BillingServicerPage } from "./pages/BillingPage.js";
import { CompliancePage } from "./pages/CompliancePage.js";
import { ControlsPage } from "./pages/ControlsPage.js";
import { AiPage } from "./pages/AiPage.js";
import { StaffPage } from "./pages/StaffPage.js";
import { AccessReviewPage } from "./pages/AccessReviewPage.js";
import { TapePage } from "./pages/TapePage.js";

function KindRoute() {
  const { kind } = useParams();
  if (!kind || !(QUEUE_KINDS as readonly string[]).includes(kind))
    return <Navigate to="/" replace />;
  return <QueuePage kind={kind as QueueKind} />;
}

/**
 * One hostname, one sign-in, two products. The entry page takes an e-mail
 * and sends it to the staff door or the servicer door by its domain; which
 * session comes back decides what renders — the ops console for staff, the
 * partner portal (`/portal`) for a servicer's team. An invitation link
 * (`/accept`) needs no session at all.
 *
 * One browser, one of the two. A servicer's session always renders the
 * portal and never the ops console, whatever else the browser holds: the
 * two cookies are separate, so somebody on our staff who takes a
 * servicer's invitation in the browser they work in holds both, and the
 * console used to show them ops under the member's name. Now the member's
 * session wins, and the staff session it was found beside is signed out —
 * so signing out of the portal lands on the sign-in page, not in the ops
 * console. Nothing about access rides on this: the servicing app's API
 * answers its own cookie and no other, and a member's cookie is not it.
 *
 * The console has one role. Every page opens for every admin, and the
 * servicing app's own API is the gate on what each call may do; a page it
 * refuses says so in place.
 */
function Routed() {
  const { status, stepAside } = useAuth();
  const portal = usePortalAuth();
  const { pathname } = useLocation();
  const both = status === "signed-in" && portal.status === "signed-in";
  useEffect(() => {
    if (both) void stepAside().catch(() => undefined);
  }, [both, stepAside]);
  // The door is shared, so nothing says "Ops" until a staff session says so.
  const servicerName = portal.status === "signed-in" ? portal.me?.servicer.displayName : null;
  useEffect(() => {
    document.title = servicerName
      ? `${servicerName} · Supermortgage`
      : status === "signed-in"
        ? "Supermortgage Ops"
        : "Supermortgage";
  }, [servicerName, status]);
  if (pathname === "/accept") return <AcceptPage />;
  if (status === "loading" || portal.status === "loading") return <Loading />;
  if (portal.status === "signed-in") {
    return (
      <PortalShell>
        <Routes>
          <Route path="/portal" element={<BookPage />} />
          <Route path="/portal/loans/:id" element={<PortalLoanPage />} />
          <Route path="/portal/billing" element={<PortalBillingPage />} />
          <Route path="/portal/billing/:month" element={<PortalInvoicePage />} />
          <Route path="/portal/team" element={<TeamPage />} />
          <Route path="*" element={<Navigate to="/portal" replace />} />
        </Routes>
      </PortalShell>
    );
  }
  if (status === "signed-out") return <EntryPage />;
  // The tape desk is its own experience: one job, no navigation around it.
  if (pathname === "/tape" || pathname.startsWith("/tape/")) return <TapePage />;
  return (
    <Shell>
      <Routes>
        <Route index element={<QueuePage />} />
        <Route path="/work/:kind" element={<KindRoute />} />
        <Route path="/work-items" element={<WorkItemsPage />} />
        <Route path="/loans" element={<LoansPage />} />
        <Route path="/loans/:id" element={<LoanPage />} />
        <Route path="/people" element={<PeoplePage />} />
        <Route path="/partner-book" element={<PartnerBookPage />} />
        <Route path="/servicers" element={<ServicersPage />} />
        <Route path="/servicers/:slug" element={<ServicerPage />} />
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/billing/:slug" element={<BillingServicerPage />} />
        <Route path="/oversight/compliance" element={<CompliancePage />} />
        <Route path="/oversight/controls" element={<ControlsPage />} />
        <Route path="/oversight/ai" element={<AiPage />} />
        <Route path="/staff" element={<StaffPage />} />
        <Route path="/staff/access-review" element={<AccessReviewPage />} />
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
