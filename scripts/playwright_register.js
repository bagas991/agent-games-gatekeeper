/**
 * Register on Agent Games using Playwright (headless browser).
 * Handles wallet SIWE auth + profile completion in the browser.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const { Wallet } = require("ethers");

async function main() {
  const wallet = JSON.parse(fs.readFileSync("/root/agent-games/wallet.json", "utf8"));
  const account = new Wallet(wallet.privateKey);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  // Intercept wallet signing requests
  // Inject ethereum provider that uses our wallet
  await context.addInitScript((privateKey) => {
    // Minimal ethers wallet for signing
    // We'll intercept personal_sign requests
    window.__AGENT_WALLET_PK = privateKey;
  }, wallet.privateKey);

  const page = await context.newPage();

  // Set up console logging
  page.on("console", msg => {
    if (msg.type() === "error") console.log("BROWSER ERROR:", msg.text());
  });

  console.log("1. Navigating to register page...");
  await page.goto("https://agentgames.zkverify.io/register", { waitUntil: "networkidle" });
  console.log("   Page title:", await page.title());

  // Click "Connect Wallet"
  console.log("\n2. Looking for Connect Wallet button...");
  const walletBtn = await page.locator("text=Connect Wallet").first();
  if (await walletBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log("   Found Connect Wallet button, clicking...");
    await walletBtn.click();
    await page.waitForTimeout(2000);
  }

  // The site uses wagmi/RainbowKit. We need to inject a wallet provider.
  // Instead of using the UI wallet flow, let's inject our own provider.
  console.log("\n3. Injecting custom wallet provider...");
  
  await page.evaluate(async (privateKey, address) => {
    // Create a minimal provider that signs with our key
    // Using ethers inline
    const { Wallet } = await import("https://cdn.ethers.org/lib/ethers-6.2.min.js");
    const wallet = new Wallet(privateKey);
    
    // Set up ethereum provider
    let account = address;
    const requestHandlers = {
      eth_requestAccounts: () => [account],
      eth_accounts: () => [account],
      eth_chainId: () => "0x1",
      personal_sign: async (params) => {
        const [message, addr] = params;
        if (addr.toLowerCase() !== account.toLowerCase()) throw new Error("wrong account");
        const sig = await wallet.signMessage(message);
        return sig;
      },
      wallet_requestPermissions: () => [{ eth_accounts: {} }],
      wallet_revokePermissions: () => true,
      wallet_switchEthereumChain: () => null,
      wallet_addEthereumChain: () => null,
    };

    window.ethereum = {
      isMetaMask: true,
      request: async ({ method, params }) => {
        console.log("wallet request:", method);
        const handler = requestHandlers[method];
        if (!handler) throw new Error(`method ${method} not supported`);
        return handler(params || []);
      },
      on: (event, handler) => {
        if (event === "connect") handler({ chainId: "0x1" });
      },
      removeListener: () => {},
      emit: () => {},
    };
    
    // Dispatch events to notify wagmi
    window.dispatchEvent(new Event("ethereum#initialized"));
  }, wallet.privateKey, wallet.address);

  await page.waitForTimeout(1000);

  // Now click Connect Wallet again if needed
  console.log("\n4. Clicking Connect Wallet with injected provider...");
  const connectBtn = page.locator("text=Connect Wallet").first();
  if (await connectBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await connectBtn.click();
    await page.waitForTimeout(2000);
  }

  // Check if we're connected
  console.log("\n5. Page URL:", page.url());
  const pageContent = await page.content();

  // Check if we see the handle input (registration form)
  const handleInput = page.locator('input[placeholder="your-handle"]').first();
  if (await handleInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log("   Registration form visible!");
    await handleInput.fill("bagasgatekeeper");
    
    // Fill email if present
    const emailInput = page.locator('input[type="email"]').first();
    if (await emailInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await emailInput.fill("ach.bagas58@gmail.com");
    }
    
    // Check the terms checkbox
    const checkbox = page.locator('input[type="checkbox"]').first();
    if (await checkbox.isVisible({ timeout: 2000 }).catch(() => false)) {
      await checkbox.check();
    }
    
    // Click Complete registration
    const submitBtn = page.locator("text=Complete registration").first();
    await submitBtn.click();
    
    console.log("   Clicked Complete registration, waiting...");
    await page.waitForTimeout(5000);
    console.log("   URL after submit:", page.url());
    
    // Check session
    const sessionEl = await page.evaluate(() => {
      return fetch("/api/auth/session").then(r => r.text());
    });
    console.log("   Session:", sessionEl);
  } else {
    console.log("   Registration form NOT visible. Page content:");
    console.log(pageContent.slice(0, 1000));
  }

  // Take screenshot for debugging
  await page.screenshot({ path: "/root/agent-games/register_screenshot.png" });
  console.log("\nScreenshot saved.");

  await browser.close();
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
