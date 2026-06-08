"""
server.py
Kitchen Agent — Local HTTP server with Playwright automation endpoints.

Serves the kitchen-agent.html app AND provides a local REST API for
browser automation tasks that can't run serverless (Playwright pickup flow,
auth session management).

Run via start_kitchen_agent.bat or:  python server.py

Endpoints:
  GET  /                          → kitchen-agent.html (redirects)
  GET  /status                    → {"ok": true, "sessions": {...}}
  POST /playwright/login          → Opens browser for interactive login
  POST /playwright/add-to-cart    → Adds items to retailer cart
  POST /playwright/cleanup        → Removes bought items from saved list
  POST /playwright/open-list      → Opens Instacart shoppable URL in headed browser
"""

from __future__ import annotations

import http.server
import json
import os
import socket
import socketserver
import subprocess
import sys
import threading
from pathlib import Path
from urllib.parse import urlparse

PORT = 8765          # Different from the old port to avoid conflicts
STATIC_PORT = 8000   # Serves kitchen-agent.html (unchanged)
HOST = "0.0.0.0"

SERVE_DIR = Path(__file__).parent

# ── Auth status helpers ────────────────────────────────────────────────────────

def get_session_status() -> dict:
    """Return which retailers have saved sessions."""
    auth_dir = SERVE_DIR / "auth"
    retailers = ["kroger", "walmart", "instacart", "publix", "aldi"]
    return {
        r: (auth_dir / f"{r}_state.json").exists()
        for r in retailers
    }


def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


# ── Request handler ─────────────────────────────────────────────────────────────

