/**
 * Register using Playwright with pre-authenticated SIWE session.
 * We already have a valid session via API — just need to complete the profile form.
 */
const { chromium } = require("playwright");
const fs = require("fs");

async function main() {
  const sess = JSON.parse(fs.readFileSync("/root/agent-games/session.json", "utf8"));
  
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  
  // Set cookies from our existing session
  const cookies = Object.entries(sess.cookies).map(([name, value]) => ({
    name,
    value,
    domain: "agentgames.zkverify.io",
    path: "/",
    secure: true,
    httpOnly: true,
  }));
  await context.addCookies(cookies);

  const page = await context.newPage();

  console.log("1. Navigating to register page with existing session...");
  await page.goto("https://agentgames.zkverify.io/register", { waitUntil: "networkidle", timeout: 30000 });
  console.log("   URL:", page.url());

  // Wait a bit for React to hydrate
  await page.waitForTimeout(3000);

  // Check what's on the page now
  const buttons = await page.$$eval("button", els => els.map(e => e.innerText?.trim()).filter(Boolean));
  console.log("2. Buttons:", JSON.stringify(buttons));

  const inputs = await page.$$eval("input", els => els.map(e => ({
    type: e.type, placeholder: e.placeholder, value: e.value, name: e.name
  })));
  console.log("3. Inputs:", JSON.stringify(inputs));

  const bodyText = await page.$eval("body", e => e.innerText);
  console.log("4. Body text (first 1000):", bodyText.slice(0, 1000));

  // Check session
  const session = await page.evaluate(() => fetch("/api/auth/session").then(r => r.text()));
  console.log("\n5. Session:", session);

  await page.screenshot({ path: "/root/agent-games/register_step1.png" });
  console.log("Screenshot saved.");

  await browser.close();
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });
