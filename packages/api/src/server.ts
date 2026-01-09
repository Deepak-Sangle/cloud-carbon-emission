/*
 * © 2021 Thoughtworks, Inc.
 */

if (process.env.NODE_ENV === "production") {
  require("module-alias/register");
}

import cors, { CorsOptions } from "cors";
import express from "express";
import helmet from "helmet";

import { Logger } from "@cloud-carbon-footprint/common";
import { createRouter } from "./api";
import auth from "./utils/auth";
import swaggerDocs from "./utils/swagger";

const port = process.env.PORT || 4000;
const host = process.env.HOST || "127.0.0.1";
const httpApp = express();
const serverLogger = new Logger("Server");

if (process.env.NODE_ENV === "production") {
  httpApp.use(auth);
}

httpApp.use(helmet());
httpApp.use(express.json());

if (process.env.ENABLE_CORS) {
  const corsOptions: CorsOptions = {
    optionsSuccessStatus: 200,
  };

  if (process.env.CORS_ALLOW_ORIGIN) {
    serverLogger.info(
      "Allowing CORS requests from origin(s) " + process.env.CORS_ALLOW_ORIGIN
    );
    corsOptions.origin = process.env.CORS_ALLOW_ORIGIN.split(",");
  }

  httpApp.use(cors(corsOptions));
}

httpApp.use("/api", createRouter());

httpApp.listen(Number(port), host, () => {
  serverLogger.info(
    `Cloud Carbon Footprint Server listening at http://0.0.0.0:${port}`
  );
  swaggerDocs(httpApp, Number(port));
});

// Instructions for graceful shutdown
process.on("SIGINT", async () => {
  serverLogger.info("Cloud Carbon Footprint Server shutting down...");
  process.exit();
});
