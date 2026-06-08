"""
pantry_scanner.py
Kitchen Agent — Async pantry item scanner using Claude Vision.

Primary model:  Claude 3.5 Haiku  (fast, cheap)
Fallback model: Claude 3.5 Sonnet (if confidence < CONFIDENCE_THRESHOLD)

Usage:
    from pantry_scanner import process_batch
    results = asyncio.run(process_batch(["photo1.jpg", "photo2.jpg"]))
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import time
from pathlib import Path
from typing import List, Optional

import httpx
from PIL import Image
from pydantic import BaseModel, Field, field_validator

# ── Config ────────────────────────────────────────────────────────────────────

HAIKU_MODEL           = "claude-3-5-haiku-20241022"
SONNET_MODEL          = "claude-3-5-sonnet-20241022"
CONFIDENCE_THRESHOLD  = 0.85      # below this → retry with Sonnet
MAX_LONG_SIDE         = 1500      # px; images resized before sending
JPEG_QUALITY          = 80        # compression for upload speed
MAX_BATCH_SIZE        = 10        # hard cap per batch
REQUEST_TIMEOUT       = 30.0      # seconds per API call
RETRY_WAIT            = 2.0       # seconds before retrying on 429

ANTHROPIC_API_URL  = "https://api.anthropic.com/v1/messages"
ANTHROPIC_API_KEY  = os.getenv("ANTHROPIC_API_KEY", "")
ANTHROPIC_VERSION  = "2023-06-01"

# ── Pydantic model ─────────────────────────────────────────────────────────────

class PantryItem(BaseModel):
    """Validated pantry item returned by the vision models."""
    item_name:              str
    total_volume:           str
    estimated_qty_percent:  int   = Field(ge=0, le=100)
    exp_date:               str   # YYYY-MM-DD or "Unknown"
    confidence:             float = Field(ge=0.0, le=1.0)
    fallback_used:          bool  = False
    low_confidence:         bool  = False

    @field_validator("exp_date")
    @classmethod
    def validate_date(cls, v: str) -> str:
        if v == "Unknown":
            return v
        # Accept YYYY-MM-DD; coerce other formats loosely
        import re
        if re.match(r"\d{4}-\d{2}-\d{2}", v):
            return v
        return v  # Let it through; UI will flag bad dates


# ── Image preprocessing ────────────────────────────────────────────────────────

def preprocess_image(path: str | Path) -> tuple[str, str]:
    """
    Open an image, resize so longest side ≤ MAX_LONG_SIDE, convert to JPEG,
    and return (base64_string, media_type).
    """
    img = Image.open(str(path)).convert("RGB")
    w, h = img.size
    if max(w, h) > MAX_LONG_SIDE:
        scale = MAX_LONG_SIDE / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
    return b64, "image/jpeg"


# ── Vision prompt ──────────────────────────────────────────────────────────────

VISION_PROMPT = """Analyze this grocery/pantry item image and return ONLY a JSON object.
No markdown, no explanation, just the raw JSON.

Required JSON schema:
{
  "item_name": "<brand and product name, e.g. Hunts Diced Tomatoes>",
  "total_volume": "<size on label, e.g. 14.5 oz>",
  "estimated_qty_percent": <integer 0-100 based on visible fill level or fullness>,
  "exp_date": "<YYYY-MM-DD if visible on label, or today + typical shelf life if not visible>",
  "confidence": <float 0.0-1.0 reflecting your certainty about all fields>
}

