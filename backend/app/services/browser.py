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


async def _try_cdp_connect(url: str) -> tuple[bool, str]:
    """Try to connect to Chrome via CDP at the given URL.

    Returns (success, error_message).
    """
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
        return True, ""
    except Exception as e:
        err = str(e)
        logger.warning("CDP connect to %s failed: %s", url, err)
        return False, err


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
    """Connect to Chrome via CDP. Falls back to launching a new instance.

    Returns (success, message, warning) — warning is non-empty when we fell
    back to launching a fresh Chrome instead of attaching to an existing one.
    """
    global _context, _playwright, _is_owned_browser

    if _context:
        alive = await _check_context_alive(_context)
        if alive:
            pages = _context.pages
            return True, f"Browser already connected, {len(pages)} page(s) open", ""
        await _stop_browser()

    _playwright = await async_playwright().start()

    cdp_errors: list[str] = []

    # Strategy 1: configured CDP URL (localhost + 127.0.0.1 variants)
    cdp_candidates = [CDP_URL_ENV]
    # Also try 127.0.0.1 — some systems resolve "localhost" to IPv6 ::1 but
    # Chrome only binds to IPv4 127.0.0.1, causing connection refused.
    if "localhost" in CDP_URL_ENV:
        cdp_candidates.append(CDP_URL_ENV.replace("localhost", "127.0.0.1"))
    for url in cdp_candidates:
        ok, err = await _try_cdp_connect(url)
        if ok:
            return True, f"Connected via CDP: {url}", ""
        if err:
            cdp_errors.append(f"{url}: {err}")

    # Strategy 2: auto-detect common ports (both localhost and 127.0.0.1)
    for port in CDP_DETECT_PORTS:
        for host in ("localhost", "127.0.0.1"):
            url = f"http://{host}:{port}"
            if url in cdp_candidates:
                continue
            ok, err = await _try_cdp_connect(url)
            if ok:
                return True, f"Auto-detected Chrome at {url}", ""
            if err:
                cdp_errors.append(f"{url}: {err}")

    error_detail = "\n".join(cdp_errors[:3]) if cdp_errors else "连接超时或被拒绝"
    _FALLBACK_WARNING = (
        f"无法连接到已有 Chrome 的调试端口，已启动一个全新的 Chrome 窗口。\n"
        f"这个新窗口没有你的 BOSS 登录态，搜索功能将无法使用。\n\n"
        f"连接失败原因：{error_detail}\n\n"
        f"正确做法（在终端执行以下命令）：\n"
        f"/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\\n"
        f"  --remote-debugging-port=9222 \\\n"
        f"  --user-data-dir=\"{CHROME_PROFILE_DIR}\" \\\n"
        f"  --no-first-run\n\n"
        f"注意：Chrome v120+ 必须指定 --user-data-dir 才能开启远程调试，缺少该参数会导致端口无法绑定。\n"
        f"启动后在新 Chrome 窗口里登录 BOSS，再回来点击「启动浏览器」。\n\n"
        f"验证端口：curl http://127.0.0.1:9222/json/version（应返回 JSON）"
    )

    # Strategy 3: launch system Chrome with debug port
    logger.warning("CDP port not available, falling back to launching system Chrome")
    port = await _launch_system_chrome()
    if port:
        for host in ("127.0.0.1", "localhost"):
            url = f"http://{host}:{port}"
            ok, _ = await _try_cdp_connect(url)
            if ok:
                _is_owned_browser = True
                return True, f"Launched system Chrome at port {port}", _FALLBACK_WARNING

    # Strategy 4: bare Chromium (last resort)
    logger.warning("Falling back to bare Chromium (user must log in)")
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
    return True, "Bare Chromium started (please log in to BOSS)", _FALLBACK_WARNING


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
