/**
 * Complete registration on Agent Games via Next.js Server Action.
 * Server actions POST to the page URL with Next-Action header.
 */
const { Wallet } = require("ethers");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");

const BASE = "https://agentgames.zkverify.io";
const REGISTER_ACTION_ID = "4014167088ada80bf93c1455079f882e2214dc9d42";

let cookieJar = {};

function fetchRaw(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const cookieStr = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join("; ");
    const headers = { ...opts.headers, cookie: cookieStr };
    if (opts.body && !headers["content-type"]) headers["content-type"] = "application/json";

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

async function main() {
  // Load session
  const sess = JSON.parse(fs.readFileSync("/root/agent-games/session.json", "utf8"));
  cookieJar = sess.cookies;

  // Verify session still valid
  console.log("1. Verifying session...");
  const sessRes = await fetchRaw("/api/auth/session");
  console.log("   Session:", sessRes.body.slice(0, 200));
  if (sessRes.body.includes("null")) {
    console.error("   Session expired! Re-login needed.");
    process.exit(1);
  }

  // Check handle availability
  const handle = "bagasgatekeeper";
  console.log(`\n2. Checking handle "${handle}"...`);
  const handleRes = await fetchRaw(`/api/handles/availability?handle=${encodeURIComponent(handle)}`);
  console.log("   Status:", handleRes.status, "Body:", handleRes.body.slice(0, 200));

  // Call the server action to complete registration
  console.log("\n3. Calling registerAction server action...");
  
  // Next.js server actions use a special RSC-encoded body format
  // The body is an array of args, serialized as React Flight format
  // For a simple action, the body is: [arg1, arg2, ...]
  // encoded as: "$1" + args array
  
  // The args for registerAction are likely: handle, email, country, bio, github, etc.
  // Let me try different formats
  
  // The registerAction takes a single object argument:
  // {handle, displayName, contactEmail, country, bio, twitter, referralCode}
  const regData = {
    handle: handle,
    displayName: handle,
    contactEmail: "",
    country: "ID",
    bio: "",
    twitter: "",
    referralCode: undefined,
  };

  // Next.js RSC server action body format:
  // The args are encoded as: 0:["$K1",["arg1"]] where arg1 is the first argument
  // But simpler: just send the args array as RSC flight text
  // Format: 1:{"handle":"...","displayName":"...","contactEmail":"...","country":"ID","bio":"","twitter":"","referralCode":null}
  // Actually for single-arg actions, the body is just the arg as a JSON-encoded value
  // in the RSC wire format: the body is a serialized array of arguments
  
  // The correct RSC format for server actions is:
  // body = JSON.stringify([arg1, arg2, ...])
  // But with RSC encoding it's different. Let me try the actual format:
  // Next.js sends: [arg] as the body, with the first line being the RSC header
  
  const rscBody = JSON.stringify([regData]);
  
  const res1 = await fetchRaw("/register", {
    method: "POST",
    headers: {
      "content-type": "text/plain;charset=UTF-8",
      "next-action": REGISTER_ACTION_ID,
      "accept": "text/x-component",
    },
    body: rscBody,
  });
  console.log("   RSC format:", res1.status, res1.body.slice(0, 500));

  // Check if registration worked
  console.log("\n4. Checking session after registration...");
  const sessRes2 = await fetchRaw("/api/auth/session");
  console.log("   Session:", sessRes2.body.slice(0, 300));

  // Try accessing dashboard
  console.log("\n5. Checking dashboard...");
  const dashRes = await fetchRaw("/dashboard");
  console.log("   Status:", dashRes.status, "Redirect:", dashRes.headers.location || "none");
  
  fs.writeFileSync("/root/agent-games/session.json", JSON.stringify({
    cookies: cookieJar,
    wallet: sess.wallet,
  }, null, 2));
  console.log("\nSession updated.");
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
