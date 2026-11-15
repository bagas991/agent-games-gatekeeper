/**
 * Register agent via Playwright UI (using existing SIWE session cookies).
 */
const { chromium } = require("playwright");
const fs = require("fs");

async function main() {
  const sess = JSON.parse(fs.readFileSync("/root/agent-games/session.json", "utf8"));
  const cookies = Object.entries(sess.cookies).map(([name, value]) => ({
    name, value,
    domain: "agentgames.zkverify.io",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  }));

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies(cookies);

  const page = await context.newPage();
  page.on("console", msg => {
    const t = msg.text();
    if (t.includes("error") || t.includes("Error") || t.includes("agent")) console.log("BROWSER:", t);
  });

  console.log("1. Navigating to dashboard/agents...");
  await page.goto("https://agentgames.zkverify.io/dashboard/agents", { waitUntil: "networkidle", timeout: 30000 });
  console.log("   URL:", page.url());

  // Check if we're logged in
  const session = await page.evaluate(() => fetch("/api/auth/session").then(r => r.json()));
  console.log("   Session:", JSON.stringify(session).slice(0, 150));

  if (!session.user) {
    console.error("   Not logged in!");
    await browser.close();
    process.exit(1);
  }

  // Click "Register agent" button
  console.log("\n2. Clicking Register agent...");
  const regBtn = page.locator("button:has-text('Register agent')").first();
  await regBtn.waitFor({ timeout: 5000 });
  await regBtn.click();
  await page.waitForTimeout(1000);

  // Fill the form
  console.log("3. Filling agent form...");
  
  // Agent name
  const nameInput = page.locator('input[aria-label="Agent name"]').first();
  if (await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await nameInput.fill("Bagas Gatekeeper");
    console.log("   Name filled");
  }

  // Select Proof Gatekeeper event
  const gatekeeperToggle = page.locator('button[aria-pressed="false"]:has-text("Proof Gatekeeper")').first();
  if (await gatekeeperToggle.isVisible({ timeout: 3000 }).catch(() => false)) {
    await gatekeeperToggle.click();
    console.log("   Proof Gatekeeper selected");
  }

  // Fill endpoint
  const endpointInput = page.locator('input[aria-label="Agent endpoint"]').first();
  if (await endpointInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await endpointInput.fill("largest-descriptions-supplies-travels.trycloudflare.com/agent");
    console.log("   Endpoint filled");
  } else {
    // Try other selectors
    const endpointInput2 = page.locator('input[placeholder*="agent"]').first();
    if (await endpointInput2.isVisible({ timeout: 3000 }).catch(() => false)) {
      await endpointInput2.fill("largest-descriptions-supplies-travels.trycloudflare.com/agent");
      console.log("   Endpoint filled (v2)");
    }
  }

  // Click Register button (submit)
  console.log("4. Clicking Register...");
  const submitBtn = page.locator("button:has-text('Register')").last();
  await submitBtn.click({ timeout: 5000 });
  await page.waitForTimeout(3000);

  // Check for secret or success message
  console.log("5. Checking result...");
  const bodyText = await page.$eval("body", e => e.innerText);
  
  // Look for secret
  const secretMatch = bodyText.match(/([a-f0-9]{32,64})/i);
  if (secretMatch) {
    console.log("   Secret found:", secretMatch[1]);
  }
  
  // Look for success indicators
  if (bodyText.includes("registered") || bodyText.includes("active") || bodyText.includes("Copy")) {
    console.log("   Registration likely successful!");
  }
  
  // Look for error
  if (bodyText.includes("error") || bodyText.includes("Error") || bodyText.includes("failed")) {
    const errorLines = bodyText.split("\n").filter(l => /error|fail/i.test(l));
    console.log("   Errors:", errorLines.slice(0, 3));
  }

  // Get all text from any modal/dialog
  const dialog = page.locator('[role="dialog"]').first();
  if (await dialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    const dialogText = await dialog.innerText();
    console.log("   Dialog text:", dialogText.slice(0, 500));
  }

  await page.screenshot({ path: "/root/agent-games/agent_reg_result.png" });
  console.log("   Screenshot saved");

  // Save updated cookies
  const newCookies = await context.cookies();
  const cookieObj = {};
  for (const c of newCookies) cookieObj[c.name] = c.value;
  fs.writeFileSync("/root/agent-games/session.json", JSON.stringify({
    cookies: cookieObj,
    wallet: sess.wallet,
  }, null, 2));

  await browser.close();
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });
