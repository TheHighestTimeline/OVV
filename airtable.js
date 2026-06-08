"""
setup_instacart_auth.py
-----------------------
One-time setup: opens a real Chrome window, lets you log into Instacart,
then saves your session to instacart_auth.json so add_to_aldi_cart.py
can run headlessly without ever asking for credentials again.

Re-run this any time your session expires (usually every few weeks).
"""

import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

BASE_DIR = Path(__file__).parent
AUTH_FILE = BASE_DIR / "instacart_auth.json"


async def setup():
    print("Opening Instacart in a new browser window...")
    print("Log in as you normally would, then come back here and press ENTER.\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        context = await browser.new_context()
        page = await context.new_page()

        await page.goto("https://www.instacart.com/login")

        input("─── Logged in? Press ENTER to save your session ───")

        # Verify we're actually logged in
        if "login" in page.url:
            print("\n⚠️  Still on the login page — make sure you completed login before pressing ENTER.")
            input("Try again — press ENTER when logged in: ")

        await context.storage_state(path=str(AUTH_FILE))
        print(f"\n✅  Session saved to: {AUTH_FILE}")
        print("    You can now run: python add_to_aldi_cart.py\n")

        await browser.close()


if __name__ == "__main__":
    asyncio.run(setup())