Rules:
- estimated_qty_percent: 100 = factory sealed / unopened. 0 = empty.
- exp_date: Extract from the label. If the date is not visible, estimate using the product category typical shelf life (e.g. unopened canned goods = 2 years from today).
- confidence: 1.0 = crystal clear label with all info visible. 0.5 = blurry or partially obscured. Below 0.7 = very uncertain.
- Return ONLY the JSON object. No other text."""


# ── Single image API call ──────────────────────────────────────────────────────

async def _call_vision(
    client: httpx.AsyncClient,
    b64: str,
    mime: str,
    model: str,
) -> dict:
    """
    Send one image to the Claude vision API and return parsed JSON.
    Retries once on HTTP 429.
    """
    headers = {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
    }
    payload = {
        "model": model,
        "max_tokens": 512,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime,
                            "data": b64,
                        },
                    },
                    {"type": "text", "text": VISION_PROMPT},
                ],
            }
        ],
    }

    for attempt in range(2):
        resp = await client.post(ANTHROPIC_API_URL, headers=headers, json=payload)
        if resp.status_code == 429:
            if attempt == 0:
                await asyncio.sleep(RETRY_WAIT)
                continue
            resp.raise_for_status()
        elif not resp.is_success:
            resp.raise_for_status()
        break

    data = resp.json()
    text = data.get("content", [{}])[0].get("text", "{}").strip()

    # Strip any accidental markdown fences
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    text = text.strip()

    return json.loads(text)


# ── Per-image pipeline: Haiku → optional Sonnet fallback ─────────────────────

async def _process_one(
    client: httpx.AsyncClient,
    path: str | Path,
    index: int,
) -> dict:
    """
    Process a single image through the full Haiku→Sonnet pipeline.
    Returns a validated PantryItem dict with extra metadata.
    """
    try:
        b64, mime = preprocess_image(path)
    except Exception as e:
        return {
            "index": index,
            "error": f"Image preprocessing failed: {e}",
            "item_name": "Unknown",
            "confidence": 0.0,
        }

    fallback_used = False
    low_confidence = False

    try:
        raw = await _call_vision(client, b64, mime, HAIKU_MODEL)
        confidence = float(raw.get("confidence", 0.0))

        if confidence < CONFIDENCE_THRESHOLD:
            # Try Sonnet for better accuracy
            try:
                sonnet_raw = await _call_vision(client, b64, mime, SONNET_MODEL)
                sonnet_confidence = float(sonnet_raw.get("confidence", 0.0))
                if sonnet_confidence >= CONFIDENCE_THRESHOLD:
                    raw = sonnet_raw
                    fallback_used = True
                else:
                    low_confidence = True   # Both models uncertain
            except Exception:
                low_confidence = True       # Sonnet call failed; keep Haiku result

        raw["fallback_used"] = fallback_used
        raw["low_confidence"] = low_confidence
        raw["index"] = index
        raw["source_path"] = str(path)

        # Validate with Pydantic
        item = PantryItem(**raw)
        return item.model_dump() | {"index": index, "source_path": str(path)}

    except Exception as e:
        return {
            "index": index,
            "source_path": str(path),
            "error": str(e),
            "item_name": "Unknown",
            "total_volume": "Unknown",
            "estimated_qty_percent": 0,
            "exp_date": "Unknown",
            "confidence": 0.0,
            "fallback_used": False,
            "low_confidence": True,
        }


# ── Main batch entry point ─────────────────────────────────────────────────────

async def process_batch(image_paths: List[str | Path]) -> List[dict]:
    """
    Process up to MAX_BATCH_SIZE images in parallel using Claude Vision.

    Args:
        image_paths: List of local file paths (jpg, png, heic, etc.)

    Returns:
        List of dicts matching the PantryItem schema, in original order.
        Each entry includes 'index', 'source_path', and optionally 'error'.
    """
    if not ANTHROPIC_API_KEY:
        raise EnvironmentError("ANTHROPIC_API_KEY is not set in the environment.")

    paths = list(image_paths)[:MAX_BATCH_SIZE]

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        tasks = [_process_one(client, p, i) for i, p in enumerate(paths)]
        results = await asyncio.gather(*tasks, return_exceptions=False)

    # Return in original order
    return sorted(results, key=lambda r: r.get("index", 0))


# ── Display / review helper ────────────────────────────────────────────────────

def display_review(items: List[dict]) -> List[dict]:
    """
    Prepare items for a review table.
    Adds 'confidence_badge' field: 'red' | 'yellow' | 'green'.

    This is a data-only stub; your UI layer renders the actual table.
    """
    reviewed = []
    for item in items:
        conf = item.get("confidence", 0.0)
        badge = "green" if conf >= CONFIDENCE_THRESHOLD else ("yellow" if conf >= 0.6 else "red")
        reviewed.append({
            **item,
            "confidence_badge": badge,
            "model_used": (SONNET_MODEL if item.get("fallback_used") else HAIKU_MODEL),
        })
    return reviewed


def commit_to_pantry(reviewed_items: List[dict]) -> None:
    """
    Stub — call database.insert_items after the user confirms the review list.
    Import from database module to wire this up.
    """
    try:
        from database import insert_items
        insert_items(reviewed_items)
        print(f"[Scanner] Committed {len(reviewed_items)} items to pantry.")
    except ImportError:
        print("[Scanner] database.py not found — items not persisted.")


# ── CLI for quick testing ──────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python pantry_scanner.py photo1.jpg [photo2.jpg ...]")
        sys.exit(1)

    paths = sys.argv[1:]
    print(f"Processing {len(paths)} image(s)...")
    results = asyncio.run(process_batch(paths))
    reviewed = display_review(results)

    for r in reviewed:
        flag = "⚠️ LOW CONF" if r.get("low_confidence") else ("🔄 SONNET" if r.get("fallback_used") else "✓ HAIKU")
        print(
            f"[{r['confidence_badge'].upper()}] {r.get('item_name','?')} | "
            f"{r.get('total_volume','?')} | "
            f"{r.get('estimated_qty_percent','?')}% full | "
            f"exp {r.get('exp_date','?')} | "
            f"conf {r.get('confidence',0):.2f} {flag}"
        )
