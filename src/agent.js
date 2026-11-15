/**
 * Agent Games — Proof Gatekeeper Agent
 * 
 * Receives signed task envelopes, makes APPROVE/REJECT decisions,
 * generates Groth16 ZK proofs with snarkjs, and returns signed responses.
 */

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const snarkjs = require("snarkjs");

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "443", 10);
const HMAC_SECRET = process.env.AGENT_GAMES_HMAC_SECRET || "";
const CIRCUIT_DIR = path.join(__dirname, "..", "circuits");
const WASM_PATH = path.join(CIRCUIT_DIR, "gatekeeper.wasm");
const ZKEY_PATH = path.join(CIRCUIT_DIR, "gatekeeper_final.zkey");
const VK_PATH = path.join(CIRCUIT_DIR, "verification_key.json");
const DATA_DIR = path.join(__dirname, "..", "data");
const SEEN_FILE = path.join(DATA_DIR, "seen_proofs.json");
const DECISIONS_FILE = path.join(DATA_DIR, "decisions.json");
const LOG_FILE = path.join(DATA_DIR, "tasks.log");

const GATEKEEPER_VK_HASH = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";

// ─── Persistence ──────────────────────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")); }
  catch { return {}; }
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

function loadDecisions() {
  try { return JSON.parse(fs.readFileSync(DECISIONS_FILE, "utf8")); }
  catch { return {}; }
}

function saveDecisions(d) {
  fs.writeFileSync(DECISIONS_FILE, JSON.stringify(d, null, 2));
}

function logTask(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  fs.appendFileSync(LOG_FILE, line);
}

// ─── HMAC ─────────────────────────────────────────────────────────────────────
function signBody(body) {
  return crypto.createHmac("sha256", HMAC_SECRET).update(body).digest("hex");
}

