// ==UserScript==
// @name         BOSS 候选人恢复探针（只读实验）
// @namespace    https://github.com/hr_assistant
// @version      0.1.0
// @description  只读采集 BOSS 原生候选人简历可能暴露的恢复入口；不翻页、不滚动、不收藏、不打招呼、不请求接口
// @match        https://www.zhipin.com/*
// @noframes
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  if (window.top !== window.self || window.__bossRecoveryProbeRunning) return;
  window.__bossRecoveryProbeRunning = true;

  const SCRIPT_VERSION = '0.1.0';
  const STORE_KEY = 'boss_recovery_probe_store_v1';
  const TEST_KEY = 'boss_recovery_probe_pending_test_v1';
  const CARD_SEL = 'li.card-item, li.geek-info-card';
  const RESUME_PANEL_SEL = [
    '.boss-layer__wrapper',
    '.boss-popup__wrapper',
    'div.dialog-wrap',
    '[class*="resume"][class*="dialog"]',
    '[class*="resume"][class*="popup"]',
    '[class*="resume"][class*="drawer"]',
    '[class*="geek"][class*="detail"]',
    '[class*="detail"][class*="dialog"]',
  ].join(',');
  const GREET_RE = /^(打招呼|立即沟通|继续沟通|去沟通|沟通|联系Ta|联系TA)$/;
  const URL_HINT_RE = /(geek|candidate|resume|expect|detail|recommend\/geek)/i;
  const SENSITIVE_QUERY_RE = /^(token|access_token|refresh_token|authorization|auth|session|sessionid|sid|cookie|ticket|code)$/i;
  const MAX_ENTRIES = 40;
  const MAX_URLS_PER_ENTRY = 8;
  const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
  const PROBE_WINDOW_MS = 12_000;

  let lastCandidateContext = null;
  let activeProbe = null;
  let probeTimer = null;
  let statusText = '等待你手动打开候选人简历';
  let statusKind = 'idle';
  const watchedDocs = new Set();

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizedName(value) {
    return cleanText(value).replace(/[\s·•]/g, '').toLowerCase();
  }

  function getAllDocs() {
    const docs = [];
    const seen = new Set();
    function visit(doc, depth) {
      if (!doc || seen.has(doc) || depth > 4) return;
      seen.add(doc);
      docs.push(doc);
      for (const frame of doc.querySelectorAll('iframe')) {
        try {
          if (frame.contentDocument) visit(frame.contentDocument, depth + 1);
        } catch {
          // Cross-origin iframe: its src can still be inspected from the parent.
        }
      }
    }
    visit(document, 0);
    return docs;
  }

  function isVisible(el) {
    if (!el || !el.isConnected || !el.getClientRects().length) return false;
    try {
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    } catch {
      return true;
    }
  }

  function safeBossUrl(raw, base) {
    if (!raw) return '';
    try {
      const url = new URL(raw, base || location.href);
      const isBossHost = url.hostname === 'zhipin.com' || url.hostname.endsWith('.zhipin.com');
      if (url.protocol !== 'https:' || !isBossHost) return '';
      url.username = '';
      url.password = '';
      for (const key of new Set(url.searchParams.keys())) {
        if (SENSITIVE_QUERY_RE.test(key)) url.searchParams.delete(key);
      }
      if (/(token|authorization|session|cookie|ticket)=/i.test(url.hash)) {
        url.hash = '';
      }
      return url.href.length <= 2_000 ? url.href : '';
    } catch {
      return '';
    }
  }

  function urlShape(raw) {
    try {
      const url = new URL(raw);
      const keys = Array.from(new Set(url.searchParams.keys()));
      return `${url.origin}${url.pathname}${keys.length ? `?${keys.join('&')}` : ''}${url.hash ? '#…' : ''}`;
    } catch {
      return '';
    }
  }

  function getCandidateIdEl(card) {
    return card?.querySelector('a[data-contact]') || card?.querySelector('[data-expect],[data-geek],[data-geekid]') || null;
  }

  function getCandidateId(root) {
    if (!root) return '';
    const direct = root.matches?.('[data-expect],[data-geek],[data-geekid]') ? root : null;
    const el = direct || root.querySelector?.('[data-expect],[data-geek],[data-geekid]');
    return cleanText(
      el?.getAttribute('data-expect') ||
      el?.getAttribute('data-geek') ||
      el?.getAttribute('data-geekid') ||
      ''
    );
  }

  function getCandidateName(card) {
    const selectors = [
      '.geek-name', '.name-wrap', '[class*="geek-name"]',
      '[class*="candidate-name"]', '.name',
    ];
    for (const selector of selectors) {
      const value = cleanText(card?.querySelector(selector)?.textContent);
      if (value && value.length <= 40) return value.split(/[|｜]/)[0].trim();
    }
    return cleanText(card?.textContent).split(' ')[0].slice(0, 40);
  }

  function collectCardContext(card) {
    const idEl = getCandidateIdEl(card);
    const bossId = getCandidateId(card);
    const name = getCandidateName(card);
    const sourceUrl = safeBossUrl(card.ownerDocument?.location?.href || location.href);
    const ids = {
      expectId: cleanText(idEl?.getAttribute('data-expect')),
      geekId: cleanText(idEl?.getAttribute('data-geek') || idEl?.getAttribute('data-geekid')),
      lid: cleanText(idEl?.getAttribute('data-lid')),
      jid: cleanText(idEl?.getAttribute('data-jid')),
    };
    const cardUrls = [];
    const candidateAnchors = [
      idEl?.matches?.('a[href]') ? idEl : null,
      idEl?.closest?.('a[href]'),
      idEl?.querySelector?.('a[href]'),
      card.querySelector('.name-wrap a[href], a[data-contact][href], a[class*="name"][href]'),
    ].filter(Boolean);
    for (const anchor of candidateAnchors) {
      const url = safeBossUrl(anchor.href, sourceUrl);
      if (url && !cardUrls.includes(url)) cardUrls.push(url);
    }
    return { bossId, name, ids, sourceUrl, cardUrls: cardUrls.slice(0, 8), armedAt: Date.now() };
  }

  function isResumeFrame(frame, doc) {
    if (!frame) return false;
    let docUrl = '';
    try { docUrl = doc?.location?.href || ''; } catch {}
    const descriptor = [
      frame.getAttribute('class'), frame.getAttribute('id'), frame.getAttribute('name'),
      frame.getAttribute('title'), frame.getAttribute('src'), docUrl,
    ].filter(Boolean).join(' ');
    return /(c-resume|resume|candidate[-_]?detail|geek[-_]?detail|talent[-_]?detail)/i.test(descriptor);
  }

  function surfaceGreetCount(surface) {
    if (!surface?.querySelectorAll) return 0;
    let count = 0;
    for (const el of surface.querySelectorAll('button, a, [role="button"]')) {
      const text = cleanText(el.textContent);
      if (!isVisible(el) || !GREET_RE.test(text)) continue;
      if (text === '沟通' && el.closest('nav, [class*="nav"], [class*="menu"], [class*="sidebar"]')) continue;
      count += 1;
    }
    return count;
  }

  function surfaceIdentity(surface, context) {
    if (!surface) return { matched: false, mismatchedId: false };
    const ids = [...surface.querySelectorAll?.('[data-expect],[data-geek],[data-geekid]') || []]
      .map(el => cleanText(
        el.getAttribute('data-expect') || el.getAttribute('data-geek') || el.getAttribute('data-geekid')
      ))
      .filter(Boolean);
    const uniqueIdCount = new Set(ids).size;
    if (context.bossId && ids.includes(context.bossId)) {
      return { matched: true, mismatchedId: false, uniqueIdCount };
    }
    const targetName = normalizedName(context.name);
    const text = normalizedName(surface.textContent);
    if (targetName && targetName.length >= 2 && text.includes(targetName)) {
      return { matched: true, mismatchedId: false, uniqueIdCount };
    }
    return {
      matched: false,
      mismatchedId: Boolean(context.bossId && ids.length && !ids.includes(context.bossId)),
      uniqueIdCount,
    };
  }

  function collectResumeSurfaces(context) {
    const surfaces = [];
    const seen = new Set();
    const add = (surface, kind, url) => {
      if (!surface || seen.has(surface) || !isVisible(surface)) return;
      const identity = surfaceIdentity(surface, context);
      const greetCount = surfaceGreetCount(surface);
      const greetSeen = greetCount > 0;
      if (!identity.matched && !greetSeen) return;
      // A full talent list can contain the target name plus many greeting
      // controls. Never treat that broad page body as a resume/detail page.
      if (kind === 'detail-page' && (identity.uniqueIdCount > 2 || greetCount > 2)) return;
      seen.add(surface);
      surfaces.push({ surface, kind, url: safeBossUrl(url), identity, greetSeen, greetCount });
    };

    for (const doc of getAllDocs()) {
      for (const panel of doc.querySelectorAll(RESUME_PANEL_SEL)) {
        add(panel, 'resume-panel', doc.location?.href);
      }
      if (doc !== document && doc.body) {
        let frame = null;
        try { frame = doc.defaultView?.frameElement; } catch {}
        if (isResumeFrame(frame, doc)) {
          add(doc.body, 'iframe-document', frame?.src || doc.location?.href);
        }
      }
    }

    const topUrl = safeBossUrl(location.href);
    if (URL_HINT_RE.test(topUrl) && topUrl !== context.sourceUrl && document.body) {
      add(document.body, 'detail-page', topUrl);
    }
    return surfaces;
  }

  function scoreUrl(url, source, context) {
    let score = 0;
    if (source === 'iframe-src' || source === 'iframe-document') score += 7;
    if (source === 'panel-link') score += 5;
    if (source === 'card-link') score += 3;
    if (source === 'route-after-open') score += 4;
    if (URL_HINT_RE.test(url)) score += 4;
    if (context.bossId && url.includes(encodeURIComponent(context.bossId))) score += 8;
    if (context.bossId && url.includes(context.bossId)) score += 8;
    if (url !== context.sourceUrl) score += 2;
    if (url === context.sourceUrl) score -= 10;
    try {
      const parsed = new URL(url);
      if (/\/web\/boss\/(recommend|search)/.test(parsed.pathname) && !URL_HINT_RE.test(parsed.search + parsed.hash)) {
        score -= 7;
      }
    } catch {}
    return score;
  }

  function inspectResume(context) {
    const surfaces = collectResumeSurfaces(context);
    const urls = new Map();
    const addUrl = (raw, source, base) => {
      const url = safeBossUrl(raw, base || context.sourceUrl);
      if (!url) return;
      const score = scoreUrl(url, source, context);
      const current = urls.get(url);
      if (!current || score > current.score) urls.set(url, { url, source, score });
    };

    for (const url of context.cardUrls || []) addUrl(url, 'card-link');

    for (const doc of getAllDocs()) {
      for (const frame of doc.querySelectorAll('iframe[src]')) {
        let childText = '';
        let childDoc = null;
        try {
          childDoc = frame.contentDocument;
          childText = normalizedName(childDoc?.body?.textContent);
        } catch {}
        const relevant = isResumeFrame(frame, childDoc) && (
          URL_HINT_RE.test(frame.src || '') ||
          (normalizedName(context.name) && childText.includes(normalizedName(context.name))) ||
          Boolean(context.bossId && childText.includes(normalizedName(context.bossId)))
        );
        if (relevant) addUrl(frame.src, 'iframe-src', doc.location?.href);
      }
    }

    for (const item of surfaces) {
      addUrl(item.url, item.kind === 'iframe-document' ? 'iframe-document' : 'route-after-open');
      for (const anchor of item.surface.querySelectorAll('a[href]')) {
        const url = safeBossUrl(anchor.href, item.url || context.sourceUrl);
        if (url && (URL_HINT_RE.test(url) || (context.bossId && url.includes(context.bossId)))) {
          addUrl(url, 'panel-link');
        }
      }
    }

    const routeAfterOpen = safeBossUrl(location.href);
    if (routeAfterOpen && routeAfterOpen !== context.sourceUrl) {
      addUrl(routeAfterOpen, 'route-after-open');
    }

    const identityMatched = surfaces.some(item => item.identity.matched);
    const mismatchedId = surfaces.some(item => item.identity.mismatchedId) && !identityMatched;
    const greetSeen = surfaces.some(item => item.greetSeen);
    return {
      capturedAt: new Date().toISOString(),
      sourceUrl: context.sourceUrl,
      identityMatched,
      mismatchedId,
      greetSeen,
      surfaceKinds: [...new Set(surfaces.map(item => item.kind))],
      urls: [...urls.values()].sort((a, b) => b.score - a.score),
      hasResumeSurface: surfaces.length > 0,
    };
  }

  function blankStore() {
    return { version: 1, updatedAt: '', entries: {} };
  }

  function loadStore() {
    try {
      const raw = GM_getValue(STORE_KEY, '');
      const value = typeof raw === 'string' ? JSON.parse(raw || 'null') : raw;
      if (value && value.version === 1 && value.entries && typeof value.entries === 'object') return value;
    } catch {}
    return blankStore();
  }

  function saveStore(store) {
    const cutoff = Date.now() - RETENTION_MS;
    const entries = Object.values(store.entries || {})
      .filter(entry => Date.parse(entry.lastCapturedAt || entry.createdAt || 0) >= cutoff)
      .sort((a, b) => Date.parse(b.lastCapturedAt || 0) - Date.parse(a.lastCapturedAt || 0))
      .slice(0, MAX_ENTRIES);
    store.entries = Object.fromEntries(entries.map(entry => [entry.key, entry]));
    store.updatedAt = new Date().toISOString();
    GM_setValue(STORE_KEY, JSON.stringify(store));
  }

  function entryKey(context) {
    return context.bossId || `name:${normalizedName(context.name)}`;
  }

  function mergeSnapshot(context, snapshot) {
    const store = loadStore();
    const key = entryKey(context);
    if (!key || key === 'name:') return null;
    const existing = store.entries[key] || {
      key,
      bossId: context.bossId || '',
      name: context.name || '未知候选人',
      ids: context.ids || {},
      createdAt: snapshot.capturedAt,
      urls: [],
    };
    existing.name = context.name || existing.name;
    existing.bossId = context.bossId || existing.bossId;
    existing.ids = { ...existing.ids, ...context.ids };
    existing.sourceUrl = snapshot.sourceUrl || existing.sourceUrl;
    existing.lastCapturedAt = snapshot.capturedAt;
    existing.identityMatched = snapshot.identityMatched;
    existing.mismatchedId = snapshot.mismatchedId;
    existing.greetSeen = snapshot.greetSeen;
    existing.surfaceKinds = snapshot.surfaceKinds;

    const mergedUrls = new Map((existing.urls || []).map(item => [item.url, item]));
    for (const item of snapshot.urls) {
      const previous = mergedUrls.get(item.url) || {};
      mergedUrls.set(item.url, {
        ...previous,
        ...item,
        status: previous.status || 'unverified',
        firstSeenAt: previous.firstSeenAt || snapshot.capturedAt,
        lastSeenAt: snapshot.capturedAt,
      });
    }
    existing.urls = [...mergedUrls.values()]
      .sort((a, b) => {
        const statusOrder = status => status === 'verified' ? 2 : status === 'rejected' ? 0 : 1;
        return statusOrder(b.status) - statusOrder(a.status) || b.score - a.score;
      })
      .slice(0, MAX_URLS_PER_ENTRY);
    store.entries[key] = existing;
    saveStore(store);
    return existing;
  }

  function bestUrl(entry) {
    const candidates = (entry?.urls || []).filter(item => item.status !== 'rejected' && item.score > 0);
    return candidates.sort((a, b) => {
      const verified = status => status === 'verified' ? 1 : 0;
      return verified(b.status) - verified(a.status) || b.score - a.score;
    })[0] || null;
  }

  function setStatus(message, kind = 'idle') {
    statusText = message;
    statusKind = kind;
    renderPanel();
  }

  function armProbe(context) {
    if (!context || (!context.bossId && !context.name)) return;
    lastCandidateContext = context;
    activeProbe = { context, deadline: Date.now() + PROBE_WINDOW_MS };
    setStatus(`只读观察：${context.name || context.bossId}`, 'watching');
    clearTimeout(probeTimer);
    probeTimer = setTimeout(probeTick, 180);
  }

  function probeTick() {
    if (!activeProbe) return;
    const snapshot = inspectResume(activeProbe.context);
    if (snapshot.hasResumeSurface) {
      if (snapshot.mismatchedId) {
        activeProbe = null;
        setStatus('检测到不同候选人 ID，已丢弃本次采集', 'warning');
        return;
      }
      const saved = mergeSnapshot(activeProbe.context, snapshot);
      activeProbe = null;
      const count = saved?.urls?.filter(item => item.score > 0).length || 0;
      setStatus(
        count ? `已本地保存 ${count} 个待验证入口` : '已记录简历结构，但未发现候选入口',
        count ? 'captured' : 'warning'
      );
      return;
    }
    if (Date.now() >= activeProbe.deadline) {
      activeProbe = null;
      setStatus('未识别到原生简历；没有执行任何页面操作', 'warning');
      return;
    }
    probeTimer = setTimeout(probeTick, 350);
  }

  function manualCapture() {
    const context = activeProbe?.context || lastCandidateContext;
    if (!context) {
      setStatus('请先手动点击一位候选人并打开原生简历', 'warning');
      return;
    }
    const snapshot = inspectResume(context);
    if (!snapshot.hasResumeSurface) {
      setStatus('当前没有识别到该候选人的原生简历', 'warning');
      return;
    }
    if (snapshot.mismatchedId) {
      setStatus('当前简历 ID 与最近候选人不同，未保存', 'warning');
      return;
    }
    const saved = mergeSnapshot(context, snapshot);
    setStatus(`手动采集完成：${saved?.urls?.filter(item => item.score > 0).length || 0} 个待验证入口`, 'captured');
  }

  function updateUrlState(key, urlIndex, status) {
    const store = loadStore();
    const entry = store.entries[key];
    const item = entry?.urls?.[urlIndex];
    if (!item) return;
    item.status = status;
    item.reviewedAt = new Date().toISOString();
    if (status === 'verified') item.verifiedAt = item.reviewedAt;
    saveStore(store);
    setStatus(status === 'verified' ? '已标记为可直达入口' : '已排除该入口，可继续测试下一个', status === 'verified' ? 'captured' : 'idle');
  }

  function startUrlTest(key, urlIndex) {
    const store = loadStore();
    const entry = store.entries[key];
    const item = entry?.urls?.[urlIndex];
    if (!item || item.status === 'rejected') {
      setStatus('没有可验证入口', 'warning');
      return;
    }
    item.lastTestedAt = new Date().toISOString();
    item.status = item.status === 'verified' ? 'verified' : 'testing';
    saveStore(store);
    GM_setValue(TEST_KEY, JSON.stringify({
      key,
      bossId: entry.bossId || '',
      name: entry.name || '',
      url: item.url,
      startedAt: Date.now(),
    }));
    window.open(item.url, '_blank', 'noopener,noreferrer');
    setStatus('已尝试新开验证页；不会自动点击任何 BOSS 控件', 'watching');
  }

  function sameTestPage(test) {
    const current = safeBossUrl(location.href);
    const target = safeBossUrl(test.url);
    if (!current || !target) return false;
    try {
      const a = new URL(current);
      const b = new URL(target);
      if (a.origin === b.origin && a.pathname === b.pathname && a.search === b.search) return true;
      if (test.bossId && (current.includes(test.bossId) || current.includes(encodeURIComponent(test.bossId)))) return true;
    } catch {}
    return false;
  }

  function beginPassiveVerification() {
    let test = null;
    try {
      const raw = GM_getValue(TEST_KEY, '');
      test = typeof raw === 'string' ? JSON.parse(raw || 'null') : raw;
    } catch {}
    if (!test || Date.now() - Number(test.startedAt || 0) > 120_000 || !sameTestPage(test)) return;

    const context = { bossId: test.bossId || '', name: test.name || '', sourceUrl: '', cardUrls: [], ids: {} };
    const deadline = Date.now() + 15_000;
    const check = () => {
      const surfaces = collectResumeSurfaces(context);
      const confirmed = surfaces.some(item => item.identity.matched && item.greetSeen);
      if (confirmed) {
        const store = loadStore();
        const entry = store.entries[test.key];
        const item = entry?.urls?.find(candidate => candidate.url === test.url);
        if (item) {
          item.status = 'verified';
          item.verifiedAt = new Date().toISOString();
          item.lastTestResult = 'identity-and-greet-confirmed';
          saveStore(store);
        }
        GM_setValue(TEST_KEY, '');
        setStatus('验证通过：同一候选人且存在“打招呼”', 'captured');
        return;
      }
      if (Date.now() >= deadline) {
        const store = loadStore();
        const entry = store.entries[test.key];
        const item = entry?.urls?.find(candidate => candidate.url === test.url);
        if (item && item.status === 'testing') {
          item.status = 'unverified';
          item.lastTestResult = 'not-confirmed';
          saveStore(store);
        }
        GM_setValue(TEST_KEY, '');
        setStatus('未自动确认；请人工查看姓名和“打招呼”后标记', 'warning');
        return;
      }
      setTimeout(check, 500);
    };
    setStatus('只读验证候选人身份和“打招呼”按钮', 'watching');
    setTimeout(check, 300);
  }

  function copyDiagnostic() {
    const store = loadStore();
    const report = {
      scriptVersion: SCRIPT_VERSION,
      page: urlShape(safeBossUrl(location.href)),
      generatedAt: new Date().toISOString(),
      safety: {
        networkRequests: 0,
        automaticClicks: 0,
        automaticScrolls: 0,
        automaticPagination: 0,
      },
      entries: Object.values(store.entries || {}).map(entry => ({
        bossId: entry.bossId,
        name: entry.name,
        lastCapturedAt: entry.lastCapturedAt,
        identityMatched: entry.identityMatched,
        greetSeen: entry.greetSeen,
        surfaceKinds: entry.surfaceKinds,
        urls: (entry.urls || []).map(item => ({
          source: item.source,
          score: item.score,
          status: item.status,
          shape: urlShape(item.url),
          lastTestResult: item.lastTestResult || '',
        })),
      })),
    };
    GM_setClipboard(`BOSS-RECOVERY-PROBE\n${JSON.stringify(report, null, 2)}`);
    setStatus('诊断已复制；参数值已隐藏，只保留 URL 结构', 'captured');
  }

  function clearLocalData() {
    if (!window.confirm('只删除本机恢复探针记录，不影响 BOSS 收藏、沟通和助手队列。确定删除吗？')) return;
    GM_setValue(STORE_KEY, JSON.stringify(blankStore()));
    GM_setValue(TEST_KEY, '');
    setStatus('本机探针记录已清空', 'idle');
  }

  function formatTime(value) {
    const date = new Date(value || 0);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  function renderRecord(entry) {
    const best = bestUrl(entry);
    const urlIndex = best ? entry.urls.findIndex(item => item.url === best.url) : -1;
    const state = best?.status === 'verified' ? '可直达' : best ? '待验证' : '无候选入口';
    const stateClass = best?.status === 'verified' ? 'verified' : best ? 'pending' : 'empty';
    return `
      <article class="brp-record">
        <div class="brp-record-head">
          <b>${esc(entry.name || '未知候选人')}</b>
          <span class="brp-record-state ${stateClass}">${state}</span>
        </div>
        <div class="brp-meta">${esc(entry.bossId || '无候选人 ID')} · ${esc(formatTime(entry.lastCapturedAt))}</div>
        ${best ? `<div class="brp-url" title="${esc(best.url)}">${esc(best.source)} · 分值 ${best.score} · ${esc(urlShape(best.url))}</div>` : ''}
        <div class="brp-record-actions">
          ${best ? `<button data-brp-act="test" data-key="${esc(entry.key)}" data-url-index="${urlIndex}">验证入口</button>` : ''}
          ${best && best.status !== 'verified' ? `<button data-brp-act="verify" data-key="${esc(entry.key)}" data-url-index="${urlIndex}">人工确认有效</button>` : ''}
          ${best ? `<button data-brp-act="reject" data-key="${esc(entry.key)}" data-url-index="${urlIndex}">排除此入口</button>` : ''}
        </div>
      </article>
    `;
  }

  function renderPanel() {
    const panel = document.getElementById('boss-recovery-probe');
    if (!panel) return;
    const store = loadStore();
    const entries = Object.values(store.entries || {})
      .sort((a, b) => Date.parse(b.lastCapturedAt || 0) - Date.parse(a.lastCapturedAt || 0));
    const expanded = panel.dataset.expanded === '1';
    panel.innerHTML = `
      <header class="brp-header">
        <div><b>恢复探针</b><span>只读实验 v${SCRIPT_VERSION}</span></div>
        <button data-brp-act="toggle" aria-label="${expanded ? '收起' : '展开'}">${expanded ? '−' : '+'}</button>
      </header>
      <div class="brp-status ${esc(statusKind)}">${esc(statusText)}</div>
      ${expanded ? `
        <div class="brp-safety">零接口请求 · 零自动点击 · 零滚动翻页 · 数据仅存本机 14 天</div>
        <div class="brp-actions">
          <button data-brp-act="capture">采集当前简历</button>
          <button data-brp-act="refresh">刷新记录</button>
          <button data-brp-act="copy">复制诊断</button>
          <button data-brp-act="clear" class="danger">清空本地</button>
        </div>
        <div class="brp-records">
          ${entries.length ? entries.map(renderRecord).join('') : '<div class="brp-empty">暂无记录。请手动点击候选人并打开 BOSS 原生简历。</div>'}
        </div>
      ` : ''}
    `;
  }

  function createPanel() {
    GM_addStyle(`
      #boss-recovery-probe {
        position: fixed; left: 12px; bottom: 12px; z-index: 100005;
        width: min(360px, calc(100vw - 24px)); max-height: min(620px, calc(100vh - 24px));
        overflow: hidden; color: #26324f; background: #fff; border: 1px solid #dce2f2;
        border-radius: 12px; box-shadow: 0 12px 36px rgba(28, 42, 86, .22);
        font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #boss-recovery-probe * { box-sizing: border-box; }
      .brp-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; color: #fff; background: #4055cc; }
      .brp-header div { display: flex; align-items: baseline; gap: 7px; }
      .brp-header b { font-size: 14px; }
      .brp-header span { opacity: .78; font-size: 10px; }
      .brp-header button { width: 26px; height: 26px; padding: 0; color: #fff; border: 0; border-radius: 7px; background: rgba(255,255,255,.16); cursor: pointer; font-size: 18px; }
      .brp-status { padding: 8px 11px; border-bottom: 1px solid #edf0f6; background: #f7f8fc; }
      .brp-status.watching { color: #6b5100; background: #fff8dc; }
      .brp-status.captured { color: #17643c; background: #ebf8f0; }
      .brp-status.warning { color: #9b3f2e; background: #fff0ed; }
      .brp-safety { padding: 8px 11px; color: #58647d; background: #f4f6fb; font-size: 10px; }
      .brp-actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 9px 10px; border-bottom: 1px solid #edf0f6; }
      .brp-actions button, .brp-record-actions button { padding: 5px 8px; color: #4055cc; border: 1px solid #d8def3; border-radius: 7px; background: #f4f6ff; cursor: pointer; font-size: 11px; }
      .brp-actions button.danger { color: #a33a30; background: #fff2f0; border-color: #f0d5d1; }
      .brp-records { max-height: 400px; overflow-y: auto; padding: 9px; background: #f7f8fc; }
      .brp-record { margin-bottom: 8px; padding: 9px; border: 1px solid #e2e6f1; border-radius: 9px; background: #fff; }
      .brp-record-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .brp-record-state { padding: 1px 6px; border-radius: 999px; font-size: 10px; }
      .brp-record-state.verified { color: #17643c; background: #e8f7ee; }
      .brp-record-state.pending { color: #7d5900; background: #fff4d4; }
      .brp-record-state.empty { color: #6c7487; background: #edf0f5; }
      .brp-meta { margin-top: 3px; color: #8991a3; font-size: 10px; }
      .brp-url { margin-top: 6px; overflow: hidden; color: #52607b; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
      .brp-record-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
      .brp-empty { padding: 20px 12px; color: #7d879c; text-align: center; }
    `);

    const panel = document.createElement('aside');
    panel.id = 'boss-recovery-probe';
    panel.dataset.expanded = '1';
    panel.setAttribute('aria-label', 'BOSS 候选人恢复探针');
    panel.addEventListener('click', event => {
      const button = event.target.closest('[data-brp-act]');
      if (!button) return;
      const action = button.dataset.brpAct;
      if (action === 'toggle') {
        panel.dataset.expanded = panel.dataset.expanded === '1' ? '0' : '1';
        renderPanel();
      } else if (action === 'capture') {
        manualCapture();
      } else if (action === 'refresh') {
        renderPanel();
      } else if (action === 'copy') {
        copyDiagnostic();
      } else if (action === 'clear') {
        clearLocalData();
      } else if (action === 'test') {
        startUrlTest(button.dataset.key, Number(button.dataset.urlIndex));
      } else if (action === 'verify') {
        updateUrlState(button.dataset.key, Number(button.dataset.urlIndex), 'verified');
      } else if (action === 'reject') {
        updateUrlState(button.dataset.key, Number(button.dataset.urlIndex), 'rejected');
      }
    });
    document.body.appendChild(panel);
    renderPanel();
  }

  function handlePageClick(event) {
    // Candidate cards often live in a same-origin iframe. Avoid `instanceof
    // Element`, which fails across window realms even for a valid element.
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    if (!target || target.closest('#boss-recovery-probe')) return;
    const card = target.closest(CARD_SEL);
    if (!card) return;
    const context = collectCardContext(card);
    if (!context.bossId && !context.name) return;
    armProbe(context);
  }

  function bindDocumentWatchers() {
    for (const doc of getAllDocs()) {
      if (watchedDocs.has(doc)) continue;
      watchedDocs.add(doc);
      doc.addEventListener('click', handlePageClick, true);
    }
  }

  createPanel();
  bindDocumentWatchers();
  setInterval(bindDocumentWatchers, 1_500);
  beginPassiveVerification();
})();
