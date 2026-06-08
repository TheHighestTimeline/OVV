"""
add_to_aldi_cart.py
-------------------
Reads shopping_list.json, adds every item to your Aldi cart on Instacart
using a saved login session, then sends a Windows desktop notification.

Run manually:   python add_to_aldi_cart.py
First-time setup: python setup_instacart_auth.py  (saves your login once)
"""

import asyncio
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import quote_plus

BASE_DIR = Path(__file__).parent
AUTH_FILE = BASE_DIR / "instacart_auth.json"
LIST_FILE = BASE_DIR / "shopping_list.json"
STATUS_FILE = BASE_DIR / "cart_status.json"


# ─── helpers ────────────────────────────────────────────────────────────────

def notify(title: str, message: str) -> None:
    """Send a desktop notification.
    - Windows: PowerShell toast (when run via run_cart.bat)
    - Linux/container: prints to stdout (Cowork notifies via notifyOnCompletion)
    """
    import platform
    print(f"\n🔔  {title}")
    print(f"    {message}\n")

    if platform.system() != "Windows":
        return  # Cowork's own notification handles the scheduled-task case

    ps = (
        "$app='Kitchen Agent';"
        "[Windows.UI.Notifications.ToastNotificationManager,"
        "Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null;"
        "$xml=[Windows.UI.Notifications.ToastNotificationManager]::"
        "GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);"
        f"$xml.SelectSingleNode('//text[@id=1]').InnerText='{title}';"
        f"$xml.SelectSingleNode('//text[@id=2]').InnerText='{message}';"
        "$toast=[Windows.UI.Notifications.ToastNotification]::new($xml);"
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)"
    )
    try:
        subprocess.run(
            ["powershell", "-WindowStyle", "Hidden", "-Command", ps],
            capture_output=True, timeout=10
        )
    except Exception as e:
        print(f"[notify] powershell error: {e}")


def write_status(added, not_found, errors):
    data = {
        "completed_at": datetime.now().isoformat(),
        "added": added,
        "not_found": not_found,
        "errors": errors,
        "total_added": len(added),
        "cart_url": "https://www.instacart.com/store/aldi/storefront",
    }
    STATUS_FILE.write_text(json.dumps(data, indent=2))
    print(f"\n[status] Written to {STATUS_FILE}")


# ─── core automation ────────────────────────────────────────────────────────

async def add_items():
    # ── 0. load list ──────────────────────────────────────────────────────
    if not LIST_FILE.exists():
        sys.exit(f"❌  shopping_list.json not found at {LIST_FILE}")

    data = json.loads(LIST_FILE.read_text())
    items = data.get("items", [])
    skip = {s.lower().strip() for s in data.get("skip_items", [])}

    print(f"📋  Loaded {len(items)} items  |  skipping: {skip or 'none'}")

    # ── 1. check auth ─────────────────────────────────────────────────────
    if not AUTH_FILE.exists():
        sys.exit(
            "❌  No saved login found.\n"
            "    Run  python setup_instacart_auth.py  first to save your Instacart session."
        )

    # ── 2. launch headless browser ────────────────────────────────────────
    from playwright.async_api import async_playwright

    added, not_found, errors = [], [], []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            storage_state=str(AUTH_FILE),
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )
        page = await context.new_page()

        # ── 3. verify login ───────────────────────────────────────────────
        await page.goto("https://www.instacart.com/store/aldi/storefront",
                        wait_until="domcontentloaded", timeout=20_000)
        if "login" in page.url:
            await browser.close()
            sys.exit(
                "❌  Instacart session expired.\n"
                "    Run  python setup_instacart_auth.py  to refresh your login."
            )
        print("✅  Logged in to Instacart\n")

        # ── 4. process each item ──────────────────────────────────────────
        for item in items:
            if item.lower().strip() in skip:
                print(f"⏭   skip  : {item}")
                continue

            url = f"https://www.instacart.com/store/aldi/s?k={quote_plus(item)}"
            print(f"🔍  search : {item}")

            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=15_000)
                await page.wait_for_timeout(2_200)  # let JS render results

                # ── find the FIRST "Add" button in main results (not related) ──
                # Instacart renders the primary result section before "Related items"
                add_btn = None

                # strategy 1: aria-label contains "Add"
                candidates = await page.query_selector_all('button[aria-label*="Add"]')
                for btn in candidates:
                    label = (await btn.get_attribute("aria-label") or "").lower()
                    if "add" in label and "remove" not in label:
                        add_btn = btn
                        break

                # strategy 2: visible button with exact text "Add"
                if not add_btn:
                    for btn in await page.query_selector_all("button"):
                        txt = (await btn.text_content() or "").strip()
                        if txt == "Add":
                            add_btn = btn
                            break

                if add_btn:
                    await add_btn.scroll_into_view_if_needed()
                    await add_btn.click()
                    await page.wait_for_timeout(900)
                    added.append(item)
                    print(f"  ✅  added")
                else:
                    not_found.append(item)
                    print(f"  ❌  not found at Aldi")

            except Exception as exc:
                errors.append({"item": item, "error": str(exc)})
                print(f"  ⚠️   error: {exc}")

        await browser.close()

    # ── 5. report ─────────────────────────────────────────────────────────
    print(f"\n{'─'*50}")
    print(f"  Added    : {len(added)}")
    print(f"  Not found: {len(not_found)} {not_found or ''}")
    print(f"  Errors   : {len(errors)}")
    print(f"{'─'*50}\n")

    write_status(added, not_found, [e["item"] for e in errors])

    # ── 6. Windows notification ───────────────────────────────────────────
    if not_found:
        msg = (
            f"{len(added)} items added. "
            f"{len(not_found)} not at Aldi: {', '.join(not_found[:3])}"
            f"{'…' if len(not_found) > 3 else ''}. "
            "Open Instacart to review, pick a time & checkout."
        )
    else:
        msg = (
            f"All {len(added)} items added to your Aldi cart! "
            "Open Instacart to pick a delivery time and checkout."
        )

    notify("🛒 Aldi cart is ready!", msg)
    print("🔔  Notification sent.")


# ─── entry point ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    asyncio.run(add_items())
