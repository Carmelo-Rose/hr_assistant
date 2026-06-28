"""BOSS 直聘批量候选人搜索 — 通过 CDP 连接的 Chrome 操作招聘者端 SPA。

依赖 browser.py 的 CDP 连接，不走独立浏览器启动。
"""

import asyncio
import json
import logging
import os
import tempfile
import re
from typing import Optional

from app.services.browser import get_browser_context, random_delay

try:
    from PIL import Image
    from pyzbar.pyzbar import decode as decode_qr
    import io
    HAS_QR_DECODER = True
except ImportError:
    HAS_QR_DECODER = False

logger = logging.getLogger(__name__)

SCREENSHOT_DIR = os.path.join(
    os.path.dirname(__file__), "..", "..", "data", "screenshots"
)
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

# BOSS 招聘者端搜索页 URL
BOSS_SEARCH_URL = "https://www.zhipin.com/web/boss/recommend"

# JS: extract candidate info from card list
EXTRACT_CARDS_JS = """() => {
    const cards = document.querySelectorAll("li.geek-info-card");
    const results = [];

    for (let idx = 0; idx < cards.length; idx++) {
        const card = cards[idx];
        const text = card.innerText || "";
        const link = card.querySelector("a[data-contact]");
        const lines = text.split("\\n").map(l => l.trim()).filter(l => l);

        const name = lines[0] || "未知";
        let age = "", experience = "", education = "", jobStatus = "", salary = "";
        for (const line of lines) {
            const parts = line.split(/\\s{2,}/);
            if (parts.length >= 3) {
                for (const part of parts) {
                    if (part.includes("岁")) age = part;
                    else if (part.includes("年")) experience = part;
                    else if (["本科", "硕士", "博士", "大专", "高中"].some(e => part.includes(e))) education = part;
                    else if (part.includes("离职") || part.includes("在职") || part.includes("到岗")) jobStatus = part;
                    else if (part.includes("K") || part.includes("k") || part.includes("面议") || part.includes("薪")) salary = part;
                }
                if (age || experience) break;
            }
        }

        const skillEls = card.querySelectorAll(".rcd-tags span, .tag-item, [class*='tag']");
        const skills = Array.from(skillEls).map(el => el.innerText.trim()).filter(s => s.length > 0 && s.length < 20);

        let expectCity = "";
        const cityIdx = lines.findIndex(l => l === "期望城市");
        if (cityIdx >= 0 && lines[cityIdx + 1]) expectCity = lines[cityIdx + 1];
        if (!expectCity) {
            const expIdx = lines.findIndex(l => l === "期望");
            if (expIdx >= 0 && lines[expIdx + 1]) expectCity = lines[expIdx + 1];
        }

        let company = "", title = "";
        const posIdx = lines.findIndex(l => l === "职位");
        if (posIdx >= 0) {
            company = lines[posIdx + 1] || "";
            title = lines[posIdx + 2] || "";
        }

        let school = "", major = "";
        const eduIdx = lines.findIndex(l => l === "院校");
        if (eduIdx >= 0) {
            school = lines[eduIdx + 1] || "";
            major = lines[eduIdx + 2] || "";
        }

        const expectId = link ? link.getAttribute("data-expect") : "";
        const lid = link ? link.getAttribute("data-lid") : "";
        const jid = link ? link.getAttribute("data-jid") : "";

        results.push({
            index: idx, name, age, experience, education, jobStatus, salary,
            skills: skills.slice(0, 8),
            expectCity, company, title, school, major,
            expectId, lid, jid,
            fullText: text.slice(0, 500),
        });
    }
    return results;
}"""


async def _get_page():
    ctx, msg = get_browser_context()
    if not ctx:
        raise RuntimeError(f"Browser not available: {msg}")
    pages = ctx.pages
    if pages:
        return pages[-1]
    return await ctx.new_page()


async def _navigate_to_search(page):
    """Navigate to recruiter search page and return the search iframe."""
    search_menu = await page.query_selector("dl.menu-geeksearch")
    if not search_menu:
        logger.info("Navigating to recruiter search page: %s", BOSS_SEARCH_URL)
        await page.goto(BOSS_SEARCH_URL, wait_until="domcontentloaded")
        await asyncio.sleep(3)
        search_menu = await page.query_selector("dl.menu-geeksearch")
        if not search_menu:
            return None

    await search_menu.click()
    await asyncio.sleep(2)

    iframe_el = await page.query_selector("#searchContent iframe")
    if not iframe_el:
        return None
    return await iframe_el.content_frame()


async def _cleanup_dialogs(page):
    """Remove dialog overlays that block interactions."""
    await page.evaluate("""() => {
        document.querySelectorAll('div.dialog-wrap').forEach(d => d.remove());
        document.querySelectorAll('.boss-layer__wrapper').forEach(l => l.remove());
        document.querySelectorAll('.boss-popup__wrapper').forEach(l => l.remove());
    }""")