function verifySignature(rawBody, signature) {
  if (!signature) return false;
  const expected = signBody(rawBody);
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ─── Circuit input encoding ───────────────────────────────────────────────────
// The gatekeeper circuit has 13 public signals (from dev.to research):
// 1: taskId, 2: minimum, 3: publicBalance, 4: expiryBlock, 5: currentBlock,
// 6: recipient, 7: conditionRecipient, 8: amount, 9: maxTransfer,
// 10: registeredVkHash, 11: proofVkHash, 12: salt (private), 13: decision
//
// Signal names are camelCase versions of envelope snake_case fields.
// salt is the ONLY private input.

function normalizeAddr(addr) {
  if (!addr) return "0";
  // Convert hex address to decimal string for circuit
  const hex = addr.toLowerCase().replace(/^0x/, "");
  if (/^[0-9a-f]+$/.test(hex) && hex.length > 0) {
    return BigInt("0x" + hex).toString();
  }
  return addr.toString();
}

function normalizeVkHash(hash) {
  if (!hash) return "0";
  const hex = hash.toLowerCase().replace(/^0x/, "");
  if (/^[0-9a-f]+$/.test(hex) && hex.length > 0) {
    return BigInt("0x" + hex).toString();
  }
  return hash.toString();
}

function normalizeBigInt(val) {
  if (val === null || val === undefined) return "0";
  const s = val.toString();
  // If it's a hex string
  if (s.startsWith("0x") || s.startsWith("0X")) {
    return BigInt(s).toString();
  }
  // If it's a plain number string
  if (/^\d+$/.test(s)) return s;
  // Try as hex without prefix
  if (/^[0-9a-fA-F]+$/.test(s)) {
    try { return BigInt("0x" + s).toString(); } catch { return s; }
  }
  return s;
}

function buildCircuitInput(task, decision) {
  const input = task.input || {};
  const taskId = task.task_id || "";
  
  // Convert taskId to a numeric value for the circuit
  // Use a hash of the task_id string to get a field element
  const taskIdHash = crypto.createHash("sha256").update(taskId).digest("hex");
  const taskIdNum = BigInt("0x" + taskIdHash.slice(0, 32)).toString(); // First 128 bits
  
  // Salt - random per-proof private input (in production should be deterministic per task for idempotency)
  // For idempotency, derive salt from task_id + HMAC secret
  const saltHash = crypto.createHmac("sha256", HMAC_SECRET || "fallback").update(taskId).digest("hex");
  const salt = BigInt("0x" + saltHash.slice(0, 32)).toString();
  
  const circuitInput = {
    taskId: taskIdNum,
    minimum: normalizeBigInt(input.minimum),
    publicBalance: normalizeBigInt(input.public_balance),
    expiryBlock: normalizeBigInt(input.expiry_block),
    currentBlock: normalizeBigInt(input.current_block),
    recipient: normalizeAddr(input.recipient),
    conditionRecipient: normalizeAddr(input.condition_recipient),
    amount: normalizeBigInt(input.amount),
    maxTransfer: normalizeBigInt(input.max_transfer),
    registeredVkHash: normalizeVkHash(input.registered_vk),
    proofVkHash: normalizeVkHash(input.proof_vk),
    salt: salt,
    decision: decision === "APPROVE" ? "1" : "0",
  };
  
  return circuitInput;
}

// ─── Decision logic ───────────────────────────────────────────────────────────
function makeDecision(task, seen) {
  const input = task.input || {};
  const taskId = task.task_id || "";
  const proofTx = input.proof_tx || "";
  
  // Check 1: VK substitution — proof_vk must match registered_vk
  const regVk = (input.registered_vk || "").toLowerCase();
  const proofVk = (input.proof_vk || "").toLowerCase();
  if (regVk !== proofVk) {
    return { decision: "REJECT", reason_code: "VK_SUBSTITUTION" };
  }
  
  // Check 2: Proof reused — proof_tx already seen
  if (proofTx && seen[proofTx]) {
    return { decision: "REJECT", reason_code: "PROOF_REUSED" };
  }
  
  // Check 3: Threshold mismatch — public_balance >= minimum
  try {
    if (BigInt(normalizeBigInt(input.public_balance)) < BigInt(normalizeBigInt(input.minimum))) {
      return { decision: "REJECT", reason_code: "THRESHOLD_MISMATCH" };
    }
  } catch {
    return { decision: "REJECT", reason_code: "THRESHOLD_MISMATCH" };
  }
  
  // Check 4: Expired condition — current_block <= expiry_block
  try {
    if (BigInt(normalizeBigInt(input.current_block)) > BigInt(normalizeBigInt(input.expiry_block))) {
      return { decision: "REJECT", reason_code: "EXPIRED" };
    }
  } catch {
    return { decision: "REJECT", reason_code: "EXPIRED" };
  }
  
  // Check 5: Recipient mismatch — recipient must match condition_recipient
  const recipient = (input.recipient || "").toLowerCase();
  const conditionRecipient = (input.condition_recipient || "").toLowerCase();
  if (recipient !== conditionRecipient) {
    return { decision: "REJECT", reason_code: "RECIPIENT_MISMATCH" };
  }
  
  // Check 6: Amount overflow — amount <= max_transfer
  try {
    if (BigInt(normalizeBigInt(input.amount)) > BigInt(normalizeBigInt(input.max_transfer))) {
      return { decision: "REJECT", reason_code: "AMOUNT_OVERFLOW" };
    }
  } catch {
    return { decision: "REJECT", reason_code: "AMOUNT_OVERFLOW" };
  }
  
  // All checks pass
  return { decision: "APPROVE", reason_code: "VALID_CONDITION" };
}

// ─── Proof generation ─────────────────────────────────────────────────────────
let vkCache = null;
function getVerificationKey() {
  if (vkCache) return vkCache;
  if (fs.existsSync(VK_PATH)) {
    vkCache = JSON.parse(fs.readFileSync(VK_PATH, "utf8"));
  }
  return vkCache;
}

async function generateProof(task, decision) {
  try {
    const circuitInput = buildCircuitInput(task, decision);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      circuitInput,
      WASM_PATH,
      ZKEY_PATH
    );
    
    // Verify locally
    const vk = getVerificationKey();
    if (vk) {
      const isValid = await snarkjs.groth16.verify(vk, publicSignals, proof);
      if (!isValid) {
        logTask({ event: "proof_verify_failed", task_id: task.task_id });
        return null;
      }
    }
    
    return { proof, publicSignals };
  } catch (err) {
    logTask({ event: "proof_error", task_id: task.task_id, error: err.message });
    return null;
  }
}

