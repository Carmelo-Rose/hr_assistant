"""Persistent browser manager using CDP to connect to existing Chrome.

Strategies (in order):
1. Connect to user-specified CDP URL (BOSS_CDP_URL env)
2. Auto-detect Chrome debug port on common ports
3. Launch system Chrome with debug port + dedicated profile
4. Fallback: bare Chromium (last resort)
"""

import asyncio
import json
import logging
import os
import subprocess
import platform
import random
from typing import Optional

from playwright.async_api import async_playwright, BrowserContext, Page

logger = logging.getLogger(__name__)

_context: Optional[BrowserContext] = None
_playwright = None
_cdp_url = None
_is_owned_browser = False  # did we launch it ourselves?

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "data")
COOKIES_DIR = os.path.join(DATA_DIR, "browser_cookies")
COOKIES_FILE = os.path.join(COOKIES_DIR, "boss_cookies.json")
CHROME_PROFILE_DIR = os.path.join(DATA_DIR, "browser_profile")
CDP_DETECT_PORTS = [9222, 9229, 19222]
CDP_URL_ENV = os.environ.get("BOSS_CDP_URL", "http://localhost:9222")

MIN_DELAY = 1.5
MAX_DELAY = 4.0


async def _try_cdp_connect(url: str) -> bool:
    """Try to connect to Chrome via CDP at the given URL."""
    global _context, _playwright, _cdp_url
    try:
        browser = await _playwright.chromium.connect_over_cdp(url, timeout=8000)
        contexts = browser.contexts
        if contexts:
            _context = contexts[0]
        else:
            _context = await browser.new_context(
                viewport={"width": 1440, "height": 900},
                locale="zh-CN",
            )
        _cdp_url = url
        logger.info("Connected to Chrome via CDP: %s", url)
        return True
    except Exception as e:
        logger.debug("CDP connect to %s failed: %s", url, e)
        return False


async def _launch_system_chrome() -> Optional[int]:
    """Launch system Chrome with --remote-debugging-port using dedicated profile."""
    system = platform.system()
    if system == "Darwin":
        chrome_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    elif system == "Linux":
        chrome_path = "google-chrome"
    elif system == "Windows":
        chrome_path = r"C:\Program Files\Google Chrome\Application\chrome.exe"
    else:
        return None

    port = 9222
    os.makedirs(CHROME_PROFILE_DIR, exist_ok=True)

    try:
        subprocess.Popen(
            [chrome_path, f"--remote-debugging-port={port}",
             f"--user-data-dir={CHROME_PROFILE_DIR}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        for _ in range(20):
            await asyncio.sleep(1)
            try:
                import urllib.request
                urllib.request.urlopen(f"http://localhost:{port}/json/version", timeout=2)
                return port
            except Exception:
                continue
    except FileNotFoundError:
        logger.warning("Chrome not found at %s", chrome_path)
    except Exception as e:
        logger.warning("Failed to launch system Chrome: %s", e)
    return None


async def _load_cookies(ctx: BrowserContext):
    if os.path.exists(COOKIES_FILE):
        try:
            with open(COOKIES_FILE, "r") as f:
                cookies = json.load(f)
            await ctx.add_cookies(cookies)
        except Exception as e:
            logger.debug("Cookie load skipped: %s", e)


async def _save_cookies(ctx: BrowserContext):
    os.makedirs(COOKIES_DIR, exist_ok=True)
    try:
        cookies = await ctx.cookies()
        with open(COOKIES_FILE, "w") as f:
            json.dump(cookies, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.debug("Cookie save skipped: %s", e)


async def start_browser(user_data_dir: str = CHROME_PROFILE_DIR, headless: bool = False) -> tuple:
    """Connect to Chrome via CDP. Falls back to launching a new instance."""
    global _context, _playwright, _is_owned_browser

    if _context:
        alive = await _check_context_alive(_context)
        if alive:
            pages = _context.pages
            return True, f"Browser already connected, {len(pages)} page(s) open"
        await _stop_browser()

    _playwright = await async_playwright().start()

    # Strategy 1: configured CDP URL
    if await _try_cdp_connect(CDP_URL_ENV):
        return True, f"Connected via CDP: {CDP_URL_ENV}"

    # Strategy 2: auto-detect common ports
    for port in CDP_DETECT_PORTS:
        url = f"http://localhost:{port}"
        if url == CDP_URL_ENV:
            continue
        if await _try_cdp_connect(url):
            return True, f"Auto-detected Chrome at port {port}"

    # Strategy 3: launch system Chrome with debug port
    logger.info("No running Chrome found, launching system Chrome with debug port")
    port = await _launch_system_chrome()
    if port:
        url = f"http://localhost:{port}"
        if await _try_cdp_connect(url):
            _is_owned_browser = True
            return True, f"Launched system Chrome at port {port}"

    # Strategy 4: bare Chromium (last resort)
    logger.info("Falling back to bare Chromium (user must log in)")
    browser = await _playwright.chromium.launch(
        headless=headless,
        args=["--disable-blink-features=AutomationControlled"],
    )
    _context = await browser.new_context(
        viewport={"width": 1440, "height": 900},
        locale="zh-CN",
    )
    await _load_cookies(_context)
    page = await _context.new_page()
    await page.goto("https://www.zhipin.com", wait_until="domcontentloaded")
    _is_owned_browser = True
    return True, "Bare Chromium started (please log in to BOSS)"


async def _check_context_alive(ctx: BrowserContext) -> bool:
    try:
        browser = ctx.browser
        if browser is not None and not browser.is_connected():
            return False
        pages = ctx.pages
        if pages:
            await pages[0].evaluate("1+1")
        return True
    except Exception:
        return False


def get_browser_context() -> tuple:
    global _context
    if _context is None:
        return None, "Browser not connected. POST /api/browser/start first."
    try:
        browser = _context.browser
        if browser is not None and not browser.is_connected():
            _context = None
            return None, "Browser disconnected. POST /api/browser/start to reconnect."
        _ = _context.pages
        return _context, "ok"
    except Exception as e:
        _context = None
        return None, f"Browser context invalid: {e}"


async def _stop_browser():
    global _context, _playwright, _is_owned_browser
    if _context:
        await _save_cookies(_context)
        if not _is_owned_browser:
            try:
                await _context.close()
            except Exception:
                pass
    if _playwright:
        if _is_owned_browser:
            try:
                await _playwright.stop()
            except Exception:
                pass
        else:
            try:
                await _playwright.stop()
            except Exception:
                pass
    _context = None
    _playwright = None
    _is_owned_browser = False


async def stop_browser():
    await _stop_browser()


async def random_delay():
    await asyncio.sleep(random.uniform(MIN_DELAY, MAX_DELAY))
