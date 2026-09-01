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

const app = express();

app.set("trust proxy", config.trustProxy);
// Helmet's default CSP is `script-src 'self'`, which blocks Google Identity
// Services outright — the sign-in button silently never renders. These four
// directives are the minimum GIS needs, and they name Google explicitly rather
// than widening to a wildcard.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'", "https://accounts.google.com/gsi/client"],
        "connect-src": ["'self'", "https://accounts.google.com/gsi/"],
        "frame-src": ["'self'", "https://accounts.google.com/gsi/"],
        // Google serves the avatar returned in the ID token from these hosts.
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
