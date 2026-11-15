/**
 * Register agent via Playwright UI with correct selectors.
 */
const { chromium } = require("playwright");
const fs = require("fs");

async function main() {
  const sess = JSON.parse(fs.readFileSync("/root/agent-games/session.json", "utf8"));
  const cookies = Object.entries(sess.cookies).map(([name, value]) => ({
    name, value, domain: "agentgames.zkverify.io", path: "/", secure: true, httpOnly: true, sameSite: "Lax",
  }));

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies(cookies);
  const page = await context.newPage();

  // Capture network responses for the server action
  page.on("response", async (response) => {
    const url = response.url();
    if (response.request().method() === "POST" && url.includes("/dashboard/agents")) {
      console.log("POST response:", response.status(), url.slice(-60));
      try {
        const body = await response.text();
        if (body.length > 0) console.log("  Body:", body.slice(0, 500));
      } catch {}
    }
  });

  console.log("1. Navigating to dashboard/agents...");
  await page.goto("https://agentgames.zkverify.io/dashboard/agents", { waitUntil: "networkidle", timeout: 30000 });

  console.log("2. Clicking Register agent...");
  await page.locator("button:has-text('Register agent')").first().click();
  await page.waitForTimeout(1000);

  console.log("3. Filling form...");
  // Name: placeholder "e.g. CIPHER-7"
  await page.locator('input[placeholder="e.g. CIPHER-7"]').fill("Bagas Gatekeeper");
  console.log("   Name filled");

  // Select Proof Gatekeeper
  const gkBtn = page.locator('button[aria-pressed="false"]:has-text("Proof Gatekeeper")').first();
  await gkBtn.click();
  console.log("   Proof Gatekeeper selected");

  // Endpoint: placeholder "my-agent.fly.dev/agent"
  await page.locator('input[placeholder="my-agent.fly.dev/agent"]').fill("largest-descriptions-supplies-travels.trycloudflare.com/agent");
  console.log("   Endpoint filled");

  console.log("4. Clicking Register agent (submit)...");
  // The Register agent button in the dialog
  const submitBtn = page.locator('[role="dialog"] button:has-text("Register agent")').first();
  await submitBtn.click();
  console.log("   Clicked, waiting for response...");
  await page.waitForTimeout(5000);

  console.log("5. Checking result...");
  
  // Check for secret in the page
  const pageText = await page.evaluate(() => document.body.innerText);
  
  // Look for secret (32+ hex chars)
  const secretMatch = pageText.match(/\b([a-f0-9]{32,})\b/i);
  if (secretMatch) {
    console.log("   ✅ Secret found:", secretMatch[1]);
    fs.writeFileSync("/root/agent-games/agent_secret.txt", secretMatch[1]);
  }
  
  // Look for agent ID
  const agentIdMatch = pageText.match(/agt_[a-zA-Z0-9]+/);
  if (agentIdMatch) {
    console.log("   Agent ID:", agentIdMatch[0]);
  }

  // Check for success/error
  if (pageText.includes("Copy now")) {
    console.log("   ✅ Registration successful! Secret shown.");
  }
  if (pageText.includes("error") || pageText.includes("Error")) {
    const lines = pageText.split("\n").filter(l => /error|fail|invalid|reject/i.test(l));
    console.log("   Errors:", lines.slice(0, 3));
  }

  // Get dialog text
  const dialogText = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    return d ? d.innerText.slice(0, 800) : "no dialog";
  });
  console.log("   Dialog:", dialogText.slice(0, 400));

  await page.screenshot({ path: "/root/agent-games/agent_reg_result.png" });
  console.log("   Screenshot saved");

  // Save cookies
  const newCookies = await context.cookies();
  const cookieObj = {};
  for (const c of newCookies) cookieObj[c.name] = c.value;
  fs.writeFileSync("/root/agent-games/session.json", JSON.stringify({ cookies: cookieObj, wallet: sess.wallet }, null, 2));

  await browser.close();
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });
