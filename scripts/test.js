#!/usr/bin/env node
/**
 * Local test harness — tests the agent's decision logic and proof generation
 * against the sample task from the build page.
 */

const http = require("node:http");
const crypto = require("node:crypto");

const PORT = process.env.TEST_PORT || 8443;
const SECRET = process.env.AGENT_GAMES_HMAC_SECRET || "test-secret-32-bytes-0000000000";

function sign(body) {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

async function sendTask(task) {
  const rawBody = JSON.stringify(task);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: PORT,
      path: "/agent",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-games-signature": sign(rawBody),
        "content-length": Buffer.byteLength(rawBody),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode,
            signature: res.headers["x-agent-games-signature"],
            body: JSON.parse(Buffer.concat(chunks).toString()),
          });
        } catch (e) {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() });
        }
      });
    });
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

const sampleTask = {
  type: "agent-games.proof-gatekeeper.v1",
  task_id: "gk_test_001",
  mode: "competition",
  issued_at: new Date().toISOString(),
  deadline_at: new Date(Date.now() + 60000).toISOString(),
  input: {
    registered_vk: "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0",
    proof_vk: "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0",
    minimum: "1000",
    public_balance: "1460",
    expiry_block: 8430000,
    current_block: 8420000,
    recipient: "0xDe429f01De429f01De429f01De429f01De429f01",
    condition_recipient: "0xDe429f01De429f01De429f01De429f01De429f01",
    amount: "500",
    max_transfer: "1000",
    proof_tx: "0xa8c2e5f1a8c2e5f1a8c2e5f1a8c2e5f1a8c2e5f1a8c2e5f1a8c2e5f1c2",
  },
};

// Trap variants — each with UNIQUE proof_tx to avoid PROOF_REUSED
const mkTrap = (id, overrides) => ({
  ...sampleTask,
  task_id: id,
  input: { ...sampleTask.input, proof_tx: "0x" + id.padEnd(64, "0").slice(0, 64), ...overrides },
});

const traps = {
  vk_substitution: mkTrap("gk_trap_vk", { proof_vk: "0x13aa13aa13aa13aa13aa13aa13aa13aa13aa13aa13aa13aa13aa13aa13aa13aa" }),
  threshold_mismatch: mkTrap("gk_trap_thr", { public_balance: "900" }),
  expired: mkTrap("gk_trap_exp", { current_block: 8430001 }),
  recipient_mismatch: mkTrap("gk_trap_rec", { recipient: "0x9999f01De429f01De429f01De429f01De429f01" }),
  amount_overflow: mkTrap("gk_trap_amt", { amount: "1500" }),
  proof_reused: { ...sampleTask, task_id: "gk_trap_reuse" }, // same proof_tx as sampleTask
};

async function main() {
  console.log("Testing Agent Games Gatekeeper\n");
  
  // Test 1: Preflight
  console.log("1. Preflight...");
  const preflight = await sendTask({
    type: "agent-games.preflight.v1",
    agent_id: "agt_test",
    issued_at: new Date().toISOString(),
    nonce: "test123",
  });
  console.log("   Status:", preflight.status, "Body:", JSON.stringify(preflight.body));
  console.log("   Signature:", preflight.signature ? "present" : "MISSING");
  
  // Test 2: Valid task
  console.log("\n2. Valid task (should APPROVE)...");
  const valid = await sendTask(sampleTask);
  console.log("   Status:", valid.status, "Decision:", valid.body.decision, "Reason:", valid.body.reason_code);
  console.log("   Has proof:", !!valid.body.proof);
  console.log("   Has public_signals:", !!valid.body.public_signals);
  if (valid.body.proof) {
    console.log("   Proof keys:", Object.keys(valid.body.proof));
    console.log("   Public signals count:", valid.body.public_signals?.length);
  }
  
  // Test 3: VK substitution
  console.log("\n3. VK substitution (should REJECT)...");
  const vkTrap = await sendTask(traps.vk_substitution);
  console.log("   Decision:", vkTrap.body.decision, "Reason:", vkTrap.body.reason_code);
  
  // Test 4: Threshold mismatch
  console.log("\n4. Threshold mismatch (should REJECT)...");
  const thrTrap = await sendTask(traps.threshold_mismatch);
  console.log("   Decision:", thrTrap.body.decision, "Reason:", thrTrap.body.reason_code);
  
  // Test 5: Expired
  console.log("\n5. Expired (should REJECT)...");
  const expTrap = await sendTask(traps.expired);
  console.log("   Decision:", expTrap.body.decision, "Reason:", expTrap.body.reason_code);
  
  // Test 6: Recipient mismatch
  console.log("\n6. Recipient mismatch (should REJECT)...");
  const recTrap = await sendTask(traps.recipient_mismatch);
  console.log("   Decision:", recTrap.body.decision, "Reason:", recTrap.body.reason_code);
  
  // Test 7: Amount overflow
  console.log("\n7. Amount overflow (should REJECT)...");
  const amtTrap = await sendTask(traps.amount_overflow);
  console.log("   Decision:", amtTrap.body.decision, "Reason:", amtTrap.body.reason_code);
  
  // Test 8: Proof reused
  console.log("\n8. Proof reused (should REJECT)...");
  const reuseTrap = await sendTask(traps.proof_reused);
  console.log("   Decision:", reuseTrap.body.decision, "Reason:", reuseTrap.body.reason_code);
  
  // Test 9: Bad signature
  console.log("\n9. Bad signature (should 401)...");
  const badSig = await new Promise((resolve) => {
    const rawBody = JSON.stringify(sampleTask);
    const req = http.request({
      hostname: "127.0.0.1", port: PORT, path: "/agent", method: "POST",
      headers: { "content-type": "application/json", "x-agent-games-signature": "invalid", "content-length": Buffer.byteLength(rawBody) },
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.write(rawBody); req.end();
  });
  console.log("   Status:", badSig.status);
  
  console.log("\n=== All tests done ===");
}

main().catch(console.error);
