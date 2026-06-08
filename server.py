@echo off
REM ─── Aldi Cart Filler ───────────────────────────────────────────────────────
REM Double-click this file to run the cart automation any time.
REM It reads shopping_list.json, fills your Aldi cart, and notifies you when done.

cd /d "%~dp0"

echo.
echo  *** Kitchen Agent — Aldi Cart Filler ***
echo.

REM Check if Playwright is installed
python -c "import playwright" 2>nul
if errorlevel 1 (
    echo  Installing required packages...
    pip install playwright --break-system-packages --quiet
    playwright install chromium --quiet
)

REM Check if auth file exists
if not exist "instacart_auth.json" (
    echo  No saved login found. Running one-time setup...
    echo.
    python setup_instacart_auth.py
)

echo  Starting cart automation...
echo  (Running in background — you will get a desktop notification when done)
echo.

python add_to_aldi_cart.py

echo.
echo  Done! Check your desktop for the notification.
pause
