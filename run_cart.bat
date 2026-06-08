"""
playwright_robot.py
Kitchen Agent — Headed Playwright automation for store pickup.

Supports:
  - Instacart (delivery cleanup / saved-list management)
  - Kroger pickup
  - Walmart pickup

Proxy rotation is optional — works fine without proxies.txt.
Session cookies are stored in ./auth/{retailer}_state.json.

Usage (interactive login, run once per retailer):
    python playwright_robot.py --login --retailer kroger

Usage (add to cart):
    python playwright_robot.py --add --retailer kroger --items '[{"name":"milk","quantity":"1 gal"}]'
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import sys
import time
from pathlib import Path
from typing import List, Optional

# Playwright is only imported if available; fail gracefully
try:
    from playwright.sync_api import sync_playwright, Playwright, BrowserContext, Page
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False

# ── Constants ────────────────────────────────────────────────────────────────

AUTH_DIR = Path(__file__).parent / "auth"
CONFIG_DIR = Path(__file__).parent / "config"

MIN_SLEEP = 0.8   # seconds between actions
MAX_SLEEP = 2.4

RETAILER_URLS = {
    "kroger":    "https://www.kroger.com",
    "walmart":   "https://www.walmart.com",
    "instacart": "https://www.instacart.com",
    "publix":    "https://www.publix.com",
    "aldi":      "https://www.aldi.us",
}

RETAILER_LOGIN_URLS = {
    "kroger":    "https://www.kroger.com/signin",
    "walmart":   "https://www.walmart.com/account/login",
    "instacart": "https://www.instacart.com/accounts/login",
    "publix":    "https://www.publix.com/account/sign-in",
}

RETAILER_CART_URLS = {
    "kroger":    "https://www.kroger.com/cart",
    "walmart":   "https://www.walmart.com/cart",
    "instacart": "https://www.instacart.com",
}

# ── Proxy loader ─────────────────────────────────────────────────────────────

def _load_proxy() -> Optional[dict]:
    """
    Load a random proxy from config/proxies.txt if it exists.
    Each line: http://user:pass@host:port  OR  host:port
    Returns None if no proxy file found (app works without proxies).
    """
    proxy_file = CONFIG_DIR / "proxies.txt"
    if not proxy_file.exists():
        return None
    lines = [l.strip() for l in proxy_file.read_text().splitlines() if l.strip() and not l.startswith("#")]
    if not lines:
        return None
    chosen = random.choice(lines)
    if chosen.startswith("http"):
        return {"server": chosen}
    return {"server": f"http://{chosen}"}


# ── Main robot class ──────────────────────────────────────────────────────────

class PlaywrightRobot:
    """
    Headed Playwright browser robot for store pickup automation.

    Args:
        retailer: One of 'kroger', 'walmart', 'instacart', 'publix'.
        headless: False by default (keeps browser visible to avoid bot detection).
    """

    def __init__(self, retailer: str = "kroger", headless: bool = False) -> None:
        if not PLAYWRIGHT_AVAILABLE:
            raise RuntimeError(
                "Playwright is not installed. Run: pip install playwright && playwright install chromium"
            )
        self.retailer = retailer.lower()
        self.headless = headless
        AUTH_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        self._session_path = AUTH_DIR / f"{self.retailer}_state.json"

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _human_delay(self) -> None:
        """Sleep a random human-like interval."""
        time.sleep(random.uniform(MIN_SLEEP, MAX_SLEEP))

    def _launch_context(self, pw: Playwright) -> BrowserContext:
        """Launch a Chromium context, optionally with proxy + saved session."""
        launch_kwargs: dict = {
            "headless": self.headless,
            "args": [
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
            ],
        }
        proxy = _load_proxy()
        if proxy:
            launch_kwargs["proxy"] = proxy

        browser = pw.chromium.launch(**launch_kwargs)

        context_kwargs: dict = {
            "user_agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            "viewport": {"width": 1280, "height": 800},
        }

        # Restore saved session if available
        if self._session_path.exists():
            context_kwargs["storage_state"] = str(self._session_path)

        return browser.new_context(**context_kwargs)

    def _save_session(self, context: BrowserContext) -> None:
        """Persist the current browser cookies/localStorage to disk."""
        context.storage_state(path=str(self._session_path))
        print(f"[Robot] Session saved → {self._session_path}")

    def _type_humanlike(self, page: Page, selector: str, text: str) -> None:
        """Click a field and type text with random delays between characters."""
        page.click(selector)
        page.keyboard.type(text, delay=random.randint(60, 130))

    # ── Public API ─────────────────────────────────────────────────────────────

    def session_exists(self) -> bool:
        """Return True if a saved session file exists for this retailer."""
        return self._session_path.exists()

    def login_interactive(self) -> None:
        """
        Open a visible browser to the retailer login page.
        Wait for the user to log in manually, then save the session.
        Call this once per retailer; subsequent runs reuse the saved session.
        """
        login_url = RETAILER_LOGIN_URLS.get(
            self.retailer, RETAILER_URLS.get(self.retailer, "https://www.google.com")
        )
        print(f"\n[Robot] Opening {self.retailer} login page: {login_url}")
        print("[Robot] Please log in manually in the browser window that opens.")
        print("[Robot] When you are fully logged in, come back here and press Enter.\n")

        with sync_playwright() as pw:
            context = self._launch_context(pw)
            page = context.new_page()
            page.goto(login_url, wait_until="domcontentloaded")

            input("[Robot] Press Enter after you have logged in successfully... ")

            self._save_session(context)
            context.close()

        print(f"[Robot] Login complete. Session stored at: {self._session_path}")

    def add_items_to_cart(self, items: List[dict]) -> dict:
        """
        Search for each item and add it to the cart at the retailer site.

        Args:
            items: List of {"name": str, "quantity": str} dicts.

        Returns:
            {"added": [...], "failed": [...]}
        """
        added, failed = [], []
        base_url = RETAILER_URLS.get(self.retailer, "")

        with sync_playwright() as pw:
            context = self._launch_context(pw)
            page = context.new_page()

            try:
                page.goto(base_url, wait_until="domcontentloaded")
                self._human_delay()

                for item in items:
                    name = item.get("name", "")
                    qty_str = item.get("quantity", "1")
                    print(f"[Robot] Searching: {name}")

                    try:
                        success = self._add_single_item(page, name, qty_str)
                        if success:
                            added.append(name)
                        else:
                            failed.append(name)
                    except Exception as e:
                        print(f"[Robot] Failed to add {name}: {e}")
                        failed.append(name)

                    self._human_delay()

                # Save refreshed session (cookies may have been updated)
                self._save_session(context)

            finally:
                context.close()

        print(f"[Robot] Done — added: {len(added)}, failed: {len(failed)}")
        return {"added": added, "failed": failed}

    def _add_single_item(self, page: Page, name: str, quantity: str) -> bool:
        """
        Search for one item and click 'Add to Cart'.
        Selectors are tuned for Kroger; adapt comments for other retailers.
        """
        if self.retailer == "kroger":
            return self._add_item_kroger(page, name)
        elif self.retailer == "walmart":
            return self._add_item_walmart(page, name)
        elif self.retailer == "instacart":
            return self._add_item_instacart(page, name)
        else:
            print(f"[Robot] No implementation for retailer: {self.retailer}")
            return False

    def _add_item_kroger(self, page: Page, name: str) -> bool:
        """Kroger-specific: search bar + first result add-to-cart."""
        try:
            # Click the search input
            page.click("input[name='query'], input[aria-label*='search' i], #SearchBar-input")
            page.keyboard.press("Control+a")
            page.keyboard.type(name, delay=random.randint(60, 120))
            page.keyboard.press("Enter")
            page.wait_for_load_state("networkidle", timeout=10000)
            self._human_delay()

            # Click first "Add to Cart" button in results
            btn = page.locator(
                "button:has-text('Add'), button:has-text('+ Cart'), [data-testid*='add-to-cart']"
            ).first
            btn.click(timeout=8000)
            self._human_delay()
            return True
        except Exception as e:
            print(f"[Robot][Kroger] {name}: {e}")
            return False

    def _add_item_walmart(self, page: Page, name: str) -> bool:
        """Walmart-specific: search and add."""
        try:
            page.goto(f"https://www.walmart.com/search?q={name.replace(' ','+')}",
                      wait_until="domcontentloaded")
            self._human_delay()
            btn = page.locator(
                "button:has-text('Add to cart'), [data-automation-id='add-to-cart']"
            ).first
            btn.click(timeout=8000)
            self._human_delay()
            return True
        except Exception as e:
            print(f"[Robot][Walmart] {name}: {e}")
            return False

    def _add_item_instacart(self, page: Page, name: str) -> bool:
        """Instacart-specific: search within a store."""
        try:
            page.wait_for_selector("input[type='search'], input[placeholder*='search' i]",
                                    timeout=8000)
            search = page.locator("input[type='search'], input[placeholder*='search' i]").first
            search.fill("")
            search.type(name, delay=random.randint(60, 100))
            page.keyboard.press("Enter")
            page.wait_for_load_state("networkidle", timeout=10000)
            self._human_delay()

            btn = page.locator(
                "button:has-text('Add'), [data-testid*='add-to-cart'], [aria-label*='Add' i]"
            ).first
            btn.click(timeout=8000)
            self._human_delay()
            return True
        except Exception as e:
            print(f"[Robot][Instacart] {name}: {e}")
            return False

    def clean_up_saved_list(self, bought_items: List[dict]) -> dict:
        """
        Navigate to the Instacart saved list and remove items that were just purchased.

        Args:
            bought_items: List of {"name": str} dicts.

        Returns:
            {"removed": [...], "not_found": [...]}
        """
        removed, not_found = [], []
        bought_names = {item["name"].lower() for item in bought_items}

        print(f"[Robot] Cleaning up saved list — removing {len(bought_names)} items...")

        with sync_playwright() as pw:
            context = self._launch_context(pw)
            page = context.new_page()

            try:
                # Go to Instacart saved lists
                page.goto("https://www.instacart.com/lists", wait_until="domcontentloaded")
                self._human_delay()

                # Find list items — selector may need adjustment per Instacart version
                list_items = page.locator("[data-testid*='list-item'], .list-item, [class*='ListItem']").all()

                for list_item in list_items:
                    try:
                        item_text = list_item.inner_text().lower()
                        # Check if any bought item name appears in this row
                        match = next((n for n in bought_names if n in item_text), None)
                        if match:
                            # Try clicking the remove / delete button in this row
                            remove_btn = list_item.locator(
                                "button:has-text('Remove'), button[aria-label*='remove' i], [class*='delete' i]"
                            ).first
                            remove_btn.click(timeout=5000)
                            self._human_delay()
                            removed.append(match)
                            print(f"[Robot] Removed: {match}")
                    except Exception as e:
                        print(f"[Robot] Couldn't remove item: {e}")

                self._save_session(context)

            finally:
                context.close()

        not_found = list(bought_names - set(removed))
        print(f"[Robot] Cleanup done — removed: {len(removed)}, not found: {len(not_found)}")
        return {"removed": removed, "not_found": not_found}

    def open_instacart_list(self, url: str) -> None:
        """Open a Composio-generated Instacart shoppable list URL in a headed browser."""
        with sync_playwright() as pw:
            context = self._launch_context(pw)
            page = context.new_page()
            page.goto(url, wait_until="domcontentloaded")
            print(f"[Robot] Opened Instacart list. Complete your order in the browser.")
            print("[Robot] Press Enter when done to close the browser.")
            input()
            self._save_session(context)
            context.close()


# ── CLI entry point ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Kitchen Agent Playwright Robot")
    parser.add_argument("--login", action="store_true", help="Run interactive login flow")
    parser.add_argument("--add", action="store_true", help="Add items to cart")
    parser.add_argument("--cleanup", action="store_true", help="Clean up saved list")
    parser.add_argument("--retailer", default="kroger", help="kroger | walmart | instacart")
    parser.add_argument("--items", default="[]", help='JSON: [{"name":"...","quantity":"..."}]')
    args = parser.parse_args()

    robot = PlaywrightRobot(retailer=args.retailer)
    items = json.loads(args.items)

    if args.login:
        robot.login_interactive()
    elif args.add:
        result = robot.add_items_to_cart(items)
        print(json.dumps(result, indent=2))
    elif args.cleanup:
        result = robot.clean_up_saved_list(items)
        print(json.dumps(result, indent=2))
    else:
        print("Use --login, --add, or --cleanup. See --help.")