// ─── HTTP Handler ─────────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  // Health check
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    const body = JSON.stringify({ ok: true, ts: Date.now() });
    const sig = signBody(body);
    res.writeHead(200, {
      "content-type": "application/json",
      "x-agent-games-signature": sig,
    });
    res.end(body);
    return;
  }
  
  // Agent endpoint
  if (req.method === "POST" && (url.pathname === "/agent" || url.pathname === "/")) {
    // Collect raw body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    
    // Verify HMAC signature
    const sig = req.headers["x-agent-games-signature"];
    if (!HMAC_SECRET) {
      const body = JSON.stringify({ error: "secret_not_configured" });
      res.writeHead(500, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    if (!verifySignature(rawBody, sig)) {
      logTask({ event: "bad_signature", path: url.pathname });
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_signature" }));
      return;
    }
    
    // Parse task
    let task;
    try {
      task = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_json" }));
      return;
    }
    
    // Preflight check
    if (task.type === "agent-games.preflight.v1") {
      const body = JSON.stringify({ ok: true, protocolVersion: "v1" });
      const respSig = signBody(body);
      res.writeHead(200, {
        "content-type": "application/json",
        "x-agent-games-signature": respSig,
      });
      res.end(body);
      logTask({ event: "preflight_ok", agent_id: task.agent_id });
      return;
    }
    
    // Proof Gatekeeper task
    if (task.type === "agent-games.proof-gatekeeper.v1") {
      const taskId = task.task_id || "";
      const seen = loadSeen();
      const decisions = loadDecisions();
      
      // Idempotency: return cached decision if exists
      if (decisions[taskId]) {
        const cached = decisions[taskId];
        const body = JSON.stringify(cached.response);
        const respSig = signBody(body);
        res.writeHead(200, {
          "content-type": "application/json",
          "x-agent-games-signature": respSig,
        });
        res.end(body);
        logTask({ event: "cached_response", task_id: taskId });
        return;
      }
      
      // Make decision
      const { decision, reason_code } = makeDecision(task, seen);
      
      // Generate proof — skip for PROOF_REUSED (nothing new to prove per rules)
      // and skip if no HMAC secret (can't derive deterministic salt)
      let proofResult = null;
      if (reason_code !== "PROOF_REUSED") {
        proofResult = await generateProof(task, decision);
      }
      
      // Build response
      const response = {
        decision,
        reason_code,
        proof_tx: task.input?.proof_tx || "",
      };
      
      if (proofResult) {
        response.proof = proofResult.proof;
        response.public_signals = proofResult.publicSignals;
      }
      
      // Cache the response
      decisions[taskId] = { response, ts: Date.now() };
      saveDecisions(decisions);
      
      // Mark proof as seen
      const proofTx = task.input?.proof_tx || "";
      if (proofTx) {
        seen[proofTx] = { task_id: taskId, ts: Date.now() };
        saveSeen(seen);
      }
      
      // Send response
      const body = JSON.stringify(response);
      const respSig = signBody(body);
      res.writeHead(200, {
        "content-type": "application/json",
        "x-agent-games-signature": respSig,
      });
      res.end(body);
      
      logTask({
        event: "task_processed",
        task_id: taskId,
        decision,
        reason_code,
        has_proof: !!proofResult,
      });
      return;
    }
    
    // Unknown task type
    const body = JSON.stringify({ error: "unknown_task_type", type: task.type });
    const respSig = signBody(body);
    res.writeHead(200, {
      "content-type": "application/json",
      "x-agent-games-signature": respSig,
    });
    res.end(body);
    return;
  }
  
  // 404
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  ensureDataDir();
  
  if (!HMAC_SECRET) {
    console.error("WARNING: AGENT_GAMES_HMAC_SECRET not set — preflight will fail");
  }
  
  if (!fs.existsSync(WASM_PATH) || !fs.existsSync(ZKEY_PATH)) {
    console.error("ERROR: Circuit artifacts not found at", CIRCUIT_DIR);
    process.exit(1);
  }
  
  // Export VK if not present
  if (!fs.existsSync(VK_PATH)) {
    console.log("Exporting verification key...");
    const { execSync } = require("node:child_process");
    execSync(`node ${path.join(__dirname, "..", "node_modules", "snarkjs", "build", "cli.cjs")} zkey export verificationkey ${ZKEY_PATH} ${VK_PATH}`);
    console.log("VK exported.");
  }
  
  const server = http.createServer(handleRequest);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Agent Games Gatekeeper listening on :${PORT}`);
    console.log(`  HMAC secret: ${HMAC_SECRET ? "set" : "NOT SET"}`);
    console.log(`  Circuit: ${CIRCUIT_DIR}`);
  });
  
  // Graceful shutdown
  process.on("SIGTERM", () => { server.close(); process.exit(0); });
  process.on("SIGINT", () => { server.close(); process.exit(0); });
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
