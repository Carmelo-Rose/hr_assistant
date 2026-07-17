// ==UserScript==
// @name         招聘助手 — 油猴版
// @namespace    https://github.com/hr_assistant
// @version      1.24.1
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
  // Business dates and displayed timestamps follow the production service
  // clock (192.168.1.198, China Standard Time), not the browser timezone.
  const SERVER_TIME_ZONE = 'Asia/Shanghai';
  function getServerDateKey(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: SERVER_TIME_ZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
  }
  // `li.card-item` = 新版推荐/沟通页卡片（2026-07 起）；`li.geek-info-card` = 旧版人才库搜索页卡片。
  // 两个选择器并存，哪个页面用哪套 DOM 就匹配哪个。
  const CARD_SEL = 'li.card-item, li.geek-info-card';
  const PENDING_QUEUE_STATUSES = new Set(['new', 'queued', 'drafted', 'filled']);
  const COMPLETED_QUEUE_STATUSES = new Set(['sent_manual', 'sent_auto']);

  // ─── State ────────────────────────────────────────────────────────
  const state = {
    scanned: [],       // [{expectId, name, score, is_blocked, details, draft, cardEl}]
    jobId: '',         // selected workbench job id (scoring profile)
    jobs: [],          // [{id, title}]
    jobConfigMode: 'edit', // 'edit' | 'create'
    llmEnabled: false, // backend has LLM configured → personalize greetings
    threshold: 70,
    dailyCap: 150,
    greetingCount: 0,
    multiPage: true,      // auto-scroll to load more before scoring
    maxCandidates: 50,    // stop auto-loading after roughly this many cards
    configLoaded: false,
    todayKey: getServerDateKey(),
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

  function incrCounter() {
    state.greetingCount++;
    GM_setValue('boss_count', state.greetingCount);
    updateDailyProgress();
  }

  function decrCounter() {
    state.greetingCount = Math.max(0, state.greetingCount - 1);
    GM_setValue('boss_count', state.greetingCount);
    updateDailyProgress();
  }

  function updateDailyProgress() {
    const countEl = document.getElementById('bh-count');
    if (countEl) countEl.textContent = state.greetingCount;
    const capEl = document.getElementById('bh-cap');
    if (capEl) capEl.textContent = state.dailyCap;
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

  // Save a real candidate/detail link when BOSS exposes one on the identity
  // element. Many newer cards are button-driven and have no durable URL; in
  // that case this deliberately returns empty instead of saving the list URL.
  function getCandidateShareUrl(card, idEl) {
    const identityAnchor =
      (idEl && idEl.matches?.('a[href]') ? idEl : null) ||
      idEl?.closest?.('a[href]') ||
      idEl?.querySelector?.('a[href]') ||
      card.querySelector('.name-wrap a[href], a[data-contact][href], a[class*="name"][href]');
    return identityAnchor ? safeBossUrl(identityAnchor.href || '') : '';
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
      const shareUrl = getCandidateShareUrl(card, idEl);

      results.push({
        index: idx, name, age, experience, education, jobStatus, salary, activeStatus,
        skills: skills.slice(0, 8),
        expectCity, company, title, school, major,
        expectId, lid, jid, shareUrl,
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
      box-shadow: 0 12px 32px rgba(35, 55, 130, .14); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px; color: #24304f; user-select: none;
      display: flex; flex-direction: column; max-height: calc(100vh - 216px); overflow: hidden;
    }
    #boss-helper-panel.dragging { cursor: move; }
    .bh-header {
      display: flex; align-items: center; justify-content: space-between;
      min-height: 44px; box-sizing: border-box; padding: 8px 10px 8px 14px; background: #4f63d8; color: #fff;
      border-radius: 13px 13px 0 0; cursor: move; flex: 0 0 auto;
    }
    .bh-header-left { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .bh-header h3 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: .1px; white-space: nowrap; }
    .bh-header-actions { display: flex; align-items: center; gap: 4px; }
    .bh-window-action, .bh-back {
      width: 30px; height: 28px; padding: 0; border: 0; border-radius: 7px;
      display: inline-flex; align-items: center; justify-content: center;
      background: rgba(255,255,255,.12); color: #fff; cursor: pointer;
    }
    .bh-window-action img, .bh-back img { width: 15px; height: 15px; display: block; pointer-events: none; }
    .bh-window-action:hover, .bh-back:hover { background: rgba(255,255,255,.22); }
    .bh-window-action:focus-visible, .bh-back:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
    .bh-back { display: none; }
    .bh-body {
      min-height: 0; padding: 12px 14px 12px; overflow-y: auto;
      overscroll-behavior: contain; scrollbar-gutter: stable;
    }
    #boss-helper-panel select {
      appearance: none; -webkit-appearance: none; outline: none; color-scheme: light;
      padding-right: 30px !important; cursor: pointer; color: #2e3b66;
      background-color: #fff;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1.5 1.5 6 6l4.5-4.5' fill='none' stroke='%23727da3' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 10px center; background-size: 12px 8px;
      transition: border-color .15s, background-color .15s;
    }
    #boss-helper-panel select:hover { border-color: #aeb8dc !important; background-color: #fbfcff; }
    #boss-helper-panel select:focus { outline: none; border-color: #7083e7 !important; box-shadow: 0 0 0 2px rgba(79,99,216,.12) !important; }
    #boss-helper-panel select option { background: #fff; color: #24304f; }
    #boss-helper-panel.bh-collapsed .bh-body { display: none; }
    #boss-helper-panel.bh-collapsed .bh-header { border-radius: 12px; }
    #boss-helper-panel.bh-queue-mode { height: 620px; }
    #boss-helper-panel.bh-queue-mode .bh-main-view { display: none; }
    #boss-helper-panel.bh-queue-mode .bh-back { display: inline-flex; }
    #boss-helper-panel.bh-queue-mode .bh-collapse-action { display: none; }
    .bh-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .bh-row > label:first-child { flex: 0 0 70px; font-size: 12px; color: #66708b; }
    .bh-row input[type=number] { width: 60px; height: 34px; box-sizing: border-box; padding: 5px 7px; border: 1px solid #dce1f0; border-radius: 8px; background: #fff; }
    .bh-row input[type=range] { flex: 1; min-width: 0; }
    .bh-row select { height: 34px; padding: 5px 8px; border: 1px solid #dce1f0; border-radius: 8px; }
    .bh-row input:focus-visible, .bh-btn:focus-visible, .bh-icon-btn:focus-visible {
      outline: 2px solid rgba(79,99,216,.32); outline-offset: 2px;
    }
    .bh-icon-btn {
      width: 44px; height: 34px; display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid #dce1f0; border-radius: 8px; background: #f8f9fd; color: #596684; cursor: pointer;
      font-size: 11px; font-weight: 600;
    }
    .bh-icon-btn:hover { border-color: #4f6ef7; color: #4f6ef7; }
    .bh-job-config {
      display: none; margin: 10px -2px 12px; padding: 12px; border: 1px solid #e1e6f5;
      border-radius: 12px; background: linear-gradient(180deg, #fbfcff 0%, #f7f9ff 100%);
      box-shadow: 0 5px 18px rgba(56, 73, 145, .07); user-select: text;
    }
    .bh-job-config.open { display: block; }
    .bh-job-config-head { display: flex; gap: 3px; margin-bottom: 12px; padding: 3px; border-radius: 9px; background: #edf0f8; }
    .bh-job-mode-btn {
      flex: 1; padding: 7px 8px; border: 0; border-radius: 7px;
      background: transparent; color: #69738c; font-size: 12px; cursor: pointer;
    }
    .bh-job-mode-btn.active { background: #fff; color: #3f56cb; font-weight: 700; box-shadow: 0 2px 7px rgba(54,70,135,.12); }
    .bh-job-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 9px; }
    .bh-job-field.full { grid-column: 1 / -1; }
    .bh-job-subtitle { grid-column: 1 / -1; display: flex; align-items: center; gap: 7px; margin: 2px 0 -1px; color: #3d4969; font-size: 11px; font-weight: 700; }
    .bh-job-subtitle::after { content: ''; flex: 1; height: 1px; background: #e4e8f3; }
    .bh-job-field label { display: block; margin-bottom: 5px; font-size: 11px; color: #6e7891; }
    .bh-job-field input,
    .bh-job-field select {
      width: 100%; height: 35px; box-sizing: border-box; padding: 6px 9px; border: 1px solid #dce1ef;
      border-radius: 8px; background: #fff; color: #2f3b5a; font-size: 12px; transition: border-color .15s, background .15s;
    }
    .bh-job-field input:hover { border-color: #b8c1df; }
    .bh-job-field input:focus { outline: none; border-color: #7f8fd1; background: #fff; box-shadow: 0 0 0 2px rgba(79,110,247,.08); }
    .bh-job-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 13px; padding-top: 11px; border-top: 1px solid #e6e9f3; }
    .bh-job-hint { margin-top: 8px; padding: 7px 9px; border-radius: 7px; background: #f0f3fb; font-size: 10px; color: #74809b; line-height: 1.5; }
    .bh-btn {
      display: inline-block; min-height: 38px; padding: 8px 13px; border-radius: 9px;
      font-size: 12px; cursor: pointer; border: none; font-weight: 600;
    }
    .bh-btn-primary { background: #4f63d8; color: #fff; box-shadow: 0 2px 6px rgba(67,85,204,.14); }
    .bh-btn-primary:hover { background: #4357cb; }
    .bh-btn-danger { background: #e74c3c; color: #fff; }
    .bh-btn-secondary { background: #eef1f7; color: #46506a; }
    .bh-daily-summary { margin-bottom: 14px; }
    .bh-stats { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: #66708b; }
    .bh-stats strong { color: #3649bd; font-size: 13px; font-variant-numeric: tabular-nums; }
    .bh-section { padding: 0; margin-bottom: 14px; border: 0; border-radius: 0; background: transparent; }
    .bh-section-title { display: block; margin: 0 0 9px; color: #3f4965; font-size: 11px; font-weight: 700; letter-spacing: .4px; }
    .bh-section .bh-row:last-child { margin-bottom: 0; }
    .bh-inline-note { font-size: 11px; color: #7b849b; white-space: nowrap; }
    .bh-max-label { margin-left: 28px; }
    .bh-action-row { display: flex; align-items: center; gap: 9px; margin-top: 2px; }
    #bh-scan { flex: 1.25; }
    #bh-open-queue { flex: 1; }
    #bh-diag { margin-right: auto; }
    .bh-status { min-height: 16px; margin-top: 10px; padding-top: 9px; border-top: 1px solid #edf0f7; font-size: 11px; color: #747e97; }
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

    /* ─── Queue view: lives inside the assistant window ──────────── */
    #boss-helper-queue-panel {
      display: none; flex: 1; min-height: 0; flex-direction: column; overflow: hidden; background: #fff;
    }
    #boss-helper-panel.bh-queue-mode #boss-helper-queue-panel { display: flex; }
    .bhq-nav { display: flex; align-items: center; gap: 6px; padding: 9px 10px; border-bottom: 1px solid #edf0f7; }
    .bhq-tabs { display: flex; gap: 5px; }
    .bhq-tab {
      border: 0; padding: 5px 10px; border-radius: 14px; font-size: 12px;
      cursor: pointer; background: #eef1fb; color: #66708b;
    }
    .bhq-tab.active { background: #4f6ef7; color: #fff; font-weight: 600; }
    .bhq-tab-count { margin-left: 3px; }
    .bhq-nav-spacer { flex: 1; }
    .bhq-header-btn {
      cursor: pointer; border: 0; padding: 4px 8px; border-radius: 6px;
      background: #eef1fb; color: #4355cc; font-size: 13px;
    }
    .bhq-header-btn:hover { background: #e0e6ff; }

    .bhq-toolbar {
      display: flex; align-items: center; gap: 7px;
      padding: 8px 10px; border-bottom: 1px solid #edf0f7;
      background: #fafbff; flex-wrap: wrap;
    }
    .bhq-toolbar-status { display: none; }
    .bhq-toolbar-status.err { color: #e74c3c; }
    .bhq-filter {
      display: flex; align-items: center; min-width: 0; height: 34px;
      border: 1px solid #d9def5; border-radius: 8px; background: #fff;
      box-shadow: 0 1px 2px rgba(55, 72, 150, .05); white-space: nowrap;
      transition: border-color .15s, box-shadow .15s;
    }
    .bhq-filter:focus-within { border-color: #aeb8dc; box-shadow: none; }
    .bhq-filter-label { padding: 0 9px; color: #7b8499; font-size: 11px; }
    .bhq-filter select {
      width: 174px; min-width: 110px; height: 32px;
      padding: 0 30px 0 10px; border: 0; border-left: 1px solid #edf0f7;
      border-radius: 0 8px 8px 0; outline: none; cursor: pointer;
      background-color: #fff; color: #35469d; font-size: 12px; font-weight: 600;
    }
    .bhq-list {
      flex: 1; overflow-y: auto; padding: 8px;
      min-height: 120px; background: #f7f8fd;
    }
    .bhq-empty { padding: 40px 20px; text-align: center; color: #8a93a9; font-size: 12px; }
    .bhq-row {
      display: flex; gap: 10px; align-items: flex-start;
      padding: 11px 12px; margin-bottom: 8px; border: 1px solid #e9ecf5; border-radius: 10px;
      background: #fff; cursor: default; transition: background .12s, border-color .12s, box-shadow .12s;
    }
    .bhq-row.is-actionable { cursor: pointer; }
    .bhq-row.is-actionable:hover { border-color: #aebaff; background: #fafbff; box-shadow: 0 4px 12px rgba(63, 79, 160, .08); }
    .bhq-row.is-actionable:focus-visible { outline: 3px solid rgba(79,110,247,.25); outline-offset: 1px; }
    .bhq-row.is-active { border-color: #7589ff; background: #f2f5ff; box-shadow: inset 3px 0 #4f6ef7; }
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
    .bhq-presence {
      display: inline-block; padding: 1px 7px; border-radius: 999px;
      font-size: 10px; font-weight: 700; line-height: 1.5;
    }
    .bhq-presence.live { color: #167144; background: #e6f7ed; }
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
    .bhq-undo-bar {
      display: none; align-items: center; gap: 8px; padding: 9px 11px;
      border-bottom: 1px solid #ccebd7; background: #effaf3; color: #24623b; font-size: 11px;
    }
    .bhq-undo-bar.show { display: flex; }
    .bhq-undo-message { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bhq-undo-count { color: #62806c; font-variant-numeric: tabular-nums; }
    .bhq-undo-btn {
      flex: 0 0 auto; border: 1px solid #8ccba3; border-radius: 7px; padding: 4px 9px;
      background: #fff; color: #18733a; font-size: 11px; font-weight: 700; cursor: pointer;
    }
    .bhq-undo-btn:hover { background: #e0f6e8; }

    .bhq-toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      z-index: 100001; padding: 8px 18px; border-radius: 6px;
      background: rgba(0,0,0,0.82); color: #fff; font-size: 12px;
      opacity: 0; transition: opacity 0.2s; pointer-events: none;
    }
    .bhq-toast.show { opacity: 1; }
    .bhq-toast.err { background: rgba(200, 30, 30, 0.9); }
    .bhq-toast.undo { pointer-events: auto; display: flex; align-items: center; gap: 10px; }
    .bhq-toast button { border: 0; border-radius: 4px; padding: 3px 8px; color: #273889; background: #fff; font-weight: 700; cursor: pointer; }

    /* Locate-on-page highlight (applied to a BOSS card temporarily) */
    .bhq-located {
      outline: 3px solid #4f6ef7 !important;
      outline-offset: 2px;
      transition: outline 0.15s;
    }

  `);

  // Tabler Icons (MIT), embedded as image assets so the title bar stays self-contained.
  const HEADER_ICONS = {
    back: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m5 12 6 6"/><path d="m5 12 6-6"/></svg>`,
    collapse: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>`,
    expand: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
    close: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  };
  const headerIcon = (name) => `<img alt="" aria-hidden="true" src="data:image/svg+xml,${encodeURIComponent(HEADER_ICONS[name])}">`;

  function createPanel() {
    // Prevent duplicate panels (page navigation / re-inject)
    const existing = document.getElementById('boss-helper-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'boss-helper-panel';
    panel.innerHTML = `
      <div class="bh-header">
        <div class="bh-header-left">
          <button class="bh-back" id="bh-back" type="button" title="返回招聘助手" aria-label="返回招聘助手">${headerIcon('back')}</button>
          <h3 id="bh-header-title">招聘助手</h3>
        </div>
        <div class="bh-header-actions">
          <button class="bh-window-action bh-collapse-action" id="bh-collapse" type="button" title="收起" aria-label="收起招聘助手" aria-expanded="true" aria-controls="bh-main-body">${headerIcon('collapse')}</button>
          <button class="bh-window-action bh-close" type="button" title="关闭" aria-label="关闭招聘助手">${headerIcon('close')}</button>
        </div>
      </div>
      <div class="bh-body bh-main-view" id="bh-main-body">
        <div class="bh-daily-summary">
          <div class="bh-stats"><span>今日触达</span><strong><span id="bh-count">${state.greetingCount}</span> / <span id="bh-cap">${state.dailyCap}</span></strong></div>
        </div>
        <div class="bh-section">
          <p class="bh-section-title">评分设置</p>
          <div class="bh-row">
            <label for="bh-job">匹配岗位</label>
            <select id="bh-job" style="flex:1"><option value="">加载中…</option></select>
            <button class="bh-icon-btn" id="bh-job-config-toggle" type="button" title="配置当前岗位">设置</button>
          </div>
          <div class="bh-row">
            <label for="bh-threshold">评分阈值</label>
            <input type="range" id="bh-threshold" min="0" max="100" value="${state.threshold}">
            <span id="bh-threshold-val">${state.threshold}</span>
          </div>
        </div>
        <div class="bh-job-config" id="bh-job-config"></div>
        <div class="bh-section">
          <div class="bh-row">
            <label for="bh-multipage">自动加载</label>
            <input type="checkbox" id="bh-multipage" aria-label="自动加载更多候选人" ${state.multiPage ? 'checked' : ''}>
            <label class="bh-inline-note bh-max-label" for="bh-maxcand">加载上限</label>
            <input type="number" id="bh-maxcand" value="${state.maxCandidates}" min="15" max="500" step="5" style="width:56px">
            <span class="bh-inline-note">人</span>
          </div>
        </div>
        <div class="bh-action-row">
          <button class="bh-btn bh-btn-primary" id="bh-scan">扫描列表</button>
          <button class="bh-btn bh-btn-secondary" id="bh-open-queue">查看队列</button>
        </div>
        <div class="bh-status" id="bh-status" role="status" aria-live="polite">状态：就绪</div>
      </div>
    `;
    document.body.appendChild(panel);
    panel.addEventListener('change', (event) => {
      if (event.target?.matches?.('select')) setTimeout(() => event.target.blur(), 0);
    });
    const defaultTop = Math.max(16, Math.min(200, window.innerHeight - 320));
    panel.style.top = defaultTop + 'px';
    panel.style.maxHeight = Math.max(220, window.innerHeight - defaultTop - 16) + 'px';
    const fitPanelToViewport = () => {
      if (!panel.isConnected) return;
      const currentTop = Number.parseFloat(panel.style.top) || 200;
      const nextTop = Math.max(8, Math.min(currentTop, window.innerHeight - 220));
      panel.style.top = nextTop + 'px';
      panel.style.maxHeight = Math.max(212, window.innerHeight - nextTop - 8) + 'px';
      const rect = panel.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) {
        panel.style.left = Math.max(8, window.innerWidth - panel.offsetWidth - 8) + 'px';
        panel.style.right = 'auto';
      }
    };
    window.addEventListener('resize', fitPanelToViewport);

    // Drag
    const header = panel.querySelector('.bh-header');
    let dragging = false, dragPointerId = null, dx = 0, dy = 0;
    const stopDragging = (event) => {
      if (event?.pointerId != null && dragPointerId != null && event.pointerId !== dragPointerId) return;
      const capturedPointerId = dragPointerId;
      dragging = false;
      dragPointerId = null;
      panel.classList.remove('dragging');
      if (capturedPointerId != null && header.hasPointerCapture?.(capturedPointerId)) {
        header.releasePointerCapture(capturedPointerId);
      }
    };
    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, .bh-close')) return;
      if (e.button !== 0) return;
      dragging = true;
      dragPointerId = e.pointerId;
      dx = e.clientX - panel.getBoundingClientRect().left;
      dy = e.clientY - panel.getBoundingClientRect().top;
      header.setPointerCapture(e.pointerId);
      panel.classList.add('dragging');
      e.preventDefault();
    });
    header.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== dragPointerId) return;
      const nextLeft = Math.max(8, Math.min(e.clientX - dx, window.innerWidth - panel.offsetWidth - 8));
      const nextTop = Math.max(8, Math.min(e.clientY - dy, window.innerHeight - header.offsetHeight - 8));
      panel.style.left = nextLeft + 'px';
      panel.style.top = nextTop + 'px';
      panel.style.right = 'auto';
      panel.style.maxHeight = Math.max(header.offsetHeight, window.innerHeight - nextTop - 8) + 'px';
    });
    header.addEventListener('pointerup', stopDragging);
    header.addEventListener('pointercancel', stopDragging);
    header.addEventListener('lostpointercapture', stopDragging);
    window.addEventListener('blur', stopDragging);

    // Collapse is a dedicated control so it cannot be confused with dragging.
    const collapseBtn = panel.querySelector('#bh-collapse');
    collapseBtn.addEventListener('click', () => {
      if (panel.classList.contains('bh-queue-mode')) return;
      const collapsed = panel.classList.toggle('bh-collapsed');
      collapseBtn.innerHTML = headerIcon(collapsed ? 'expand' : 'collapse');
      collapseBtn.title = collapsed ? '展开' : '收起';
      collapseBtn.setAttribute('aria-label', collapsed ? '展开招聘助手' : '收起招聘助手');
      collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    });

    // Close
    panel.querySelector('.bh-close').addEventListener('click', () => {
      window.removeEventListener('resize', fitPanelToViewport);
      panel.remove();
    });
    panel.querySelector('#bh-back').addEventListener('click', closeQueuePanel);

    // Controls
    document.getElementById('bh-job').addEventListener('change', (e) => {
      state.jobId = e.target.value;
      state.jobConfigMode = 'edit';
      renderJobConfig();
      if (state.queuePanel?.open) {
        state.queuePanel.jobId = state.jobId;
        renderQueueJobFilter();
        fetchQueue(true, true);
      }
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
    document.getElementById('bh-open-queue').addEventListener('click', openQueuePanel);

    syncAutoLoadControls();
    return panel;
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
    el.textContent = msg === '就绪' ? '状态：就绪' : msg;
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
    const scored = await apiPost('/score', {
      candidates: serializable,
      threshold: state.threshold,
      job_id: state.jobId,
      replace_pending: Boolean(state.jobId),
    });
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
        : (item.is_blocked ? '⛔' : item.score);
      badge.title = item.already_contacted ? '该岗位已打过招呼'
        : (item.is_blocked ? '被排除' : item.details?.join('；') || '');
      item.cardEl.style.position = 'relative';
      item.cardEl.appendChild(badge);
    });

    // 过阈值：未排除、未打招呼、达阈值。
    const eligible = items.filter(s => !s.is_blocked && !s.already_contacted && s.score >= state.threshold);
    const contacted = items.filter(s => s.already_contacted).length;
    return { found: items.length, passed: eligible.length, contacted, scored: items };
  }

  async function doScan() {
    if (state.queuePanel?.llmBusy || state.queuePanel?.completionInFlight?.size) {
      setStatus('当前有 AI 评分或完成标记进行中，请稍后再扫描', true);
      return;
    }
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
    bindNativeInteractionListeners();
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
      const { found, passed, contacted, scored } = await scoreCurrentPage();
      if (!found) {
        setStatus('未找到候选人卡片', true);
        return;
      }
      state.scanned = scored;
      const contactedNote = contacted ? `，已联系 ${contacted} 人(灰显)` : '';
      setStatus(`完成：共扫描 ${found} 人，待处理 ${passed} 人${contactedNote}`);
      if (state.queuePanel?.open) fetchQueue(true, true);
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

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }


  // ─── Load config from backend on start ────────────────────────────
  async function loadConfig() {
    try {
      const cfg = await apiGet('/config');
      state.llmEnabled = !!cfg.llm_enabled;
      if (cfg.automation) {
        state.threshold = cfg.automation.score_threshold || state.threshold;
        state.dailyCap = cfg.automation.daily_cap || state.dailyCap;
      }
      state.configLoaded = true;
      // Update panel controls
      const tEl = document.getElementById('bh-threshold');
      const tvEl = document.getElementById('bh-threshold-val');
      if (tEl) { tEl.value = state.threshold; }
      if (tvEl) { tvEl.textContent = state.threshold; }
      updateDailyProgress();
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
        <div class="bh-job-subtitle">岗位信息</div>
        <div class="bh-job-field full">
          <label>岗位名称</label>
          <input id="bh-job-title" placeholder="例如：电商运营" value="${esc(job.title || '')}">
        </div>
        <div class="bh-job-subtitle">基础门槛</div>
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
        <div class="bh-job-subtitle">筛选与评分</div>
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
        <button class="bh-btn bh-btn-secondary" id="bh-diag" title="复制当前页面结构，供故障排查">诊断</button>
        <button class="bh-btn bh-btn-secondary" id="bh-job-cancel">收起</button>
        <button class="bh-btn bh-btn-primary" id="bh-job-save">${isCreate ? '创建岗位' : '保存'}</button>
      </div>
      ${isCreate ? '<div class="bh-job-hint">创建后会自动选中新岗位。</div>' : ''}
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
    box.querySelector('#bh-diag')?.addEventListener('click', diagnose);
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
    doSemiFill(item);
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
  // Second floating panel: current pending snapshot + durable completed
  // greeting history. Only a real card on the current page can be opened.
  state.queuePanel = {
    open: false,
    tab: 'pending',          // 'pending' | 'completed'
    jobId: '',               // defaults to the assistant's selected job
    items: [],               // last-known list (kept in DOM order via diff)
    itemsById: new Map(),    // match_id → item (fast lookup for actions/optimistic revert)
    loading: false,
    requestSeq: 0,
    llmBusy: false,
    counts: { pending: 0, completed: 0 },
    activeItem: null,
    activeOpen: false,
    activeVerified: false,
    activeAt: 0,
    completionInFlight: new Set(),
    undoTimer: null,
    undoInterval: null,
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
      <div class="bhq-nav">
        <div class="bhq-tabs">
          <button class="bhq-tab active" data-tab="pending">待处理 <b class="bhq-tab-count" id="bhq-pending-count">0</b></button>
          <button class="bhq-tab" data-tab="completed">已完成 <b class="bhq-tab-count" id="bhq-completed-count">0</b></button>
        </div>
        <span class="bhq-nav-spacer"></span>
        <button class="bhq-header-btn bhq-clear-pending" id="bhq-clear-pending" title="清空所有待处理" aria-label="清空所有待处理">⌫</button>
      </div>
      <div class="bhq-toolbar">
        <label class="bhq-filter"><span class="bhq-filter-label">筛选岗位</span>
          <select id="bhq-job-filter"><option value="">全部岗位</option></select>
        </label>
        <button class="bhq-act bhq-act-primary" id="bhq-rerank" style="display:none" title="只评分尚未有 AI 分数的候选人">AI评分</button>
        <span class="bhq-toolbar-status" id="bhq-toolbar-status">就绪</span>
      </div>
      <div class="bhq-progress-wrap" id="bhq-progress-wrap" style="display:none">
        <div class="bhq-progress-bar"><div class="bhq-progress-fill" id="bhq-progress-fill"></div></div>
        <span class="bhq-progress-text" id="bhq-progress-text"></span>
      </div>
      <div class="bhq-undo-bar" id="bhq-undo-bar">
        <span class="bhq-undo-message" id="bhq-undo-message"></span>
        <span class="bhq-undo-count" id="bhq-undo-count"></span>
        <button class="bhq-undo-btn" id="bhq-undo-btn" type="button">撤销</button>
      </div>
      <div class="bhq-list" id="bhq-list"><div class="bhq-empty">加载中…</div></div>
    `;
    document.getElementById('boss-helper-panel')?.appendChild(el);
    renderQueueJobFilter();

    // Tab switch
    el.querySelectorAll('.bhq-tab').forEach(t => {
      t.addEventListener('click', () => {
        const tab = t.getAttribute('data-tab');
        if (tab === state.queuePanel.tab) return;
        if (state.queuePanel.llmBusy) {
          showToast('当前任务进行中，请稍后切换', true);
          return;
        }
        state.queuePanel.tab = tab;
        el.querySelectorAll('.bhq-tab').forEach(x => {
          x.classList.toggle('active', x.getAttribute('data-tab') === tab);
        });
        applyToolbarVisibility();
        fetchQueue(true, true);
      });
    });

    el.querySelector('#bhq-clear-pending').addEventListener('click', clearAllPendingCandidates);
    el.querySelector('#bhq-rerank').addEventListener('click', doTrackedLlmRerank);
    el.querySelector('#bhq-job-filter').addEventListener('change', (e) => {
      if (state.queuePanel.llmBusy) {
        e.target.value = state.queuePanel.jobId;
        showToast('当前任务进行中，请稍后切换岗位', true);
        return;
      }
      state.queuePanel.jobId = e.target.value;
      applyToolbarVisibility();
      fetchQueue(true, true);
    });

    el.querySelector('#bhq-list').addEventListener('click', onListClick);
    el.querySelector('#bhq-list').addEventListener('keydown', onListKeydown);

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
    if (!rerank) return;
    const isQueue = state.queuePanel.tab === 'pending';
    const rerankJobId = getRerankJobId();
    rerank.style.display = isQueue ? 'inline-block' : 'none';
    rerank.disabled = !isQueue || !rerankJobId || state.queuePanel.llmBusy;
    rerank.title = rerankJobId ? '只评分尚未有 AI 分数的候选人' : '当前列表包含多个岗位，请先选择一个岗位';
  }

  function openQueuePanel() {
    ensureQueuePanel();
    const panel = document.getElementById('boss-helper-panel');
    if (!panel) return;
    state.queuePanel.jobId = state.jobId || state.queuePanel.jobId || '';
    renderQueueJobFilter();
    applyToolbarVisibility();
    panel.classList.remove('bh-collapsed');
    panel.classList.add('bh-queue-mode');
    const collapse = document.getElementById('bh-collapse');
    if (collapse) {
      collapse.innerHTML = headerIcon('collapse');
      collapse.title = '收起';
      collapse.setAttribute('aria-label', '收起招聘助手');
      collapse.setAttribute('aria-expanded', 'true');
    }
    const title = document.getElementById('bh-header-title');
    if (title) title.textContent = '候选人队列';
    state.queuePanel.open = true;
    fetchQueue(true, true);
  }

  function closeQueuePanel() {
    const panel = document.getElementById('boss-helper-panel');
    panel?.classList.remove('bh-queue-mode');
    const title = document.getElementById('bh-header-title');
    if (title) title.textContent = '招聘助手';
    state.queuePanel.open = false;
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

  function updateTabCounts() {
    const pending = document.getElementById('bhq-pending-count');
    const completed = document.getElementById('bhq-completed-count');
    if (pending) pending.textContent = state.queuePanel.counts.pending >= 100 ? '100+' : String(state.queuePanel.counts.pending);
    if (completed) completed.textContent = state.queuePanel.counts.completed >= 100 ? '100+' : String(state.queuePanel.counts.completed);
  }

  function filterQueueItems(items, view) {
    const statuses = view === 'completed' ? COMPLETED_QUEUE_STATUSES : PENDING_QUEUE_STATUSES;
    return (Array.isArray(items) ? items : []).filter(item => statuses.has(item?.status));
  }

  async function clearAllPendingCandidates() {
    if (state.queuePanel.llmBusy || state.queuePanel.completionInFlight.size) {
      showToast('当前有任务进行中，请稍后清空', true);
      return;
    }
    const confirmed = window.confirm('将清空所有岗位的待处理候选人及未发送草稿。\n\n已完成候选人不会被删除。');
    if (!confirmed) return;

    const button = document.getElementById('bhq-clear-pending');
    if (button) { button.disabled = true; button.textContent = '…'; }
    try {
      const result = await apiPost('/clear-pending', {});
      state.scanned = [];
      clearActiveCandidate();
      hideCompletionUndo();
      const count = Number(result?.deleted_matches || 0);
      showToast(count ? `已清空 ${count} 位待处理候选人` : '没有可清空的待处理候选人');
      await fetchQueue(true, true);
    } catch (err) {
      showToast(`清空待处理失败：${err.message}`, true);
    } finally {
      if (button) { button.disabled = false; button.textContent = '⌫'; }
    }
  }

  async function fetchQueue(showLoading, includeCounts = false) {
    const requestSeq = ++state.queuePanel.requestSeq;
    const requestedTab = state.queuePanel.tab;
    const requestedJobId = state.queuePanel.jobId;
    state.queuePanel.loading = true;
    if (showLoading) setQueueStatus('加载中…');
    const params = new URLSearchParams();
    if (requestedJobId) params.append('job_id', requestedJobId);
    params.append('view', requestedTab);
    params.append('limit', '100');
    try {
      const responseItems = await apiGetRoot('/queue/today?' + params.toString());
      if (requestSeq !== state.queuePanel.requestSeq || requestedTab !== state.queuePanel.tab || requestedJobId !== state.queuePanel.jobId) return;
      state.queuePanel.items = filterQueueItems(responseItems, requestedTab);
      state.queuePanel.itemsById = new Map(state.queuePanel.items.map(x => [x.match_id, x]));
      state.queuePanel.counts[requestedTab] = state.queuePanel.items.length;
      diffRenderQueueList(state.queuePanel.items);
      applyToolbarVisibility();
      updateTabCounts();
      setQueueStatus('就绪');
      if (includeCounts) {
        const otherTab = requestedTab === 'pending' ? 'completed' : 'pending';
        const otherParams = new URLSearchParams();
        if (requestedJobId) otherParams.append('job_id', requestedJobId);
        otherParams.append('view', otherTab);
        otherParams.append('limit', '100');
        try {
          const otherItems = await apiGetRoot('/queue/today?' + otherParams.toString());
          if (requestSeq !== state.queuePanel.requestSeq || requestedJobId !== state.queuePanel.jobId) return;
          state.queuePanel.counts[otherTab] = filterQueueItems(otherItems, otherTab).length;
          updateTabCounts();
        } catch { /* keep the last count; the visible list already loaded */ }
      }
    } catch (err) {
      setQueueStatus('加载失败: ' + err.message, true);
    } finally {
      if (requestSeq === state.queuePanel.requestSeq) state.queuePanel.loading = false;
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

  function currentPageBossIds() {
    const ids = new Set();
    for (const doc of getAllDocs()) {
      for (const card of doc.querySelectorAll(CARD_SEL)) {
        const id = getCardCandidateId(card);
        if (id) ids.add(String(id));
      }
    }
    return ids;
  }

  // Row template — minimal fields per v1 spec (no CheckBadges/skill tags/preview).
  function buildRowHTML(item, isLive) {
    const isCompleted = state.queuePanel.tab === 'completed';
    const isActive = state.queuePanel.activeItem?.match_id === item.match_id;
    const missingHtml = item.missing_info
      ? `<div class="bhq-missing" title="${esc(item.missing_info)}">⚠ 缺：${esc(item.missing_info)}</div>` : '';
    const llmBadge = (item.llm_score != null)
      ? `<span class="bhq-badge ${llmBadgeClass(item.llm_score)}" title="AI 精评分">AI ${Math.round(item.llm_score)}</span>` : '';
    const actionBtns = !isCompleted && isLive && isActive && state.queuePanel.activeOpen
      ? `<button class="bhq-act bhq-act-success" data-act="complete" data-mid="${item.match_id}">标记完成</button>`
      : '';
    const completedAt = isCompleted && item.completed_at
      ? `<div class="bhq-info">完成于 ${esc(formatQueueTime(item.completed_at))}</div>` : '';
    return `
      <div class="bhq-row-main">
        <div class="bhq-name-line">
          <span class="bhq-name">${esc(item.name || '未知')}</span>
          ${isLive ? '<span class="bhq-presence live">当前页</span>' : ''}
          ${state.queuePanel.jobId ? '' : `<span class="bhq-job" title="岗位：${esc(item.job_title || '未指定岗位')}">${esc(item.job_title || '未指定岗位')}</span>`}
          <span class="bhq-badge ${scoreBadgeClass(item.score)}" title="规则分">${Math.round(item.score)}</span>
          ${llmBadge}
        </div>
        <div class="bhq-info">${esc(buildInfoLine(item))}</div>
        ${completedAt}
        ${missingHtml}
      </div>
      ${actionBtns ? `<div class="bhq-row-actions">${actionBtns}</div>` : ''}
    `;
  }

  function formatQueueTime(value) {
    if (!value) return '';
    // SQLite drops timezone offsets. Backend timestamps are stored in UTC, so
    // an offset-less value (e.g. 2026-07-16T14:32:43) must be parsed as UTC
    // instead of being mistaken for the browser's local China time.
    const raw = String(value);
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
    const date = new Date(hasTimezone ? raw : `${raw}Z`);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('zh-CN', { hour12: false, timeZone: SERVER_TIME_ZONE });
  }

  function safeBossUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(value);
      const isBossHost = url.hostname === 'zhipin.com' || url.hostname.endsWith('.zhipin.com');
      return url.protocol === 'https:' && isBossHost ? url.href : '';
    } catch {
      return '';
    }
  }

  // Cheap change-detection signature for a row.
  function rowSig(item, isLive) {
    const active = state.queuePanel.activeItem?.match_id === item.match_id ? 1 : 0;
    return `${item.status}|${item.job_id ?? ''}|${item.job_title ?? ''}|${item.score}|${item.llm_score ?? ''}|${item.missing_info ?? ''}|${item.completed_at ?? ''}|${isLive ? 1 : 0}|${active}|${state.queuePanel.activeOpen ? 1 : 0}|${state.queuePanel.jobId}`;
  }

  // Incremental diff render: preserve scroll and focus across event-driven refreshes.
  function diffRenderQueueList(items) {
    const listEl = document.getElementById('bhq-list');
    if (!listEl) return;

    if (!items.length) {
      listEl.innerHTML = `<div class="bhq-empty">${state.queuePanel.tab === 'completed' ? '暂无已完成记录' : '待处理为空（先扫描当前列表）'}</div>`;
      return;
    }

    // Remove sentinel empty message if present
    const empty = listEl.querySelector('.bhq-empty');
    if (empty) empty.remove();

    const liveBossIds = currentPageBossIds();
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
      const isLive = !!item.boss_id && liveBossIds.has(String(item.boss_id));
      const actionable = state.queuePanel.tab === 'pending' && isLive;
      const active = state.queuePanel.activeItem?.match_id === item.match_id;
      let node = existing.get(item.match_id);
      if (!node) {
        node = document.createElement('div');
        node.className = 'bhq-row';
        node.setAttribute('data-mid', String(item.match_id));
        if (item.boss_id) node.setAttribute('data-bossid', item.boss_id);
        node.innerHTML = buildRowHTML(item, isLive);
        node._sig = rowSig(item, isLive);
      } else {
        // Update only if content signature changed (cheap: score+status+llm_score+reason)
        const sig = rowSig(item, isLive);
        if (node._sig !== sig) {
          node.innerHTML = buildRowHTML(item, isLive);
          if (item.boss_id) node.setAttribute('data-bossid', item.boss_id);
        }
        node._sig = sig;
      }
      node.classList.toggle('is-actionable', actionable);
      node.classList.toggle('is-active', active);
      if (actionable) {
        node.setAttribute('role', 'button');
        node.setAttribute('tabindex', '0');
        node.setAttribute('aria-label', `打开候选人简历：${item.name || '未知'}`);
      } else {
        node.removeAttribute('role');
        node.removeAttribute('tabindex');
        node.removeAttribute('aria-label');
      }
      // Ensure DOM order matches items[]
      const nextSibling = prev ? prev.nextSibling : listEl.firstChild;
      if (nextSibling !== node) listEl.insertBefore(node, nextSibling);
      prev = node;
    }
  }

  function onListClick(e) {
    const actBtn = e.target.closest('button[data-act]');
    const row = e.target.closest('.bhq-row');
    if (!row) return;
    const mid = Number((actBtn || row).getAttribute('data-mid'));
    const item = state.queuePanel.itemsById.get(mid);
    if (!item) return;
    if (actBtn?.getAttribute('data-act') === 'complete') {
      e.stopPropagation();
      markCandidateCompleted(item, 'manual');
      return;
    }
    if (!row.classList.contains('is-actionable')) return;
    locateCardOnPage(item);
  }

  function onListKeydown(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.bhq-row.is-actionable');
    if (!row) return;
    e.preventDefault();
    const item = state.queuePanel.itemsById.get(Number(row.getAttribute('data-mid')));
    if (item) locateCardOnPage(item);
  }

  function candidateKey(item) {
    const bossId = item?.boss_id || item?.expectId || '';
    const jobId = item?.job_id || state.jobId || '';
    return bossId && jobId ? `${jobId}:${bossId}` : '';
  }

  function setActiveCandidate(item, opened = false, verified = false) {
    if (!item) return;
    state.queuePanel.activeItem = {
      ...item,
      boss_id: item.boss_id || item.expectId || '',
      job_id: item.job_id || state.jobId || '',
    };
    state.queuePanel.activeOpen = opened;
    state.queuePanel.activeVerified = verified;
    state.queuePanel.activeAt = Date.now();
    if (state.queuePanel.open) diffRenderQueueList(state.queuePanel.items);
  }

  function clearActiveCandidate() {
    state.queuePanel.activeItem = null;
    state.queuePanel.activeOpen = false;
    state.queuePanel.activeVerified = false;
    state.queuePanel.activeAt = 0;
    if (state.queuePanel.open) diffRenderQueueList(state.queuePanel.items);
  }

  async function markCandidateCompleted(item, mode = 'manual') {
    const bossId = item?.boss_id || item?.expectId || '';
    const jobId = item?.job_id || state.jobId || '';
    const key = candidateKey({ ...item, boss_id: bossId, job_id: jobId });
    if (!key || state.queuePanel.completionInFlight.has(key)) return;

    state.queuePanel.completionInFlight.add(key);
    setQueueStatus(`正在记录完成：${item.name || '候选人'}…`);
    try {
      const result = await apiPost('/log-greeting', {
        expectId: bossId,
        name: item.name || '候选人',
        mode,
        job_id: jobId,
      });
      // Older production backends do not return `newly_completed`. A row that
      // came from the pending view is still a reliable first-completion signal.
      const incremented = typeof result?.newly_completed === 'boolean'
        ? result.newly_completed
        : !item.already_contacted && PENDING_QUEUE_STATUSES.has(item.status || 'new');
      if (incremented) {
        incrCounter();
        state.queuePanel.counts.pending = Math.max(0, state.queuePanel.counts.pending - 1);
        state.queuePanel.counts.completed += 1;
        updateTabCounts();
      }
      if (state.queuePanel.tab === 'pending') {
        state.queuePanel.items = state.queuePanel.items.filter(x => x.match_id !== item.match_id);
        state.queuePanel.itemsById.delete(item.match_id);
        diffRenderQueueList(state.queuePanel.items);
      }
      clearActiveCandidate();
      setQueueStatus(`已完成：${item.name || '候选人'}`);
      if (incremented && result?.match_id) {
        showCompletionUndo({ ...item, match_id: result.match_id }, incremented);
      } else {
        showToast(`${item.name || '候选人'} 已在完成列表中`);
      }
      if (state.queuePanel.open) await fetchQueue(false, true);
    } catch (err) {
      const message = `完成标记失败：${err.message}`;
      setQueueStatus(message, true);
      showToast(message, true);
    } finally {
      state.queuePanel.completionInFlight.delete(key);
    }
  }

  function showCompletionUndo(item, incremented) {
    const bar = document.getElementById('bhq-undo-bar');
    if (bar && state.queuePanel.open) {
      if (state.queuePanel.undoTimer) clearTimeout(state.queuePanel.undoTimer);
      if (state.queuePanel.undoInterval) clearInterval(state.queuePanel.undoInterval);
      const message = document.getElementById('bhq-undo-message');
      const count = document.getElementById('bhq-undo-count');
      const button = document.getElementById('bhq-undo-btn');
      const expiresAt = Date.now() + 5000;
      if (message) message.textContent = `已完成：${item.name || '候选人'}`;
      if (button) button.onclick = () => undoCandidateCompletion(item, incremented);
      const tick = () => {
        const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
        if (count) count.textContent = `${seconds}秒`;
      };
      tick();
      bar.classList.add('show');
      state.queuePanel.undoInterval = setInterval(tick, 250);
      state.queuePanel.undoTimer = setTimeout(hideCompletionUndo, 5000);
      return;
    }

    let toast = document.getElementById('bhq-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'bhq-toast';
      document.body.appendChild(toast);
    }
    clearTimeout(toast._hideTimer);
    if (state.queuePanel.undoTimer) clearTimeout(state.queuePanel.undoTimer);
    toast.className = 'bhq-toast show undo';
    toast.innerHTML = `<span>已完成：${esc(item.name || '候选人')}</span><button type="button">撤销</button>`;
    toast.querySelector('button').addEventListener('click', () => undoCandidateCompletion(item, incremented));
    state.queuePanel.undoTimer = setTimeout(() => {
      toast.className = 'bhq-toast';
      toast.textContent = '';
      state.queuePanel.undoTimer = null;
    }, 5000);
  }

  function hideCompletionUndo() {
    const bar = document.getElementById('bhq-undo-bar');
    bar?.classList.remove('show');
    if (state.queuePanel.undoTimer) clearTimeout(state.queuePanel.undoTimer);
    if (state.queuePanel.undoInterval) clearInterval(state.queuePanel.undoInterval);
    state.queuePanel.undoTimer = null;
    state.queuePanel.undoInterval = null;
  }

  async function undoCandidateCompletion(item, incremented) {
    const toast = document.getElementById('bhq-toast');
    try {
      await apiPatchRoot(`/outreach/${encodeURIComponent(item.match_id)}/status`, { status: 'new' });
      if (incremented) {
        decrCounter();
        state.queuePanel.counts.pending += 1;
        state.queuePanel.counts.completed = Math.max(0, state.queuePanel.counts.completed - 1);
        updateTabCounts();
      }
      hideCompletionUndo();
      if (toast) { toast.className = 'bhq-toast'; toast.textContent = ''; }
      showToast(`已撤销：${item.name || '候选人'}`);
      if (state.queuePanel.open) await fetchQueue(true, true);
    } catch (err) {
      showToast(`撤销失败：${err.message}`, true);
    }
  }

  function itemFromCard(card) {
    const bossId = getCardCandidateId(card);
    if (!bossId || !state.jobId) return null;
    const queueItem = state.queuePanel.items.find(x => String(x.boss_id) === String(bossId));
    if (queueItem) return queueItem;
    const scanned = state.scanned.find(x => String(x.expectId) === String(bossId));
    const fields = _structuredFields(card);
    return {
      ...(scanned || {}),
      boss_id: bossId,
      name: scanned?.name || fields.name || '候选人',
      job_id: state.jobId,
    };
  }

  function clickedGreetControl(target, root, scope) {
    for (let el = target; el && el !== root.parentElement; el = el.parentElement) {
      if (isGreetAction(el, scope)) return el;
      if (el === root) break;
    }
    if (scope === 'card') {
      const control = findCardGreetControl(root);
      if (control && control.contains(target)) return control;
    }
    return null;
  }

  function panelCandidateMatch(panel, item) {
    if (!panel || !item) return null;
    const targetId = String(item.boss_id || item.expectId || '');
    const ids = [...panel.querySelectorAll('[data-expect], [data-geek], [data-geekid]')]
      .map(el => el.getAttribute('data-expect') || el.getAttribute('data-geek') || el.getAttribute('data-geekid'))
      .filter(Boolean)
      .map(String);
    if (targetId && ids.includes(targetId)) return true;
    if (targetId && ids.length) return false;
    const targetName = String(item.name || '').replace(/[\s·•]/g, '');
    const panelText = String(panel.innerText || '').replace(/[\s·•]/g, '');
    return targetName && panelText.includes(targetName) ? true : null;
  }

  function nativeInteractionHandler(e) {
    if (e.target.closest?.('#boss-helper-panel, #bhq-toast')) return;
    const card = e.target.closest?.(CARD_SEL);
    if (card) {
      const item = itemFromCard(card);
      if (item) setActiveCandidate(item, false, true);
      if (item && clickedGreetControl(e.target, card, 'card')) {
        markCandidateCompleted(item, 'manual');
      }
      return;
    }

    const resumePanel = findOpenResumePanels().find(panel => panel.contains(e.target));
    if (!resumePanel || !clickedGreetControl(e.target, resumePanel, 'resume')) return;
    const active = state.queuePanel.activeItem;
    const panelMatch = panelCandidateMatch(resumePanel, active);
    const reliable = active && Date.now() - state.queuePanel.activeAt < 5 * 60 * 1000 &&
      (state.queuePanel.activeVerified || panelMatch === true);
    if (reliable) {
      markCandidateCompleted(active, 'manual');
    } else if (panelMatch === false) {
      showToast('弹窗候选人与刚打开的卡片不一致，未自动标记', true);
    } else {
      showToast('未读取到候选人 ID 或姓名，未自动标记；可使用“标记完成”', true);
    }
  }

  const _nativeBoundDocs = new WeakSet();
  function bindNativeInteractionListeners() {
    for (const doc of getAllDocs()) {
      if (_nativeBoundDocs.has(doc)) continue;
      doc.addEventListener('click', nativeInteractionHandler, true);
      _nativeBoundDocs.add(doc);
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


  async function doTrackedLlmRerank() {
    if (state.queuePanel.llmBusy) return;
    const btn = document.getElementById('bhq-rerank');
    const rerankJobId = getRerankJobId();
    if (!rerankJobId) { showToast('当前列表包含多个岗位，请先选择一个岗位', true); return; }

    state.queuePanel.llmBusy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'AI评分中'; }
    showProgress(0, 0, '正在创建评分任务');
    setQueueStatus('AI评分任务已启动，正在准备候选人…');
    try {
      const started = await apiPost('/llm-rerank-jobs', { job_id: rerankJobId, limit: 60 });
      if (!started || started.error || started.configured === false) {
        throw new Error((started && started.error) || '无法启动 AI评分任务');
      }
      const skippedExisting = started.skipped_existing || 0;
      if (started.completed || !started.task_id) {
        const summary = started.message || `已有 ${skippedExisting} 人完成 AI 评分，无需重复评分`;
        showToast(summary);
        setQueueStatus(summary);
        await fetchQueue(true, true);
        return;
      }
      showProgress(0, started.total || 0, skippedExisting
        ? `待评 ${started.total} 人，已跳过 ${skippedExisting} 人`
        : '正在准备评分');

      while (true) {
        const task = await apiPost(`/llm-rerank-jobs/${encodeURIComponent(started.task_id)}/status`, {});
        if (!task || task.error) throw new Error((task && task.error) || '评分任务状态不可用');
        showProgress(task.processed || 0, task.total || started.total || 0, task.message || '正在评分');
        setQueueStatus(task.message || '正在评分…', task.status === 'failed');

        if (task.status === 'succeeded') {
          const summary = `AI评分完成：新评 ${task.scored}/${task.total} 人${skippedExisting ? `，跳过已评 ${skippedExisting} 人` : ''}`;
          showToast(summary);
          setQueueStatus(summary);
          await fetchQueue(true, true);
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
        if (!/(打招呼|立即沟通|继续沟通|去沟通|联系Ta|联系TA)/.test(text)) continue;
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
    let sawDifferentCandidateId = false;
    const targetId = String(item.boss_id || '');
    const targetName = String(item.name || '').replace(/[\s·•]/g, '');
    while (Date.now() < deadline) {
      const panels = findOpenResumePanels();
      if (panels.length) {
        sawPanel = true;
        for (const panel of panels) {
          const ids = [...panel.querySelectorAll('[data-expect], [data-geek], [data-geekid]')]
            .map(el => el.getAttribute('data-expect') || el.getAttribute('data-geek') || el.getAttribute('data-geekid'))
            .filter(Boolean)
            .map(String);
          if (targetId && ids.includes(targetId)) return 'confirmed';
          if (ids.length && targetId && !ids.includes(targetId)) sawDifferentCandidateId = true;
          const panelText = String(panel.innerText || '').replace(/[\s·•]/g, '');
          if (targetName && panelText.includes(targetName)) return 'confirmed';
        }
      }
      await sleep(100);
    }
    // Absence of an inspectable ID/name is not proof of a mismatch. BOSS often
    // renders the visible resume inside a nested surface that exposes neither.
    if (sawDifferentCandidateId) return 'mismatch';
    return sawPanel ? 'opened_unverified' : 'unverified';
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
    setActiveCandidate(item, false, false);
    try {
      const target = findCardByBossId(item.boss_id);
      if (!target || getCardCandidateId(target) !== item.boss_id) {
        setQueueStatus('未找到与队列记录一致的当前卡片，未执行打开操作', true);
        showToast('当前页已没有该候选人的真实卡片', true);
        clearActiveCandidate();
        return false;
      }
      if (!await closeOpenResumePanels()) {
        setQueueStatus('未能自动关闭已有简历，请先关闭后再试', true);
        showToast('未能自动关闭已有简历，请先关闭后再试', true);
        clearActiveCandidate();
        return false;
      }
      try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
      target.classList.add('bhq-located');
      setTimeout(() => target.classList.remove('bhq-located'), 2000);
      if (!openCardChat(target)) {
        setQueueStatus('未找到该候选人的简历入口', true);
        showToast('未找到该候选人的简历入口', true);
        clearActiveCandidate();
        return false;
      }
      const result = await waitForResumeIdentity(item);
      if (result === 'confirmed') {
        setActiveCandidate(item, true, true);
        setQueueStatus(`已定位并打开简历：${item.name || ''}`);
        return true;
      }
      if (result === 'mismatch') {
        await closeOpenResumePanels();
        const message = '检测到明确不同的候选人 ID，已自动关闭简历';
        setQueueStatus(message, true);
        showToast(message, true);
        clearActiveCandidate();
        return false;
      }
      // The queue action started from a live card whose boss_id matched exactly.
      // Unless the popup exposes an explicit different ID (handled above), keep
      // that recent card context as a reliable identity even when BOSS hides ID/name.
      setActiveCandidate(item, true, true);
      const message = result === 'opened_unverified'
        ? `简历已打开：${item.name || ''}（页面未暴露可核验 ID，请人工确认姓名）`
        : `已执行打开操作：${item.name || ''}（未检测到标准简历弹层，请人工确认）`;
      setQueueStatus(message);
      showToast(message);
      return true;
    } finally {
      resumeOpenInFlight = false;
    }
  }

  bindBadgeListeners();
  bindNativeInteractionListeners();
  setInterval(() => {
    bindBadgeListeners();
    bindNativeInteractionListeners();
  }, 1200);
})();
