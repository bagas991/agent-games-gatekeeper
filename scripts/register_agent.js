/**
 * Register agent endpoint on Agent Games platform.
 * Calls addAgentAction, then updateAgentEndpoint, rotateAgentSecret, preflightAgent.
 */
const fs = require("fs");
const https = require("https");

const BASE = "https://agentgames.zkverify.io";

// Server action IDs (build-specific — may need updating)
const ACTIONS = {
  addAgent: "40c0b4417aec010d0bf2b44ca09f82600c7fcc16e3",
  rotateSecret: "407e358d85759a71ee796bd1ab6c321084ecb67541",
  updateEndpoint: "60c75d7e395e2964d77535ba3c5198598c9d94ff8c",
  preflight: "4050d1fe4e6f18ef97b211ad2c92b1836a95e18a80",
  updateEvents: "6078313ae3c1a930d481334814c4f2ea24d3d21d89",
};

let cookieJar = {};

function fetchRaw(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const cookieStr = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join("; ");
    const headers = { ...opts.headers, cookie: cookieStr };

    const req = https.request(url, {
      method: opts.method || "GET",
      headers,
    }, (res) => {
      const setCookies = res.headers["set-cookie"];
      if (setCookies) {
        for (const c of setCookies) {
          const [nameVal] = c.split(";");
          const [name, ...valParts] = nameVal.split("=");
          cookieJar[name.trim()] = valParts.join("=").trim();
        }
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() });
      });
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function callAction(actionId, args, page = "/dashboard/agents") {
  const body = "0:" + JSON.stringify([args]);
  const res = await fetchRaw(page, {
    method: "POST",
    headers: {
      "content-type": "text/plain;charset=UTF-8",
      "next-action": actionId,
      "accept": "text/x-component",
      "rsc": "1",
      "next-router-state-tree": "%5B%22%22%5D",
    },
    body,
  });
  return res;
}

function parseRSCResponse(body) {
  // RSC responses are in format: 0:{...}\n1:{...}\n
  // Extract the JSON values
  const lines = body.split("\n");
  for (const line of lines) {
    const match = line.match(/^\d+:(.*)$/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {}
    }
  }
  return null;
}

async function main() {
  // Load session
  const sess = JSON.parse(fs.readFileSync("/root/agent-games/session.json", "utf8"));
  cookieJar = sess.cookies;

  const ENDPOINT = "https://largest-descriptions-supplies-travels.trycloudflare.com/agent";

  // Verify session
  console.log("1. Verifying session...");
  const sessRes = await fetchRaw("/api/auth/session");
  const sessData = JSON.parse(sessRes.body);
  if (!sessData.user?.registrationComplete) {
    console.error("   Registration not complete!", sessRes.body);
    process.exit(1);
  }
  console.log("   OK — user:", sessData.user.walletAddress);

  // Add agent
  console.log("\n2. Adding agent...");
  const agentData = {
    name: "Bagas Gatekeeper",
    events: ["Proof Gatekeeper"],
    repoUrl: "",
    endpoint: ENDPOINT,
  };
  const addRes = await callAction(ACTIONS.addAgent, agentData);
  console.log("   Status:", addRes.status);
  console.log("   Body:", addRes.body.slice(0, 500));
  
  const addResult = parseRSCResponse(addRes.body);
  if (addResult && addResult.ok) {
    console.log("   ✅ Agent added!");
    console.log("   Agent ID:", addResult.agentId);
    console.log("   Name:", addResult.name);
    console.log("   Secret:", addResult.secret ? addResult.secret.slice(0, 20) + "..." : "none");
    
    // Save agent info
    fs.writeFileSync("/root/agent-games/agent_info.json", JSON.stringify({
      agentId: addResult.agentId,
      name: addResult.name,
      secret: addResult.secret,
      endpoint: ENDPOINT,
    }, null, 2));
    
    // The secret returned is the HMAC secret
    if (addResult.secret) {
      console.log("\n3. HMAC secret received!");
      console.log("   Secret:", addResult.secret);
      console.log("\n   Set this as AGENT_GAMES_HMAC_SECRET in the agent environment.");
    }
  } else {
    console.log("   ❌ Failed:", addResult);
    
    // If agent already exists, try rotate secret
    console.log("\n3. Trying rotate secret...");
    const rotRes = await callAction(ACTIONS.rotateSecret, {});
    console.log("   Status:", rotRes.status);
    console.log("   Body:", rotRes.body.slice(0, 500));
  }

  // Save updated session
  fs.writeFileSync("/root/agent-games/session.json", JSON.stringify({
    cookies: cookieJar,
    wallet: sess.wallet,
  }, null, 2));
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
