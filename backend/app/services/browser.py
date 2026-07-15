"""Browser manager for BOSS scraping.

Default: attach via CDP to a Chrome the user launched manually with
``--remote-debugging-port``. A normally launched Chrome (real profile, no
automation flags) is what BOSS's anti-bot trusts.

Fallback: Playwright's bundled Chromium with a persistent profile under
``data/pw_profile``. This works as a backup path, but BOSS may flag it and
bounce pages to ``about:blank`` because it is automation launched.
"""

import asyncio
import json
import logging
import os
import random
import sys
from typing import Optional

from playwright.async_api import BrowserContext, async_playwright

logger = logging.getLogger(__name__)

_context: Optional[BrowserContext] = None
_playwright = None
_cdp_url = None
_is_owned_browser = False

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "data")
COOKIES_DIR = os.path.join(DATA_DIR, "browser_cookies")
COOKIES_FILE = os.path.join(COOKIES_DIR, "boss_cookies.json")
CHROME_PROFILE_DIR = os.path.join(DATA_DIR, "browser_profile")
PW_PROFILE_DIR = os.path.join(DATA_DIR, "pw_profile")
CDP_DETECT_PORTS = [9222, 9229, 19222]
CDP_URL_ENV = os.environ.get("BOSS_CDP_URL", "http://localhost:9222")
FORCE_BUNDLED = os.environ.get("BOSS_FORCE_BUNDLED", "").strip().lower() in ("1", "true", "yes")

MIN_DELAY = 1.5
MAX_DELAY = 4.0


async def _try_cdp_connect(url: str) -> tuple[bool, str]:
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
        return True, ""
    except Exception as e:
        err = str(e)
        logger.warning("CDP connect to %s failed: %s", url, err)
        return False, err


async def _load_cookies(ctx: BrowserContext):
    if not os.path.exists(COOKIES_FILE):
        return
    try:
        with open(COOKIES_FILE, "r", encoding="utf-8") as f:
            cookies = json.load(f)
        await ctx.add_cookies(cookies)
    except Exception as e:
        logger.debug("Cookie load skipped: %s", e)