class KitchenAgentHandler(http.server.BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        # Quiet mode — only log errors
        if args and str(args[1]) not in ("200", "204", "304"):
            super().log_message(format, *args)

    def _send_json(self, data: dict, status: int = 200) -> None:
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, message: str, status: int = 500) -> None:
        self._send_json({"ok": False, "error": message}, status)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        return json.loads(raw) if raw else {}

    # ── Route dispatcher ──────────────────────────────────────────────────────

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            self._redirect_to_app()
        elif path == "/status":
            self._handle_status()
        else:
            self._send_error_json("Not found", 404)

    def do_POST(self):
        path = urlparse(self.path).path
        routes = {
            "/playwright/login":     self._handle_login,
            "/playwright/add-to-cart": self._handle_add_to_cart,
            "/playwright/cleanup":   self._handle_cleanup,
            "/playwright/open-list": self._handle_open_list,
        }
        handler = routes.get(path)
        if handler:
            handler()
        else:
            self._send_error_json("Unknown endpoint", 404)

    # ── Route handlers ─────────────────────────────────────────────────────────

    def _redirect_to_app(self) -> None:
        self.send_response(302)
        self.send_header("Location", f"http://localhost:{STATIC_PORT}/kitchen-agent.html")
        self.end_headers()

    def _handle_status(self) -> None:
        self._send_json({
            "ok": True,
            "api_port": PORT,
            "app_port": STATIC_PORT,
            "sessions": get_session_status(),
        })

    def _handle_login(self) -> None:
        """
        Open a headed browser for the user to log in interactively.
        Runs in a background thread so the HTTP response returns immediately.
        """
        try:
            body = self._read_json_body()
            retailer = body.get("retailer", "kroger")

            try:
                from playwright_robot import PlaywrightRobot
            except ImportError:
                self._send_error_json("Playwright not installed. Run: pip install playwright && playwright install chromium")
                return

            self._send_json({
                "ok": True,
                "message": f"Opening {retailer} login browser. Log in, then click 'Done' in the app.",
                "retailer": retailer,
            })

            # Run login in background thread (HTTP response already sent)
            def _login():
                try:
                    robot = PlaywrightRobot(retailer=retailer)
                    robot.login_interactive()
                    print(f"[Server] Login complete for {retailer}")
                except Exception as e:
                    print(f"[Server] Login error: {e}")

            threading.Thread(target=_login, daemon=True).start()

        except Exception as e:
            self._send_error_json(str(e))

    def _handle_add_to_cart(self) -> None:
        """Add a list of items to the retailer cart via Playwright."""
        try:
            body = self._read_json_body()
            retailer = body.get("retailer", "kroger")
            items = body.get("items", [])

            if not items:
                self._send_error_json("No items provided", 400)
                return

            try:
                from playwright_robot import PlaywrightRobot
            except ImportError:
                self._send_error_json("Playwright not installed.")
                return

            robot = PlaywrightRobot(retailer=retailer)
            if not robot.session_exists():
                self._send_error_json(
                    f"No saved session for {retailer}. Open Settings → Pickup Login first.", 401
                )
                return

            # Run in background; respond immediately to avoid browser timeout
            self._send_json({"ok": True, "message": f"Starting {retailer} cart automation...", "items_count": len(items)})

            def _add():
                try:
                    result = robot.add_items_to_cart(items)
                    print(f"[Server] Cart result: {result}")
                except Exception as e:
                    print(f"[Server] Cart error: {e}")

            threading.Thread(target=_add, daemon=True).start()

        except Exception as e:
            self._send_error_json(str(e))

    def _handle_cleanup(self) -> None:
        """Remove bought items from the Instacart saved list."""
        try:
            body = self._read_json_body()
            bought_items = body.get("bought_items", [])

            try:
                from playwright_robot import PlaywrightRobot
            except ImportError:
                self._send_error_json("Playwright not installed.")
                return

            robot = PlaywrightRobot(retailer="instacart")
            if not robot.session_exists():
                self._send_error_json("No Instacart session. Set up Instacart login first.", 401)
                return

            self._send_json({"ok": True, "message": "Running cleanup...", "items": len(bought_items)})

            def _cleanup():
                try:
                    result = robot.clean_up_saved_list(bought_items)
                    print(f"[Server] Cleanup result: {result}")
                except Exception as e:
                    print(f"[Server] Cleanup error: {e}")

            threading.Thread(target=_cleanup, daemon=True).start()

        except Exception as e:
            self._send_error_json(str(e))

    def _handle_open_list(self) -> None:
        """Open a Composio Instacart URL in a headed browser (with saved session)."""
        try:
            body = self._read_json_body()
            url = body.get("url", "")
            if not url:
                self._send_error_json("url is required", 400)
                return

            try:
                from playwright_robot import PlaywrightRobot
            except ImportError:
                # Fallback: just tell the app to use webbrowser
                self._send_json({"ok": True, "fallback": True, "url": url})
                return

            self._send_json({"ok": True, "message": "Opening Instacart in browser..."})

            def _open():
                try:
                    robot = PlaywrightRobot(retailer="instacart")
                    robot.open_instacart_list(url)
                except Exception as e:
                    print(f"[Server] Open list error: {e}")

            threading.Thread(target=_open, daemon=True).start()

        except Exception as e:
            self._send_error_json(str(e))


# ── Static file server for kitchen-agent.html ────────────────────────────────

class StaticHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SERVE_DIR), **kwargs)

    def log_message(self, format, *args):
        if args and str(args[1]) not in ("200", "304"):
            super().log_message(format, *args)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    local_ip = get_local_ip()

    print("=" * 58)
    print("  Kitchen Agent — Local Server")
    print("=" * 58)
    print(f"  App (HTML):    http://localhost:{STATIC_PORT}/kitchen-agent.html")
    print(f"  iPhone:        http://{local_ip}:{STATIC_PORT}/kitchen-agent.html")
    print(f"  API (local):   http://localhost:{PORT}/status")
    print()
    print("  Press Ctrl+C to stop.")
    print("=" * 58)

    # Static file server on port 8000
    static_server = socketserver.TCPServer((HOST, STATIC_PORT), StaticHandler)
    static_server.allow_reuse_address = True

    # API server on port 8765
    api_server = socketserver.TCPServer((HOST, PORT), KitchenAgentHandler)
    api_server.allow_reuse_address = True

    static_thread = threading.Thread(target=static_server.serve_forever, daemon=True)
    static_thread.start()

    print(f"\n  Static server started on :{STATIC_PORT}")
    print(f"  API server started on    :{PORT}")
    print()

    try:
        api_server.serve_forever()
    except KeyboardInterrupt:
        print("\n\n  Servers stopped.")
        static_server.shutdown()
