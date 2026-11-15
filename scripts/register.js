/**
 * Register on Agent Games via NextAuth wallet credentials provider.
 * Uses Auth.js (NextAuth) credential flow: CSRF → signin → callback → session.
 */
const { Wallet } = require("ethers");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");

const BASE = "https://agentgames.zkverify.io";

let cookieJar = {};

function fetch(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const cookieStr = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join("; ");
    const headers = { ...opts.headers, cookie: cookieStr };
    if (opts.body) headers["content-type"] = headers["content-type"] || "application/json";

    const req = https.request(url, {
      method: opts.method || "GET",
      headers,
    }, (res) => {
      // Capture cookies
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
        const body = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(body), raw: body });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, raw: body });
        }
      });
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function main() {
  // Load wallet
  const walletFile = "/root/agent-games/wallet.json";
  const wallet = JSON.parse(fs.readFileSync(walletFile, "utf8"));
  const account = new Wallet(wallet.privateKey);
  console.log("Wallet:", wallet.address);

  // Step 1: Get CSRF token
  console.log("\n1. Getting CSRF token...");
  const csrfRes = await fetch("/api/auth/csrf");
  const csrfToken = csrfRes.json?.csrfToken;
  console.log("   CSRF:", csrfToken?.slice(0, 16) + "...");

  // Step 2: Get SIWE nonce
  console.log("\n2. Getting SIWE nonce...");
  const nonceRes = await fetch("/api/auth/wallet/siwe/nonce");
  const nonce = nonceRes.json?.nonce;
  console.log("   Nonce:", nonce?.slice(0, 16) + "...");

  // Step 3: Build & sign SIWE message
  const domain = "agentgames.zkverify.io";
  const uri = "https://agentgames.zkverify.io";
  const issuedAt = new Date().toISOString();
  const expirationTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const siweMessage = `${domain} wants you to sign in with your Ethereum account:
${wallet.address}

Sign in to Agent Games with your wallet.

URI: ${uri}
Version: 1
Chain ID: 1
Nonce: ${nonce}
Issued At: ${issuedAt}
Expiration Time: ${expirationTime}`;

  console.log("\n3. Signing SIWE message...");
  const signature = await account.signMessage(siweMessage);
  console.log("   Signature:", signature.slice(0, 20) + "...");

  // Step 4: Submit to NextAuth credentials provider
  // NextAuth credentials signin expects POST to /api/auth/callback/credentials
  // with form-encoded body: csrfToken, message, signature, redirect=false
  console.log("\n4. Submitting to NextAuth wallet provider...");
  const formData = new URLSearchParams({
    csrfToken,
    message: siweMessage,
    signature,
    redirect: "false",
    json: "true",
  }).toString();

  const signinRes = await fetch("/api/auth/callback/wallet", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: formData,
  });
  console.log("   Status:", signinRes.status);
  console.log("   Response:", signinRes.raw?.slice(0, 300));

  // Step 5: Check session
  console.log("\n5. Checking session...");
  const sessRes = await fetch("/api/auth/session");
  console.log("   Status:", sessRes.status);
  console.log("   Session:", JSON.stringify(sessRes.json || sessRes.raw).slice(0, 500));

  if (sessRes.json && sessRes.json.user) {
    console.log("\n✅ Logged in as:", sessRes.json.user.email || sessRes.json.user.name || "unknown");

    // Step 6: Create profile
    console.log("\n6. Creating profile...");
    const profileBody = JSON.stringify({
      handle: "bagasgatekeeper",
      country: "ID",
      bio: "AI agent builder. Proof Gatekeeper.",
      github_url: "https://github.com/bagas991",
      wallet_address: wallet.address,
    });

    // Try different profile endpoints
    for (const ep of ["/api/me/profile", "/api/profile", "/api/me", "/api/user/profile"]) {
      const profRes = await fetch(ep, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: profileBody,
      });
      console.log(`   ${ep}: ${profRes.status} ${profRes.raw?.slice(0, 200)}`);
      if (profRes.status === 200 || profRes.status === 201) break;
    }
  }

  // Save session
  fs.writeFileSync("/root/agent-games/session.json", JSON.stringify({
    cookies: cookieJar,
    wallet: wallet.address,
  }, null, 2));
  console.log("\nSession saved.");
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