async def _save_cookies(ctx: BrowserContext):
    os.makedirs(COOKIES_DIR, exist_ok=True)
    try:
        cookies = await ctx.cookies()
        with open(COOKIES_FILE, "w", encoding="utf-8") as f:
            json.dump(cookies, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.debug("Cookie save skipped: %s", e)


def _build_cdp_launch_hint(profile_dir: str) -> str:
    if sys.platform == "darwin":
        quit_hint = "先完全退出 Chrome（⌘Q，确保没有任何 Chrome 窗口）"
        launch_cmd = (
            "/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\\n"
            "  --remote-debugging-port=9222 \\\n"
            f"  --user-data-dir=\"{profile_dir}\" \\\n"
            "  --no-first-run"
        )
    elif os.name == "nt":
        quit_hint = "先完全退出 Chrome（确保任务栏里也没有残留窗口）"
        launch_cmd = (
            "& \"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\" "
            f"--remote-debugging-port=9222 --user-data-dir=\"{profile_dir}\" --no-first-run\n"
            "如果 Chrome 不在默认安装路径，也可以改用：\n"
            "& \"$env:LOCALAPPDATA\\Google\\Chrome\\Application\\chrome.exe\" "
            f"--remote-debugging-port=9222 --user-data-dir=\"{profile_dir}\" --no-first-run"
        )
    else:
        quit_hint = "先完全退出 Chrome"
        launch_cmd = (
            "google-chrome \\\n"
            "  --remote-debugging-port=9222 \\\n"
            f"  --user-data-dir=\"{profile_dir}\" \\\n"
            "  --no-first-run"
        )

    return (
        f"建议改用更稳的方式：{quit_hint}，再用调试端口启动一个干净实例：\n"
        f"{launch_cmd}\n"
        "在那个窗口登录 BOSS 招聘账号，再回来点“启动浏览器”。"
        "手动启动的普通 Chrome 更不容易触发反爬。"
    )


async def start_browser(user_data_dir: str = CHROME_PROFILE_DIR, headless: bool = False) -> tuple:
    """Start a browser for BOSS scraping."""
    global _context, _playwright

    if _context:
        alive = await _check_context_alive(_context)
        if alive:
            return True, f"Browser already connected, {len(_context.pages)} page(s) open", ""
        await _stop_browser()

    _playwright = await async_playwright().start()

    cdp_error = ""
    if not FORCE_BUNDLED:
        ok, msg, cdp_error = await _connect_via_cdp()
        if ok:
            return True, msg, ""

    return await _launch_persistent_chromium(headless=headless, cdp_error=cdp_error)


async def _connect_via_cdp() -> tuple[bool, str, str]:
    cdp_errors: list[str] = []

    cdp_candidates = [CDP_URL_ENV]
    if "localhost" in CDP_URL_ENV:
        cdp_candidates.append(CDP_URL_ENV.replace("localhost", "127.0.0.1"))

    seen = set()
    for url in cdp_candidates:
        seen.add(url)
        ok, err = await _try_cdp_connect(url)
        if ok:
            return True, f"Connected via CDP: {url}", ""
        if err:
            cdp_errors.append(f"{url}: {err}")

    for port in CDP_DETECT_PORTS:
        for host in ("localhost", "127.0.0.1"):
            url = f"http://{host}:{port}"
            if url in seen:
                continue
            seen.add(url)
            ok, err = await _try_cdp_connect(url)
            if ok:
                return True, f"Auto-detected Chrome at {url}", ""
            if err:
                cdp_errors.append(f"{url}: {err}")

    error_detail = "\n".join(cdp_errors[:3]) if cdp_errors else "连接超时或被拒绝"
    logger.warning("CDP connect failed, falling back to bundled Chromium:\n%s", error_detail)
    return False, "", error_detail


async def _launch_persistent_chromium(headless: bool = False, cdp_error: str = "") -> tuple:
    """Launch Playwright's bundled Chromium with a persistent profile."""
    global _context, _is_owned_browser

    os.makedirs(PW_PROFILE_DIR, exist_ok=True)
    _context = await _playwright.chromium.launch_persistent_context(
        PW_PROFILE_DIR,
        headless=headless,
        viewport={"width": 1440, "height": 900},
        locale="zh-CN",
        args=["--disable-blink-features=AutomationControlled"],
    )
    _is_owned_browser = True

    page = _context.pages[0] if _context.pages else await _context.new_page()
    final_url = ""
    try:
        await page.goto("https://login.zhipin.com/", wait_until="domcontentloaded", timeout=20000)
        await page.wait_for_timeout(3000)
        final_url = page.url
    except Exception as e:
        logger.debug("Login-page navigation skipped: %s", e)

    logged_in = "zhipin.com/web/" in final_url and "login" not in final_url
    cdp_line = f"（CDP 连接失败：{cdp_error.splitlines()[0]}）\n" if cdp_error else ""
    recommend_cdp = _build_cdp_launch_hint(CHROME_PROFILE_DIR)

    if logged_in:
        return True, "已启动内置 Chromium（已是登录态）", (
            "已用内置 Chromium 连接（登录态已就绪）。\n"
            "注意：内置 Chromium 是自动化浏览器，BOSS 反爬可能在使用中把页面弹回 about:blank。\n"
            + recommend_cdp
        )

    warning = (
        "已回退到内置 Chromium。\n"
        + cdp_line
        + "内置 Chromium 是自动化浏览器，BOSS 反爬可能把页面弹回 about:blank，导致无法登录或采集。\n\n"
        + recommend_cdp
    )
    return True, "已启动内置 Chromium（回退方案，建议改用 CDP）", warning


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
        try:
            await _context.close()
        except Exception:
            pass
    if _playwright:
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
