import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config.js";
import { accessGate } from "./middleware/access-gate.js";
import { errorHandler } from "./middleware/error-handler.js";
import { serveSpa } from "./static.js";
import { healthRouter } from "./routes/health.js";
import { fileRouter } from "./routes/files.js";
import { connectorRouter } from "./routes/connectors.js";
import { requirementRouter } from "./routes/requirements.js";
import { decisionRouter } from "./routes/decision.js";

const app = express();

app.set("trust proxy", config.trustProxy);
app.use(helmet());
app.use(
  cors({
    origin: config.nodeEnv === "production" ? config.corsOrigins : true,
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));

// Everything below this line is behind the prototype passphrase, including the
// SPA itself — the gate is on the door, not on individual rooms.
app.use(accessGate(config.accessPassphrase));

app.use("/api/health", healthRouter);
app.use("/api/requirements", requirementRouter);
app.use("/api/files", fileRouter);
app.use("/api/files", connectorRouter);
app.use("/api/files", decisionRouter);

// Mounted after the API routes so it can claim every remaining path, and
// before the error handler so a 404 from it still renders properly.
const spaServed = serveSpa(app);

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`SuperMortgage API on :${config.port} (${config.nodeEnv})`);
  console.log(`Connector mode: ${config.connectorMode}`);
  if (config.connectorMode === "fixture") {
    console.log(`Fixture persona: ${config.fixturePersona}`);
  }
  console.log(`SPA: ${spaServed ? "served from apps/web/dist" : "not built (Vite serves it in dev)"}`);
  console.log(`Access gate: ${config.accessPassphrase ? "on" : "OFF"}`);
});
