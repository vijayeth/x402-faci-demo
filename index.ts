/* eslint-env node */
/**
 * x402 Facilitator Service
 *
 * A standalone service that verifies and settles x402 payments across multiple networks.
 * Developers integrate with this service using the x402-express middleware (or other clients).
 *
 * Production Deployment Requirements:
 * - Set NODE_ENV=production
 * - Provide EVM_PRIVATE_KEY for EVM chains (Ethereum, Base, Polygon, Avalanche, Filecoin)
 * - Optionally provide SVM_PRIVATE_KEY for Solana networks
 * - Ensure wallet has sufficient gas tokens on all supported networks
 * - Use dedicated RPC endpoints (not public RPCs) for reliability
 * - Set up HTTPS/TLS termination (use a reverse proxy like nginx)
 * - Configure CORS appropriately for your application domains
 *
 * Supported Testnets:
 * - Sepolia: USDC, JPYC (with FeeReceiver contract deployed)
 * - Filecoin Calibration: USDFC (with FeeReceiver contract deployed)
 *
 * For Mainnet deployment:
 * - Deploy FeeReceiver contracts to production networks first
 * - Update config.ts with FeeReceiver addresses
 * - Verify JPYC token addresses are correct
 */
import { config } from "dotenv";
import express, { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { verify, settle } from "@secured-finance/sf-x402/facilitator";
import {
  PaymentRequirementsSchema,
  type PaymentRequirements,
  type PaymentPayload,
  PaymentPayloadSchema,
  createConnectedClient,
  createSigner,
  SupportedEVMNetworks,
  SupportedSVMNetworks,
  Signer,
  ConnectedClient,
  SupportedPaymentKind,
  isSvmSignerWallet,
  type X402Config,
} from "@secured-finance/sf-x402/types";

config();

const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY || "";
const SVM_PRIVATE_KEY = process.env.SVM_PRIVATE_KEY || "";
const SVM_RPC_URL = process.env.SVM_RPC_URL || "";
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "";
const FILECOIN_CALIBRATION_RPC_URL = process.env.FILECOIN_CALIBRATION_RPC_URL || "";
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";

if (!EVM_PRIVATE_KEY && !SVM_PRIVATE_KEY) {
  console.error("Error: Missing required environment variables");
  console.error("At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY must be provided");
  process.exit(1);
}

const x402Config: X402Config | undefined =
  SVM_RPC_URL || SEPOLIA_RPC_URL || FILECOIN_CALIBRATION_RPC_URL
    ? {
        ...(SVM_RPC_URL && { svmConfig: { rpcUrl: SVM_RPC_URL } }),
        ...((SEPOLIA_RPC_URL || FILECOIN_CALIBRATION_RPC_URL) && {
          evmConfig: {
            rpcUrls: {
              ...(SEPOLIA_RPC_URL && { sepolia: SEPOLIA_RPC_URL }),
              ...(FILECOIN_CALIBRATION_RPC_URL && {
                "filecoin-calibration": FILECOIN_CALIBRATION_RPC_URL,
              }),
            },
          },
        }),
      }
    : undefined;

const app = express();

app.use(express.json());
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${duration}ms)`,
    );
  });
  next();
});

// Rate limiting: 100 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per IP
  message: { error: "Too many requests, please slow down" },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

app.use(limiter);

if (NODE_ENV === "development") {
  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    networks: {
      evm: !!EVM_PRIVATE_KEY,
      svm: !!SVM_PRIVATE_KEY,
    },
  });
});

app.get("/health/rpc", async (_req: Request, res: Response) => {
  const checks: Record<string, { healthy: boolean; latency?: number; error?: string }> = {};

  // Check EVM RPC endpoints if configured
  if (x402Config?.evmConfig?.rpcUrls && EVM_PRIVATE_KEY) {
    for (const [networkName, rpcUrl] of Object.entries(x402Config.evmConfig.rpcUrls)) {
      if (!rpcUrl) continue;
      const start = Date.now();
      try {
        const client = createConnectedClient(networkName, rpcUrl);
        // EVM client has getBlockNumber - safe to call
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const blockNumber = await (client as any).getBlockNumber();
        const latency = Date.now() - start;
        checks[networkName] = {
          healthy: blockNumber > 0,
          latency,
        };
      } catch (error) {
        checks[networkName] = {
          healthy: false,
          latency: Date.now() - start,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  }

  // Check SVM RPC if configured
  if (SVM_RPC_URL && SVM_PRIVATE_KEY) {
    const start = Date.now();
    try {
      const signer = await createSigner("solana-devnet", SVM_PRIVATE_KEY);
      if (isSvmSignerWallet(signer)) {
        // Simple check - if we can create signer, RPC is accessible
        checks["solana-devnet"] = {
          healthy: true,
          latency: Date.now() - start,
        };
      }
    } catch (error) {
      checks["solana-devnet"] = {
        healthy: false,
        latency: Date.now() - start,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  const allHealthy = Object.values(checks).every(check => check.healthy);
  const status = allHealthy ? "healthy" : "degraded";

  res.status(allHealthy ? 200 : 503).json({
    status,
    checks,
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "x402-facilitator",
    version: "1.0.0",
    endpoints: {
      health: "GET /health",
      healthRpc: "GET /health/rpc",
      verify: "POST /verify",
      settle: "POST /settle",
      supported: "GET /supported",
    },
  });
});

type VerifyRequest = {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
};

type SettleRequest = {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
};

app.get("/verify", (_req: Request, res: Response) => {
  res.json({
    endpoint: "/verify",
    method: "POST",
    description: "Verify payment authorization without executing on-chain",
  });
});

app.post("/verify", async (req: Request, res: Response) => {
  let network: string | undefined;
  try {
    const body: VerifyRequest = req.body;
    const paymentRequirements = PaymentRequirementsSchema.parse(body.paymentRequirements);
    const paymentPayload = PaymentPayloadSchema.parse(body.paymentPayload);
    network = paymentRequirements.network;

    let client: Signer | ConnectedClient;
    if (SupportedEVMNetworks.includes(paymentRequirements.network)) {
      if (!EVM_PRIVATE_KEY) {
        return res.status(503).json({ error: "EVM payments not supported" });
      }
      // Use custom RPC URL from config if available
      const rpcUrl = x402Config?.evmConfig?.rpcUrls?.[paymentRequirements.network];
      client = createConnectedClient(paymentRequirements.network, rpcUrl);
    } else if (SupportedSVMNetworks.includes(paymentRequirements.network)) {
      if (!SVM_PRIVATE_KEY) {
        return res.status(503).json({ error: "SVM payments not supported" });
      }
      client = await createSigner(paymentRequirements.network, SVM_PRIVATE_KEY);
    } else {
      return res.status(400).json({ error: `Unsupported network: ${paymentRequirements.network}` });
    }

    const result = await verify(client, paymentPayload, paymentRequirements, x402Config);
    res.json(result);
  } catch (error) {
    console.error("[VERIFY ERROR]", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      network: network || "unknown",
      rpcUrl: SEPOLIA_RPC_URL || FILECOIN_CALIBRATION_RPC_URL ? "custom" : "default",
      timestamp: new Date().toISOString(),
    });
    const errorMessage = error instanceof Error ? error.message : "Invalid request";
    res.status(400).json({ error: errorMessage });
  }
});

app.get("/settle", (_req: Request, res: Response) => {
  res.json({
    endpoint: "/settle",
    method: "POST",
    description: "Execute on-chain settlement of verified payment",
  });
});

app.get("/supported", async (_req: Request, res: Response) => {
  const kinds: SupportedPaymentKind[] = [];

  if (EVM_PRIVATE_KEY) {
    kinds.push(
      { x402Version: 1, scheme: "exact", network: "sepolia" },
      { x402Version: 1, scheme: "exact", network: "base-sepolia" },
      { x402Version: 1, scheme: "exact", network: "base" },
      { x402Version: 1, scheme: "exact", network: "mainnet" },
      { x402Version: 1, scheme: "exact", network: "polygon" },
      { x402Version: 1, scheme: "exact", network: "avalanche" },
      { x402Version: 1, scheme: "exact", network: "filecoin" },
      { x402Version: 1, scheme: "exact", network: "filecoin-calibration" },
    );
  }

  if (SVM_PRIVATE_KEY) {
    const signer = await createSigner("solana-devnet", SVM_PRIVATE_KEY);
    const feePayer = isSvmSignerWallet(signer) ? signer.address : undefined;

    kinds.push(
      {
        x402Version: 1,
        scheme: "exact",
        network: "solana-devnet",
        extra: { feePayer },
      },
      {
        x402Version: 1,
        scheme: "exact",
        network: "solana",
        extra: { feePayer },
      },
    );
  }

  res.json({ kinds });
});

app.post("/settle", async (req: Request, res: Response) => {
  let network: string | undefined;
  try {
    const body: SettleRequest = req.body;
    const paymentRequirements = PaymentRequirementsSchema.parse(body.paymentRequirements);
    const paymentPayload = PaymentPayloadSchema.parse(body.paymentPayload);
    network = paymentRequirements.network;

    let signer: Signer;
    if (SupportedEVMNetworks.includes(paymentRequirements.network)) {
      if (!EVM_PRIVATE_KEY) {
        return res.status(503).json({ error: "EVM payments not supported" });
      }
      // Use custom RPC URL from config if available
      const rpcUrl = x402Config?.evmConfig?.rpcUrls?.[paymentRequirements.network];
      signer = await createSigner(paymentRequirements.network, EVM_PRIVATE_KEY, rpcUrl);
    } else if (SupportedSVMNetworks.includes(paymentRequirements.network)) {
      if (!SVM_PRIVATE_KEY) {
        return res.status(503).json({ error: "SVM payments not supported" });
      }
      signer = await createSigner(paymentRequirements.network, SVM_PRIVATE_KEY);
    } else {
      return res.status(400).json({ error: `Unsupported network: ${paymentRequirements.network}` });
    }

    const response = await settle(signer, paymentPayload, paymentRequirements, x402Config);

    // LOG SETTLEMENT RESPONSE FOR DEBUGGING
    console.log("[SETTLE RESPONSE]", {
      success: response.success,
      transaction: response.transaction || "EMPTY/MISSING",
      errorReason: response.errorReason || "none",
      network: response.network,
      payer: response.payer || "unknown",
      timestamp: new Date().toISOString(),
    });

    res.json(response);
  } catch (error) {
    console.error("[SETTLE ERROR]", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      network: network || "unknown",
      rpcUrl: SEPOLIA_RPC_URL || FILECOIN_CALIBRATION_RPC_URL ? "custom" : "default",
      timestamp: new Date().toISOString(),
    });
    const errorMessage = error instanceof Error ? error.message : "Settlement failed";
    res.status(400).json({ error: errorMessage });
  }
});

app.listen(PORT, () => {
  console.log(`✅ x402 Facilitator Service`);
  console.log(`   URL: http://localhost:${PORT}`);
  console.log(`   Environment: ${NODE_ENV}`);
  console.log(
    `   Networks: ${EVM_PRIVATE_KEY ? "EVM" : ""}${EVM_PRIVATE_KEY && SVM_PRIVATE_KEY ? " + " : ""}${SVM_PRIVATE_KEY ? "Solana" : ""}`,
  );
  console.log(`\n   Ready to process payments on testnet and mainnet`);
});
