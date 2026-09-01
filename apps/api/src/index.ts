import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config.js";
import { errorHandler } from "./middleware/error-handler.js";
import { requireAuth } from "./middleware/require-auth.js";
import { sessionMiddleware } from "./middleware/session.js";
import { assertAuthConfigured } from "./services/auth.js";
import { serveSpa } from "./static.js";
import { authRouter } from "./routes/auth.js";
import { healthRouter } from "./routes/health.js";
import { fileRouter } from "./routes/files.js";
import { connectorRouter } from "./routes/connectors.js";
import { requirementRouter } from "./routes/requirements.js";
import { decisionRouter } from "./routes/decision.js";
import { esignRouter } from "./routes/esign.js";
import { documentRouter } from "./routes/documents.js";

const app = express();

app.set("trust proxy", config.trustProxy);
// Two of helmet's defaults break Google Identity Services, and both fail
// silently — which is the expensive part.
//
// 1. CSP `script-src 'self'` blocks the GIS script, so the button never
//    renders. Visible enough to catch.
//
// 2. `Cross-Origin-Opener-Policy: same-origin` severs `window.opener` for the
//    popup GIS opens. The popup loads, tries to post the credential back to
//    us, and cannot — so it sits there blank forever with no error in either
//    window. It looks exactly like an unregistered OAuth origin, and it cost a
//    round of chasing the wrong thing. `same-origin-allow-popups` keeps the
//    isolation that matters (other sites still cannot get a handle on our
//    window) while letting our own popups talk back.
app.use(
  helmet({
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'", "https://accounts.google.com/gsi/client"],
        // Whole origin rather than the /gsi/ path prefix: GIS moves between
        // several paths on accounts.google.com and a path-scoped source is a
        // subtle breakage waiting for the next SDK change.
        "connect-src": ["'self'", "https://accounts.google.com"],
        "frame-src": ["'self'", "https://accounts.google.com"],
        // Google serves the avatar from the ID token here.
        "img-src": ["'self'", "data:", "https://lh3.googleusercontent.com"],
      },
    },
  }),
);
app.use(
  cors({
    origin: config.nodeEnv === "production" ? config.corsOrigins : true,
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(sessionMiddleware());

// Open: health for infrastructure probes, auth for getting in at all.
app.use("/api/health", healthRouter);
app.use("/api/auth", authRouter);

// Everything past this point requires a signed-in user. Mounted as one gate
// rather than per-router, so a new router cannot be added without it.
app.use("/api", requireAuth);

app.use("/api/requirements", requirementRouter);
app.use("/api/files", fileRouter);
app.use("/api/files", connectorRouter);
app.use("/api/files", decisionRouter);
app.use("/api/files", esignRouter);
app.use("/api/files", documentRouter);

// An unmatched /api path fell through to the SPA fallback and returned HTML,
// which the client then tried to parse as JSON — turning "no such endpoint"
// into an unreadable parse error. API 404s must look like API responses.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: { message: "No such endpoint.", code: "NOT_FOUND" } });
});

// Mounted after the API routes so it can claim every remaining path, and
// before the error handler so a 404 from it still renders properly.
const spaServed = serveSpa(app);

app.use(errorHandler);

// Refuse to start rather than serve a sign-in page that can never succeed.
assertAuthConfigured();

app.listen(config.port, () => {
  console.log(`Homestead Mortgages API on :${config.port} (${config.nodeEnv})`);
  console.log(`Connector mode: ${config.connectorMode}`);
  if (config.connectorMode === "fixture") {
    console.log(`Fixture persona: ${config.fixturePersona}`);
  }
  console.log(`SPA: ${spaServed ? "served from apps/web/dist" : "not built (Vite serves it in dev)"}`);
  console.log(
    `Auth: Google sign-in${config.googleClientId ? "" : " (NOT CONFIGURED — developer sign-in only)"}` +
      `${config.allowedDomain ? `, limited to ${config.allowedDomain}` : ""}`,
  );
});
