import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config.js";
import { errorHandler } from "./middleware/error-handler.js";
import { requireAuth } from "./middleware/require-auth.js";
import { personaReadOnly } from "./middleware/persona-read-only.js";
import { sessionMiddleware } from "./middleware/session.js";
import { assertAuthConfigured } from "./services/auth.js";
import { serveSpa } from "./static.js";
import { providerMix } from "./services/connectors.js";
import { authRouter } from "./routes/auth.js";
import { healthRouter } from "./routes/health.js";
import { fileRouter } from "./routes/files.js";
import { connectorRouter } from "./routes/connectors.js";
import { propertyRouter, propertyFileRouter } from "./routes/property.js";
import { requirementRouter } from "./routes/requirements.js";
import { decisionRouter } from "./routes/decision.js";
import { esignRouter } from "./routes/esign.js";
import { documentRouter } from "./routes/documents.js";
import { applicationRouter } from "./routes/application.js";
import { vestingRouter } from "./routes/vesting.js";
import { declarationRouter } from "./routes/declarations.js";
import { partnerRouter } from "./routes/partner.js";
import { securityHeaders } from "./security-policy.js";

const app = express();

app.set("trust proxy", config.trustProxy);
app.use(helmet(securityHeaders(config.plaid.environment)));
app.use(
  cors({
    origin: config.nodeEnv === "production" ? config.corsOrigins : true,
    credentials: true,
  }),
);
// A partner is a key, not a sign-in. Mounted ABOVE the session gate because
// the gate would refuse it — a servicer's integration has no session and no
// second factor — and carrying its own gate, so a key opens this prefix and
// nothing below. Above the body parser and the session too: a tape is
// megabytes where a person's screen is kilobytes, so the router parses its own
// body, and a machine's request never mints a cookie.
// `partner-credential.test.ts` reads this file to hold the order.
app.use("/api/partner", partnerRouter);

app.use(express.json({ limit: "1mb" }));
app.use(sessionMiddleware());

// Open: health for infrastructure probes, auth for getting in at all.
app.use("/api/health", healthRouter);
app.use("/api/auth", authRouter);

// Everything past this point requires a signed-in user. Mounted as one gate
// rather than per-router, so a new router cannot be added without it.
app.use("/api", requireAuth);

// And a sample borrower may only look. On the line after the gate rather than
// inside it, because the two refusals answer different questions — "who are
// you" and "may you change this" — and every router below is mounted after
// both, so a new one cannot be added without either.
app.use("/api", personaReadOnly);

app.use("/api/requirements", requirementRouter);
app.use("/api/property", propertyRouter);
app.use("/api/files", fileRouter);
app.use("/api/files", connectorRouter);
app.use("/api/files", decisionRouter);
app.use("/api/files", esignRouter);
app.use("/api/files", documentRouter);
app.use("/api/files", applicationRouter);
app.use("/api/files", declarationRouter);
app.use("/api/files", vestingRouter);
app.use("/api/files", propertyFileRouter);

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
  for (const [name, provider] of Object.entries(providerMix())) {
    console.log(`  ${name.padEnd(14)} ${provider}`);
  }
  if (config.connectorMode === "fixture") {
    console.log(`Fixture persona: ${config.fixturePersona}`);
  }
  console.log(
    `SPA: ${spaServed ? "served from apps/web/dist" : "not built (Vite serves it in dev)"}`,
  );
  if (config.demoPersonasEnabled) {
    console.log("DEMO_PERSONAS is on: sample-borrower sign-in is mounted");
  }
  console.log(
    `Auth: Google sign-in${config.googleClientId ? "" : " (NOT CONFIGURED — developer sign-in only)"}` +
      `${config.allowedDomain ? `, limited to ${config.allowedDomain}` : ""}`,
  );
});
