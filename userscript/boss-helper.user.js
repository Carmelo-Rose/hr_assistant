// ==UserScript==
// @name         BOSS 招聘助手 — 油猴版
// @namespace    https://github.com/hr_assistant
// @version      1.16.0
// @description  在 BOSS 直聘页面内扫描候选人、评分、辅助/自动打招呼
// @match        https://www.zhipin.com/*
// @noframes
// @connect      localhost
// @updateURL    http://localhost:8000/boss-helper.user.js
// @downloadURL  http://localhost:8000/boss-helper.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  // Prevent duplicate panels caused by SPA route changes / iframe / multi-inject.
  // Use DOM check (works across separate window contexts) + window flag (fast path).
  if (window.top !== window.self) return;          // skip iframes
  if (window.__bhRunning) return;
  if (document.getElementById('boss-helper-panel')) return;
  window.__bhRunning = true;

  // ─── Configuration ────────────────────────────────────────────────
  const BACKEND = 'http://localhost:8000/api/ext';
  // `li.card-item` = 新版推荐/沟通页卡片（2026-07 起）；`li.geek-info-card` = 旧版人才库搜索页卡片。
  // 两个选择器并存，哪个页面用哪套 DOM 就匹配哪个。
  const CARD_SEL = 'li.card-item, li.geek-info-card';

  // ─── State ────────────────────────────────────────────────────────
  const state = {
    scanned: [],       // [{expectId, name, score, is_blocked, details, draft, cardEl}]
    mode: 'semi',      // 'semi' | 'auto'
    jobId: '',         // selected workbench job id (scoring profile)
    jobs: [],          // [{id, title}]
    llmEnabled: false, // backend has LLM configured → personalize greetings
    threshold: 70,
    dailyCap: 50,
    delayMin: 5,
    delayMax: 15,
    greetingCount: 0,
    autoRunning: false,
    multiPage: true,      // auto-scroll to load more before scoring
    maxCandidates: 300,   // stop loading after roughly this many cards
    configLoaded: false,
    todayKey: new Date().toISOString().slice(0, 10),
  };

  // Restore daily counter
  const savedDate = GM_getValue('boss_date', '');
  if (savedDate === state.todayKey) {
    state.greetingCount = GM_getValue('boss_count', 0);
  } else {
    GM_setValue('boss_date', state.todayKey);
    GM_setValue('boss_count', 0);
  }

  // ─── Helpers ──────────────────────────────────────────────────────
  function apiPost(path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: BACKEND + path,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body),
        onload: (res) => {
          try { resolve(JSON.parse(res.responseText)); }
          catch { reject(new Error('Parse error: ' + res.responseText.slice(0, 200))); }
        },
        onerror: (err) => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timeout')),
      });
    });
  }

  function apiGet(path) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: BACKEND + path,
        onload: (res) => {
          try { resolve(JSON.parse(res.responseText)); }
          catch { reject(new Error('Parse error')); }
        },
        onerror: () => reject(new Error('Network error')),
      });
    });
  }

  function randDelay() {
    return Math.floor(Math.random() * (state.delayMax - state.delayMin + 1) + state.delayMin) * 1000;
  }

  function incrCounter() {
    state.greetingCount++;
    GM_setValue('boss_count', state.greetingCount);
  }

  // ─── Helpers: collect all accessible documents (main + same-origin iframes) ──
  function getAllDocs() {
    const docs = [document];
    document.querySelectorAll('iframe').forEach(f => {
      try { if (f.contentDocument) docs.push(f.contentDocument); } catch {}
    });
    return docs;
  }

  // ─── Extract cards (same logic as EXTRACT_CARDS_JS) ──────────────
  function extractCards() {
    // Try each accessible document (main page + same-origin iframes)
    for (const doc of getAllDocs()) {
      const cards = doc.querySelectorAll(CARD_SEL);
      if (!cards.length) continue;
      return _extractFromCards(cards);
    }
    return [];
  }

  // Candidate identity: old DOM used `a[data-contact][data-expect]`; new DOM
  // (li.card-item) puts it on `.card-inner[data-geek]` instead. Try both.
  function getGeekIdEl(card) {
    return card.querySelector('a[data-contact]') || card.querySelector('[data-geek],[data-geekid]');
  }

  function _extractFromCards(cards) {
    const results = [];

    for (let idx = 0; idx < cards.length; idx++) {
      const card = cards[idx];
      const text = card.innerText || '';
      const idEl = getGeekIdEl(card);
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);

      const name = lines[0] || '未知';
      let age = '', experience = '', education = '', jobStatus = '', salary = '';
      for (const line of lines) {
        const parts = line.split(/\s{2,}/);
        if (parts.length >= 3) {
          for (const part of parts) {
            if (part.includes('岁')) age = part;
            else if (part.includes('年')) experience = part;
            else if (['本科', '硕士', '博士', '大专', '高中'].some(e => part.includes(e))) education = part;
            else if (part.includes('离职') || part.includes('在职') || part.includes('到岗')) jobStatus = part;
            else if (part.includes('K') || part.includes('k') || part.includes('面议') || part.includes('薪')) salary = part;
          }
          if (age || experience) break;
        }
      }

      const skillEls = card.querySelectorAll('.rcd-tags span, .tag-item, [class*="tag"]');
      const skills = Array.from(skillEls).map(el => el.innerText.trim()).filter(s => s.length > 0 && s.length < 20);

      let expectCity = '';
      const cityIdx = lines.findIndex(l => l === '期望城市');
      if (cityIdx >= 0 && lines[cityIdx + 1]) expectCity = lines[cityIdx + 1];
      if (!expectCity) {
        const expIdx = lines.findIndex(l => l === '期望');
        if (expIdx >= 0 && lines[expIdx + 1]) expectCity = lines[expIdx + 1];
      }

      let company = '', title = '';
      const posIdx = lines.findIndex(l => l === '职位');
      if (posIdx >= 0) {
        company = lines[posIdx + 1] || '';
        title = lines[posIdx + 2] || '';
      }

      let school = '', major = '';
      const eduIdx = lines.findIndex(l => l === '院校');
      if (eduIdx >= 0) {
        school = lines[eduIdx + 1] || '';
        major = lines[eduIdx + 2] || '';
      }

      const expectId = idEl
        ? (idEl.getAttribute('data-expect') || idEl.getAttribute('data-geek') || idEl.getAttribute('data-geekid') || '')
        : '';
      const lid = idEl ? (idEl.getAttribute('data-lid') || '') : '';
      const jid = idEl ? (idEl.getAttribute('data-jid') || '') : '';

      results.push({
        index: idx, name, age, experience, education, jobStatus, salary,
        skills: skills.slice(0, 8),
        expectCity, company, title, school, major,
        expectId, lid, jid,
        fullText: text.slice(0, 500),
        cardEl: card,  // DOM reference
      });
    }
    return results;
  }

  // ─── Diagnose: discover the real card / greet-button selectors ────
  // Runs entirely inside the page (no DevTools → no BOSS anti-debug reload).
  // Copies a JSON report to the clipboard for the user to paste back.
  function classSkeleton(el, depth, maxDepth) {
    if (!el || depth > maxDepth) return null;
    const cls = (el.getAttribute && el.getAttribute('class')) || '';
    const node = { tag: el.tagName ? el.tagName.toLowerCase() : '?', class: cls };
    const kids = [];
    for (const child of el.children || []) {
      const s = classSkeleton(child, depth + 1, maxDepth);
      if (s) kids.push(s);
      if (kids.length >= 8) break; // cap breadth
    }
    if (kids.length) node.children = kids;
    return node;
  }

  function diagnose() {
    const ourPanel = document.getElementById('boss-helper-panel');
    const allDocs = getAllDocs();

    // 1) Find repeating container classes across main page + iframes.
    //    Exclude our own panel.
    const tally = {};
    allDocs.forEach(doc => {
      doc.querySelectorAll('[class]').forEach(e => {
        if (ourPanel && ourPanel.contains(e)) return;
        (e.getAttribute('class') || '').trim().split(/\s+/).forEach(c => {
          if (c) tally[c] = (tally[c] || 0) + 1;
        });
      });
    });
    const repeating = Object.entries(tally)
      .filter(([k, v]) => v >= 4 && v <= 80 && /card|item|geek|list|rec|res|cell|row/i.test(k))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 18)
      .map(([k, v]) => `${k} ×${v}`);

    // 1b) Raw top-20 repeating classes (no name filter).
    const rawRepeating = Object.entries(tally)
      .filter(([k, v]) => v >= 3 && v <= 150)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([k, v]) => `${k} ×${v}`);

    // 2) Greet / chat buttons by visible text (search all docs).
    const greetRe = /^(打招呼|立即沟通|继续沟通|去沟通|沟通|联系Ta|联系TA)$/;
    const greet = [];
    allDocs.forEach(doc => {
      [...doc.querySelectorAll('button,a,span,div')]
        .filter(e => !ourPanel?.contains(e) && e.children.length === 0 && greetRe.test((e.textContent || '').trim()))
        .slice(0, 5)
        .forEach(b => {
          const p = b.parentElement;
          greet.push(`${b.tagName.toLowerCase()} | text="${b.textContent.trim()}" | class="${b.getAttribute('class') || ''}" | parentClass="${p?.getAttribute('class') || ''}"`);
        });
    });

    // 3) Pick the most likely card container with a non-trivial subtree.
    let skeleton = null, sampleSel = '', sampleDoc = 'main';
    const candidateClasses = Object.entries(tally)
      .filter(([k, v]) => v >= 3 && v <= 80)
      .sort((a, b) => b[1] - a[1]);
    outer: for (const [k] of candidateClasses) {
      for (let di = 0; di < allDocs.length; di++) {
        const el = allDocs[di].querySelector('.' + CSS.escape(k));
        if (el && el.querySelectorAll('*').length >= 4) {
          sampleSel = '.' + k;
          sampleDoc = di === 0 ? 'main' : `iframe[${di - 1}]`;
          skeleton = classSkeleton(el, 0, 4);
          break outer;
        }
      }
    }

    // 4) Pagination probe: dump elements that look like a "下一页" control and
    //    any pagination component's outerHTML (trimmed) so we can target it.
    const pagination = [];
    allDocs.forEach((doc, di) => {
      [...doc.querySelectorAll('a,button,li,span,div,i')]
        .filter(e => /^\s*(下一页|下页|下一頁)\s*$/.test(e.textContent || ''))
        .slice(0, 4)
        .forEach(e => {
          const c = e.closest('a,button,li') || e;
          pagination.push(`doc${di} | ${c.tagName.toLowerCase()} | class="${c.getAttribute('class') || ''}" | html=${(c.outerHTML || '').slice(0, 160)}`);
        });
      const pager = doc.querySelector('[class*="pagination"],[class*="pager"],[class*="page-nav"]');
      if (pager) pagination.push(`doc${di} PAGER | class="${pager.getAttribute('class')}" | html=${(pager.outerHTML || '').slice(0, 300)}`);
    });

    // 5) Scroll container probe: walk up from the first card to the scrollable
    //    ancestor (the element infinite-scroll listens on).
    let scrollContainer = '（无卡片）';
    const cardDoc = getCardDoc();
    if (cardDoc) {
      const firstCard = cardDoc.querySelector(CARD_SEL);
      const sc = scrollableAncestor(firstCard);
      if (sc) {
        scrollContainer = `${sc.tagName.toLowerCase()} | class="${sc.getAttribute('class') || ''}" | scrollH=${sc.scrollHeight} clientH=${sc.clientHeight}`;
      }
    }

    // 6) Full HTML dump for the most likely per-candidate card class (any class
    //    whose element count is close to the visible candidate count), so we can
    //    redesign the extractor when `li.geek-info-card` no longer matches.
    const cardHtmlSamples = {};
    const probeClasses = candidateClasses
      .filter(([k, v]) => v >= 5 && v <= 40 && /card|item|wrap/i.test(k))
      .slice(0, 10)
      .map(([k]) => k);
    outer2: for (const k of probeClasses) {
      for (let di = 0; di < allDocs.length; di++) {
        const el = allDocs[di].querySelector('.' + CSS.escape(k));
        if (!el) continue;
        const dataAttrs = [];
        el.querySelectorAll('*').forEach(child => {
          for (const attr of child.attributes || []) {
            if (attr.name.startsWith('data-')) dataAttrs.push(`${child.tagName.toLowerCase()}[${attr.name}="${attr.value}"]`);
          }
        });
        for (const attr of el.attributes || []) {
          if (attr.name.startsWith('data-')) dataAttrs.push(`SELF[${attr.name}="${attr.value}"]`);
        }
        cardHtmlSamples[k] = {
          doc: di === 0 ? 'main' : `iframe[${di - 1}]`,
          outerHTML: (el.outerHTML || '').slice(0, 3000),
          dataAttrs: dataAttrs.slice(0, 20),
        };
        if (Object.keys(cardHtmlSamples).length >= 6) break outer2;
      }
    }

    const report = {
      url: location.href,
      iframeCount: allDocs.length - 1,
      cardCandidates: repeating,
      rawTopClasses: rawRepeating,
      greetButtons: greet.length ? greet : '（未找到"打招呼/沟通/联系Ta"按钮，可能要 hover 或进详情页才出现）',
      pagination: pagination.length ? pagination : '（未找到"下一页"控件）',
      scrollContainer,
      sampleContainer: sampleSel,
      sampleDoc,
      sampleSkeleton: skeleton,
      cardHtmlSamples,
    };
    const text = 'BOSS-DIAG\n' + JSON.stringify(report, null, 2);
    try { GM_setClipboard(text); } catch (e) { /* ignore */ }
    window.__bhDiag = text; // fallback access
    setStatus('诊断完成：结果已复制到剪贴板，粘贴给我即可');
    return text;
  }

  // ─── Detect safety hazards ────────────────────────────────────────
  function checkHazards() {
    for (const doc of getAllDocs()) {
      // Captcha / verification dialog
      const captchaEl = doc.querySelector('[class*="captcha"], [class*="verify"]');
      if (captchaEl && captchaEl.offsetParent !== null) return 'captcha';

      // "操作频繁" or "达到上限" dialog
      const dialogs = doc.querySelectorAll('div.dialog-wrap, .boss-layer__wrapper, .boss-popup__wrapper');
      for (const d of dialogs) {
        const t = d.innerText || '';
        if (t.includes('操作频繁') || t.includes('达到上限') || t.includes('验证')) return 'limit_dialog';
      }
    }
    return null;
  }

  // ─── Pagination: the talent list uses page buttons, not infinite scroll ──
  function getCardDoc() {
    for (const doc of getAllDocs()) {
      if (doc.querySelector(CARD_SEL)) return doc;
    }
    return null;
  }

  // Click the "下一页" pagination control. Returns false if missing/disabled
  // (i.e. we're on the last page). Clicking is normal navigation → low risk.
  function isDisabledEl(el) {
    if (!el) return false;
    const cls = el.getAttribute && (el.getAttribute('class') || '');
    return /disabl/i.test(cls || '') ||
      (el.getAttribute && el.getAttribute('aria-disabled') === 'true') ||
      el.disabled === true;
  }

  function clickNextPage() {
    const nextRe = /^\s*(下一页|下页|下一頁)\s*$/;
    for (const doc of getAllDocs()) {
      // Strategy 1: any element whose ENTIRE text is "下一页" (allows child
      // icon/span nodes). Pick the innermost match, then climb to a clickable.
      const textHits = [...doc.querySelectorAll('a,button,li,span,div,i')]
        .filter(e => nextRe.test(e.textContent || ''))
        .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      for (const el of textHits) {
        const clickable = el.closest('a,button,li') || el;
        if (isDisabledEl(clickable) || isDisabledEl(el)) return false; // last page
        clickable.click();
        return true;
      }
      // Strategy 2: class-based next button inside a pagination component.
      const byClass = doc.querySelector(
        'a[class*="next"]:not([class*="disabl"]),' +
        'button[class*="next"]:not([class*="disabl"]),' +
        'li[class*="next"]:not([class*="disabl"]),' +
        '[class*="pag"] [class*="next"]:not([class*="disabl"])'
      );
      if (byClass && !isDisabledEl(byClass)) {
        (byClass.closest('a,button,li') || byClass).click();
        return true;
      }
    }
    return false;
  }

  // Wait until the card list changes (next page rendered) or timeout.
  async function waitForPageChange(prevFirstId, maxMs = 8000) {
    const doc = getCardDoc();
    if (!doc) return false;
    const firstId = () => {
      const firstCard = doc.querySelector(CARD_SEL);
      const idEl = firstCard ? getGeekIdEl(firstCard) : null;
      if (idEl) return idEl.getAttribute('data-expect') || idEl.getAttribute('data-geek') || idEl.getAttribute('data-geekid');
      return doc.querySelectorAll(CARD_SEL).length;
    };
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      await sleep(400);
      if (firstId() !== prevFirstId) return true;
    }
    return false;
  }

  // ─── Infinite scroll: the talent list lazy-appends cards as you scroll ───
  // Find the actual scrollable container (an inner div, NOT the iframe doc) by
  // walking up from a card to the first overflow:auto/scroll ancestor.
  function scrollableAncestor(el) {
    if (!el) return null;
    const win = el.ownerDocument.defaultView || window;
    let node = el.parentElement;
    while (node && node !== el.ownerDocument.documentElement) {
      const s = win.getComputedStyle(node);
      if (/(auto|scroll)/.test(s.overflowY) && node.scrollHeight > node.clientHeight + 20) {
        return node;
      }
      node = node.parentElement;
    }
    return el.ownerDocument.scrollingElement || el.ownerDocument.documentElement;
  }

  // Scroll to load more cards. Stops when the count plateaus (3 flat rounds),
  // the target is reached, a hazard appears, or maxRounds is hit. Falls back to
  // clicking "下一页" if scrolling stalls but a next button exists.
  async function autoLoad(targetCards, maxRounds = 40) {
    const doc = getCardDoc();
    if (!doc) return 0;
    const win = doc.defaultView || window;
    const count = () => doc.querySelectorAll(CARD_SEL).length;
    let prev = count(), stagnant = 0;

    for (let i = 0; i < maxRounds; i++) {
      if (checkHazards()) {
        setStatus('检测到风控弹窗，停止加载', true);
        break;
      }
      const cards = doc.querySelectorAll(CARD_SEL);
      if (cards.length >= targetCards) break;

      const last = cards[cards.length - 1];
      const sc = scrollableAncestor(last);

      // Incremental, human-like scroll that fires real scroll/wheel events —
      // lazy loaders (IntersectionObserver / scroll listeners) need these; a
      // single jump to scrollHeight often doesn't trigger a fetch.
      const step = Math.max(300, (sc.clientHeight || 800) * 0.85);
      for (let s = 0; s < 5; s++) {
        if (sc) sc.scrollTop = Math.min(sc.scrollTop + step, sc.scrollHeight);
        try { win.dispatchEvent(new Event('scroll')); } catch {}
        try { sc.dispatchEvent(new Event('scroll', { bubbles: true })); } catch {}
        try { (sc || doc).dispatchEvent(new WheelEvent('wheel', { deltaY: step, bubbles: true })); } catch {}
        await sleep(250 + Math.floor(Math.random() * 200));
        if (sc && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 5) break; // hit bottom
      }
      if (last) last.scrollIntoView({ block: 'end' });

      setStatus(`加载中… 已加载 ${count()} 人`);
      await sleep(900 + Math.floor(Math.random() * 900)); // settle: let the fetch land

      const now = count();
      if (now === prev) {
        stagnant++;
        // Scrolling stalled — try a pagination next button before giving up.
        if (stagnant === 2 && clickNextPage()) {
          await sleep(1500 + Math.floor(Math.random() * 1500));
          stagnant = 0;
        } else if (stagnant >= 3) {
          break; // truly reached the end
        }
      } else {
        stagnant = 0;
        prev = now;
      }
    }
    return count();
  }

  // ─── Fill chat input ──────────────────────────────────────────────
  function fillChatInput(text) {
    const selectors = [
      'textarea[class*="chat-input"]',
      'textarea[class*="message-input"]',
      'div[class*="chat"] textarea',
      'textarea[placeholder*="说"]',
      'textarea[placeholder*="输入"]',
      '[contenteditable="true"][class*="chat"]',
      '[contenteditable="true"][class*="message"]',
      '[class*="chat-input"] [contenteditable="true"]',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'textarea' || tag === 'input') {
          // Use native input setter to trigger React reconciliation
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          ).set;
          nativeInputValueSetter.call(el, text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.getAttribute('contenteditable') === 'true') {
          el.textContent = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      }
    }
    return false;
  }

  // ─── Click "打招呼" button on a card ──────────────────────────────
  function clickGreetBtn(cardEl) {
    // Try common BOSS greet button selectors
    const greetBtnSelectors = [
      'button.btn-getcontact',         // 人才库搜索页"联系Ta"按钮（当前 BOSS DOM）
      'button[class*="getcontact"]',
      'a.btn-greet',                   // 推荐/搜索页卡片上的招呼按钮
      'a[class*="greet"]',
      'button[class*="greet"]',
      'a[data-contact]',               // card link that opens chat
    ];
    for (const sel of greetBtnSelectors) {
      const btn = cardEl.querySelector(sel);
      if (btn) {
        btn.click();
        return true;
      }
    }
    // Fallback: find "沟通" / "打招呼" / "联系Ta" text node inside card (new BOSS DOM)
    const greetRe = /^(打招呼|立即沟通|继续沟通|去沟通|沟通|联系Ta|联系TA)$/;
    for (const el of cardEl.querySelectorAll('button,a,span,div')) {
      if (el.children.length === 0 && greetRe.test((el.textContent || '').trim())) {
        el.click();
        return true;
      }
    }
    return false;
  }

  // ─── Open a card's chat/profile WITHOUT sending (半自动 fill path) ─────
  // Old DOM: click the `a[data-contact]` card link. New DOM (li.card-item)
  // has no such link — best-effort click the name/avatar to open the panel.
  function openCardChat(cardEl) {
    const link = cardEl.querySelector('a[data-contact]');
    if (link) { link.click(); return true; }
    const target = cardEl.querySelector('.name-wrap .name, .name, .avatar-wrap, .avatar');
    if (target) { target.click(); return true; }
    return false;
  }

  // ─── Panel HTML ───────────────────────────────────────────────────
  GM_addStyle(`
    #boss-helper-panel {
      position: fixed; top: 80px; right: 20px; z-index: 99999;
      width: 340px; background: #fff; border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,.18); font-family: -apple-system, sans-serif;
      font-size: 13px; color: #333; user-select: none;
    }
    #boss-helper-panel.dragging { cursor: move; }
    .bh-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; background: #4f6ef7; color: #fff;
      border-radius: 12px 12px 0 0; cursor: move;
    }
    .bh-header h3 { margin: 0; font-size: 14px; font-weight: 600; }
    .bh-header .bh-close { cursor: pointer; font-size: 18px; line-height: 1; }
    .bh-body { padding: 12px 14px; }
    .bh-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .bh-row label { min-width: 70px; font-size: 12px; color: #666; }
    .bh-row input[type=number] { width: 60px; padding: 4px 6px; border: 1px solid #ddd; border-radius: 6px; }
    .bh-row input[type=range] { width: 120px; }
    .bh-row select { padding: 4px 6px; border: 1px solid #ddd; border-radius: 6px; }
    .bh-btn {
      display: inline-block; padding: 6px 14px; border-radius: 8px;
      font-size: 12px; cursor: pointer; border: none; font-weight: 500;
    }
    .bh-btn-primary { background: #4f6ef7; color: #fff; }
    .bh-btn-danger { background: #e74c3c; color: #fff; }
    .bh-btn-secondary { background: #f0f0f0; color: #333; }
    .bh-stats { font-size: 12px; color: #888; margin-bottom: 10px; }
    .bh-stats b { color: #4f6ef7; }
    .bh-status { margin-top: 8px; font-size: 11px; color: #999; }
    .bh-status.err { color: #e74c3c; }
    .bh-badge {
      position: absolute; top: 6px; right: 40px;
      background: #4f6ef7; color: #fff; padding: 2px 6px;
      border-radius: 4px; font-size: 10px; font-weight: 600;
    }
    .bh-card-score {
      position: absolute; top: 4px; right: 4px;
      padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 700;
      z-index: 1000;
    }
    .bh-card-score.high { background: #d4edda; color: #28a745; }
    .bh-card-score.mid { background: #fff3cd; color: #856404; }
    .bh-card-score.low { background: #f8d7da; color: #721c24; }
    .bh-card-score.blocked { background: #343a40; color: #fff; }
    .bh-card-score.contacted { background: #e2e3e5; color: #6c757d; }
  `);

  function createPanel() {
    // Prevent duplicate panels (page navigation / re-inject)
    const existing = document.getElementById('boss-helper-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'boss-helper-panel';
    panel.innerHTML = `
      <div class="bh-header">
        <h3>BOSS 招聘助手</h3>
        <span class="bh-close">×</span>
      </div>
      <div class="bh-body">
        <div class="bh-stats">
          今日已打招呼 <b id="bh-count">${state.greetingCount}</b> / <b id="bh-cap">${state.dailyCap}</b>
        </div>
        <div class="bh-row">
          <label>匹配岗位</label>
          <select id="bh-job" style="flex:1"><option value="">加载中…</option></select>
        </div>
        <div class="bh-row">
          <label>评分阈值</label>
          <input type="range" id="bh-threshold" min="0" max="100" value="${state.threshold}">
          <span id="bh-threshold-val">${state.threshold}</span>
        </div>
        <div class="bh-row">
          <label>每日上限</label>
          <input type="number" id="bh-cap-input" value="${state.dailyCap}" min="1" max="500">
        </div>
        <div class="bh-row">
          <label>间隔(秒)</label>
          <input type="number" id="bh-delay-min" value="${state.delayMin}" min="1" max="120" style="width:50px">
          ~
          <input type="number" id="bh-delay-max" value="${state.delayMax}" min="1" max="120" style="width:50px">
        </div>
        <div class="bh-row">
          <label>模式</label>
          <select id="bh-mode">
            <option value="semi">半自动</option>
            <option value="auto">自动打招呼</option>
          </select>
        </div>
        <div class="bh-row">
          <label>自动加载</label>
          <input type="checkbox" id="bh-multipage" ${state.multiPage ? 'checked' : ''}>
          <span style="font-size:11px;color:#999">最多</span>
          <input type="number" id="bh-maxcand" value="${state.maxCandidates}" min="15" max="2000" step="15" style="width:56px">
          <span style="font-size:11px;color:#999">人</span>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <button class="bh-btn bh-btn-primary" id="bh-scan">扫描列表</button>
          <button class="bh-btn bh-btn-primary" id="bh-start" style="display:none">开始</button>
          <button class="bh-btn bh-btn-danger" id="bh-stop" style="display:none">停止</button>
          <button class="bh-btn bh-btn-secondary" id="bh-diag">诊断</button>
        </div>
        <div class="bh-status" id="bh-status">就绪</div>
      </div>
    `;
    document.body.appendChild(panel);

    // Drag
    const header = panel.querySelector('.bh-header');
    let dragging = false, dx = 0, dy = 0;
    header.addEventListener('mousedown', (e) => {
      dragging = true;
      dx = e.clientX - panel.getBoundingClientRect().left;
      dy = e.clientY - panel.getBoundingClientRect().top;
      panel.classList.add('dragging');
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (e.clientX - dx) + 'px';
      panel.style.top = (e.clientY - dy) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; panel.classList.remove('dragging'); });

    // Close
    panel.querySelector('.bh-close').addEventListener('click', () => panel.remove());

    // Controls
    document.getElementById('bh-job').addEventListener('change', (e) => {
      state.jobId = e.target.value;
    });

    const thresholdEl = document.getElementById('bh-threshold');
    const thresholdValEl = document.getElementById('bh-threshold-val');
    thresholdEl.addEventListener('input', () => {
      state.threshold = parseInt(thresholdEl.value);
      thresholdValEl.textContent = state.threshold;
    });

    document.getElementById('bh-cap-input').addEventListener('change', (e) => {
      state.dailyCap = parseInt(e.target.value) || 50;
      document.getElementById('bh-cap').textContent = state.dailyCap;
    });

    document.getElementById('bh-delay-min').addEventListener('change', (e) => {
      state.delayMin = parseInt(e.target.value) || 5;
    });
    document.getElementById('bh-delay-max').addEventListener('change', (e) => {
      state.delayMax = parseInt(e.target.value) || 15;
    });

    document.getElementById('bh-mode').addEventListener('change', (e) => {
      state.mode = e.target.value;
      updateAutoButtons();
    });

    document.getElementById('bh-multipage').addEventListener('change', (e) => {
      state.multiPage = e.target.checked;
    });
    document.getElementById('bh-maxcand').addEventListener('change', (e) => {
      state.maxCandidates = parseInt(e.target.value) || 300;
    });

    document.getElementById('bh-scan').addEventListener('click', doScan);
    document.getElementById('bh-start').addEventListener('click', doAutoStart);
    document.getElementById('bh-stop').addEventListener('click', doAutoStop);
    document.getElementById('bh-diag').addEventListener('click', diagnose);

    updateAutoButtons();
    return panel;
  }

  function updateAutoButtons() {
    const startBtn = document.getElementById('bh-start');
    const stopBtn = document.getElementById('bh-stop');
    if (state.mode === 'auto') {
      startBtn.style.display = state.autoRunning ? 'none' : 'inline-block';
      stopBtn.style.display = state.autoRunning ? 'inline-block' : 'none';
    } else {
      startBtn.style.display = 'none';
      stopBtn.style.display = 'none';
    }
  }

  function setStatus(msg, err = false) {
    const el = document.getElementById('bh-status');
    if (!el) return;
    el.textContent = msg;
    el.className = err ? 'bh-status err' : 'bh-status';
  }

  // ─── Scan ─────────────────────────────────────────────────────────
  // Score the cards currently on screen; append result badges; return counts.
  async function scoreCurrentPage() {
    const rawCards = extractCards();
    if (!rawCards.length) return { found: 0, passed: 0, scored: [] };

    const serializable = rawCards.map(c => {
      const copy = { ...c };
      delete copy.cardEl;  // DOM refs can't be JSON-stringified
      return copy;
    });
    const scored = await apiPost('/score', { candidates: serializable, threshold: state.threshold, job_id: state.jobId });
    const items = scored.map((s, i) => ({
      ...s,
      cardEl: rawCards[i]?.cardEl,
      raw: rawCards[i],
    }));

    // Add score badges to cards
    items.forEach(item => {
      if (!item.cardEl) return;
      const badge = (item.cardEl.ownerDocument || document).createElement('div');
      badge.className = 'bh-card-score ' + (
        item.already_contacted ? 'contacted' :
        item.is_blocked ? 'blocked' :
        item.score >= state.threshold ? 'high' :
        item.score >= 50 ? 'mid' : 'low'
      );
      badge.textContent = item.already_contacted ? '✓已打'
        : item.already_skipped ? '⤺已跳过'
        : (item.is_blocked ? '⛔' : item.score);
      badge.title = item.already_contacted ? '该岗位已打过招呼'
        : item.already_skipped ? '该岗位曾被手动跳过，重扫不会自动回队'
        : (item.is_blocked ? '被排除' : item.details?.join('；') || '');
      item.cardEl.style.position = 'relative';
      item.cardEl.appendChild(badge);
    });

    // 过阈值：未排除、未打招呼、未跳过、达阈值。其中"已跳过"虽过阈值但不回队，单独计。
    const eligible = items.filter(s => !s.is_blocked && !s.already_contacted && s.score >= state.threshold);
    const newlyQueued = eligible.filter(s => !s.already_skipped).length;
    const skipped = eligible.filter(s => s.already_skipped).length;
    const contacted = items.filter(s => s.already_contacted).length;
    return { found: items.length, passed: newlyQueued, skipped, contacted, scored: items };
  }

  async function doScan() {
    setStatus('正在扫描卡片...');
    bindBadgeListeners();  // iframe may have loaded after init
    // Remove old badges (cards live in an iframe, so clear every document)
    getAllDocs().forEach(doc => doc.querySelectorAll('.bh-card-score').forEach(b => b.remove()));

    if (!getCardDoc()) {
      diagnose(); // auto-collect real selectors so we can fix the mismatch
      setStatus('未找到候选人卡片：已自动诊断并复制结果到剪贴板，粘贴给我', true);
      return;
    }

    try {
      // The list lazy-appends cards on scroll, so load more first.
      if (state.multiPage) {
        const loaded = await autoLoad(Math.max(15, state.maxCandidates));
        setStatus(`已加载 ${loaded} 人，正在评分...`);
      }

      // Score everything now in the DOM in one pass (backend upsert is idempotent).
      const { found, passed, skipped, contacted, scored } = await scoreCurrentPage();
      if (!found) {
        setStatus('未找到候选人卡片', true);
        return;
      }
      state.scanned = scored;
      const skippedNote = skipped ? `，曾跳过 ${skipped} 人(不回队)` : '';
      const contactedNote = contacted ? `，已联系 ${contacted} 人(灰显)` : '';
      setStatus(`完成：共扫描 ${found} 人，新入队 ${passed} 人${skippedNote}${contactedNote}`);
      updateAutoButtons();
    } catch (err) {
      setStatus('评分请求失败: ' + err.message, true);
    }
  }

  // Fetch a personalized greeting for this candidate (国产 LLM). The backend
  // falls back to the template when LLM isn't configured, so this always
  // returns the best available draft; on network error use the scan-time draft.
  async function fetchDraft(item) {
    // No LLM configured → /llm-draft would just echo the template we already
    // have from scan, so skip the round-trip (matters in the auto-greet loop).
    if (!state.llmEnabled) return item.draft || '';
    try {
      const res = await apiPost('/llm-draft', { expectId: item.expectId, job_id: state.jobId });
      if (res && res.draft) return res.draft;
    } catch { /* fall back to template draft */ }
    return item.draft || '';
  }

  // ─── Semi-auto: fill draft into chat ──────────────────────────────
  async function doSemiFill(item) {
    if (item.already_contacted) {
      setStatus(`${item.name} 该岗位已打过招呼，跳过`, true);
      return;
    }
    // Open chat for this candidate by clicking their card link
    if (item.cardEl) openCardChat(item.cardEl);

    setStatus(`正在为 ${item.name} 生成个性化话术...`);
    const draft = await fetchDraft(item);
    if (!draft) {
      setStatus('该候选人无话术草稿', true);
      return;
    }

    // Wait for chat to appear, then fill
    setTimeout(() => {
      const filled = fillChatInput(draft);
      if (filled) {
        setStatus(`已为 ${item.name} 填入话术，请检查后手动发送`);
      } else {
        setStatus('未找到聊天输入框', true);
      }
    }, 1200);
  }

  // ─── Auto greet loop ──────────────────────────────────────────────
  let autoTimer = null;

  async function doAutoStart() {
    if (state.mode !== 'auto') return;
    if (state.greetingCount >= state.dailyCap) {
      setStatus('已达每日上限', true);
      return;
    }

    const candidates = state.scanned.filter(s => !s.is_blocked && !s.already_contacted && !s.already_skipped && s.score >= state.threshold);
    const skipped = state.scanned.filter(s => s.already_contacted || s.already_skipped).length;
    if (!candidates.length) {
      setStatus('无过阈值候选人', true);
      return;
    }

    state.autoRunning = true;
    updateAutoButtons();
    const skipNote = skipped ? `，跳过 ${skipped} 位已联系` : '';
    setStatus(`自动打招呼开始，${candidates.length} 人待处理${skipNote}`);

    for (const item of candidates) {
      if (!state.autoRunning) break;
      if (state.greetingCount >= state.dailyCap) {
        setStatus('已达每日上限，自动停止');
        break;
      }

      // Safety check
      const hazard = checkHazards();
      if (hazard) {
        setStatus(`检测到安全阻断: ${hazard}，自动停止`, true);
        state.autoRunning = false;
        updateAutoButtons();
        break;
      }

      // Visibility check: tab must be in foreground
      if (document.hidden) {
        setStatus('标签页不在前台，暂停自动打招呼');
        // Wait until visible again
        await waitForVisible();
        if (!state.autoRunning) break;
      }

      setStatus(`正在打招呼: ${item.name} (${item.score}分) #${state.greetingCount + 1}`);

      // Personalized draft (国产 LLM, falls back to template) for the fill path.
      const personalizedDraft = await fetchDraft(item);

      // Click greet button on card
      const clicked = clickGreetBtn(item.cardEl);
      if (!clicked) {
        // Fallback: open chat then fill + try to find send button
        if (item.cardEl) openCardChat(item.cardEl);
        await sleep(1500);
        fillChatInput(personalizedDraft || `您好，我们有合适的岗位机会想和您聊聊`);
        await sleep(500);
        // Try to click send button
        const sendBtn = document.querySelector('button[class*="send"], [class*="btn-send"]');
        if (sendBtn) sendBtn.click();
      }

      incrCounter();
      document.getElementById('bh-count').textContent = state.greetingCount;

      // Log to backend
      try {
        await apiPost('/log-greeting', {
          expectId: item.expectId,
          name: item.name,
          mode: 'auto',
          job_id: state.jobId,
        });
      } catch { /* non-critical */ }

      // Random delay
      const delay = randDelay();
      setStatus(`${item.name} 已打招呼，等待 ${Math.round(delay/1000)}秒...`);
      await sleep(delay);
    }

    state.autoRunning = false;
    updateAutoButtons();
    if (state.greetingCount >= state.dailyCap) {
      setStatus(`今日 ${state.greetingCount}/${state.dailyCap} 已完成`);
    } else {
      setStatus('自动打招呼结束');
    }
  }

  function doAutoStop() {
    state.autoRunning = false;
    updateAutoButtons();
    setStatus('已停止自动打招呼');
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function waitForVisible() {
    return new Promise(resolve => {
      const handler = () => {
        if (!document.hidden) {
          document.removeEventListener('visibilitychange', handler);
          resolve();
        }
      };
      document.addEventListener('visibilitychange', handler);
      // Also timeout after 5 min
      setTimeout(resolve, 300000);
    });
  }

  // ─── Load config from backend on start ────────────────────────────
  async function loadConfig() {
    try {
      const cfg = await apiGet('/config');
      state.llmEnabled = !!cfg.llm_enabled;
      if (cfg.automation) {
        state.threshold = cfg.automation.score_threshold || state.threshold;
        state.dailyCap = cfg.automation.daily_cap || state.dailyCap;
        state.delayMin = cfg.automation.delay_min_s || state.delayMin;
        state.delayMax = cfg.automation.delay_max_s || state.delayMax;
      }
      state.configLoaded = true;
      // Update panel controls
      const tEl = document.getElementById('bh-threshold');
      const tvEl = document.getElementById('bh-threshold-val');
      const capEl = document.getElementById('bh-cap');
      const capInput = document.getElementById('bh-cap-input');
      const dMin = document.getElementById('bh-delay-min');
      const dMax = document.getElementById('bh-delay-max');
      if (tEl) { tEl.value = state.threshold; }
      if (tvEl) { tvEl.textContent = state.threshold; }
      if (capEl) { capEl.textContent = state.dailyCap; }
      if (capInput) { capInput.value = state.dailyCap; }
      if (dMin) { dMin.value = state.delayMin; }
      if (dMax) { dMax.value = state.delayMax; }
    } catch {
      setStatus('后端未连接，使用默认配置', true);
    }
  }

  // ─── Load workbench jobs into the picker ──────────────────────────
  async function loadJobs() {
    const sel = document.getElementById('bh-job');
    try {
      const jobs = await apiGet('/jobs');
      state.jobs = jobs || [];
      if (!state.jobs.length) {
        if (sel) sel.innerHTML = '<option value="">（无岗位，请在工作台配置）</option>';
        return;
      }
      state.jobId = state.jobs[0].id; // default to first job
      if (sel) {
        sel.innerHTML = state.jobs
          .map(j => `<option value="${j.id}">${j.title}</option>`)
          .join('');
        sel.value = state.jobId;
      }
    } catch {
      if (sel) sel.innerHTML = '<option value="">（加载岗位失败）</option>';
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────
  const panel = createPanel();
  loadConfig();
  loadJobs();

  // Add click handlers for scored cards (semi-auto mode).
  // Cards live inside an iframe, so attach to every accessible document — a
  // listener on the top document alone never sees clicks inside the iframe.
  function badgeClickHandler(e) {
    const badge = e.target.closest('.bh-card-score');
    if (!badge || badge.textContent === '⛔') return;
    const cardEl = badge.parentElement;
    const item = state.scanned.find(s => s.cardEl === cardEl);
    if (!item) return;
    if (state.mode === 'semi') {
      doSemiFill(item);
    }
  }

  const _badgeBoundDocs = new WeakSet();
  function bindBadgeListeners() {
    for (const doc of getAllDocs()) {
      if (_badgeBoundDocs.has(doc)) continue;
      doc.addEventListener('click', badgeClickHandler);
      _badgeBoundDocs.add(doc);
    }
  }

  bindBadgeListeners();
})();
