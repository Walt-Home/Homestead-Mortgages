import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config.js";
import { errorHandler } from "./middleware/error-handler.js";
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

app.use("/api/health", healthRouter);
app.use("/api/requirements", requirementRouter);
app.use("/api/files", fileRouter);
app.use("/api/files", connectorRouter);
app.use("/api/files", decisionRouter);

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`SuperMortgage API on :${config.port} (${config.nodeEnv})`);
  console.log(`Connector mode: ${config.connectorMode}`);
  if (config.connectorMode === "fixture") {
    console.log(`Fixture persona: ${config.fixturePersona}`);
  }
});
