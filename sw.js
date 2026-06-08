# Kitchen Agent — Python dependencies
# Install: pip install -r requirements.txt --break-system-packages
# Then:    playwright install chromium

# Playwright browser automation (pickup flow)
playwright>=1.44.0

# Async HTTP client (pantry scanner API calls)
httpx>=0.27.0

# Image processing (resize before sending to Claude)
Pillow>=10.3.0

# Data validation
pydantic>=2.7.0

# Environment variable loading
python-dotenv>=1.0.1

# Composio SDK (optional — Composio calls go through Netlify Function)
# composio-openai>=0.5.0