async def search_candidates(
    keyword: str,
    city: str = "",
    count: int = 30,
) -> list[dict]:
    """批量搜索候选人，返回卡片列表数据。

    Args:
        keyword: 搜索关键词
        city: 城市名（如 "北京"）
        count: 期望获取数量，默认 30

    Returns:
        候选人列表，每个包含 name/age/experience/education/salary/skills/expectId 等
    """
    page = await _get_page()
    frame = await _navigate_to_search(page)
    if not frame:
        return [{"error": "无法找到搜索 iframe，请确认已登录 BOSS 招聘者后台"}]

    search_input = await frame.query_selector("input.search-input")
    if not search_input:
        return [{"error": "无法找到搜索输入框"}]

    await search_input.click()
    await search_input.fill("")
    await search_input.type(keyword, delay=80)
    await asyncio.sleep(0.5)
    await search_input.press("Enter")
    await asyncio.sleep(3)

    try:
        await frame.wait_for_selector("li.geek-info-card", timeout=10000)
    except Exception:
        return [{"error": "搜索超时，未找到候选人卡片"}]

    await random_delay()

    # Scroll to load more
    if count > 30:
        loaded = await frame.evaluate(
            'document.querySelectorAll("li.geek-info-card").length'
        )
        max_rounds = min((count - loaded) // 14 + 2, 25)
        for _ in range(max_rounds):
            if loaded >= count:
                break
            await frame.evaluate(
                "document.documentElement.scrollTop = document.documentElement.scrollHeight"
            )
            await asyncio.sleep(2)
            new_loaded = await frame.evaluate(
                'document.querySelectorAll("li.geek-info-card").length'
            )
            if new_loaded == loaded:
                break
            loaded = new_loaded

    candidates = await frame.evaluate(EXTRACT_CARDS_JS)
    return candidates


async def view_candidate_by_index(index: int) -> dict:
    """点击第 N 个候选人卡片，截图简历。

    Args:
        index: 0-based 索引

    Returns:
        截图路径、候选人 ID、分享链接等
    """
    page = await _get_page()

    await _cleanup_dialogs(page)

    iframe_el = await page.query_selector("#searchContent iframe")
    if not iframe_el:
        return {"error": "未找到搜索 iframe"}
    frame = await iframe_el.content_frame()
    if not frame:
        return {"error": "无法获取搜索 iframe"}

    clicked = await frame.evaluate(f"""() => {{
        const cards = document.querySelectorAll("li.geek-info-card a[data-contact]");
        if ({index} >= cards.length) return false;
        cards[{index}].click();
        return true;
    }}""")

    if not clicked:
        return {"error": f"索引 {index} 超出范围"}

    await asyncio.sleep(3)

    dialog = await page.query_selector("div.boss-dialog__body")
    if not dialog:
        dialog = await page.query_selector("div.dialog-wrap.active")
    if not dialog:
        return {"error": "未找到简历弹窗"}

    screenshot = await dialog.screenshot()
    screenshot_path = os.path.join(SCREENSHOT_DIR, f"resume_{index}.png")
    with open(screenshot_path, "wb") as f:
        f.write(screenshot)

    ids = await page.evaluate("""() => {
        const el = document.querySelector('[data-geekid]');
        if (!el) return {};
        return {
            geekId: el.getAttribute('data-geekid') || '',
            expectId: el.getAttribute('data-expectid') || '',
            jid: el.getAttribute('data-jid') || '',
        };
    }""")

    await _cleanup_dialogs(page)

    return {
        "screenshot": screenshot_path,
        "ids": ids,
        "index": index,
    }


async def multi_search(
    keywords: list[str],
    city: str = "",
    count_per_keyword: int = 50,
) -> list[dict]:
    """多关键词批量搜索，自动去重。

    Args:
        keywords: 关键词列表
        city: 城市
        count_per_keyword: 每个关键词获取数量

    Returns:
        去重后的候选人列表
    """
    seen_ids = set()
    all_candidates = []

    for kw in keywords:
        try:
            raw = await search_candidates(kw, city, count_per_keyword)
        except Exception as e:
            logger.warning("搜索 '%s' 失败: %s", kw, e)
            continue

        if raw and isinstance(raw[0], dict) and raw[0].get("error"):
            logger.warning("搜索 '%s' 返回错误: %s", kw, raw[0]["error"])
            continue

        new_count = 0
        for c in raw:
            eid = c.get("expectId", "")
            if eid and eid in seen_ids:
                continue
            if eid:
                seen_ids.add(eid)
            c["_source_keyword"] = kw
            all_candidates.append(c)
            new_count += 1

        logger.info("关键词 '%s': 获取 %d, 新增 %d", kw, len(raw), new_count)

    return all_candidates
