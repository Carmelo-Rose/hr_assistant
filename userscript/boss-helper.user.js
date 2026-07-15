// ==UserScript==
// @name         BOSS 招聘助手 — 油猴版
// @namespace    https://github.com/hr_assistant
// @version      1.20.17
// @description  在 BOSS 直聘页面内扫描候选人、评分、队列复盘、辅助话术
// @match        https://www.zhipin.com/*
// @noframes
// @connect      *
// @updateURL    __BOSS_HELPER_BASE_URL__/boss-helper.user.js
// @downloadURL  __BOSS_HELPER_BASE_URL__/boss-helper.user.js
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
  const DEFAULT_BACKEND_ORIGIN = '__BOSS_HELPER_BASE_URL__';
  function getBackendOrigin() {
    if (DEFAULT_BACKEND_ORIGIN && !DEFAULT_BACKEND_ORIGIN.includes('__')) {
      return DEFAULT_BACKEND_ORIGIN.replace(/\/+$/, '');
    }
    const info = typeof GM_info !== 'undefined' ? GM_info : null;
    const scriptUrl = info && info.script && (info.script.downloadURL || info.script.updateURL);
    if (scriptUrl) {
      try { return new URL(scriptUrl).origin; } catch { /* fall through */ }
    }
    return 'http://localhost:8000';
  }

  const BACKEND_ORIGIN = getBackendOrigin();
  const BACKEND = `${BACKEND_ORIGIN}/api/ext`;
  // Root API (without /ext prefix) — used by the in-panel queue view for
  // /queue/today, /outreach/*. Old BACKEND stays for the scan/greet flow.
  const BACKEND_ROOT = `${BACKEND_ORIGIN}/api`;
  // `li.card-item` = 新版推荐/沟通页卡片（2026-07 起）；`li.geek-info-card` = 旧版人才库搜索页卡片。
  // 两个选择器并存，哪个页面用哪套 DOM 就匹配哪个。
  const CARD_SEL = 'li.card-item, li.geek-info-card';

  // ─── State ────────────────────────────────────────────────────────
  const state = {
    scanned: [],       // [{expectId, name, score, is_blocked, details, draft, cardEl}]
    mode: 'semi',      // legacy: 'semi' | 'auto'
    jobId: '',         // selected workbench job id (scoring profile)
    jobs: [],          // [{id, title}]
    jobConfigMode: 'edit', // 'edit' | 'create'
    llmEnabled: false, // backend has LLM configured → personalize greetings
    threshold: 70,
    dailyCap: 150,
    delayMin: 5,
    delayMax: 15,
    greetingCount: 0,
    autoRunning: false,
    multiPage: true,      // auto-scroll to load more before scoring
    maxCandidates: 50,    // stop auto-loading after roughly this many cards
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
          if (res.status >= 400) {
            let msg = `HTTP ${res.status}`;
            try {
              const j = JSON.parse(res.responseText);
              if (j && j.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
              else if (j && j.error) msg = j.error;
            } catch {}
            reject(new Error(msg));
            return;
          }
          try { resolve(JSON.parse(res.responseText)); }
          catch { reject(new Error('Parse error: ' + res.responseText.slice(0, 200))); }
        },
        onerror: (err) => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timeout')),
      });
    });
  }

  function apiPatch(path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'PATCH',
        url: BACKEND + path,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body),
        onload: (res) => {
          if (res.status >= 400) {
            let msg = `HTTP ${res.status}`;
            try {
              const j = JSON.parse(res.responseText);
              if (j && j.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
            } catch {}
            reject(new Error(msg));
            return;
          }
          try { resolve(JSON.parse(res.responseText)); }
          catch { reject(new Error('Parse error: ' + res.responseText.slice(0, 200))); }
        },
        onerror: () => reject(new Error('Network error')),
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

  // ─── Root-level API (no /ext prefix) — used by the queue panel ────
  // Kept as a separate set so the scan/greet flow (BACKEND with /ext) is
  // untouched. All three share the same GM_xmlhttpRequest error surface.
  function _rootRequest(method, path, body, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 30000;
    return new Promise((resolve, reject) => {
      const req = {
        method,
        url: BACKEND_ROOT + path,
        onload: (res) => {
          if (res.status >= 400) {
            let msg = `HTTP ${res.status}`;
            try {
              const j = JSON.parse(res.responseText);
              if (j && j.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
            } catch {}
            reject(new Error(msg));
            return;
          }
          if (!res.responseText) { resolve(null); return; }
          try { resolve(JSON.parse(res.responseText)); }
          catch { reject(new Error('Parse error: ' + res.responseText.slice(0, 200))); }
        },
        onerror: () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timeout')),
        timeout: timeoutMs,
      };
      if (body !== undefined && body !== null) {
        req.headers = { 'Content-Type': 'application/json' };
        req.data = JSON.stringify(body);
      }
      GM_xmlhttpRequest(req);
    });
  }
  function apiGetRoot(path, opts) { return _rootRequest('GET', path, null, opts); }
  function apiPostRoot(path, body, opts) { return _rootRequest('POST', path, body || {}, opts); }
  function apiPatchRoot(path, body, opts) { return _rootRequest('PATCH', path, body || {}, opts); }

  function randDelay() {
    return Math.floor(Math.random() * (state.delayMax - state.delayMin + 1) + state.delayMin) * 1000;
  }

  function incrCounter() {
    state.greetingCount++;
    GM_setValue('boss_count', state.greetingCount);
  }

  // ─── Helpers: collect all accessible documents (main + same-origin iframes,
  // recursively — e.g. the candidate list iframe itself hosts a nested
  // c-resume iframe for the profile/chat panel opened on card click) ──
  function getAllDocs() {
    const docs = [];
    const seen = new Set();
    function visit(doc, depth) {
      if (!doc || seen.has(doc) || depth > 3) return;
      seen.add(doc);
      docs.push(doc);
      doc.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentDocument) visit(f.contentDocument, depth + 1); } catch {}
      });
    }
    visit(document, 0);
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

  function getCardCandidateId(card) {
    const idEl = getGeekIdEl(card);
    return idEl
      ? (idEl.getAttribute('data-expect') || idEl.getAttribute('data-geek') || idEl.getAttribute('data-geekid') || '')
      : '';
  }

  function isVisibleElement(el) {
    if (!el || !el.isConnected || !el.getClientRects().length) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  // The chat/recommend redesign uses a generic "沟通" label in the card
  // action bar, while the older talent-search page uses "打招呼". Keep the
  // generic label scoped to a card action bar or a resume/detail panel so the
  // left navigation's "沟通" item can never be clicked by mistake.
  function isGreetAction(el, scope) {
    const text = (el?.textContent || '').trim();
    if (!/^(打招呼|立即沟通|继续沟通|去沟通|沟通|联系Ta|联系TA)$/.test(text)) return false;
    if (!isVisibleElement(el)) return false;
    if (scope === 'card') {
      return !!el.closest('.button-list, [class*="button-list"], [class*="action-list"]');
    }
    return !el.closest('.menu-item-content, .nav-item, .menu-item, [class*="sidebar"]');
  }

  function findCardGreetControl(cardEl) {
    const controls = [...cardEl.querySelectorAll(
      '.button-list button, .button-list a, .button-list .btn,' +
      ' [class*="button-list"] button, [class*="button-list"] a, [class*="button-list"] .btn'
    )].filter(isVisibleElement);
    if (!controls.length) return null;

    const textMatch = controls.find(el => isGreetAction(el, 'card'));
    if (textMatch) return textMatch;

    const semanticMatch = controls.find(el =>
      /(greet|contact|commun|chat|getcontact|沟通|打招呼)/i.test(el.className || '')
    );
    if (semanticMatch) return semanticMatch;

    // The current chat/recommend layout exposes exactly one generic `.btn`
    // in each card's button-list and renders its label through an icon/text
    // component, so there is no reliable text node to match.
    return controls.length === 1 ? controls[0] : null;
  }

  // Structured extraction for the new li.card-item DOM: fields sit in dedicated
  // classes with no reliable whitespace between them (the old heuristic below
  // requires 2+ space chars to split a line, which this markup doesn't have —
  // that's why name/age/salary came out wrong after the 2026-07 BOSS redesign).
  function _structuredFields(card) {
    const name = card.querySelector('.name-wrap .name')?.textContent?.trim() || '';
    const activeStatus = card.querySelector('.name-wrap .active-text')?.textContent?.trim() || '';
    const salary = card.querySelector('.salary-wrap span, .salary-wrap')?.textContent?.trim() || '';

    let age = '', experience = '', education = '', jobStatus = '';
    card.querySelectorAll('.base-info span').forEach(el => {
      const t = (el.textContent || '').trim();
      if (!t) return;
      if (t.includes('岁')) age = t;
      else if (t.includes('年')) experience = t;
      else if (['本科', '硕士', '博士', '大专', '高中', '中专'].some(e => t.includes(e))) education = t;
      else if (t.includes('离职') || t.includes('在职') || t.includes('到岗')) jobStatus = t;
    });

    let expectCity = '';
    const expectSpans = card.querySelectorAll('.expect-wrap .content span');
    if (expectSpans[0]) expectCity = expectSpans[0].textContent.trim();

    return { name, age, experience, education, jobStatus, salary, activeStatus, expectCity };
  }

  function _extractFromCards(cards) {
    const results = [];

    for (let idx = 0; idx < cards.length; idx++) {
      const card = cards[idx];
      const text = card.innerText || '';
      const idEl = getGeekIdEl(card);
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);

      const structured = _structuredFields(card);
      let name, age, experience, education, jobStatus, salary, expectCity;
      if (structured.age || structured.experience || structured.education || structured.jobStatus) {
        // New DOM matched — trust the structured values wholesale.
        ({ age, experience, education, jobStatus, salary, expectCity } = structured);
        name = structured.name || lines[0] || '未知';
      } else {
        // Old DOM (li.geek-info-card) fallback: guess fields from line text.
        name = lines[0] || '未知';
        age = ''; experience = ''; education = ''; jobStatus = ''; salary = ''; expectCity = '';
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
        const cityIdx = lines.findIndex(l => l === '期望城市');
        if (cityIdx >= 0 && lines[cityIdx + 1]) expectCity = lines[cityIdx + 1];
        if (!expectCity) {
          const expIdx = lines.findIndex(l => l === '期望');
          if (expIdx >= 0 && lines[expIdx + 1]) expectCity = lines[expIdx + 1];
        }
      }
      const activeStatus = structured.activeStatus || '';

      const skillEls = card.querySelectorAll('.rcd-tags span, .tag-item, [class*="tag"]');
      const skills = Array.from(skillEls).map(el => el.innerText.trim()).filter(s => s.length > 0 && s.length < 20);

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
        index: idx, name, age, experience, education, jobStatus, salary, activeStatus,
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
        .filter(e => !ourPanel?.contains(e) && greetRe.test((e.textContent || '').trim()) &&
          (e.children.length === 0 || e.matches('button,a,[role="button"]')))
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

    // 5b) The redesigned chat/recommend cards keep their primary action in a
    // `.button-list` after the main profile markup. Capture it separately:
    // the general card sample is intentionally truncated before this region.
    const cardActionSamples = [];
    if (cardDoc) {
      [...cardDoc.querySelectorAll(CARD_SEL)].slice(0, 3).forEach((card, index) => {
        const actionBar = card.querySelector('.button-list, [class*="button-list"], [class*="action-list"]');
        if (!actionBar) {
          cardActionSamples.push({ card: index + 1, actionBar: null });
          return;
        }
        const controls = [...actionBar.querySelectorAll('button, a, [role="button"], .btn, [class*="btn"]')]
          .slice(0, 8)
          .map(el => ({
            tag: el.tagName.toLowerCase(),
            class: el.getAttribute('class') || '',
            text: (el.textContent || '').trim(),
            visible: isVisibleElement(el),
            html: (el.outerHTML || '').slice(0, 500),
          }));
        cardActionSamples.push({
          card: index + 1,
          actionBarClass: actionBar.getAttribute('class') || '',
          actionBarHtml: (actionBar.outerHTML || '').slice(0, 1200),
          controls,
        });
      });
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

    let scriptVersion = '?';
    try { scriptVersion = (GM_info && GM_info.script && GM_info.script.version) || '?'; } catch {}
    const report = {
      scriptVersion,
      url: location.href,
      iframeCount: allDocs.length - 1,
      cardCandidates: repeating,
      rawTopClasses: rawRepeating,
      greetButtons: greet.length ? greet : '（未找到"打招呼/沟通/联系Ta"按钮，可能要 hover 或进详情页才出现）',
      pagination: pagination.length ? pagination : '（未找到"下一页"控件）',
      scrollContainer,
      cardActionSamples,
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

  // Diagnostic dump for "找不到聊天输入框/发送按钮" failures — captures every
  // visible textarea/input/contenteditable element plus any open dialog/
  // panel-like container across all accessible documents, and copies it to
  // the clipboard so the actual selector mismatch can be identified without
  // opening DevTools (which BOSS's anti-debug bounces to about:blank).
  function dumpChatInputDiag() {
    const ourPanels = [document.getElementById('boss-helper-panel'), document.getElementById('boss-helper-queue-panel')];
    const inputs = [];
    const panels = [];
    const iframes = [];
    const greetBtns = [];
    const greetRe = /^(打招呼|立即沟通|继续沟通|去沟通|沟通|联系Ta|联系TA|发送|发 送)$/;
    getAllDocs().forEach((doc, di) => {
      // All inputs — hidden ones too (an inline greeting box is often hidden
      // until you click 打招呼, so filtering hidden would erase the clue).
      doc.querySelectorAll('textarea, [contenteditable="true"], input[type="text"], input:not([type])').forEach(el => {
        if (ourPanels.some(p => p && p.contains(el))) return;
        inputs.push({
          doc: di,
          tag: el.tagName.toLowerCase(),
          visible: el.offsetParent !== null,
          class: el.getAttribute('class') || '',
          placeholder: el.getAttribute('placeholder') || '',
          parentClass: el.parentElement ? (el.parentElement.getAttribute('class') || '') : '',
        });
      });
      doc.querySelectorAll('[class*="dialog"],[class*="modal"],[class*="popup"],[class*="drawer"],[class*="chat"],[class*="im-"],[class*="resume"]').forEach(el => {
        if (ourPanels.some(p => p && p.contains(el))) return;
        if (el.offsetParent === null) return;
        panels.push(`doc${di} | ${el.tagName.toLowerCase()} | class="${el.getAttribute('class') || ''}"`);
      });
      // Greet / send buttons by visible text — tells us what to click to
      // reveal the input (or to send) on this particular BOSS page layout.
      doc.querySelectorAll('button,a,span,div').forEach(el => {
        if (ourPanels.some(p => p && p.contains(el))) return;
        if (el.children.length !== 0 && !el.matches('button,a,[role="button"]')) return;
        if (!greetRe.test((el.textContent || '').trim())) return;
        if (el.offsetParent === null) return;
        greetBtns.push(`doc${di} | ${el.tagName.toLowerCase()} | text="${el.textContent.trim()}" | class="${el.getAttribute('class') || ''}" | parentClass="${el.parentElement ? (el.parentElement.getAttribute('class') || '') : ''}"`);
      });
      // Every iframe in this doc, with src + whether contentDocument is
      // reachable — pinpoints cross-origin (Same-Origin Policy blocks us
      // structurally, no selector fix possible) vs. same-origin-but-missed.
      doc.querySelectorAll('iframe').forEach(f => {
        let accessible = false, reason = '';
        try {
          accessible = !!f.contentDocument;
          if (accessible) reason = `readyState=${f.contentDocument.readyState}, bodyChildren=${f.contentDocument.body ? f.contentDocument.body.children.length : 'n/a'}`;
        } catch (err) {
          reason = 'blocked: ' + err.message;
        }
        iframes.push({
          inDoc: di,
          class: f.getAttribute('class') || '',
          src: f.getAttribute('src') || '(no src attr)',
          accessible,
          reason,
        });
      });
    });
    // Stamp the ACTUALLY-loaded script version so there's no ambiguity about
    // whether Tampermonkey picked up the latest edit.
    let scriptVersion = '?';
    try { scriptVersion = (GM_info && GM_info.script && GM_info.script.version) || '?'; } catch {}
    const report = { scriptVersion, url: location.href, docCount: getAllDocs().length, inputs, greetBtns: greetBtns.slice(0, 20), panels: panels.slice(0, 20), iframes };
    const text = 'BOSS-INPUT-DIAG\n' + JSON.stringify(report, null, 2);
    try { GM_setClipboard(text); } catch {}
    return text;
  }

  // Resolve a queue item's boss_id to a card that is live RIGHT NOW. BOSS's
  // virtual list can reuse a connected DOM node for a different candidate, so
  // a cached card reference is never trusted unless its current data-* ID also
  // matches. Prefer a fresh DOM scan to avoid opening the wrong resume.
  function findCardByBossId(bossId) {
    if (!bossId) return null;
    for (const doc of getAllDocs()) {
      for (const card of doc.querySelectorAll(CARD_SEL)) {
        if (getCardCandidateId(card) === bossId) return card;
      }
    }
    for (const it of state.scanned || []) {
      if (it && it.expectId === bossId && it.cardEl && it.cardEl.isConnected && getCardCandidateId(it.cardEl) === bossId) {
        return it.cardEl;
      }
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

  // ─── Chat input discovery / fill ──────────────────────────────────
  const CHAT_INPUT_SELECTORS = [
    'textarea[class*="chat-input"]',
    'textarea[class*="message-input"]',
    'div[class*="chat"] textarea',
    'textarea[placeholder*="说"]',
    'textarea[placeholder*="输入"]',
    'textarea[placeholder*="招呼"]',
    '[contenteditable="true"][class*="chat"]',
    '[contenteditable="true"][class*="message"]',
    '[class*="chat-input"] [contenteditable="true"]',
    '[class*="greet"] textarea',
    '[class*="dialog"] textarea',
    '[class*="popup"] textarea',
    'textarea',  // last resort — filtered below to avoid the job-search input
  ];

  // Locate a *visible* chat/greeting input across all accessible docs (cards
  // and the chat/greet panel live in nested same-origin iframes). Skips the
  // 请输入职位名称 job-search box (an <input class="ipt chat-job-search">).
  function findChatInputEl() {
    for (const doc of getAllDocs()) {
      for (const sel of CHAT_INPUT_SELECTORS) {
        for (const el of doc.querySelectorAll(sel)) {
          if (el.offsetParent === null) continue; // must be visible
          const cls = el.getAttribute('class') || '';
          const ph = el.getAttribute('placeholder') || '';
          if (/search|职位/.test(cls) || /职位/.test(ph)) continue;
          return el;
        }
      }
    }
    return null;
  }

  // Poll for a chat input to appear (BOSS renders the greet compose box async
  // after the 打招呼 button is clicked). Returns the element or null.
  async function waitForChatInput(maxMs) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const el = findChatInputEl();
      if (el) return el;
      await sleep(300);
    }
    return null;
  }

  function fillInputEl(el, text) {
    const tag = el.tagName.toLowerCase();
    const win = el.ownerDocument.defaultView || window;
    if (tag === 'textarea' || tag === 'input') {
      const proto = tag === 'textarea' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      nativeInputValueSetter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.getAttribute('contenteditable') === 'true') {
      el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function fillChatInput(text) {
    const el = findChatInputEl();
    if (!el) return false;
    fillInputEl(el, text);
    return true;
  }

  // Find a visible send button across all docs — class-based first, then an
  // exact 发送 text leaf (the greeting dialog's confirm button).
  function findSendButton() {
    for (const doc of getAllDocs()) {
      const byClass = doc.querySelector('button[class*="send"]:not([disabled]), [class*="btn-send"]');
      if (byClass && byClass.offsetParent !== null) return byClass;
      for (const el of doc.querySelectorAll('button,a,span,div')) {
        if (el.children.length !== 0) continue;
        if (el.offsetParent === null) continue;
        if (/^(发\s*送)$/.test((el.textContent || '').trim())) return el;
      }
    }
    return null;
  }

  // Click a "打招呼" button anywhere (used after openCardChat opens the resume
  // panel, whose greet button lives in the c-resume iframe). Tight regex
  // (^打招呼$) so it never matches the sidebar 沟通 menu item.
  function clickGreetButtonAnywhere() {
    const ourPanels = [document.getElementById('boss-helper-panel'), document.getElementById('boss-helper-queue-panel')];
    for (const doc of getAllDocs()) {
      for (const sel of ['button.btn-greet', 'button.btn-getcontact', 'button[class*="getcontact"]', 'a.btn-greet', 'a[class*="greet"]', 'button[class*="greet"]']) {
        const btn = doc.querySelector(sel);
        if (btn && btn.offsetParent !== null && !ourPanels.some(p => p && p.contains(btn))) { btn.click(); return true; }
      }
      for (const el of doc.querySelectorAll('button,a,span,div')) {
        if (el.children.length !== 0) continue;
        if (ourPanels.some(p => p && p.contains(el))) continue;
        if (isGreetAction(el)) { el.click(); return true; }
      }
    }
    return false;
  }

  // Trigger BOSS's greet flow for a card: prefer the card's own greet button;
  // if the card has none (hover-only / new layout), open the resume panel and
  // click its greet button. Returns true if a greet action was triggered.
  async function triggerGreetUI(cardEl) {
    if (clickGreetBtn(cardEl)) return true;
    // The action bar can be hover-revealed in the virtualized card list.
    cardEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: cardEl.ownerDocument.defaultView }));
    cardEl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, view: cardEl.ownerDocument.defaultView }));
    await sleep(200);
    if (clickGreetBtn(cardEl)) return true;
    if (!openCardChat(cardEl)) return false;
    // The resume panel is rendered asynchronously, often inside a nested
    // same-origin iframe. Poll rather than taking a single timing snapshot.
    for (let attempt = 0; attempt < 12; attempt++) {
      await sleep(500);
      if (clickGreetButtonAnywhere()) return true;
    }
    return false;
  }

  // ─── Click "打招呼" button on a card ──────────────────────────────
  function clickGreetBtn(cardEl) {
    // Try common BOSS greet button selectors
    const greetBtnSelectors = [
      'button.btn-greet',              // chat/recommend card action (2026-07)
      'button.btn-getcontact',         // 人才库搜索页"联系Ta"按钮（当前 BOSS DOM）
      'button[class*="getcontact"]',
      'a.btn-greet',                   // 推荐/搜索页卡片上的招呼按钮
      'a[class*="greet"]',
      'button[class*="greet"]',
      'a[data-contact]',               // card link that opens chat
    ];
    for (const sel of greetBtnSelectors) {
      const btn = cardEl.querySelector(sel);
      if (btn && isVisibleElement(btn)) {
        btn.click();
        return true;
      }
    }
    const actionControl = findCardGreetControl(cardEl);
    if (actionControl) {
      actionControl.click();
      return true;
    }
    // New chat/recommend cards put the action in `.button-list` and may use
    // the generic "沟通" label instead of exposing a stable class name.
    for (const el of cardEl.querySelectorAll('button,a,span,div')) {
      if (el.children.length === 0 && isGreetAction(el, 'card')) {
        el.click();
        return true;
      }
    }
    return false;
  }

  // ─── Open a card's chat/profile WITHOUT sending (半自动 fill path) ─────
  // Old DOM: click the `a[data-contact]` card link. New DOM (li.card-item)
  // has no such link — best-effort click the candidate's name to open the
  // detail popup. NOT the avatar: clicking it opens a video/photo preview
  // lightbox instead (confirmed — a `.name-wrap .name, .avatar` combined
  // selector matched the avatar first since it sits earlier in the DOM than
  // the name, and querySelector doesn't prioritize by selector-list order).
  function openCardChat(cardEl) {
    const link = cardEl.querySelector('a[data-contact]');
    if (link) { link.click(); return true; }
    const target = cardEl.querySelector('.name-wrap .name') || cardEl.querySelector('.name');
    if (target) { target.click(); return true; }
    return false;
  }

  // ─── Panel HTML ───────────────────────────────────────────────────
  GM_addStyle(`
    #boss-helper-panel {
      position: fixed; top: 200px; right: 20px; z-index: 99999;
      width: 352px; background: #fff; border: 1px solid #e7eaff; border-radius: 14px;
      box-shadow: 0 12px 36px rgba(35, 55, 130, .18); font-family: -apple-system, sans-serif;
      font-size: 13px; color: #24304f; user-select: none;
    }
    #boss-helper-panel.dragging { cursor: move; }
    .bh-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 11px 14px; background: linear-gradient(135deg, #536dfe, #4355cc); color: #fff;
      border-radius: 13px 13px 0 0; cursor: move;
    }
    .bh-header h3 { margin: 0; font-size: 14px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 6px; }
    .bh-collapse-arrow { display: inline-block; transition: transform 0.15s; font-size: 10px; }
    .bh-header .bh-close { cursor: pointer; font-size: 18px; line-height: 1; }
    .bh-body { padding: 10px 14px 12px; }
    #boss-helper-panel.bh-collapsed .bh-body { display: none; }
    #boss-helper-panel.bh-collapsed .bh-collapse-arrow { transform: rotate(-90deg); }
    #boss-helper-panel.bh-collapsed .bh-header { border-radius: 12px; }
    .bh-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .bh-row label { min-width: 70px; font-size: 12px; color: #666; }
    .bh-row input[type=number] { width: 60px; padding: 4px 6px; border: 1px solid #ddd; border-radius: 6px; }
    .bh-row input[type=range] { width: 120px; }
    .bh-row select { padding: 4px 6px; border: 1px solid #ddd; border-radius: 6px; }
    .bh-icon-btn {
      width: 30px; height: 28px; display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid #ddd; border-radius: 7px; background: #fff; color: #555; cursor: pointer;
      font-size: 13px;
    }
    .bh-icon-btn:hover { border-color: #4f6ef7; color: #4f6ef7; }
    .bh-job-config {
      display: none; margin: 8px 0 10px; padding: 10px; border: 1px solid #e6e8ef;
      border-radius: 8px; background: #fafbff; user-select: text;
    }
    .bh-job-config.open { display: block; }
    .bh-job-config-head { display: flex; gap: 6px; margin-bottom: 9px; }
    .bh-job-mode-btn {
      flex: 1; padding: 5px 8px; border: 1px solid #d9dce6; border-radius: 7px;
      background: #fff; color: #555; font-size: 12px; cursor: pointer;
    }
    .bh-job-mode-btn.active { border-color: #4f6ef7; background: #eef2ff; color: #3455dc; font-weight: 600; }
    .bh-job-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .bh-job-field.full { grid-column: 1 / -1; }
    .bh-job-field label { display: block; margin-bottom: 3px; font-size: 11px; color: #666; }
    .bh-job-field input,
    .bh-job-field select {
      width: 100%; box-sizing: border-box; padding: 5px 7px; border: 1px solid #d9dce6;
      border-radius: 6px; background: #fff; font-size: 12px;
    }
    .bh-job-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
    .bh-job-hint { margin-top: 7px; font-size: 11px; color: #888; line-height: 1.4; }
    .bh-btn {
      display: inline-block; padding: 7px 13px; border-radius: 8px;
      font-size: 12px; cursor: pointer; border: none; font-weight: 600;
    }
    .bh-btn-primary { background: #4f6ef7; color: #fff; }
    .bh-btn-danger { background: #e74c3c; color: #fff; }
    .bh-btn-secondary { background: #f0f0f0; color: #333; }
    .bh-stats { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: #66708b; margin-bottom: 9px; }
    .bh-stats b { color: #4355cc; }
    .bh-section { padding: 0; margin-bottom: 8px; border: 0; border-radius: 0; background: transparent; }
    .bh-section-title { display: none; }
    .bh-section .bh-row:last-child { margin-bottom: 0; }
    .bh-action-row { display: flex; align-items: center; gap: 8px; margin-top: 3px; }
    #bh-scan { flex: 1.25; }
    #bh-open-queue { flex: 1; }
    #bh-diag { padding: 7px 4px; background: transparent; color: #7b849b; }
    .bh-status { min-height: 14px; margin-top: 8px; font-size: 11px; color: #7b849b; }
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

    /* ─── Queue panel ─────────────────────────────────────────────── */
    #boss-helper-queue-panel {
      position: fixed; top: 200px; right: 372px; z-index: 99998;
      width: min(780px, calc(100vw - 64px)); max-height: 82vh;
      display: none; flex-direction: column;
      background: #fff; border: 1px solid #e7eaff; border-radius: 14px;
      box-shadow: 0 14px 40px rgba(35, 55, 130, .20);
      font-family: -apple-system, sans-serif; font-size: 13px; color: #24304f;
    }
    #boss-helper-queue-panel.bhq-stacked {
      right: 20px; width: 340px;
    }
    .bhq-header {
      display: flex; align-items: center; gap: 8px;
      padding: 11px 14px; background: linear-gradient(135deg, #536dfe, #4355cc); color: #fff;
      border-radius: 13px 13px 0 0; cursor: move; user-select: none;
    }
    .bhq-header h3 { margin: 0; font-size: 14px; font-weight: 600; flex: 0 0 auto; }
    .bhq-tabs { display: flex; gap: 4px; margin-left: 10px; }
    .bhq-tab {
      padding: 3px 10px; border-radius: 12px; font-size: 12px;
      cursor: pointer; background: rgba(255,255,255,0.15); color: #fff;
    }
    .bhq-tab.active { background: #fff; color: #4f6ef7; font-weight: 600; }
    .bhq-header-spacer { flex: 1; }
    .bhq-header-btn {
      cursor: pointer; padding: 3px 8px; border-radius: 6px;
      background: rgba(255,255,255,0.15); font-size: 12px;
    }
    .bhq-header-btn:hover { background: rgba(255,255,255,0.28); }
    .bhq-close { cursor: pointer; font-size: 18px; line-height: 1; margin-left: 4px; }

    .bhq-toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 9px 14px; border-bottom: 1px solid #edf0f7;
      background: #fafbff; flex-wrap: wrap;
    }
    .bhq-toolbar-status { display: none; }
    .bhq-toolbar-status.err { color: #e74c3c; }
    .bhq-filter { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #666; white-space: nowrap; }
    .bhq-filter select {
      max-width: 160px; padding: 3px 22px 3px 6px; border: 1px solid #d9def5;
      border-radius: 6px; background: #fff; color: #35469d; font-size: 11px;
    }
    #bhq-bulk-skip { margin-left: auto; }

    .bhq-list {
      flex: 1; overflow-y: auto; padding: 10px;
      min-height: 120px; background: #f7f8fd;
    }
    .bhq-empty { padding: 40px 20px; text-align: center; color: #8a93a9; font-size: 12px; }
    .bhq-row {
      display: flex; gap: 10px; align-items: flex-start;
      padding: 11px 12px; margin-bottom: 8px; border: 1px solid #e9ecf5; border-radius: 10px;
      background: #fff; cursor: pointer; transition: background .12s, border-color .12s, box-shadow .12s;
    }
    .bhq-row:hover { border-color: #cfd7ff; background: #fff; box-shadow: 0 4px 12px rgba(63, 79, 160, .08); }
    .bhq-row-main { flex: 1; min-width: 0; }
    .bhq-row-actions { flex: 0 0 auto; display: flex; gap: 4px; align-items: center; }
    .bhq-name-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .bhq-name { font-size: 13px; font-weight: 700; color: #24304f; }
    .bhq-job {
      display: inline-block; max-width: 220px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; padding: 1px 7px;
      border-radius: 10px; background: #eef2ff; color: #4355b9;
      font-size: 11px; line-height: 1.4;
    }
    .bhq-badge {
      display: inline-block; padding: 1px 7px; border-radius: 10px;
      font-size: 11px; font-weight: 600; line-height: 1.4;
    }
    .bhq-badge.score-high { background: #d4edda; color: #1e7e34; }
    .bhq-badge.score-mid { background: #fff3cd; color: #856404; }
    .bhq-badge.score-low { background: #f8d7da; color: #721c24; }
    .bhq-badge.llm-high { background: #e3e0ff; color: #4b3fbb; }
    .bhq-badge.llm-mid { background: #ede9fe; color: #6b46c1; }
    .bhq-badge.llm-low { background: #ffe1ec; color: #b0345c; }
    .bhq-status-dot {
      display: inline-block; width: 7px; height: 7px; border-radius: 50%;
      background: #bbb; flex-shrink: 0;
    }
    .bhq-status-dot.new { background: #6c757d; }
    .bhq-status-dot.queued { background: #4f6ef7; }
    .bhq-status-dot.drafted { background: #17a2b8; }
    .bhq-status-dot.filled { background: #ffc107; }
    .bhq-status-dot.sent_manual { background: #28a745; }
    .bhq-status-dot.skipped { background: #dc3545; }
    .bhq-info {
      font-size: 11px; color: #666; margin-top: 3px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .bhq-missing {
      font-size: 11px; color: #b26a00; margin-top: 3px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .bhq-act {
      padding: 5px 9px; border-radius: 7px; border: none;
      font-size: 11px; cursor: pointer; font-weight: 600;
    }
    .bhq-act-primary { background: #4f6ef7; color: #fff; }
    .bhq-act-success { background: #28a745; color: #fff; }
    .bhq-act-danger { background: #e74c3c; color: #fff; }
    .bhq-act-secondary { background: #eef0f4; color: #333; }
    .bhq-act:disabled { opacity: 0.5; cursor: not-allowed; }

    .bhq-progress-wrap {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px; border-bottom: 1px solid #e4e8fb;
      background: #f7f8ff;
    }
    .bhq-progress-bar {
      flex: 1; height: 7px; border-radius: 999px; background: #e3e7f6; overflow: hidden;
    }
    .bhq-progress-fill {
      height: 100%; width: 0%; background: linear-gradient(90deg, #536dfe, #7c4dff); border-radius: 999px;
      transition: width 0.7s cubic-bezier(.22, 1, .36, 1);
    }
    .bhq-progress-text { flex: 0 0 auto; font-size: 11px; color: #666; white-space: nowrap; }

    .bhq-toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      z-index: 100001; padding: 8px 18px; border-radius: 6px;
      background: rgba(0,0,0,0.82); color: #fff; font-size: 12px;
      opacity: 0; transition: opacity 0.2s; pointer-events: none;
    }
    .bhq-toast.show { opacity: 1; }
    .bhq-toast.err { background: rgba(200, 30, 30, 0.9); }

    /* Locate-on-page highlight (applied to a BOSS card temporarily) */
    .bhq-located {
      outline: 3px solid #4f6ef7 !important;
      outline-offset: 2px;
      transition: outline 0.15s;
    }
  `);

  function createPanel() {
    // Prevent duplicate panels (page navigation / re-inject)
    const existing = document.getElementById('boss-helper-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'boss-helper-panel';
    panel.innerHTML = `
      <div class="bh-header">
        <h3><span class="bh-collapse-arrow">▾</span>BOSS 招聘助手</h3>
        <span class="bh-close">×</span>
      </div>
      <div class="bh-body">
        <div class="bh-stats"><span>今日触达</span><span><b id="bh-count">${state.greetingCount}</b> / <b id="bh-cap">${state.dailyCap}</b></span></div>
        <div class="bh-section">
          <p class="bh-section-title">评分设置</p>
          <div class="bh-row">
            <label>匹配岗位</label>
            <select id="bh-job" style="flex:1"><option value="">加载中…</option></select>
            <button class="bh-icon-btn" id="bh-job-config-toggle" title="配置当前岗位">⚙</button>
          </div>
          <div class="bh-row">
            <label>评分阈值</label>
            <input type="range" id="bh-threshold" min="0" max="100" value="${state.threshold}">
            <span id="bh-threshold-val">${state.threshold}</span>
          </div>
        </div>
        <div class="bh-job-config" id="bh-job-config"></div>
        <div class="bh-section">
          <p class="bh-section-title">扫描范围</p>
          <div class="bh-row">
            <label>自动加载</label>
            <input type="checkbox" id="bh-multipage" ${state.multiPage ? 'checked' : ''}>
            <span style="font-size:11px;color:#7b849b">加载上限</span>
            <input type="number" id="bh-maxcand" value="${state.maxCandidates}" min="15" max="500" step="5" style="width:56px">
            <span style="font-size:11px;color:#7b849b">人</span>
          </div>
        </div>
        <div class="bh-action-row">
          <button class="bh-btn bh-btn-primary" id="bh-scan">扫描列表</button>
          <button class="bh-btn bh-btn-secondary" id="bh-open-queue">查看队列</button>
          <button class="bh-btn bh-btn-secondary" id="bh-diag">诊断</button>
        </div>
        <div class="bh-status" id="bh-status">就绪</div>
      </div>
    `;
    document.body.appendChild(panel);

    // Drag
    const header = panel.querySelector('.bh-header');
    let dragging = false, dx = 0, dy = 0, didDrag = false;
    header.addEventListener('mousedown', (e) => {
      dragging = true;
      didDrag = false;
      dx = e.clientX - panel.getBoundingClientRect().left;
      dy = e.clientY - panel.getBoundingClientRect().top;
      panel.classList.add('dragging');
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      didDrag = true;
      panel.style.left = (e.clientX - dx) + 'px';
      panel.style.top = (e.clientY - dy) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; panel.classList.remove('dragging'); });

    // Click title to collapse/expand the body (keeps the header bar visible
    // so the panel can be tucked away without losing scan state or having to
    // reload the page, unlike the × which removes it entirely).
    header.querySelector('h3').addEventListener('click', () => {
      if (didDrag) { didDrag = false; return; }
      panel.classList.toggle('bh-collapsed');
    });

    // Close
    panel.querySelector('.bh-close').addEventListener('click', () => panel.remove());

    // Controls
    document.getElementById('bh-job').addEventListener('change', (e) => {
      state.jobId = e.target.value;
      state.jobConfigMode = 'edit';
      renderJobConfig();
    });
    document.getElementById('bh-job-config-toggle').addEventListener('click', () => {
      const box = document.getElementById('bh-job-config');
      if (!box) return;
      box.classList.toggle('open');
      renderJobConfig();
    });

    const thresholdEl = document.getElementById('bh-threshold');
    const thresholdValEl = document.getElementById('bh-threshold-val');
    thresholdEl.addEventListener('input', () => {
      state.threshold = parseInt(thresholdEl.value);
      thresholdValEl.textContent = state.threshold;
    });

    document.getElementById('bh-multipage').addEventListener('change', (e) => {
      state.multiPage = e.target.checked;
      syncAutoLoadControls();
    });
    document.getElementById('bh-maxcand').addEventListener('change', (e) => {
      const next = parseInt(e.target.value, 10);
      state.maxCandidates = Number.isFinite(next) ? Math.max(15, Math.min(500, next)) : 50;
      e.target.value = state.maxCandidates;
    });

    document.getElementById('bh-scan').addEventListener('click', doScan);
    document.getElementById('bh-diag').addEventListener('click', diagnose);
    document.getElementById('bh-open-queue').addEventListener('click', openQueuePanel);

    syncAutoLoadControls();
    return panel;
  }

  function updateAutoButtons() {
    // Legacy auto-greet buttons were removed from the UI.
  }

  function syncAutoLoadControls() {
    const maxEl = document.getElementById('bh-maxcand');
    if (!maxEl) return;
    maxEl.disabled = !state.multiPage;
    maxEl.title = state.multiPage ? '自动加载最多拉取的人数' : '关闭自动加载时，仅扫描当前页面已加载的候选人';
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
    const job = selectedJob();
    if (job) {
      try {
        setStatus('正在同步 BOSS 跳槽频率筛选...');
        const label = await syncNativeTurnoverFrequency(job);
        setStatus(`BOSS 跳槽频率已设为：${label}，正在扫描卡片...`);
      } catch (err) {
        // Native BOSS filters differ between recommend/search page versions.
        // Failing to mirror this optional filter must not block local card
        // extraction and scoring; continue with the list currently displayed.
        const message = `BOSS 跳槽频率未同步：${err.message || err}，继续扫描当前列表`;
        setStatus(message);
        showToast(message, true);
      }
    } else {
      setStatus('正在扫描卡片...');
    }
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
    if (state.queuePanel.bulkGreetRunning) {
      setStatus('队列面板批量打招呼进行中，请先停止', true);
      return;
    }
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
      if (tEl) { tEl.value = state.threshold; }
      if (tvEl) { tvEl.textContent = state.threshold; }
      if (capEl) { capEl.textContent = state.dailyCap; }
    } catch {
      setStatus('后端未连接，使用默认配置', true);
    }
  }

  function selectedJob() {
    return state.jobs.find(j => String(j.id) === String(state.jobId)) || null;
  }

  function activeRequirementLabel(value) {
    return ({
      any: '不限',
      today: '今日活跃',
      '3d': '3日内活跃',
      week: '本周活跃',
    })[value || 'any'] || '不限';
  }

  function turnoverFrequencyLabel(value) {
    return ({
      any: '不限',
      fewer_than_3_in_5y: '5年少于3份',
      average_job_over_1y: '平均每份工作大于1年',
    })[value || 'any'] || '不限';
  }

  function normalizedNativeText(value) {
    return String(value || '').replace(/\s+/g, '').replace(/[（(].*?[）)]/g, '');
  }

  function findVisibleExactText(text, root) {
    const expected = normalizedNativeText(text);
    const docs = root ? [root] : getAllDocs();
    for (const doc of docs) {
      const matches = Array.from(doc.querySelectorAll('button, [role="button"], div, span, label, li, a'))
        .filter(el => isVisibleElement(el) && normalizedNativeText(el.textContent) === expected);
      if (matches.length) return matches.sort((a, b) => a.children.length - b.children.length)[0];
    }
    return null;
  }

  function findTurnoverFrequencyOption(value) {
    const label = turnoverFrequencyLabel(value);
    if (value !== 'any') return findVisibleExactText(label);

    // “不限” appears in several BOSS filter groups, so scope it to the
    // turnover-frequency group instead of clicking a similarly named option.
    for (const doc of getAllDocs()) {
      const header = Array.from(doc.querySelectorAll('div, span, label, p'))
        .filter(el => isVisibleElement(el) && /跳槽频率/.test(normalizedNativeText(el.textContent)))
        .sort((a, b) => normalizedNativeText(a.textContent).length - normalizedNativeText(b.textContent).length)[0];
      const group = header?.parentElement;
      const option = group && Array.from(group.querySelectorAll('button, [role="button"], div, span, label, li, a'))
        .find(el => isVisibleElement(el) && normalizedNativeText(el.textContent) === label);
      if (option) return option;
    }
    return null;
  }

  function isNativeOptionSelected(el) {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const cls = String(node.className || '').toLowerCase();
      if (node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-selected') === 'true') return true;
      if (/(^|[-_\s])(active|selected|checked|current|is-select|is-active)([-_\s]|$)/.test(cls)) return true;
    }
    return false;
  }

  async function syncNativeTurnoverFrequency(job) {
    const value = job?.turnover_frequency || 'any';
    // "不限" imposes no extra constraint, so there is nothing to synchronize.
    // Trying to locate its generic BOSS option is both unnecessary and
    // unreliable because several filter groups contain an identically named
    // "不限" choice on the chat/recommend page.
    if (value === 'any') return turnoverFrequencyLabel(value);
    let option = findTurnoverFrequencyOption(value);
    if (!option) {
      const trigger = findVisibleExactText('筛选');
      if (!trigger) throw new Error('未找到 BOSS 的“筛选”入口');
      trigger.click();
      await sleep(180);
      option = findTurnoverFrequencyOption(value);
    }
    if (!option) throw new Error(`未找到 BOSS 跳槽频率选项：${turnoverFrequencyLabel(value)}`);

    if (!isNativeOptionSelected(option)) {
      option.click();
      await sleep(120);
    }
    const confirm = findVisibleExactText('确定');
    if (confirm) {
      confirm.click();
      await sleep(800);
    }
    return turnoverFrequencyLabel(value);
  }

  function jobNumber(job, field, fallback) {
    const n = Number(job && job[field]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  function blankJobConfig() {
    return {
      id: '',
      title: '',
      age_min: 24,
      age_max: 38,
      salary_min_k: 0,
      salary_max_k: 0,
      min_experience_years: 3,
      active_requirement: '3d',
      turnover_frequency: 'any',
      experience_keywords: '',
      capability_keywords: '',
    };
  }

  function hasFullJobFields(job) {
    return job && (
      Object.prototype.hasOwnProperty.call(job, 'experience_keywords') ||
      Object.prototype.hasOwnProperty.call(job, 'capability_keywords') ||
      Object.prototype.hasOwnProperty.call(job, 'salary_min_k') ||
      Object.prototype.hasOwnProperty.call(job, 'active_requirement') ||
      Object.prototype.hasOwnProperty.call(job, 'turnover_frequency')
    );
  }

  function normalizeJob(job) {
    const hasActive = Object.prototype.hasOwnProperty.call(job || {}, 'active_requirement');
    const hasTurnoverFrequency = Object.prototype.hasOwnProperty.call(job || {}, 'turnover_frequency');
    return {
      ...job,
      age_min: jobNumber(job, 'age_min', 24),
      age_max: jobNumber(job, 'age_max', 38),
      salary_min_k: jobNumber(job, 'salary_min_k', 0),
      salary_max_k: jobNumber(job, 'salary_max_k', 0),
      min_experience_years: jobNumber(job, 'min_experience_years', 3),
      active_requirement: hasActive ? (job.active_requirement || 'any') : '3d',
      turnover_frequency: hasTurnoverFrequency ? (job.turnover_frequency || 'any') : 'any',
      experience_keywords: job?.experience_keywords || '',
      capability_keywords: job?.capability_keywords || '',
    };
  }

  function renderJobConfig() {
    const box = document.getElementById('bh-job-config');
    if (!box || !box.classList.contains('open')) return;
    const isCreate = state.jobConfigMode === 'create';
    const current = selectedJob();
    const job = isCreate ? blankJobConfig() : (current ? normalizeJob(current) : null);
    if (!job) {
      box.innerHTML = '<div class="bh-job-hint">请先选择岗位。</div>';
      return;
    }

    const active = job.active_requirement || 'any';
    const turnoverFrequency = job.turnover_frequency || 'any';
    box.innerHTML = `
      <div class="bh-job-config-head">
        <button class="bh-job-mode-btn ${isCreate ? '' : 'active'}" id="bh-job-mode-edit">编辑当前</button>
        <button class="bh-job-mode-btn ${isCreate ? 'active' : ''}" id="bh-job-mode-create">新增岗位</button>
      </div>
      <div class="bh-job-grid">
        <div class="bh-job-field full">
          <label>岗位名称</label>
          <input id="bh-job-title" placeholder="例如：电商运营" value="${esc(job.title || '')}">
        </div>
        <div class="bh-job-field">
          <label>年龄下限</label>
          <input id="bh-job-age-min" type="number" min="0" max="80" value="${jobNumber(job, 'age_min', 24)}">
        </div>
        <div class="bh-job-field">
          <label>年龄上限</label>
          <input id="bh-job-age-max" type="number" min="0" max="80" value="${jobNumber(job, 'age_max', 38)}">
        </div>
        <div class="bh-job-field">
          <label>最低薪资（K/月）</label>
          <input id="bh-job-salary-min" type="number" min="0" max="999" value="${jobNumber(job, 'salary_min_k', 0)}">
        </div>
        <div class="bh-job-field">
          <label>最高薪资（K/月）</label>
          <input id="bh-job-salary-max" type="number" min="0" max="999" value="${jobNumber(job, 'salary_max_k', 0)}">
        </div>
        <div class="bh-job-field">
          <label>最低经验年限</label>
          <input id="bh-job-exp-min" type="number" min="0" max="30" value="${jobNumber(job, 'min_experience_years', 3)}">
        </div>
        <div class="bh-job-field">
          <label>活跃要求</label>
          <select id="bh-job-active">
            ${['any', 'today', '3d', 'week'].map(v => `<option value="${v}" ${active === v ? 'selected' : ''}>${activeRequirementLabel(v)}</option>`).join('')}
          </select>
        </div>
        <div class="bh-job-field full">
          <label>跳槽频率（BOSS 原生单选）</label>
          <select id="bh-job-turnover-frequency">
            ${['any', 'fewer_than_3_in_5y', 'average_job_over_1y'].map(v => `<option value="${v}" ${turnoverFrequency === v ? 'selected' : ''}>${turnoverFrequencyLabel(v)}</option>`).join('')}
          </select>
        </div>
        <div class="bh-job-field full">
          <label>经验关键词（逗号分隔）</label>
          <input id="bh-job-exp-kws" placeholder="例如：天猫,抖音,电商运营,品牌,操盘,3年" value="${esc(job.experience_keywords || '')}">
        </div>
        <div class="bh-job-field full">
          <label>能力关键词（逗号分隔）</label>
          <input id="bh-job-cap-kws" placeholder="例如：团队管理,渠道策略,全渠道,从0到1,项目管理" value="${esc(job.capability_keywords || '')}">
        </div>
      </div>
      <div class="bh-job-actions">
        <button class="bh-btn bh-btn-secondary" id="bh-job-cancel">收起</button>
        <button class="bh-btn bh-btn-primary" id="bh-job-save">${isCreate ? '创建岗位' : '保存'}</button>
      </div>
      <div class="bh-job-hint">${isCreate ? '创建后会自动选中新岗位。' : '保存后点击“扫描列表”重新评分；活跃要求会作为硬筛选。'}</div>
    `;
    box.querySelector('#bh-job-mode-edit')?.addEventListener('click', () => {
      state.jobConfigMode = 'edit';
      renderJobConfig();
    });
    box.querySelector('#bh-job-mode-create')?.addEventListener('click', () => {
      state.jobConfigMode = 'create';
      renderJobConfig();
    });
    box.querySelector('#bh-job-cancel')?.addEventListener('click', () => box.classList.remove('open'));
    box.querySelector('#bh-job-save')?.addEventListener('click', saveJobConfig);
  }

  function intField(id, fallback) {
    const raw = document.getElementById(id)?.value;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function sameJobConfig(saved, payload) {
    if (!saved || !saved.id) return false;
    const numEq = (field) => Number(saved[field]) === Number(payload[field]);
    const strEq = (field) => String(saved[field] || '') === String(payload[field] || '');
    return (
      strEq('title') &&
      numEq('age_min') &&
      numEq('age_max') &&
      numEq('salary_min_k') &&
      numEq('salary_max_k') &&
      numEq('min_experience_years') &&
      strEq('active_requirement') &&
      strEq('turnover_frequency') &&
      strEq('experience_keywords') &&
      strEq('capability_keywords')
    );
  }

  async function readBackSavedJob(jobId) {
    const jobs = await apiGet('/jobs');
    return (jobs || []).find(j => String(j.id) === String(jobId)) || null;
  }

  async function saveJobConfig() {
    const isCreate = state.jobConfigMode === 'create';
    const job = isCreate ? blankJobConfig() : selectedJob();
    if (!job) return;
    const saveBtn = document.getElementById('bh-job-save');
    const title = document.getElementById('bh-job-title')?.value?.trim() || '';
    const payload = {
      title: isCreate ? title : (title || job.title),
      age_min: Math.max(0, Math.min(80, intField('bh-job-age-min', 24))),
      age_max: Math.max(0, Math.min(80, intField('bh-job-age-max', 38))),
      salary_min_k: Math.max(0, Math.min(999, intField('bh-job-salary-min', 0))),
      salary_max_k: Math.max(0, Math.min(999, intField('bh-job-salary-max', 0))),
      min_experience_years: Math.max(0, Math.min(30, intField('bh-job-exp-min', 3))),
      active_requirement: document.getElementById('bh-job-active')?.value || 'any',
      turnover_frequency: document.getElementById('bh-job-turnover-frequency')?.value || 'any',
      experience_keywords: document.getElementById('bh-job-exp-kws')?.value?.trim() || '',
      capability_keywords: document.getElementById('bh-job-cap-kws')?.value?.trim() || '',
    };
    if (payload.age_min && payload.age_max && payload.age_min > payload.age_max) {
      setStatus('年龄下限不能大于上限', true);
      showToast('年龄下限不能大于上限', true);
      return;
    }
    if (payload.salary_min_k && payload.salary_max_k && payload.salary_min_k > payload.salary_max_k) {
      setStatus('最低薪资不能大于最高薪资', true);
      showToast('最低薪资不能大于最高薪资', true);
      return;
    }
    if (!payload.title) {
      setStatus('请先填写岗位名称', true);
      showToast('请先填写岗位名称', true);
      return;
    }
    setStatus(isCreate ? '正在创建岗位…' : '正在保存岗位配置…');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = isCreate ? '创建中…' : '保存中…';
    }
    try {
      const saved = isCreate
        ? await apiPost('/jobs', payload)
        : await apiPatch('/jobs/' + encodeURIComponent(job.id), payload);
      let verified = sameJobConfig(saved, payload) ? saved : await readBackSavedJob(saved && saved.id);
      if (!sameJobConfig(verified, payload)) {
        throw new Error('后端未保存完整岗位字段，请重启后端并重新安装/刷新脚本后再试');
      }
      verified = normalizeJob(verified);
      state.jobs = isCreate
        ? [...state.jobs.filter(j => j.id !== verified.id), verified]
        : state.jobs.map(j => j.id === verified.id ? { ...j, ...verified } : j);
      state.jobId = verified.id;
      state.jobConfigMode = 'edit';
      await loadJobs({ preserveSelection: true });
      const box = document.getElementById('bh-job-config');
      if (box) box.classList.add('open');
      renderJobConfig();
      const msg = isCreate ? `岗位已创建并选中：${verified.title}` : '岗位配置已保存，请重新扫描列表生效';
      setStatus(msg);
      showToast(msg);
    } catch (err) {
      const msg = `${isCreate ? '创建' : '保存'}失败：${err.message || err}`;
      setStatus(msg, true);
      showToast(msg, true);
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = isCreate ? '创建岗位' : '保存';
      }
    }
  }

  // ─── Load workbench jobs into the picker ──────────────────────────
  async function loadJobs(opts = {}) {
    const sel = document.getElementById('bh-job');
    try {
      let jobs = await apiGet('/jobs');
      if ((jobs || []).length && !hasFullJobFields(jobs[0])) {
        try {
          jobs = await apiGetRoot('/jobs');
        } catch {
          // Older /api/ext/jobs only had id/title; keep it usable, with defaults.
        }
      }
      const previous = opts.preserveSelection ? state.jobId : '';
      state.jobs = (jobs || []).map(normalizeJob);
      if (!state.jobs.length) {
        if (sel) sel.innerHTML = '<option value="">（无岗位，请在工作台配置）</option>';
        renderQueueJobFilter();
        renderJobConfig();
        return;
      }
      state.jobId = previous && state.jobs.some(j => j.id === previous) ? previous : state.jobs[0].id;
      if (sel) {
        sel.innerHTML = state.jobs
          .map(j => `<option value="${esc(j.id)}">${esc(j.title)}</option>`)
          .join('');
        sel.value = state.jobId;
      }
      renderQueueJobFilter();
      renderJobConfig();
    } catch {
      if (sel) sel.innerHTML = '<option value="">（加载岗位失败）</option>';
      renderJobConfig();
    }
  }

  // ─── "跳转到 BOSS" 轮询 ──────────────────────────────────────────────
  // Dashboard (localhost) posts a pending-open request when a queue row is
  // clicked; we poll our own backend (not zhipin.com — zero anti-bot surface)
  // and, if the requested candidate's card is still on THIS page, open it and
  // raise the tab. Best-effort: does nothing if the card isn't currently
  // rendered (different page/job/scroll position, or tab long since closed).
  async function pollPendingOpen() {
    let res;
    try {
      res = await apiGet('/pending-open');
    } catch { return; }
    if (!res || !res.boss_id) return;

    if (findCardByBossId(res.boss_id)) {
      await locateCardOnPage({ boss_id: res.boss_id, name: res.name || '' });
      window.focus();
      return;
    }
    setStatus(`未找到 ${res.name || '该候选人'} 的卡片(可能已翻页/不在本页)`, true);
  }

  // ─── Init ─────────────────────────────────────────────────────────
  const panel = createPanel();
  loadConfig();
  loadJobs();
  setInterval(pollPendingOpen, 2500);

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

  // ─── Queue panel (队列复盘悬浮层) ──────────────────────────────────
  // Second floating panel: shows /api/queue/today rows, supports
  // skip/restore, bulk-skip/restore, AI rerank, and click-to-locate on
  // the current BOSS page. Coexists with the small scan panel — the scan
  // panel keeps its scan/greet flow untouched. Uses BACKEND_ROOT (no /ext).
  state.queuePanel = {
    open: false,
    tab: 'queue',            // 'queue' | 'skipped'
    jobId: '',               // queue-only job filter; empty means all jobs
    items: [],               // last-known list (kept in DOM order via diff)
    itemsById: new Map(),    // match_id → item (fast lookup for actions/optimistic revert)
    loading: false,
    autoRefreshTimer: null,
    llmBusy: false,
    bulkGreetRunning: false, // true while doBulkGreet loop is active
    sendingId: null,         // match_id currently being sent (single-row or bulk)
  };

  function renderQueueJobFilter() {
    const select = document.getElementById('bhq-job-filter');
    if (!select) return;
    if (state.queuePanel.jobId && !state.jobs.some(j => String(j.id) === String(state.queuePanel.jobId))) {
      state.queuePanel.jobId = '';
    }
    select.innerHTML = [
      '<option value="">全部岗位</option>',
      ...state.jobs.map(j => `<option value="${esc(j.id)}">${esc(j.title)}</option>`),
    ].join('');
    select.value = state.queuePanel.jobId;
  }

  function ensureQueuePanel() {
    let el = document.getElementById('boss-helper-queue-panel');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'boss-helper-queue-panel';
    el.innerHTML = `
      <div class="bhq-header">
        <h3>队列复盘</h3>
        <div class="bhq-tabs">
          <span class="bhq-tab active" data-tab="queue">队列</span>
          <span class="bhq-tab" data-tab="skipped">已跳过</span>
        </div>
        <span class="bhq-header-spacer"></span>
        <span class="bhq-header-btn" id="bhq-refresh" title="立即刷新">↻</span>
        <span class="bhq-close" id="bhq-close">×</span>
      </div>
      <div class="bhq-toolbar">
        <label class="bhq-filter">岗位
          <select id="bhq-job-filter"><option value="">全部岗位</option></select>
        </label>
        <button class="bhq-act bhq-act-primary" id="bhq-rerank" style="display:none">AI评分</button>
        <button class="bhq-act bhq-act-danger" id="bhq-bulk-skip" style="display:none">一键跳过</button>
        <button class="bhq-act bhq-act-success" id="bhq-bulk-restore" style="display:none">一键恢复</button>
        <span class="bhq-toolbar-status" id="bhq-toolbar-status">就绪</span>
      </div>
      <div class="bhq-progress-wrap" id="bhq-progress-wrap" style="display:none">
        <div class="bhq-progress-bar"><div class="bhq-progress-fill" id="bhq-progress-fill"></div></div>
        <span class="bhq-progress-text" id="bhq-progress-text"></span>
      </div>
      <div class="bhq-list" id="bhq-list"><div class="bhq-empty">加载中…</div></div>
    `;
    document.body.appendChild(el);
    renderQueueJobFilter();

    // Drag by header
    const header = el.querySelector('.bhq-header');
    let dragging = false, dx = 0, dy = 0;
    header.addEventListener('mousedown', (e) => {
      // Don't start drag when clicking interactive header controls
      if (e.target.closest('.bhq-tab, .bhq-header-btn, .bhq-close')) return;
      dragging = true;
      const rect = el.getBoundingClientRect();
      dx = e.clientX - rect.left;
      dy = e.clientY - rect.top;
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = (e.clientX - dx) + 'px';
      el.style.top = (e.clientY - dy) + 'px';
      el.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    // Tab switch
    el.querySelectorAll('.bhq-tab').forEach(t => {
      t.addEventListener('click', () => {
        const tab = t.getAttribute('data-tab');
        if (tab === state.queuePanel.tab) return;
        if (state.queuePanel.bulkGreetRunning || state.queuePanel.llmBusy) {
          showToast('批量打招呼进行中，请先停止', true);
          return;
        }
        state.queuePanel.tab = tab;
        el.querySelectorAll('.bhq-tab').forEach(x => {
          x.classList.toggle('active', x.getAttribute('data-tab') === tab);
        });
        applyToolbarVisibility();
        fetchQueue(true);  // full refresh on tab switch
      });
    });

    // Header buttons
    el.querySelector('#bhq-close').addEventListener('click', closeQueuePanel);
    el.querySelector('#bhq-refresh').addEventListener('click', () => {
      if (state.queuePanel.bulkGreetRunning || state.queuePanel.llmBusy) { showToast('当前任务进行中，请稍后刷新', true); return; }
      fetchQueue(true);
    });
    el.querySelector('#bhq-rerank').addEventListener('click', doTrackedLlmRerank);
    el.querySelector('#bhq-bulk-skip').addEventListener('click', () => doBulkStatus('skipped'));
    el.querySelector('#bhq-bulk-restore').addEventListener('click', () => doBulkStatus('new'));
    el.querySelector('#bhq-job-filter').addEventListener('change', (e) => {
      if (state.queuePanel.bulkGreetRunning || state.queuePanel.llmBusy) {
        e.target.value = state.queuePanel.jobId;
        showToast('批量打招呼进行中，请先停止', true);
        return;
      }
      state.queuePanel.jobId = e.target.value;
      applyToolbarVisibility();
      fetchQueue(true);
    });

    // Row click delegation (locate + action buttons)
    el.querySelector('#bhq-list').addEventListener('click', onListClick);

    applyToolbarVisibility();
    return el;
  }

  function getRerankJobId() {
    if (state.queuePanel.jobId) return state.queuePanel.jobId;
    const jobIds = [...new Set(state.queuePanel.items.map(item => item.job_id).filter(Boolean))];
    return jobIds.length === 1 ? jobIds[0] : '';
  }

  function applyToolbarVisibility() {
    const rerank = document.getElementById('bhq-rerank');
    const bulkSkip = document.getElementById('bhq-bulk-skip');
    const bulkRestore = document.getElementById('bhq-bulk-restore');
    if (!rerank) return;
    const isQueue = state.queuePanel.tab === 'queue';
    const rerankJobId = getRerankJobId();
    rerank.style.display = isQueue ? 'inline-block' : 'none';
    rerank.disabled = !isQueue || !rerankJobId || state.queuePanel.llmBusy;
    rerank.title = rerankJobId ? '' : '当前列表包含多个岗位，请先选择一个岗位';
    bulkSkip.style.display = isQueue ? 'inline-block' : 'none';
    bulkRestore.style.display = isQueue ? 'none' : 'inline-block';
    bulkSkip.disabled = state.queuePanel.llmBusy;
    bulkRestore.disabled = state.queuePanel.llmBusy;
    rerank.title = rerankJobId ? '' : '当前列表包含多个岗位，请先选择一个岗位';
  }

  function openQueuePanel() {
    const el = ensureQueuePanel();
    // The queue starts broad so recruiters can review every role first.
    // AI评分 remains available after selecting one concrete job.
    state.queuePanel.jobId = '';
    renderQueueJobFilter();
    applyToolbarVisibility();
    // Layout: wide screen → side-by-side left of small panel; narrow → stacked
    // below. Judged once on open (not on resize) — cheap & good enough.
    const stacked = window.innerWidth < 1280;
    el.classList.toggle('bhq-stacked', stacked);
    if (stacked) {
      const smallPanel = document.getElementById('boss-helper-panel');
      const smallRect = smallPanel ? smallPanel.getBoundingClientRect() : { bottom: 80 };
      el.style.top = (smallRect.bottom + 12) + 'px';
      el.style.right = '20px';
      el.style.left = 'auto';
    } else {
      el.style.top = '200px';
      el.style.right = '372px';
      el.style.left = 'auto';
    }
    el.style.display = 'flex';
    state.queuePanel.open = true;
    fetchQueue(true);
    if (state.queuePanel.autoRefreshTimer) clearInterval(state.queuePanel.autoRefreshTimer);
    state.queuePanel.autoRefreshTimer = setInterval(() => fetchQueue(false), 10000);
  }

  function closeQueuePanel() {
    const el = document.getElementById('boss-helper-queue-panel');
    if (el) el.style.display = 'none';
    state.queuePanel.open = false;
    if (state.queuePanel.autoRefreshTimer) {
      clearInterval(state.queuePanel.autoRefreshTimer);
      state.queuePanel.autoRefreshTimer = null;
    }
  }

  function setQueueStatus(msg, err = false) {
    const el = document.getElementById('bhq-toolbar-status');
    if (!el) return;
    el.textContent = msg;
    el.className = err ? 'bhq-toolbar-status err' : 'bhq-toolbar-status';
  }

  function showToast(msg, err = false) {
    let t = document.getElementById('bhq-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'bhq-toast';
      t.className = 'bhq-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'bhq-toast show' + (err ? ' err' : '');
    clearTimeout(t._hideTimer);
    t._hideTimer = setTimeout(() => { t.className = 'bhq-toast'; }, 2200);
  }

  async function fetchQueue(showLoading) {
    if (state.queuePanel.loading) return;
    state.queuePanel.loading = true;
    if (showLoading) setQueueStatus('加载中…');
    const params = new URLSearchParams();
    if (state.queuePanel.jobId) params.append('job_id', state.queuePanel.jobId);
    if (state.queuePanel.tab === 'skipped') params.append('status_filter', 'skipped');
    params.append('limit', '100');
    try {
      const items = await apiGetRoot('/queue/today?' + params.toString());
      state.queuePanel.items = Array.isArray(items) ? items : [];
      state.queuePanel.itemsById = new Map(state.queuePanel.items.map(x => [x.match_id, x]));
      diffRenderQueueList(state.queuePanel.items);
      applyToolbarVisibility();
      setQueueStatus('就绪');
    } catch (err) {
      setQueueStatus('加载失败: ' + err.message, true);
    } finally {
      state.queuePanel.loading = false;
    }
  }

  function scoreBadgeClass(s) {
    if (s >= 80) return 'score-high';
    if (s >= 60) return 'score-mid';
    return 'score-low';
  }
  function llmBadgeClass(s) {
    if (s >= 80) return 'llm-high';
    if (s >= 60) return 'llm-mid';
    return 'llm-low';
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function statusTitle(status) {
    return ({
      new: '新',
      queued: '已入队',
      drafted: '已生成话术',
      filled: '已填入输入框',
      sent_manual: '已发送',
      skipped: '已跳过',
    })[status] || status || '';
  }

  // Build the inline info line: age岁 · work_years · education · salary · city
  function buildInfoLine(item) {
    const parts = [];
    if (item.age) parts.push(item.age + '岁');
    if (item.work_years) parts.push(item.work_years);
    if (item.education) parts.push(item.education);
    if (item.salary_range) parts.push(item.salary_range);
    if (item.expected_city) parts.push(item.expected_city);
    return parts.join(' · ');
  }

  // Row template — minimal fields per v1 spec (no CheckBadges/skill tags/preview).
  function buildRowHTML(item) {
    const isSkipped = state.queuePanel.tab === 'skipped';
    const missingHtml = item.missing_info
      ? `<div class="bhq-missing" title="${esc(item.missing_info)}">⚠ 缺：${esc(item.missing_info)}</div>` : '';
    const llmBadge = (item.llm_score != null)
      ? `<span class="bhq-badge ${llmBadgeClass(item.llm_score)}" title="AI 精评分">AI ${Math.round(item.llm_score)}</span>` : '';
    const actionBtns = isSkipped
      ? `<button class="bhq-act bhq-act-success" data-act="restore" data-mid="${item.match_id}">恢复</button>`
      : `
        <button class="bhq-act bhq-act-secondary" data-act="skip" data-mid="${item.match_id}">跳过</button>
      `;
    return `
      <div class="bhq-row-main">
        <div class="bhq-name-line">
          <span class="bhq-status-dot ${item.status || 'new'}" title="${esc(statusTitle(item.status))}"></span>
          <span class="bhq-name">${esc(item.name || '未知')}</span>
          <span class="bhq-job" title="岗位：${esc(item.job_title || '未指定岗位')}">${esc(item.job_title || '未指定岗位')}</span>
          <span class="bhq-badge ${scoreBadgeClass(item.score)}" title="规则分">${Math.round(item.score)}</span>
          ${llmBadge}
        </div>
        <div class="bhq-info">${esc(buildInfoLine(item))}</div>
        ${missingHtml}
      </div>
      <div class="bhq-row-actions">${actionBtns}</div>
    `;
  }

  // Cheap change-detection signature for a row (score+status+llm_score+reason+sending).
  function rowSig(item) {
    const sending = state.queuePanel.sendingId === item.match_id ? 1 : 0;
    return `${item.status}|${item.job_id ?? ''}|${item.job_title ?? ''}|${item.score}|${item.llm_score ?? ''}|${item.missing_info ?? ''}|${sending}`;
  }

  // Incremental diff render: upsert / remove / move rows by match_id so scroll
  // position and hover state survive the 10s auto-refresh.
  function diffRenderQueueList(items) {
    const listEl = document.getElementById('bhq-list');
    if (!listEl) return;

    if (!items.length) {
      listEl.innerHTML = `<div class="bhq-empty">${state.queuePanel.tab === 'skipped' ? '暂无已跳过记录' : '队列为空（先在页面里扫描）'}</div>`;
      return;
    }

    // Remove sentinel empty message if present
    const empty = listEl.querySelector('.bhq-empty');
    if (empty) empty.remove();

    const existing = new Map();
    for (const child of Array.from(listEl.children)) {
      const mid = child.getAttribute('data-mid');
      if (mid) existing.set(Number(mid), child);
    }

    const wantedIds = new Set(items.map(i => i.match_id));
    // Remove rows that no longer belong
    for (const [mid, node] of existing) {
      if (!wantedIds.has(mid)) node.remove();
    }

    let prev = null;
    for (const item of items) {
      let node = existing.get(item.match_id);
      if (!node) {
        node = document.createElement('div');
        node.className = 'bhq-row';
        node.setAttribute('data-mid', String(item.match_id));
        if (item.boss_id) node.setAttribute('data-bossid', item.boss_id);
        node.innerHTML = buildRowHTML(item);
        node._sig = rowSig(item);
      } else {
        // Update only if content signature changed (cheap: score+status+llm_score+reason)
        const sig = rowSig(item);
        if (node._sig !== sig) {
          node.innerHTML = buildRowHTML(item);
          if (item.boss_id) node.setAttribute('data-bossid', item.boss_id);
        }
        node._sig = sig;
      }
      // Ensure DOM order matches items[]
      const nextSibling = prev ? prev.nextSibling : listEl.firstChild;
      if (nextSibling !== node) listEl.insertBefore(node, nextSibling);
      prev = node;
    }
  }

  // Click dispatcher: action buttons intercepted first; otherwise treat the
  // row click as "locate this candidate's card on the current BOSS page".
  function onListClick(e) {
    const actBtn = e.target.closest('button[data-act]');
    if (actBtn) {
      e.stopPropagation();
      const mid = Number(actBtn.getAttribute('data-mid'));
      const act = actBtn.getAttribute('data-act');
      const item = state.queuePanel.itemsById.get(mid);
      if (!item) return;
      if (state.queuePanel.bulkGreetRunning && act !== 'restore') {
        showToast('批量打招呼进行中，请稍候', true);
        return;
      }
      if (act === 'skip') return handleStatusChange(item, 'skipped');
      if (act === 'restore') return handleStatusChange(item, 'new');
      return;
    }
    const row = e.target.closest('.bhq-row');
    if (!row) return;
    const mid = Number(row.getAttribute('data-mid'));
    const item = state.queuePanel.itemsById.get(mid);
    if (!item || !item.boss_id) { showToast('该候选人无 boss_id，无法定位', true); return; }
    locateCardOnPage(item);
  }

  // Single place that performs a real send for a queue item — used by both
  // handleGreet (mode: 'manual') and doBulkGreet (mode: 'auto').
  //
  // Probe flow (BOSS 推荐页限制：点"打招呼"要么弹出可编辑招呼框、要么直接发
  // 送后台配置的招呼语，无法在发送前插入自定义文本):
  //   1. Trigger BOSS's greet UI (native 打招呼 button, or resume-panel button).
  //   2. Poll up to 5s for an editable chat/greet input to appear.
  //      - Appears  → this account supports custom greetings: fill our
  //        template + click send.  reason: ok.
  //      - Never appears → the account sent its default 招呼语 immediately;
  //        we CANNOT inject the template.  reason: 'no_editable' (do NOT mark
  //        as sent — BOSS blocks re-greeting anyway, so no dup risk).
  async function sendGreetingToItem(item, opts) {
    const mode = (opts && opts.mode) || 'manual';

    if (state.greetingCount >= state.dailyCap) {
      return { ok: false, reason: 'cap' };
    }

    const hazard = checkHazards();
    if (hazard) {
      return { ok: false, reason: 'hazard', detail: hazard };
    }

    const target = findCardByBossId(item.boss_id);
    if (!target) {
      return { ok: false, reason: 'not_found' };
    }

    let draftText = '';
    try {
      const res = await apiPostRoot(`/outreach/${item.match_id}/draft`, {});
      draftText = (res && res.draft_text) || '';
    } catch (err) {
      return { ok: false, reason: 'error', detail: err.message };
    }
    if (!draftText) {
      return { ok: false, reason: 'error', detail: '话术为空' };
    }

    // 1) Trigger BOSS's greet flow.
    const triggered = await triggerGreetUI(target);
    if (!triggered) {
      dumpChatInputDiag();
      return { ok: false, reason: 'no_greet_btn', detail: '未找到打招呼按钮，诊断已复制' };
    }

    if (document.hidden) await waitForVisible();

    // 2) Wait for an editable greet/chat input to appear.
    const input = await waitForChatInput(5000);
    if (!input) {
      dumpChatInputDiag();
      // No editable box → account sends its default 招呼语 on click. Nothing
      // we can inject; leave status untouched so it's not falsely "sent".
      return { ok: false, reason: 'no_editable', detail: '账号点打招呼直接发默认招呼语，无法插入模板' };
    }

    // 3) Editable box present → fill our template and send.
    fillInputEl(input, draftText);
    await sleep(500);

    const sendBtn = findSendButton();
    if (!sendBtn) {
      dumpChatInputDiag();
      return { ok: false, reason: 'no_input', detail: '找到招呼框但没有发送按钮，诊断已复制' };
    }
    sendBtn.click();

    incrCounter();
    const countEl = document.getElementById('bh-count');
    if (countEl) countEl.textContent = state.greetingCount;

    try {
      await apiPost('/log-greeting', {
        expectId: item.boss_id,
        name: item.name,
        mode,
        job_id: item.job_id,
      });
    } catch { /* non-critical, mirrors doAutoStart's existing tolerance */ }

    item.status = mode === 'auto' ? 'sent_auto' : 'sent_manual';
    return { ok: true };
  }

  // Human-readable failure text for sendGreetingToItem's structured result.
  function greetFailMessage(res, item) {
    if (res.reason === 'not_found') return `未找到卡片，可能已翻页：${item.name}`;
    if (res.reason === 'hazard') return `检测到风控阻断(${res.detail})，已停止`;
    if (res.reason === 'cap') return '已达每日上限';
    if (res.reason === 'no_greet_btn') return `未找到打招呼按钮：${item.name}（诊断已复制）`;
    if (res.reason === 'no_editable') return `你的账号点"打招呼"是直接发送默认招呼语，无法插入自定义模板`;
    if (res.reason === 'no_input') return `找到招呼框但没有发送按钮：${item.name}`;
    return `打招呼失败：${item.name}` + (res.detail ? `（${res.detail}）` : '');
  }

  async function handleGreet(item) {
    if (state.autoRunning || state.queuePanel.bulkGreetRunning || state.queuePanel.sendingId) {
      showToast('自动/批量打招呼进行中，请稍后再试', true);
      return;
    }
    if (state.greetingCount >= state.dailyCap) {
      showToast('已达每日上限', true);
      return;
    }
    // sendingId flows into rowSig (see buildRowHTML/rowSig), so the row's
    // disabled/"发送中…" state survives even if a concurrent 10s poll
    // rebuilds this row's DOM node mid-send.
    state.queuePanel.sendingId = item.match_id;
    diffRenderQueueList(state.queuePanel.items);
    setQueueStatus(`正在打招呼: ${item.name}…`);
    try {
      const res = await sendGreetingToItem(item, { mode: 'manual' });
      if (res.ok) {
        showToast(`已打招呼：${item.name}`);
        setQueueStatus(`已打招呼：${item.name}`);
        // Optimistic removal — mirrors handleStatusChange: a sent item no
        // longer belongs in the 队列 tab (server-side filtering would drop
        // it on the next fetch anyway; do it now so the row disappears
        // immediately instead of staying visible-but-stale).
        state.queuePanel.items = state.queuePanel.items.filter(x => x.match_id !== item.match_id);
        state.queuePanel.itemsById.delete(item.match_id);
      } else {
        const msg = greetFailMessage(res, item);
        setQueueStatus(msg, true);
        showToast(msg, true);
      }
    } catch (err) {
      setQueueStatus('打招呼失败: ' + err.message, true);
      showToast('打招呼失败: ' + err.message, true);
    } finally {
      state.queuePanel.sendingId = null;
      diffRenderQueueList(state.queuePanel.items);
    }
  }

  // Optimistic single-row status change: remove from current view (both tabs
  // would filter it out anyway), revert on failure.
  async function handleStatusChange(item, newStatus) {
    const listEl = document.getElementById('bhq-list');
    const node = listEl && listEl.querySelector(`[data-mid="${item.match_id}"]`);
    if (node) node.style.opacity = '0.4';
    try {
      await apiPatchRoot(`/outreach/${item.match_id}/status`, { status: newStatus });
      // Remove from local list (queue tab filters out sent/skipped;
      // skipped tab filters in only skipped so restore→new also leaves).
      state.queuePanel.items = state.queuePanel.items.filter(x => x.match_id !== item.match_id);
      state.queuePanel.itemsById.delete(item.match_id);
      diffRenderQueueList(state.queuePanel.items);
      setQueueStatus(`已更新: ${item.name} → ${statusTitle(newStatus)}`);
    } catch (err) {
      if (node) node.style.opacity = '';
      setQueueStatus('操作失败: ' + err.message, true);
      showToast('操作失败: ' + err.message, true);
    }
  }

  async function doBulkStatus(newStatus) {
    const items = state.queuePanel.items;
    if (!items.length) { showToast('列表为空', true); return; }
    const verb = newStatus === 'skipped' ? '跳过' : '恢复';
    const selectedJob = state.jobs.find(j => String(j.id) === String(state.queuePanel.jobId));
    const scope = selectedJob ? `岗位“${selectedJob.title}”` : '全部岗位';
    if (!window.confirm(`确定要一键${verb}${scope}当前列表中的 ${items.length} 位候选人吗？`)) return;
    setQueueStatus(`正在${verb} ${items.length} 位…`);
    try {
      const match_ids = items.map(x => x.match_id);
      await apiPatchRoot('/outreach/bulk-status', { match_ids, status: newStatus });
      setQueueStatus(`已${verb} ${items.length} 位候选人`);
      showToast(`已${verb} ${items.length} 位`);
      await fetchQueue(true);
    } catch (err) {
      setQueueStatus(`一键${verb}失败: ` + err.message, true);
      showToast(`一键${verb}失败: ` + err.message, true);
    }
  }

  function updateBulkGreetButtons() {
    // Legacy bulk-greet controls were removed from the queue UI.
  }

  // The queue panel auto-refreshes every 10s (fetchQueue) which overwrites
  // state.queuePanel.items — pause it for the duration of a bulk run so it
  // can't clobber the list a running loop is iterating over.
  function pauseQueueAutoRefresh() {
    if (state.queuePanel.autoRefreshTimer) {
      clearInterval(state.queuePanel.autoRefreshTimer);
      state.queuePanel.autoRefreshTimer = null;
    }
  }
  function resumeQueueAutoRefresh() {
    if (state.queuePanel.open && !state.queuePanel.autoRefreshTimer) {
      state.queuePanel.autoRefreshTimer = setInterval(() => fetchQueue(false), 10000);
    }
  }

  function showProgress(done, total, label) {
    const wrap = document.getElementById('bhq-progress-wrap');
    const fill = document.getElementById('bhq-progress-fill');
    const text = document.getElementById('bhq-progress-text');
    if (!wrap) return;
    wrap.style.display = 'flex';
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    if (fill) fill.style.width = pct + '%';
    if (text) text.textContent = `${label} (${done}/${total})`;
  }
  function hideProgress() {
    const wrap = document.getElementById('bhq-progress-wrap');
    if (wrap) wrap.style.display = 'none';
  }

  async function doBulkGreet() {
    if (state.autoRunning || state.queuePanel.bulkGreetRunning) {
      showToast('已有打招呼任务在运行', true);
      return;
    }
    const allItems = state.queuePanel.items.filter(x => x && x.boss_id);
    if (!allItems.length) { showToast('列表为空', true); return; }

    const remainingCap = Math.max(0, state.dailyCap - state.greetingCount);
    if (remainingCap === 0) { showToast('已达每日上限', true); return; }

    const runCount = Math.min(allItems.length, remainingCap);
    const estMinLow = Math.max(1, Math.round(runCount * state.delayMin / 60));
    const estMinHigh = Math.max(1, Math.round(runCount * state.delayMax / 60));
    const capNote = runCount < allItems.length
      ? `（受今日上限限制，仅处理前 ${runCount}/${allItems.length} 位）` : '';
    const confirmMsg =
      `即将对 ${runCount} 位候选人依次打招呼${capNote}\n` +
      `每人间隔 ${state.delayMin}-${state.delayMax} 秒，预计耗时约 ${estMinLow}-${estMinHigh} 分钟。\n` +
      `发送内容为系统生成的模板话术，过程中可随时点击"停止打招呼"中断。是否继续？`;
    if (!window.confirm(confirmMsg)) return;

    // Snapshot: the loop works off this fixed array so the paused-but-just-
    // in-case-late auto-refresh or other mutations can't shift indices mid-run.
    const queue = allItems.slice(0, runCount);

    state.queuePanel.bulkGreetRunning = true;
    updateBulkGreetButtons();
    pauseQueueAutoRefresh();

    let sent = 0, notFound = 0, failed = 0;
    showProgress(0, queue.length, '准备中…');

    for (let i = 0; i < queue.length; i++) {
      if (!state.queuePanel.bulkGreetRunning) break;

      if (state.greetingCount >= state.dailyCap) {
        setQueueStatus('已达每日上限，批量打招呼自动停止');
        break;
      }

      // Re-read from itemsById: sendGreetingToItem mutates item.status in
      // place, and this keeps the loop working off the live object the UI
      // renders even though membership/order comes from the fixed snapshot.
      const item = state.queuePanel.itemsById.get(queue[i].match_id) || queue[i];

      state.queuePanel.sendingId = item.match_id;
      showProgress(i, queue.length, `正在打招呼: ${item.name}`);

      const res = await sendGreetingToItem(item, { mode: 'auto' });
      if (res.ok) {
        sent++;
        state.queuePanel.items = state.queuePanel.items.filter(x => x.match_id !== item.match_id);
        state.queuePanel.itemsById.delete(item.match_id);
      } else if (res.reason === 'not_found') {
        notFound++;
      } else if (res.reason === 'hazard') {
        failed++;
        setQueueStatus(`检测到风控阻断(${res.detail})，批量打招呼已停止`, true);
        state.queuePanel.sendingId = null;
        state.queuePanel.bulkGreetRunning = false;
        break;
      } else if (res.reason === 'cap') {
        setQueueStatus('已达每日上限，批量打招呼自动停止');
        state.queuePanel.sendingId = null;
        break;
      } else if (res.reason === 'no_editable') {
        // Account sends its default 招呼语 on click — custom templates aren't
        // possible on this page. No point continuing the whole batch.
        setQueueStatus('你的账号点"打招呼"直接发默认招呼语，无法插入模板，已停止', true);
        showToast('账号不支持自定义招呼语，已停止批量', true);
        state.queuePanel.sendingId = null;
        state.queuePanel.bulkGreetRunning = false;
        break;
      } else {
        failed++;
      }

      state.queuePanel.sendingId = null;
      diffRenderQueueList(state.queuePanel.items);
      showProgress(i + 1, queue.length, `${item.name} 已处理`);

      if (i < queue.length - 1 && state.queuePanel.bulkGreetRunning) {
        const delay = randDelay();
        showProgress(i + 1, queue.length, `等待 ${Math.round(delay / 1000)} 秒…`);
        await sleep(delay);
      }
    }

    state.queuePanel.bulkGreetRunning = false;
    state.queuePanel.sendingId = null;
    updateBulkGreetButtons();
    resumeQueueAutoRefresh();
    hideProgress();

    const summary = `批量打招呼完成：已发送 ${sent} 人` +
      (notFound ? `，未找到 ${notFound} 人` : '') +
      (failed ? `，失败 ${failed} 人` : '');
    setQueueStatus(summary, failed > 0 || notFound > 0);
    showToast(summary, failed > 0);
    await fetchQueue(true);
  }

  function doBulkGreetStop() {
    state.queuePanel.bulkGreetRunning = false;
    setQueueStatus('正在停止批量打招呼…');
  }

  async function doLlmRerank() {
    if (state.queuePanel.llmBusy) return;
    const btn = document.getElementById('bhq-rerank');
    if (!state.queuePanel.jobId) { showToast('请选择具体岗位后进行 AI 精评', true); return; }
    state.queuePanel.llmBusy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'AI 评分中…'; }
    setQueueStatus('AI 精评队列中，可能需要 1-3 分钟…');
    try {
      // /llm-rerank lives under /api/ext — reuse old apiPost (with /ext prefix).
      // Backend returns 200 with {configured:false, error} when LLM isn't set.
      const res = await apiPost('/llm-rerank', { job_id: state.queuePanel.jobId, limit: 60 });
      if (res && res.configured === false) {
        const msg = res.error || 'LLM 未配置';
        setQueueStatus(msg, true);
        showToast(msg, true);
        return;
      }
      if (res && res.error) {
        setQueueStatus('AI 精评失败: ' + res.error, true);
        showToast('AI 精评失败: ' + res.error, true);
        return;
      }
      const scored = (res && (res.scored ?? 0));
      showToast(`AI 精评完成：${scored} 人`);
      setQueueStatus(`AI 精评完成：${scored} 人`);
      await fetchQueue(true);
    } catch (err) {
      setQueueStatus('AI 精评失败: ' + err.message, true);
      showToast('AI 精评失败: ' + err.message, true);
    } finally {
      state.queuePanel.llmBusy = false;
      if (btn) btn.textContent = 'AI 精评队列';
      applyToolbarVisibility();
    }
  }

  async function doTrackedLlmRerank() {
    if (state.queuePanel.llmBusy || state.queuePanel.bulkGreetRunning) return;
    const btn = document.getElementById('bhq-rerank');
    const rerankJobId = getRerankJobId();
    if (!rerankJobId) { showToast('当前列表包含多个岗位，请先选择一个岗位', true); return; }

    state.queuePanel.llmBusy = true;
    pauseQueueAutoRefresh();
    if (btn) { btn.disabled = true; btn.textContent = 'AI评分中'; }
    showProgress(0, 0, '正在创建评分任务');
    setQueueStatus('AI评分任务已启动，正在准备候选人…');
    try {
      const started = await apiPost('/llm-rerank-jobs', { job_id: rerankJobId, limit: 60 });
      if (!started || started.error || started.configured === false) {
        throw new Error((started && started.error) || '无法启动 AI评分任务');
      }

      while (true) {
        const task = await apiPost(`/llm-rerank-jobs/${encodeURIComponent(started.task_id)}/status`, {});
        if (!task || task.error) throw new Error((task && task.error) || '评分任务状态不可用');
        showProgress(task.processed || 0, task.total || started.total || 0, task.message || '正在评分');
        setQueueStatus(task.message || '正在评分…', task.status === 'failed');

        if (task.status === 'succeeded') {
          const summary = `AI评分完成：${task.scored}/${task.total} 人`;
          showToast(summary);
          setQueueStatus(summary);
          await fetchQueue(true);
          return;
        }
        if (task.status === 'failed') throw new Error(task.error || 'AI评分失败');
        await sleep(1000);
      }
    } catch (err) {
      const message = 'AI评分失败：' + err.message;
      setQueueStatus(message, true);
      showToast(message, true);
    } finally {
      state.queuePanel.llmBusy = false;
      resumeQueueAutoRefresh();
      hideProgress();
      if (btn) btn.textContent = 'AI评分';
      applyToolbarVisibility();
    }
  }

  // BOSS can stack resume popups. Restrict this to panels that actually expose
  // a greeting action, so unrelated dialogs (risk controls, settings, etc.)
  // are never closed by a queue-row click.
  function findOpenResumePanels() {
    const panels = [];
    const selectors = [
      '.boss-layer__wrapper', '.boss-popup__wrapper', 'div.dialog-wrap',
      '[class*="resume"][class*="dialog"]', '[class*="resume"][class*="popup"]',
      '[class*="geek"][class*="detail"]', '[class*="detail"][class*="dialog"]',
      '[class*="resume"][class*="drawer"]',
    ].join(',');
    const ownPanels = [document.getElementById('boss-helper-panel'), document.getElementById('boss-helper-queue-panel')];
    for (const doc of getAllDocs()) {
      for (const panel of doc.querySelectorAll(selectors)) {
        if (!isVisibleElement(panel) || ownPanels.some(own => own && own.contains(panel))) continue;
        const text = (panel.innerText || '').slice(0, 2000);
        if (!/(打招呼|联系Ta|联系TA)/.test(text)) continue;
        if (!panels.includes(panel)) panels.push(panel);
      }
    }
    return panels;
  }

  function findResumeCloseButton(panel) {
    const byAttribute = [...panel.querySelectorAll(
      '[class*="close"], [aria-label*="关闭"], [title*="关闭"], [data-action="close"]'
    )].filter(isVisibleElement);
    if (byAttribute.length) return byAttribute[0];
    return [...panel.querySelectorAll('button, a, span, i, div')]
      .filter(el => isVisibleElement(el) && el.children.length === 0 && (el.textContent || '').trim() === '×')
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0] || null;
  }

  async function closeOpenResumePanels() {
    for (let attempt = 0; attempt < 4; attempt++) {
      const panels = findOpenResumePanels();
      if (!panels.length) return true;
      const panel = panels[panels.length - 1];
      const close = findResumeCloseButton(panel);
      if (!close) return false;
      close.click();
      const deadline = Date.now() + 1200;
      while (Date.now() < deadline && isVisibleElement(panel)) await sleep(80);
    }
    return findOpenResumePanels().length === 0;
  }

  async function waitForResumeIdentity(item, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    let sawPanel = false;
    while (Date.now() < deadline) {
      const panels = findOpenResumePanels();
      if (panels.length) {
        sawPanel = true;
        for (const panel of panels) {
          const ids = [...panel.querySelectorAll('[data-expect], [data-geek], [data-geekid]')]
            .map(el => el.getAttribute('data-expect') || el.getAttribute('data-geek') || el.getAttribute('data-geekid'));
          if (ids.includes(item.boss_id)) return 'confirmed';
          if (item.name && (panel.innerText || '').includes(item.name)) return 'confirmed';
        }
      }
      await sleep(100);
    }
    return sawPanel ? 'mismatch' : 'unverified';
  }

  let resumeOpenInFlight = false;

  // Open exactly one verified resume from a live card. This prevents both
  // stacked BOSS modals and stale virtual-list references opening another user.
  async function locateCardOnPage(item) {
    if (resumeOpenInFlight) {
      showToast('正在打开上一份简历，请稍候', true);
      return;
    }
    resumeOpenInFlight = true;
    try {
      if (!await closeOpenResumePanels()) {
        setQueueStatus('未能自动关闭已有简历，请先关闭后再试', true);
        showToast('未能自动关闭已有简历，请先关闭后再试', true);
        return;
      }
      const target = findCardByBossId(item.boss_id);
      if (!target || getCardCandidateId(target) !== item.boss_id) {
        setQueueStatus('未找到与队列记录一致的当前卡片，未执行打开操作', true);
        showToast('未找到与队列记录一致的当前卡片', true);
        return;
      }
      try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
      target.classList.add('bhq-located');
      setTimeout(() => target.classList.remove('bhq-located'), 2000);
      if (!openCardChat(target)) {
        setQueueStatus('未找到该候选人的简历入口', true);
        showToast('未找到该候选人的简历入口', true);
        return;
      }
      const result = await waitForResumeIdentity(item);
      if (result === 'confirmed') {
        setQueueStatus(`已定位并打开简历：${item.name || ''}`);
        return;
      }
      if (result === 'mismatch') await closeOpenResumePanels();
      const message = result === 'mismatch'
        ? '打开的简历与所选候选人不一致，已自动关闭'
        : '简历层未出现或无法确认候选人身份，请重试';
      setQueueStatus(message, true);
      showToast(message, true);
    } finally {
      resumeOpenInFlight = false;
    }
  }

  bindBadgeListeners();
})();
