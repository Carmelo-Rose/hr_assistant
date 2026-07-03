"""Browser manager for BOSS scraping.

Default: attach via CDP to a Chrome the user launched manually with
--remote-debugging-port. A normally-launched Chrome (real profile, no automation
flags) is what BOSS's anti-bot trusts — verified working against Chrome 149.

Fallback: Playwright's bundled Chromium with a persistent profile
(`data/pw_profile`). Convenient and version-matched, but it is an
automation-launched browser, so BOSS may flag it and bounce pages to
about:blank. Set BOSS_FORCE_BUNDLED=1 to skip CDP and use it directly.

Note on the `Browser.setDownloadBehavior: Browser context management is not
supported` error some users hit on connect: it stems from attaching to an
already-running multi-window Chrome. Fully quit Chrome first, then launch a
clean dedicated debug instance.
"""

import asyncio
import json
import logging
import os
import random
from typing import Optional

from playwright.async_api import async_playwright, BrowserContext

logger = logging.getLogger(__name__)

_context: Optional[BrowserContext] = None
_playwright = None
_cdp_url = None
_is_owned_browser = False  # did we launch it ourselves?

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "data")
COOKIES_DIR = os.path.join(DATA_DIR, "browser_cookies")
COOKIES_FILE = os.path.join(COOKIES_DIR, "boss_cookies.json")
CHROME_PROFILE_DIR = os.path.join(DATA_DIR, "browser_profile")
# Profile for Playwright's own bundled Chromium (version-matched, robust against
# system Chrome auto-updates). This is the default working path.
PW_PROFILE_DIR = os.path.join(DATA_DIR, "pw_profile")
CDP_DETECT_PORTS = [9222, 9229, 19222]
CDP_URL_ENV = os.environ.get("BOSS_CDP_URL", "http://localhost:9222")
# Default path is CDP: attach to a Chrome the user launched manually with
# --remote-debugging-port. A normally-launched Chrome (real profile, no
# automation flags) is what BOSS's anti-bot trusts. Playwright-LAUNCHED browsers
# (bundled Chromium or even channel="chrome") get flagged and bounced to
# about:blank, so the bundled-Chromium path is only a fallback. Set
# BOSS_FORCE_BUNDLED=1 to skip CDP and go straight to bundled Chromium.
FORCE_BUNDLED = os.environ.get("BOSS_FORCE_BUNDLED", "").strip().lower() in ("1", "true", "yes")

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
    """Start a browser for BOSS scraping.

    Default path attaches via CDP to a Chrome the user launched manually with
    --remote-debugging-port. That is a normal, non-automated Chrome, which BOSS's
    anti-bot trusts. If no such Chrome is reachable, it falls back to Playwright's
    bundled Chromium (convenient, but BOSS may flag it). Set BOSS_FORCE_BUNDLED=1
    to skip CDP entirely.

    Returns (success, message, warning) — warning is non-empty when something
    needs the user's attention (CDP unreachable / not logged in to BOSS).
    """
    global _context, _playwright, _is_owned_browser

    if _context:
        alive = await _check_context_alive(_context)
        if alive:
            pages = _context.pages
            return True, f"Browser already connected, {len(pages)} page(s) open", ""
        await _stop_browser()

    _playwright = await async_playwright().start()

    # Preferred: attach to the user's manually-launched Chrome via CDP.
    cdp_error = ""
    if not FORCE_BUNDLED:
        ok, msg, cdp_error = await _connect_via_cdp()
        if ok:
            return True, msg, ""

    # Fallback: Playwright's bundled Chromium (auto, but anti-bot may bounce it).
    return await _launch_persistent_chromium(headless=headless, cdp_error=cdp_error)


async def _connect_via_cdp() -> tuple:
    """Try every CDP candidate. Returns (ok, message, warning)."""
    cdp_errors: list[str] = []

    cdp_candidates = [CDP_URL_ENV]
    # Also try 127.0.0.1 — some systems resolve "localhost" to IPv6 ::1 but
    # Chrome only binds to IPv4 127.0.0.1, causing connection refused.
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
    """Launch Playwright's bundled Chromium with a persistent profile.

    Fallback path used when CDP attach is unavailable. Login state lives in
    PW_PROFILE_DIR and survives restarts. Note: BOSS anti-bot may flag a
    Playwright-launched browser (bouncing pages to about:blank); the CDP path
    (attach to a manually-launched Chrome) is the reliable one, so we surface a
    hint to switch to it.
    """
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
    # Land on the dedicated login page and nothing else. Crucially we never open
    # the recruiter app (/web/boss/recommend) on startup: on a not-yet-
    # authenticated profile that runs a security-check that plants a half-session
    # and sends the window bouncing between login and app — which is exactly what
    # makes logging in impossible. The login page itself is safe in both states:
    # an already-authenticated session gets redirected from it into the app,
    # while an unauthenticated one shows the QR / code login form.
    final_url = ""
    try:
        await page.goto("https://login.zhipin.com/", wait_until="domcontentloaded", timeout=20000)
        await page.wait_for_timeout(3000)  # give a logged-in redirect a chance to fire
        final_url = page.url
    except Exception as e:
        logger.debug("Login-page navigation skipped: %s", e)

    # Only treat it as logged-in when we clearly landed inside the app. Anything
    # else (still on login page, blank, error) -> show the login hint. Detecting
    # BOSS login programmatically is unreliable (anti-bot redirects), so we bias
    # toward telling the user to log in rather than silently claiming success.
    logged_in = "zhipin.com/web/" in final_url and "login" not in final_url

    # Build the fallback warning. The bundled Chromium is automation-launched, so
    # BOSS may bounce its pages to about:blank — steer the user to the CDP path.
    cdp_line = f"（CDP 连接失败：{cdp_error.splitlines()[0]}）\n" if cdp_error else ""
    recommend_cdp = (
        "建议改用更稳的方式：先【完全退出】Chrome（⌘Q，确保没有任何 Chrome 窗口），再用调试端口启动一个干净实例：\n"
        f"/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\\n"
        f"  --remote-debugging-port=9222 \\\n"
        f"  --user-data-dir=\"{CHROME_PROFILE_DIR}\" \\\n"
        f"  --no-first-run\n"
        "在那个窗口登录 BOSS 招聘账号，再回来点「启动浏览器」。手动启动的普通 Chrome 不会被反爬识别。"
    )

    if logged_in:
        # Even if it looks logged-in, the bundled browser is fragile against
        # anti-bot, so still nudge toward CDP.
        return True, "已启动内置 Chromium（已是登录态）", (
            "已用内置 Chromium 连接（登录态已就绪）。\n"
            "注意：内置 Chromium 是自动化浏览器，BOSS 反爬可能在使用中把页面弹回 about:blank。\n"
            + recommend_cdp
        )

    warning = (
        "已回退到内置 Chromium。" + cdp_line +
        "内置 Chromium 是自动化浏览器，BOSS 反爬可能把页面弹回 about:blank、导致无法登录或采集。\n\n"
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
        # Always close the context: for the persistent (owned) browser this
        # shuts Chromium down and releases the profile-dir lock; for a CDP
        # attachment it just detaches.
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
