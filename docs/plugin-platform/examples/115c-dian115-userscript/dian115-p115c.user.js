// ==UserScript==
// @name         115 转存离线助手
// @namespace    dian115.example
// @version      0.6.4
// @description  手填 Cookie 浏览 115 目录；识别已解锁的 115 分享、磁力和 ED2K，并支持外部推送。
// @author       yamcv98
// @license      MIT
// @icon         https://115.com/favicon.ico
// @match        *://*/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      webapi.115.com
// @connect      115.com
// @connect      115cdn.com
// @connect      proapi.115.com
// @connect      *
// ==/UserScript==

/*
 * Browser-side 115 helper. Credentials are entered by the user and stay in
 * userscript storage and a closed Shadow DOM.
 */
(function () {
  'use strict';

  const VERSION = '0.6.4';
  const STORE_KEY = 'd115-p115c-config-v1';
  const DIRECT = 'direct';
  const PUSH = 'push';
  const PUSH_SOURCE = '转存助手';
  const ICON_URL = 'https://115.com/favicon.ico';
  const HDHIVE_ORIGIN = 'https://hdhive.com';
  const TMDB_ORIGIN = 'https://www.themoviedb.org';
  const MAX_CANDIDATES = 100;
  const MAX_SCAN_TEXT_NODES = 1600;
  const MAX_SCAN_CHARS = 500000;
  const ACTION_GAP = 8;
  const VIEWPORT_MARGIN = 8;
  const DEFAULTS = {
    mode: DIRECT,
    cookie: '',
    targetCid: '',
    targetName: '',
    dian115Base: '',
    openApiKey: '',
    autoScan: true,
    showLauncherAlways: false,
  };

  const state = {
    config: loadConfig(),
    open: false,
    rootHost: null,
    uiRoot: null,
    panel: null,
    status: null,
    counter: null,
    launcher: null,
    launcherButton: null,
    launcherIcon: null,
    launcherDetectedIcon: null,
    launcherLabel: null,
    candidateTitle: null,
    candidateList: null,
    bulkActions: null,
    activeCandidate: null,
    candidates: new Map(),
    boundHosts: new WeakMap(),
    pushKeys: new Map(),
    actionEntries: [],
    subscriptionOverlay: null,
    positionFrame: 0,
    bulkRunning: false,
    manualInput: '',
    revealCookie: false,
    scanTimer: 0,
    offlineAuthCache: null,
  };

  function loadConfig() {
    try { return { ...DEFAULTS, ...(GM_getValue(STORE_KEY, {}) || {}) }; }
    catch (_) { return { ...DEFAULTS }; }
  }

  function saveConfig() {
    try { GM_setValue(STORE_KEY, { ...state.config }); }
    catch (_) { /* Userscript storage is unavailable. */ }
  }

  function text(value) { return String(value == null ? '' : value).trim(); }
  function first(...values) { return values.map(text).find(Boolean) || ''; }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function decodeEntities(value) {
    const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
    return String(value == null ? '' : value).replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (whole, token) => {
      const normalized = token.toLowerCase();
      if (normalized[0] !== '#') return entities[normalized] || whole;
      const radix = normalized[1] === 'x' ? 16 : 10;
      const digits = normalized.slice(radix === 16 ? 2 : 1);
      const point = Number.parseInt(digits, radix);
      try { return Number.isFinite(point) ? String.fromCodePoint(point) : whole; }
      catch (_) { return whole; }
    });
  }

  function safeUrl(value, base = location.href) {
    try { return new URL(value, base); }
    catch (_) { return null; }
  }

  function is115Host(hostname) {
    const host = text(hostname).toLowerCase();
    return host === '115.com' || host.endsWith('.115.com') || host === '115cdn.com' || host.endsWith('.115cdn.com');
  }

  function decodeUrlPart(value) {
    try { return decodeURIComponent(value); }
    catch (_) { return ''; }
  }

  function transportError(message) {
    const error = new Error(message);
    error.networkFailure = true;
    return error;
  }

  function gmRequest(options) {
    const { url, method = 'GET', headers = {}, data = '', responseType = 'text' } = options;
    return new Promise((resolve, reject) => {
      const request = {
        url, method, headers, data, responseType, timeout: 30000,
        onload: response => resolve(response),
        ontimeout: () => reject(transportError(`请求超时：${url}`)),
        onerror: response => {
          const detail = first(response?.error, response?.statusText, response?.status ? `HTTP ${response.status}` : '');
          reject(transportError(`网络请求失败：${url}${detail ? `（${detail}）` : ''}`));
        },
        onabort: () => reject(transportError(`请求已取消：${url}`)),
      };
      try { GM_xmlhttpRequest(request); }
      catch (error) { reject(error); }
    });
  }

  function formEncode(values) {
    const params = new URLSearchParams();
    Object.entries(values).forEach(([key, value]) => {
      if (value !== undefined && value !== null) params.set(key, String(value));
    });
    return params.toString();
  }

  function queryString(values) {
    const params = new URLSearchParams();
    Object.entries(values).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    });
    return params.toString();
  }

  function parseJSONResponse(response) {
    const raw = response.responseText || response.response || '';
    let parsed;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (_) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') throw new Error(`HTTP ${response.status || 0} 返回不是 JSON`);
    if (response.status >= 400 || parsed.state === false || parsed.success === false) {
      throw new Error(first(parsed.error, parsed.error_msg, parsed.message, parsed.msg, parsed.errno && `errno ${parsed.errno}`, `HTTP ${response.status || 0}`));
    }
    return parsed;
  }

  function normalizedCookie() {
    return String(state.config.cookie || '').replace(/^\s*cookie\s*:\s*/i, '').replace(/[\r\n]+/g, '; ').trim();
  }

  function cookieHeaders() {
    const cookie = normalizedCookie();
    return cookie ? {
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0',
    } : {};
  }

  function p115RequestOptions(options) {
    return {
      ...options,
      headers: { ...cookieHeaders(), ...(options.headers || {}) },
    };
  }

  async function p115GET(path, params = {}, headers = {}) {
    const query = queryString(params);
    const base = /^https:\/\//i.test(path) ? path : `https://webapi.115.com${path}`;
    const url = `${base}${query ? `${base.includes('?') ? '&' : '?'}${query}` : ''}`;
    const response = await gmRequest(p115RequestOptions({ url, headers }));
    return parseJSONResponse(response);
  }

  async function p115POST(path, payload, headers = {}) {
    const url = /^https:\/\//i.test(path) ? path : `https://webapi.115.com${path}`;
    const response = await gmRequest(p115RequestOptions({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      data: formEncode(payload),
    }));
    return parseJSONResponse(response);
  }

  async function getOfflineAuth(forceRefresh = false) {
    const cache = state.offlineAuthCache;
    if (!forceRefresh && cache && Date.now() - cache.timestamp < 5 * 60 * 1000) return cache.data;
    const [spaceResponse, uploadResponse] = await Promise.all([
      gmRequest(p115RequestOptions({ url: `https://115.com/?ct=offline&ac=space&_=${Date.now()}` })),
      gmRequest(p115RequestOptions({ url: 'https://proapi.115.com/app/uploadinfo' })),
    ]);
    const spaceInfo = parseJSONResponse(spaceResponse);
    const uploadInfo = parseJSONResponse(uploadResponse);
    const auth = {
      uid: first(uploadInfo.user_id, uploadInfo.userId, uploadInfo.data?.user_id, uploadInfo.data?.userId),
      sign: first(spaceInfo.sign, spaceInfo.data?.sign),
      time: first(spaceInfo.time, spaceInfo.data?.time),
    };
    if (!auth.uid || !auth.sign || !auth.time) throw new Error('无法获取 115 离线认证信息，请确认 Cookie 有效');
    state.offlineAuthCache = { timestamp: Date.now(), data: auth };
    return auth;
  }

  async function p115Offline(urls, saveCid) {
    if (!Array.isArray(urls) || !urls.length || urls.some(url => !text(url))) throw new Error('没有可提交的离线链接');
    const auth = await getOfflineAuth();
    const response = await gmRequest(p115RequestOptions({
      url: 'https://115.com/web/lixian/?ct=lixian&ac=add_task_url',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      data: formEncode({
        url: urls[0],
        uid: auth.uid,
        sign: auth.sign,
        time: auth.time,
        wp_path_id: String(saveCid || '0'),
      }),
    }));
    try {
      return parseJSONResponse(response);
    } catch (error) {
      let payload = null;
      try { payload = JSON.parse(response.responseText || response.response || ''); } catch (_) {}
      if (payload?.errno === 911) throw new Error('115 需要安全验证，请先打开 115 网页完成验证后重试');
      if (payload?.errno === 99) {
        state.offlineAuthCache = null;
        throw new Error('115 登录状态失效，请更新 Cookie 后重试');
      }
      if (payload?.errno === 10008) throw new Error(first(payload.error_msg, '离线链接无效'));
      throw error;
    }
  }

  function parse115Share(value) {
    const raw = text(decodeEntities(value));
    if (!raw) return null;
    if (/^[A-Za-z0-9_-]{6,128}-[A-Za-z0-9]{1,32}$/.test(raw)) {
      const separator = raw.lastIndexOf('-');
      return { type: 'share115', raw, shareCode: raw.slice(0, separator), receiveCode: raw.slice(separator + 1) };
    }
    const url = safeUrl(raw);
    if (!url || !/^https?:$/.test(url.protocol) || !is115Host(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    let shareCode = '';
    if (parts.length >= 2 && parts[0].toLowerCase() === 's') shareCode = decodeUrlPart(parts[1]);
    else if (url.hostname.toLowerCase().startsWith('share.') && parts.length === 1) shareCode = decodeUrlPart(parts[0]);
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(shareCode)) return null;
    const receiveCode = first(url.searchParams.get('password'), url.searchParams.get('receive_code'), url.searchParams.get('pwd'));
    return { type: 'share115', raw, shareCode, receiveCode };
  }

  function parse115Cid(value) {
    const raw = text(decodeEntities(value));
    if (!raw) return null;
    const explicit = raw.match(/^115cid\s*(?::|=)\s*(\d+)$/i) || raw.match(/^115cid:\/\/(\d+)\/?$/i);
    if (explicit) return { type: 'cid115', raw, cid: explicit[1] };
    const url = safeUrl(raw);
    if (!url || !/^https?:$/.test(url.protocol) || !is115Host(url.hostname)) return null;
    const cid = text(url.searchParams.get('cid'));
    return /^\d+$/.test(cid) ? { type: 'cid115', raw, cid } : null;
  }

  const MAGNET_RE = /magnet:\?xt=urn:btih:[A-Za-z0-9]{32,40}(?:&[^\s"'<>\x00-\x1f]*)?/gi;
  const ED2K_RE = /ed2k:\/\/\|file\|[^|\r\n]+\|\d+\|[a-f0-9]{32}\|(?:[^|\s<>"']*\|)*\//gi;
  const CID_RE = /115cid\s*(?::|=)\s*\d+|115cid:\/\/\d+/gi;

  function canonicalOffline(value) {
    const raw = text(decodeEntities(value));
    const magnet = raw.match(MAGNET_RE)?.[0];
    if (magnet) return { type: 'magnet', raw: magnet, url: magnet };
    const ed2k = raw.match(ED2K_RE)?.[0];
    if (ed2k) return { type: 'ed2k', raw: ed2k, url: ed2k };
    return null;
  }

  function canonicalOfflineAddress(value) {
    const raw = text(decodeEntities(value));
    const url = safeUrl(raw);
    if (!url || !/^https?:$/.test(url.protocol) || is115Host(url.hostname)) return null;
    return { type: 'offlineUrl', raw, url: url.href };
  }

  function parseCandidate(value) {
    return parse115Share(value) || parse115Cid(value) || canonicalOffline(value);
  }

  function parseManualCandidate(value) {
    return parseCandidate(value) || canonicalOfflineAddress(value);
  }

  function extractManualCandidates(value) {
    const source = decodeEntities(String(value || '')).replace(/&amp;/gi, '&');
    const found = extractCandidates(source);
    const seen = new Set(found.map(candidateKey));
    for (const match of source.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      const candidate = parseManualCandidate(match[0].replace(/[),.;，。！？]+$/, ''));
      const key = candidateKey(candidate);
      if (key && !seen.has(key)) { seen.add(key); found.push(candidate); }
    }
    return found;
  }

  function candidateKey(candidate) {
    if (!candidate) return '';
    if (candidate.type === 'share115') return `share115:${candidate.shareCode}:${candidate.receiveCode}`;
    if (candidate.type === 'cid115') return `cid115:${candidate.cid}`;
    return `${candidate.type}:${String(candidate.url || '').toLowerCase()}`;
  }

  function extractCandidates(value) {
    const source = decodeEntities(String(value || '')).replace(/&amp;/gi, '&');
    const found = [];
    const seen = new Set();
    const add = candidate => {
      const key = candidateKey(candidate);
      if (key && !seen.has(key)) { seen.add(key); found.push(candidate); }
    };
    for (const match of source.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      add(parseCandidate(match[0].replace(/[),.;，。！？]+$/, '')));
    }
    for (const match of source.matchAll(CID_RE)) add(parse115Cid(match[0]));
    for (const match of source.matchAll(MAGNET_RE)) add(canonicalOffline(match[0]));
    for (const match of source.matchAll(ED2K_RE)) add(canonicalOffline(match[0]));
    return found;
  }

  function getRows(payload) {
    const roots = [payload?.data, payload?.data?.data, payload?.data?.list, payload?.list, payload?.files, payload?.data?.files, payload?.data?.items];
    for (const value of roots) if (Array.isArray(value)) return value;
    return [];
  }

  function rowId(row) { return first(row?.file_id, row?.fid, row?.cid, row?.id, row?.fileId); }

  function rowName(row) {
    for (const value of [row?.n, row?.name, row?.fn, row?.file_name, row?.title]) {
      if (value !== undefined && value !== null && String(value) !== '') return String(value);
    }
    return '未命名';
  }

  function rowIsDir(row) {
    if ([true, 1, '1'].includes(row?.is_dir) || [true, 1, '1'].includes(row?.is_directory) || [1, '1'].includes(row?.dir)) return true;
    const kindValues = [row?.fc, row?.type, row?.file_type];
    if (kindValues.some(value => value === 0 || value === '0')) return true;
    if (kindValues.some(value => value === 1 || value === '1')) return false;
    return Array.isArray(row?.fl) && row.fl.length === 0 && row?.cid != null && row?.fid == null && row?.file_id == null;
  }

  async function list115Dirs(cid) {
    const payload = await p115GET('/files', {
      aid: 1, cid: cid || '0', show_dir: 1, nsprefix: 1,
    });
    return getRows(payload)
      .map(row => ({ cid: rowId(row), name: rowName(row), isDir: rowIsDir(row) }))
      .filter(row => row.cid && row.isDir);
  }

  async function listShareFiles(share) {
    const rows = [];
    let offset = 0;
    for (let page = 0; page < 20; page += 1) {
      const payload = await p115GET('https://115cdn.com/webapi/share/snap', {
        _v: 2, share_code: share.shareCode, receive_code: share.receiveCode, cid: '', limit: 1150, offset,
      }, { Referer: 'https://115.com/', Origin: 'https://115.com' });
      const pageRows = getRows(payload);
      rows.push(...pageRows);
      if (pageRows.length < 1150) break;
      offset += pageRows.length;
    }
    return rows
      .map(row => ({ id: rowId(row), name: rowName(row), isDir: rowIsDir(row) }))
      .filter(row => row.id);
  }

  async function receiveShare(share, fileIds, targetCid) {
    if (!share?.shareCode) throw new Error('不是有效的 115 分享链接');
    if (targetCid === '') throw new Error('请先选择转存目标目录');
    if (!Array.isArray(fileIds) || fileIds.length === 0) throw new Error('请至少选择一项分享内容');
    try {
      return await p115POST('https://115cdn.com/webapi/share/receive', {
        share_code: share.shareCode,
        receive_code: share.receiveCode,
        file_id: fileIds.join(','),
        cid: targetCid,
      });
    } catch (error) {
      if (error?.networkFailure) {
        const uncertain = new Error('转存请求的结果不确定，请先到 115 核对，勿立即重试');
        uncertain.networkFailure = true;
        throw uncertain;
      }
      throw error;
    }
  }

  function configuredPushBase() {
    const raw = text(state.config.dian115Base);
    const url = safeUrl(raw, 'http://localhost/');
    if (!raw || !url || !/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('DIAN115 地址必须是无账号、查询参数和片段的 HTTP(S) 地址');
    }
    return url.toString().replace(/\/$/, '');
  }

  function validatePushConfig() {
    configuredPushBase();
    if (!text(state.config.openApiKey)) throw new Error('请填写 OpenAPI Key');
  }

  function canonicalCandidateLink(candidate) {
    if (candidate.type === 'share115') {
      const password = candidate.receiveCode ? `?password=${encodeURIComponent(candidate.receiveCode)}` : '';
      return `https://115.com/s/${encodeURIComponent(candidate.shareCode)}${password}`;
    }
    return candidate.url || candidate.raw;
  }

  function idempotencyKey(candidate) {
    const key = candidateKey(candidate);
    let value = state.pushKeys.get(key);
    if (!value) {
      value = `d115-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
      state.pushKeys.set(key, value);
    }
    return value;
  }

  async function pushExternal(candidate, waitForCompletion = true) {
    validatePushConfig();
    const base = configuredPushBase();
    const openApiKey = text(state.config.openApiKey);
    const key = candidateKey(candidate);
    try {
      const response = await gmRequest({
        url: `${base}/api/openapi/v1/external-push`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OpenAPI-Key': openApiKey,
          'Idempotency-Key': idempotencyKey(candidate),
        },
        data: JSON.stringify({
          source: PUSH_SOURCE,
          link: canonicalCandidateLink(candidate),
        }),
      });
      const accepted = parseJSONResponse(response);
      const requestId = accepted.request_id;
      if (!requestId) { state.pushKeys.delete(key); return accepted; }
      if (!waitForCompletion) return accepted;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await sleep(1000);
        const statusResponse = await gmRequest({
          url: `${base}/api/openapi/v1/external-push/${encodeURIComponent(requestId)}`,
          headers: { 'X-OpenAPI-Key': openApiKey },
        });
        const status = parseJSONResponse(statusResponse);
        if (['succeeded', 'failed', 'rejected'].includes(status.status)) {
          state.pushKeys.delete(key);
          if (status.status !== 'succeeded') throw new Error(first(status.error_message, status.message, status.status));
          return status;
        }
      }
      return { request_id: requestId, status: 'processing' };
    } catch (error) {
      if (!error?.networkFailure) state.pushKeys.delete(key);
      throw error;
    }
  }

  async function listDian115Subscriptions(options = {}) {
    validatePushConfig();
    const base = configuredPushBase();
    const openApiKey = text(state.config.openApiKey);
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 100));
    const offset = Math.max(0, Number(options.offset) || 0);
    const mediaType = text(options.mediaType || options.media_type).toLowerCase();
    const query = queryString({ limit, offset, media_type: mediaType });
    const response = await gmRequest({
      url: `${base}/api/openapi/v1/subscriptions${query ? `?${query}` : ''}`,
      headers: { 'X-OpenAPI-Key': openApiKey },
    });
    const payload = parseJSONResponse(response);
    const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    const items = Array.isArray(data.subscriptions)
      ? data.subscriptions
      : Array.isArray(data.records)
        ? data.records
        : Array.isArray(data)
          ? data
          : [];
    return {
      items,
      total: Number.isFinite(Number(data.total)) ? Number(data.total) : items.length,
      limit: Number.isFinite(Number(data.limit)) ? Number(data.limit) : limit,
      offset: Number.isFinite(Number(data.offset)) ? Number(data.offset) : offset,
      hasMore: Boolean(data.has_more ?? data.hasMore),
    };
  }

  function buildHdhiveUrl(subscription) {
    const mediaType = text(subscription?.media_type || subscription?.mediaType).toLowerCase();
    const tmdbId = Number(subscription?.tmdb_id ?? subscription?.tmdbId);
    if (!['movie', 'tv'].includes(mediaType) || !Number.isInteger(tmdbId) || tmdbId <= 0) return '';
    return `${HDHIVE_ORIGIN}/tmdb/${mediaType}/${encodeURIComponent(String(tmdbId))}`;
  }

  function buildTmdbUrl(subscription) {
    const mediaType = text(subscription?.media_type || subscription?.mediaType).toLowerCase();
    const tmdbId = Number(subscription?.tmdb_id ?? subscription?.tmdbId);
    if (!['movie', 'tv'].includes(mediaType) || !Number.isInteger(tmdbId) || tmdbId <= 0) return '';
    return `${TMDB_ORIGIN}/${mediaType}/${encodeURIComponent(String(tmdbId))}`;
  }

  function extractDianyingCandidates(payload) {
    const found = [];
    const seen = new Set();
    const add = candidate => {
      const key = candidateKey(candidate);
      if (key && candidate.type !== 'cid115' && !seen.has(key)) { seen.add(key); found.push(candidate); }
    };
    const addField = value => {
      if (typeof value === 'string') {
        add(parseCandidate(value));
        extractCandidates(value).forEach(add);
      } else if (Array.isArray(value)) value.forEach(addField);
    };
    const walk = (value, depth) => {
      if (depth > 8 || !value) return;
      if (Array.isArray(value)) { value.forEach(item => walk(item, depth + 1)); return; }
      if (typeof value !== 'object') return;
      const shareCode = first(value.share_code, value.shareCode);
      const receiveCode = first(value.receive_code, value.receiveCode, value.password, value.pwd);
      if (/^[A-Za-z0-9_-]{6,128}$/.test(shareCode)) {
        const password = receiveCode ? `?password=${encodeURIComponent(receiveCode)}` : '';
        add(parse115Share(`https://115.com/s/${shareCode}${password}`));
      }
      for (const [field, child] of Object.entries(value)) {
        const normalized = field.toLowerCase();
        if (normalized === 'url_115' || normalized === 'url' || normalized === 'urls'
          || normalized.includes('magnet') || normalized.includes('ed2k')
          || normalized === 'link' || normalized === 'links' || normalized.includes('115')) addField(child);
        if (child && typeof child === 'object') walk(child, depth + 1);
      }
    };
    walk(payload, 0);
    return found;
  }

  function isDianyingCaptureUrl(value) {
    const url = safeUrl(value, location.href);
    if (!url || url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'm.dian115.com') return false;
    return url.pathname === '/api/portal/unlock'
      || url.pathname === '/api/portal/me/115/jobs'
      || url.pathname.startsWith('/api/portal/me/115/jobs/');
  }

  function handleDianyingPayload(url, rawBody) {
    if (!isDianyingCaptureUrl(url) || typeof rawBody !== 'string' || rawBody.length > 1000000) return;
    let payload;
    try { payload = JSON.parse(rawBody); }
    catch (_) { return; }
    const candidates = extractDianyingCandidates(payload);
    if (!candidates.length) return;
    candidates.forEach(candidate => rememberCandidate(candidate, '癫影已解锁'));
    updateCandidateUi();
    setStatus(`已从癫影解锁结果捕获 ${candidates.length} 条可操作链接`, 'success');
  }

  function installDianyingCapture() {
    if (location.protocol !== 'https:' || location.hostname.toLowerCase() !== 'm.dian115.com') return;
    const page = typeof unsafeWindow === 'object' ? unsafeWindow : window;
    const marker = '__transferHelperCaptureV1';
    if (page[marker]) return;
    try { Object.defineProperty(page, marker, { value: true, configurable: false }); }
    catch (_) { return; }
    const eventName = `transfer-helper-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const emit = (url, body) => {
      if (!isDianyingCaptureUrl(url) || typeof body !== 'string' || body.length > 1000000) return;
      page.dispatchEvent(new page.CustomEvent(eventName, { detail: JSON.stringify({ url, body }) }));
    };
    window.addEventListener(eventName, event => {
      if (typeof event.detail !== 'string' || event.detail.length > 1100000) return;
      try {
        const message = JSON.parse(event.detail);
        handleDianyingPayload(message.url, message.body);
      } catch (_) { /* Ignore untrusted page events. */ }
    });

    if (typeof page.fetch === 'function') {
      const originalFetch = page.fetch;
      page.fetch = function (...args) {
        const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        const promise = Reflect.apply(originalFetch, this, args);
        if (isDianyingCaptureUrl(requestUrl)) {
          promise.then(response => {
            const length = Number(response.headers?.get?.('content-length') || 0);
            if (length > 1000000) return;
            response.clone().text().then(body => emit(response.url || requestUrl, body)).catch(() => {});
          }).catch(() => {});
        }
        return promise;
      };
    }

    const xhrPrototype = page.XMLHttpRequest?.prototype;
    if (xhrPrototype) {
      const requestUrls = new WeakMap();
      const originalOpen = xhrPrototype.open;
      const originalSend = xhrPrototype.send;
      xhrPrototype.open = function (method, url, ...args) {
        requestUrls.set(this, String(url));
        return Reflect.apply(originalOpen, this, [method, url, ...args]);
      };
      xhrPrototype.send = function (...args) {
        const requestUrl = requestUrls.get(this);
        if (isDianyingCaptureUrl(requestUrl)) {
          this.addEventListener('load', () => {
            try {
              const body = typeof this.responseText === 'string' ? this.responseText : JSON.stringify(this.response);
              emit(this.responseURL || requestUrl, body);
            } catch (_) { /* Binary or inaccessible response. */ }
          }, { once: true });
        }
        return Reflect.apply(originalSend, this, args);
      };
    }
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else if (key === 'style') Object.assign(node.style, value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (value != null) node.setAttribute(key, String(value));
    });
    for (const child of [].concat(children)) {
      if (child) node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function button(label, onClick, className = '', title = '') {
    return el('button', {
      type: 'button',
      className: `d115-btn ${className}`,
      text: label,
      title,
      onclick: event => {
        event.preventDefault();
        event.stopPropagation();
        Promise.resolve(onClick(event)).catch(error => setStatus(error.message || '操作失败', 'error'));
      },
    });
  }

  function addField(parent, label, value, type, onInput) {
    const wrap = el('label', { className: 'd115-field' });
    wrap.append(el('span', { text: label }));
    const input = el(type === 'textarea' ? 'textarea' : 'input', {
      type: type === 'textarea' ? undefined : type,
      autocomplete: 'off',
      spellcheck: 'false',
    });
    input.value = value || '';
    input.addEventListener('input', () => onInput(input.value));
    wrap.append(input);
    parent.append(wrap);
    return input;
  }

  function setStatus(message, tone = 'info') {
    if (!state.status) return;
    state.status.textContent = message;
    state.status.className = `d115-status d115-${tone}`;
  }

  function candidateTypeLabel(candidate) {
    if (candidate.type === 'share115') return '115 分享';
    if (candidate.type === 'cid115') return '115CID';
    if (candidate.type === 'magnet') return '磁力';
    if (candidate.type === 'offlineUrl') return '离线地址';
    return 'ED2K';
  }

  function candidateActionLabel(candidate, panel = false) {
    if (candidate.type === 'cid115') return '设为目标';
    if (panel && state.config.mode === PUSH) return '推送';
    return candidate.type === 'share115' ? '转存' : '离线';
  }

  function candidateClass(candidate, panel = false) {
    if (panel && state.config.mode === PUSH && candidate.type !== 'cid115') return 'd115-push';
    if (candidate.type === 'share115') return 'd115-share';
    if (candidate.type === 'magnet' || candidate.type === 'ed2k' || candidate.type === 'offlineUrl') return 'd115-offline';
    return '';
  }

  function candidateDisplay(candidate) {
    if (candidate.type === 'share115') return `${candidate.shareCode}${candidate.receiveCode ? ' · 含访问码' : ''}`;
    if (candidate.type === 'cid115') return `CID ${candidate.cid}`;
    const value = candidate.url || candidate.raw || '';
    return value.length > 92 ? `${value.slice(0, 89)}...` : value;
  }

  function rememberCandidate(candidate, source = '页面') {
    const key = candidateKey(candidate);
    if (!key) return false;
    const existing = state.candidates.get(key);
    if (existing) {
      if (source === '癫影已解锁' && existing.source !== source) state.candidates.set(key, { ...existing, source });
      return false;
    }
    state.candidates.set(key, { ...candidate, source });
    while (state.candidates.size > MAX_CANDIDATES) state.candidates.delete(state.candidates.keys().next().value);
    return true;
  }

  function updateCandidateUi() {
    if (state.launcher) state.launcher.style.display = state.config.showLauncherAlways || state.candidates.size ? 'flex' : 'none';
    if (state.counter) state.counter.textContent = state.candidates.size ? `已识别 ${state.candidates.size}` : '115';
    if (state.launcherIcon) state.launcherIcon.style.display = state.candidates.size ? 'none' : 'block';
    if (state.launcherDetectedIcon) state.launcherDetectedIcon.style.display = state.candidates.size ? 'inline-flex' : 'none';
    if (state.candidateTitle) state.candidateTitle.style.display = state.candidates.size ? 'block' : 'none';
    if (!state.candidateList) return;
    const candidates = Array.from(state.candidates.values()).slice(-20).reverse();
    state.candidateList.replaceChildren();
    if (!candidates.length) {
      state.candidateList.style.display = 'none';
      if (state.bulkActions) state.bulkActions.style.display = 'none';
      return;
    }
    state.candidateList.style.display = 'grid';
    if (state.bulkActions) {
      state.bulkActions.style.display = 'flex';
      refreshBulkActions();
    }
    for (const candidate of candidates) {
      const meta = el('div', { className: 'd115-candidate-meta' }, [
        el('strong', { text: candidateTypeLabel(candidate) }),
        candidate.source === '癫影已解锁' ? el('span', { className: 'd115-source', text: '癫影已解锁' }) : null,
        el('span', { className: 'd115-candidate-value', text: candidateDisplay(candidate), title: candidate.raw || candidate.url || '' }),
      ]);
      state.candidateList.append(el('div', { className: 'd115-candidate' }, [
        meta,
        button(candidateActionLabel(candidate, true), () => perform(candidate), candidateClass(candidate, true)),
      ]));
    }
  }

  function refreshBulkActions() {
    if (!state.bulkActions) return;
    state.bulkActions.replaceChildren();
    const candidates = Array.from(state.candidates.values());
    if (!candidates.length) {
      state.bulkActions.style.display = 'none';
      return;
    }
    if (state.config.mode === PUSH) {
      if (candidates.some(candidate => candidate.type !== 'cid115')) {
        state.bulkActions.append(button('依次推送全部', () => performAllCandidates(), 'd115-push'));
      }
      return;
    }
    if (candidates.some(candidate => candidate.type === 'share115')) {
      state.bulkActions.append(button('全部转存', () => performAllCandidates('share'), 'd115-share'));
    }
    if (candidates.some(candidate => ['magnet', 'ed2k', 'offlineUrl'].includes(candidate.type))) {
      state.bulkActions.append(button('全部离线', () => performAllCandidates('offline'), 'd115-offline'));
    }
  }

  const UI_CSS = `
    :host{all:initial;color-scheme:light dark;letter-spacing:0}
    *,*::before,*::after{box-sizing:border-box;letter-spacing:0}
    #d115-shell{font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#202124;--surface:#fff;--ink:#202124;--muted:#6b7280;--border:#d7d9dd;--hover:#eceef1;--red:#b42318;--blue:#175cd3;--green:#067647;--danger:#b42318}
    .d115-launcher{position:fixed;z-index:2147483645;right:20px;bottom:20px;display:flex;align-items:center;gap:8px;filter:drop-shadow(0 8px 18px rgba(15,23,42,.18))}
    .d115-btn{min-height:32px;max-width:100%;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink);padding:6px 11px;font:600 12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;white-space:normal;transition:background .15s,border-color .15s,transform .15s}
    .d115-btn:hover{background:var(--hover);transform:translateY(-1px)}.d115-btn:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
    .d115-float{min-height:40px;display:inline-flex;align-items:center;gap:8px;border:0;border-radius:12px;background:linear-gradient(135deg,#2563eb,#0f766e);color:#fff;padding:8px 14px;font-size:13px;box-shadow:0 8px 18px rgba(37,99,235,.28)}
    .d115-float img{display:block;border-radius:4px;background:#fff}.d115-detected-icon{display:none;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:#dcfce7;color:#047857;font-size:13px;font-weight:800}
    .d115-panel{position:fixed;z-index:2147483646;right:20px;bottom:72px;width:min(480px,calc(100vw - 36px));max-height:calc(100vh - 96px);overflow:auto;border:1px solid rgba(148,163,184,.35);border-radius:16px;background:var(--surface);color:var(--ink);box-shadow:0 22px 60px rgba(15,23,42,.24);padding:18px}
    .d115-header,.d115-tabs,.d115-actions,.d115-bulk-actions,.d115-segment,.d115-target,.d115-picker-footer,.d115-candidate{display:flex;align-items:center;gap:8px}
    .d115-header{min-height:38px;margin-bottom:10px}.d115-header strong{font-size:17px}.d115-version{color:var(--muted);font-size:11px}.d115-close{margin-left:auto;width:30px;padding:4px;border-radius:50%}
    .d115-tabs{border-bottom:1px solid var(--border);margin-bottom:14px}.d115-tabs .d115-btn{border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--muted)}.d115-tabs .d115-active{border-bottom-color:var(--blue);color:var(--blue)}
    .d115-form{display:grid;gap:11px}.d115-field{display:grid;gap:5px;color:var(--muted);font-size:12px}.d115-field small{font-size:11px;color:var(--muted);line-height:1.45}.d115-toggle{display:flex;align-items:flex-start;gap:7px;color:var(--muted);font-size:12px}.d115-toggle input{margin-top:2px}
    .d115-setting-label{color:var(--muted);font-size:12px}.d115-project-link{width:max-content;color:var(--blue);font:600 12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;text-decoration:none}.d115-project-link:hover{text-decoration:underline}
    .d115-segment{padding:3px;border:1px solid var(--border);border-radius:10px;background:rgba(148,163,184,.08)}.d115-segment .d115-btn{flex:1;border:0;background:transparent;color:var(--muted)}.d115-segment .d115-active{background:var(--surface);color:var(--blue);box-shadow:0 1px 4px rgba(15,23,42,.12)}
    .d115-field input,.d115-field textarea{width:100%;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink);padding:9px;font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
    .d115-field textarea{min-height:72px;resize:vertical}.d115-field input:focus,.d115-field textarea:focus{outline:2px solid rgba(23,92,211,.22);border-color:var(--blue)}
    .d115-target{justify-content:space-between;flex-wrap:wrap;border:1px solid var(--border);border-radius:10px;padding:10px;font-size:12px;background:rgba(148,163,184,.06)}
    .d115-actions,.d115-bulk-actions{flex-wrap:wrap;margin-top:12px}.d115-bulk-actions{justify-content:flex-end;margin-top:8px}.d115-share{border-color:var(--red);color:var(--red)}.d115-offline{border-color:var(--green);color:var(--green)}.d115-push{border-color:var(--blue);color:var(--blue)}
    .d115-status{margin-top:10px;white-space:pre-wrap;overflow-wrap:anywhere}.d115-info{color:var(--blue)}.d115-success{color:var(--green)}.d115-error{color:var(--danger)}
    .d115-candidate-title{margin:14px 0 4px;padding-top:10px;border-top:1px solid var(--border);font-weight:700}.d115-candidate-list{display:grid}
    .d115-candidate{justify-content:space-between;min-width:0;border-bottom:1px solid var(--border);padding:8px 0}.d115-candidate:last-child{border-bottom:0}.d115-candidate-meta{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}.d115-candidate-value{width:100%;color:var(--muted);font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.d115-source{border-radius:999px;background:#eaf2ff;color:var(--blue);padding:1px 6px;font-size:10px}
    .d115-overlay{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(0,0,0,.48);padding:18px}.d115-picker{width:min(580px,100%);max-height:82vh;overflow:auto;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink);box-shadow:0 18px 48px rgba(0,0,0,.3);padding:14px}.d115-picker-title{font-weight:700;margin-bottom:8px}.d115-picker-path{display:flex;align-items:center;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:8px}.d115-crumb{padding:3px 6px;min-height:26px}.d115-separator{color:var(--muted)}
    .d115-picker-list,.d115-share-list{display:grid;max-height:55vh;overflow:auto}.d115-dir,.d115-share-row{display:flex;align-items:flex-start;gap:8px;border-bottom:1px solid var(--border);padding:7px 2px}.d115-dir:last-child,.d115-share-row:last-child{border-bottom:0}.d115-dir-name{min-width:0;overflow-wrap:anywhere}.d115-picker-footer{justify-content:flex-end;flex-wrap:wrap;margin-top:12px}.d115-empty{padding:12px 2px;color:var(--muted)}
    .d115-subscription-modal{width:min(680px,100%);padding:16px}.d115-subscription-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.d115-subscription-hint{display:block;color:var(--muted);font-size:11px}.d115-subscription-toolbar{display:flex;align-items:center;min-height:28px;margin-top:8px;color:var(--muted);font-size:12px}.d115-subscription-list{display:grid;max-height:58vh;overflow:auto;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}.d115-subscription-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 2px;border-bottom:1px solid var(--border)}.d115-subscription-row:last-child{border-bottom:0}.d115-subscription-meta{display:grid;min-width:0}.d115-subscription-meta strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.d115-subscription-actions{display:flex;align-items:center;gap:6px;flex:none}.d115-tmdb-link,.d115-hdhive-link{flex:none;color:var(--blue);text-decoration:none}.d115-subscription-unavailable{flex:none;color:var(--muted);font-size:11px}
    @media (prefers-color-scheme:dark){#d115-shell{--surface:#1d1e20;--ink:#f1f2f3;--muted:#a5a8ad;--border:#45484d;--hover:#303236;--red:#ff8a80;--blue:#8ab4f8;--green:#75d6a3;--danger:#ff8a80}.d115-float{background:linear-gradient(135deg,#3b82f6,#0f766e);color:#fff}.d115-source{background:#263a59}}
    @media (max-width:520px){.d115-launcher{right:10px;bottom:10px}.d115-panel{right:10px;bottom:56px;width:calc(100vw - 20px);max-height:calc(100vh - 76px)}.d115-subscription-row{align-items:flex-start;flex-direction:column}.d115-subscription-meta strong{white-space:normal;overflow-wrap:anywhere}}
  `;

  function ensureUiRoot() {
    if (state.uiRoot) {
      if (!state.rootHost?.isConnected) document.documentElement.append(state.rootHost);
      return state.uiRoot;
    }
    const host = el('div', { id: 'd115-helper-host' });
    const shadow = host.attachShadow({ mode: 'closed' });
    const shell = el('div', { id: 'd115-shell' });
    const launcher = el('div', { className: 'd115-launcher' });
    const launcherButton = button('设置', () => openPanel(), 'd115-float', '打开设置和已识别链接');
    launcherButton.textContent = '';
    const icon = el('img', { src: ICON_URL, alt: '', width: 18, height: 18, referrerpolicy: 'no-referrer' });
    const detectedIcon = el('span', { className: 'd115-detected-icon', text: '✓', 'aria-hidden': 'true' });
    const label = el('span', { text: '设置' });
    launcherButton.append(icon, detectedIcon, label);
    launcher.append(launcherButton);
    shell.append(launcher);
    shadow.append(el('style', { text: UI_CSS }), shell);
    document.documentElement.append(host);
    state.rootHost = host;
    state.uiRoot = shell;
    state.counter = label;
    state.launcher = launcher;
    state.launcherButton = launcherButton;
    state.launcherIcon = icon;
    state.launcherDetectedIcon = detectedIcon;
    state.launcherLabel = label;
    launcher.style.display = 'none';
    return shell;
  }

  function ensurePanel() {
    if (state.panel) return state.panel;
    const panel = el('section', { className: 'd115-panel', role: 'dialog', 'aria-label': '115 转存离线助手' });
    const header = el('header', { className: 'd115-header' }, [
      el('strong', { text: '115 转存离线助手' }),
      el('span', { className: 'd115-version', text: `v${VERSION}` }),
      button('×', () => closePanel(), 'd115-close', '关闭'),
    ]);
    const tabs = el('div', { className: 'd115-tabs' });
    const directTab = button('115 直连', () => setMode(DIRECT));
    const pushTab = button('外部推送', () => setMode(PUSH));
    tabs.append(directTab, pushTab);
    const form = el('div', { className: 'd115-form' });
    const actions = el('div', { className: 'd115-actions' });
    const status = el('div', { className: 'd115-status d115-info', text: '就绪' });
    const candidateTitle = el('div', { className: 'd115-candidate-title', text: '已识别链接' });
    const bulkActions = el('div', { className: 'd115-bulk-actions' });
    const candidateList = el('div', { className: 'd115-candidate-list' });
    panel.append(header, tabs, form, actions, status, candidateTitle, bulkActions, candidateList);
    state.status = status;
    state.candidateList = candidateList;
    state.candidateTitle = candidateTitle;
    state.bulkActions = bulkActions;

    state.renderPanel = () => {
      form.replaceChildren();
      actions.replaceChildren();
      directTab.classList.toggle('d115-active', state.config.mode === DIRECT);
      pushTab.classList.toggle('d115-active', state.config.mode === PUSH);
      let identifyButton = null;
      const inputField = addField(form, '待处理内容（可选）', state.manualInput, 'text', value => {
        state.manualInput = value;
        if (identifyButton) identifyButton.style.display = text(value) ? '' : 'none';
      });
      inputField.parentElement.append(el('small', { text: '可一次粘贴多个 115 分享、磁力、ED2K 或 HTTP(S) 离线地址；115CID 仅用于指定保存目录。' }));
      identifyButton = button('识别并加入', () => {
        const candidates = extractManualCandidates(state.manualInput);
        const single = candidates.length ? candidates : [parseManualCandidate(state.manualInput)].filter(Boolean);
        if (!single.length) throw new Error('没有识别到有效的转存或离线地址');
        single.forEach(candidate => rememberCandidate(candidate, '手动输入'));
        updateCandidateUi();
        setStatus(`已加入 ${single.length} 条内容`, 'success');
      });
      identifyButton.style.display = text(state.manualInput) ? '' : 'none';
      actions.append(identifyButton);
      if (state.config.mode === DIRECT) {
        const cookieInput = addField(form, '115 Cookie', state.config.cookie, state.revealCookie ? 'text' : 'password', value => { state.config.cookie = value; saveConfig(); });
        actions.append(button(state.revealCookie ? '隐藏 Cookie' : '显示 Cookie', () => {
          state.revealCookie = !state.revealCookie;
          cookieInput.type = state.revealCookie ? 'text' : 'password';
          state.renderPanel();
        }));
        const targetText = el('span', {
          text: state.config.targetCid !== ''
            ? `目标：${state.config.targetName || '目录'}（CID ${state.config.targetCid}）`
            : '尚未选择转存/离线目录',
        });
        form.append(el('div', { className: 'd115-target' }, [
          targetText,
          button('浏览并选择', () => openPicker(targetText)),
        ]));
        actions.append(button('测试目录连接', async () => {
          if (!normalizedCookie()) throw new Error('请先填写 Cookie');
          const dirs = await list115Dirs('0');
          setStatus(`连接成功，根目录有 ${dirs.length} 个目录`, 'success');
        }));
      } else {
        addField(form, 'DIAN115 地址', state.config.dian115Base, 'url', value => { state.config.dian115Base = value; saveConfig(); });
        addField(form, 'OpenAPI Key', state.config.openApiKey, 'password', value => { state.config.openApiKey = value; saveConfig(); });
        form.append(el('a', {
          className: 'd115-project-link',
          href: 'https://github.com/madbrolab/dian115',
          target: '_blank',
          rel: 'noopener noreferrer',
          text: 'DIAN115 GitHub',
        }));
        actions.append(button('校验配置格式', () => {
          validatePushConfig();
          setStatus('配置格式有效；实际可用性会在推送时验证', 'success');
        }, 'd115-push'));
        actions.append(button('DIAN115 订阅列表', () => openSubscriptionModal(), 'd115-push'));
      }
      const displayLabel = el('span', { className: 'd115-setting-label', text: '页面入口显示' });
      const displayMode = el('div', { className: 'd115-segment' });
      const showDetected = button('识别到内容时', () => {
        state.config.showLauncherAlways = false;
        saveConfig();
        state.renderPanel();
      });
      const showAlways = button('始终显示', () => {
        state.config.showLauncherAlways = true;
        saveConfig();
        state.renderPanel();
      });
      showDetected.classList.toggle('d115-active', !state.config.showLauncherAlways);
      showAlways.classList.toggle('d115-active', state.config.showLauncherAlways);
      displayMode.append(showDetected, showAlways);
      form.append(displayLabel, displayMode);
      bulkActions.replaceChildren();
      updateCandidateUi();
    };

    ensureUiRoot().append(panel);
    state.panel = panel;
    state.renderPanel();
    return panel;
  }

  function setMode(mode) {
    state.config.mode = mode;
    saveConfig();
    ensurePanel();
    state.renderPanel();
  }

  function openPanel(candidate) {
    state.activeCandidate = candidate || null;
    state.open = true;
    const panel = ensurePanel();
    panel.style.display = 'block';
    updateCandidateUi();
    if (candidate) setStatus(`已选择 ${candidateTypeLabel(candidate)}`, 'info');
  }

  function closePanel() {
    if (state.panel) state.panel.style.display = 'none';
    state.open = false;
  }

  function openSubscriptionModal() {
    if (state.subscriptionOverlay?.isConnected) return;
    const overlay = el('div', { className: 'd115-overlay' });
    const box = el('div', { className: 'd115-picker d115-subscription-modal', role: 'dialog', 'aria-label': 'DIAN115 订阅列表' });
    const header = el('div', { className: 'd115-subscription-header' }, [
      el('div', {}, [
        el('div', { className: 'd115-picker-title', text: 'DIAN115 订阅列表' }),
        el('small', { className: 'd115-subscription-hint', text: '读取服务端当前订阅；每条记录可跳转影巢对应媒体页。' }),
      ]),
      button('×', () => close(), 'd115-close', '关闭订阅列表'),
    ]);
    const toolbar = el('div', { className: 'd115-subscription-toolbar' });
    const list = el('div', { className: 'd115-subscription-list' });
    const footer = el('div', { className: 'd115-picker-footer' });
    box.append(header, toolbar, list, footer);
    overlay.append(box);
    ensureUiRoot().append(overlay);
    state.subscriptionOverlay = overlay;
    let offset = 0;
    const pageSize = 100;
    const close = () => {
      overlay.remove();
      if (state.subscriptionOverlay === overlay) state.subscriptionOverlay = null;
    };
    overlay.addEventListener('click', event => {
      if (event.target === overlay) close();
    });
    const render = async () => {
      toolbar.replaceChildren();
      list.replaceChildren(el('div', { className: 'd115-empty', text: '正在读取订阅列表…' }));
      footer.replaceChildren();
      try {
        const result = await listDian115Subscriptions({ limit: pageSize, offset });
        list.replaceChildren();
        if (!result.items.length) {
          list.append(el('div', { className: 'd115-empty', text: offset ? '没有更多订阅' : '暂无订阅记录' }));
        }
        const uniqueItems = [];
        const seenMedia = new Set();
        result.items.forEach(item => {
          const tmdbId = Number(item?.tmdb_id ?? item?.tmdbId);
          const mediaType = text(item?.media_type || item?.mediaType).toLowerCase();
          const identity = `${mediaType}:${tmdbId}`;
          if (seenMedia.has(identity)) return;
          seenMedia.add(identity);
          uniqueItems.push(item);
        });
        uniqueItems.forEach(item => {
          const tmdbId = Number(item?.tmdb_id ?? item?.tmdbId);
          const mediaType = text(item?.media_type || item?.mediaType).toLowerCase();
          const title = first(item?.title, item?.name, tmdbId > 0 ? `TMDB ${tmdbId}` : '未命名订阅');
          const displayTitle = item?.year ? `${title}（${String(item.year)}）` : title;
          const hdhiveUrl = buildHdhiveUrl(item);
          const tmdbUrl = buildTmdbUrl(item);
          const actions = el('div', { className: 'd115-subscription-actions' });
          if (tmdbUrl) actions.append(el('a', { className: 'd115-btn d115-tmdb-link', href: tmdbUrl, target: '_blank', rel: 'noopener noreferrer', text: '跳转 TMDB' }));
          if (hdhiveUrl) actions.append(el('a', { className: 'd115-btn d115-hdhive-link', href: hdhiveUrl, target: '_blank', rel: 'noopener noreferrer', text: '跳转影巢' }));
          if (!actions.children.length) actions.append(el('span', { className: 'd115-subscription-unavailable', text: '缺少媒体信息' }));
          list.append(el('div', { className: 'd115-subscription-row' }, [
            el('div', { className: 'd115-subscription-meta' }, [
              el('strong', { text: displayTitle, title: displayTitle }),
            ]),
            actions,
          ]));
        });
        const total = result.total;
        const pageStart = total ? offset + 1 : 0;
        const pageEnd = Math.min(offset + result.items.length, total);
        toolbar.append(el('span', { className: 'd115-subscription-count', text: `共 ${total} 条，显示 ${pageStart}-${pageEnd}` }));
        if (offset > 0) footer.append(button('上一页', () => { offset = Math.max(0, offset - pageSize); render(); }));
        if (result.hasMore) footer.append(button('下一页', () => { offset += pageSize; render(); }));
        footer.append(button('关闭', close));
      } catch (error) {
        list.replaceChildren(el('div', { className: 'd115-error', text: error.message || '订阅列表读取失败' }));
        footer.append(button('重试', render, 'd115-push'), button('关闭', close));
      }
    };
    render();
  }

  function setTargetCid(cid, name) {
    state.config.targetCid = String(cid);
    state.config.targetName = String(name || `CID ${cid}`);
    saveConfig();
    if (state.renderPanel) state.renderPanel();
    setStatus(`目标目录已设为 ${state.config.targetName}（CID ${state.config.targetCid}）`, 'success');
  }

  function openPicker(targetText) {
    return new Promise(resolve => {
      const overlay = el('div', { className: 'd115-overlay' });
      const box = el('div', { className: 'd115-picker' });
      const path = el('div', { className: 'd115-picker-path' });
      const list = el('div', { className: 'd115-picker-list', text: '读取中...' });
      const footer = el('div', { className: 'd115-picker-footer' });
      const stack = [{ cid: '0', name: '根目录' }];
      const current = () => stack[stack.length - 1];
      const close = result => { overlay.remove(); resolve(result); };
      const choose = button('选择当前目录', () => {
        const node = current();
        setTargetCid(node.cid, node.name);
        targetText.textContent = `目标：${node.name}（CID ${node.cid}）`;
        close(true);
      }, 'd115-share');
      footer.append(button('取消', () => close(false)), choose);
      box.append(el('div', { className: 'd115-picker-title', text: '选择 115 目标目录' }), path, list, footer);
      overlay.append(box);
      ensureUiRoot().append(overlay);

      const renderPath = load => {
        path.replaceChildren();
        stack.forEach((node, index) => {
          if (index) path.append(el('span', { className: 'd115-separator', text: '/' }));
          path.append(button(node.name, () => {
            stack.splice(index + 1);
            load();
          }, 'd115-crumb', `CID ${node.cid}`));
        });
      };
      const load = async () => {
        renderPath(load);
        list.replaceChildren(el('div', { className: 'd115-empty', text: '读取中...' }));
        try {
          const dirs = await list115Dirs(current().cid);
          list.replaceChildren();
          if (stack.length > 1) {
            list.append(el('div', { className: 'd115-dir' }, [
              button('返回上级', () => { stack.pop(); load(); }),
            ]));
          }
          if (!dirs.length) list.append(el('div', { className: 'd115-empty', text: '此目录没有子目录' }));
          dirs.forEach(dir => {
            list.append(el('div', { className: 'd115-dir' }, [
              button('进入', () => { stack.push({ cid: dir.cid, name: dir.name }); load(); }),
              el('span', { className: 'd115-dir-name', text: dir.name, title: `CID ${dir.cid}` }),
            ]));
          });
        } catch (error) {
          list.replaceChildren(el('div', { className: 'd115-error', text: error.message || '目录读取失败' }));
        }
      };
      load();
    });
  }

  function chooseShareFiles(rows) {
    return new Promise(resolve => {
      const overlay = el('div', { className: 'd115-overlay' });
      const box = el('div', { className: 'd115-picker' });
      const list = el('div', { className: 'd115-share-list' });
      const checks = [];
      rows.forEach(row => {
        const input = el('input', { type: 'checkbox' });
        input.checked = true;
        checks.push([input, row.id]);
        list.append(el('label', { className: 'd115-share-row' }, [
          input,
          el('span', { text: `${row.isDir ? '[目录]' : '[文件]'} ${row.name}` }),
        ]));
      });
      const footer = el('div', { className: 'd115-picker-footer' });
      footer.append(
        button('取消', () => { overlay.remove(); resolve(null); }),
        button('转存勾选项', () => {
          const ids = checks.filter(([input]) => input.checked).map(([, id]) => id);
          overlay.remove();
          resolve(ids);
        }, 'd115-share'),
      );
      box.append(el('div', { className: 'd115-picker-title', text: `选择分享内容（${rows.length} 项）` }), list, footer);
      overlay.append(box);
      ensureUiRoot().append(overlay);
    });
  }

  async function perform(candidate, options = {}) {
    const bulk = options.bulk === true;
    if (!bulk) openPanel(candidate);
    try {
      if (candidate.type === 'cid115') {
        setTargetCid(candidate.cid, `CID ${candidate.cid}`);
        return { ok: true };
      }
      if (state.config.mode === PUSH) {
        if (!bulk) setStatus('正在提交 DIAN115 外部推送...', 'info');
        const result = await pushExternal(candidate, !bulk);
        if (!bulk) setStatus(`推送${result.status === 'succeeded' ? '完成' : '已受理'}：${result.request_id || result.status || 'ok'}`, 'success');
        return { ok: true, result };
      }
      if (!normalizedCookie()) throw new Error('请先在面板填写 115 Cookie');
      if (state.config.targetCid === '') throw new Error('请先选择转存/离线目录');
      if (candidate.type === 'magnet' || candidate.type === 'ed2k' || candidate.type === 'offlineUrl') {
        if (!bulk) setStatus('正在提交离线任务...', 'info');
        try { await p115Offline([candidate.url], state.config.targetCid); }
        catch (error) {
          if (error?.networkFailure) throw new Error('离线请求的结果不确定，请先到 115 核对，勿立即重试');
          throw error;
        }
        if (!bulk) setStatus('离线任务已提交', 'success');
        return { ok: true };
      }
      if (candidate.type !== 'share115') throw new Error('此内容不是可转存的 115 分享');
      if (!bulk) setStatus('正在读取分享文件列表...', 'info');
      const rows = await listShareFiles(candidate);
      if (!rows.length) throw new Error('分享中没有可转存的文件或目录');
      const ids = bulk ? rows.map(row => row.id) : await chooseShareFiles(rows);
      if (ids === null) { setStatus('已取消转存', 'info'); return; }
      if (!ids.length) throw new Error('请至少选择一项分享内容');
      if (!bulk) setStatus(`正在一次性提交 ${ids.length} 项转存...`, 'info');
      await receiveShare(candidate, ids, state.config.targetCid);
      if (!bulk) setStatus('115 分享转存已提交', 'success');
      return { ok: true };
    } catch (error) {
      if (!bulk) setStatus(error.message || '操作失败', 'error');
      return { ok: false, error };
    }
  }

  async function performAllCandidates(filter = '') {
    if (state.bulkRunning) throw new Error('批量任务正在执行，请稍候');
    const candidates = Array.from(state.candidates.values()).filter(candidate => {
      if (candidate.type === 'cid115') return false;
      if (filter === 'share') return candidate.type === 'share115';
      if (filter === 'offline') return ['magnet', 'ed2k', 'offlineUrl'].includes(candidate.type);
      return true;
    });
    if (!candidates.length) throw new Error('没有可处理的链接');
    openPanel();
    state.bulkRunning = true;
    let succeeded = 0;
    let failed = 0;
    try {
      for (let index = 0; index < candidates.length; index += 1) {
        setStatus(`正在处理 ${index + 1}/${candidates.length}：${candidateTypeLabel(candidates[index])}`, 'info');
        const result = await perform(candidates[index], { bulk: true });
        if (result?.ok) succeeded += 1;
        else failed += 1;
        if (index < candidates.length - 1) await sleep(500);
      }
    } finally {
      state.bulkRunning = false;
    }
    setStatus(`全部处理完成：成功 ${succeeded}，失败 ${failed}`, failed ? 'error' : 'success');
  }

  const INLINE_CSS = `
    :host{all:initial;display:inline-flex;margin-left:6px;vertical-align:middle;letter-spacing:0}
    button{min-height:24px;border:1px solid #777;border-radius:5px;background:#fff;color:#222;padding:2px 7px;font:600 11px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;letter-spacing:0}
    button:hover{background:#f0f1f2}button:focus-visible{outline:2px solid #175cd3;outline-offset:2px}
    .share{border-color:#b42318;color:#b42318}.offline{border-color:#067647;color:#067647}
    @media(prefers-color-scheme:dark){button{background:#242628;color:#f1f2f3;border-color:#777}.share{color:#ff8a80;border-color:#ff8a80}.offline{color:#75d6a3;border-color:#75d6a3}}
  `;

  function isVisibleNode(node) {
    if (!(node instanceof Element) || !node.isConnected || node.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0;
  }

  function collectVisibleResourceValues(node) {
    if (!isVisibleNode(node)) return [];
    return [
      node.getAttribute('href'),
      node.getAttribute('data-href'),
      node.getAttribute('data-url'),
      node.getAttribute('data-clipboard-text'),
      node.getAttribute('data-copy'),
      node.getAttribute('data-copy-text'),
      node.getAttribute('title'),
      'value' in node ? node.value : '',
      node.textContent,
    ].filter(Boolean);
  }

  function rectsOverlap(a, b, padding = 0) {
    return a.left < b.right + padding
      && a.right > b.left - padding
      && a.top < b.bottom + padding
      && a.bottom > b.top - padding;
  }

  function rectInsideViewport(rect, width, height, margin = VIEWPORT_MARGIN) {
    return rect.left >= margin
      && rect.top >= margin
      && rect.right <= width - margin
      && rect.bottom <= height - margin;
  }

  function rectOverlapArea(a, b, padding = 0) {
    const width = Math.max(0, Math.min(a.right, b.right + padding) - Math.max(a.left, b.left - padding));
    const height = Math.max(0, Math.min(a.bottom, b.bottom + padding) - Math.max(a.top, b.top - padding));
    return width * height;
  }

  function actionPlacementCandidates(anchorRect, actionWidth, actionHeight, viewportWidth, viewportHeight) {
    const centerX = anchorRect.left + anchorRect.width / 2;
    const centerY = anchorRect.top + anchorRect.height / 2;
    return [
      { name: 'right', left: anchorRect.right + ACTION_GAP, top: centerY - actionHeight / 2 },
      { name: 'left', left: anchorRect.left - actionWidth - ACTION_GAP, top: centerY - actionHeight / 2 },
      { name: 'below', left: centerX - actionWidth / 2, top: anchorRect.bottom + ACTION_GAP },
      { name: 'above', left: centerX - actionWidth / 2, top: anchorRect.top - actionHeight - ACTION_GAP },
      { name: 'right-aligned', left: viewportWidth - actionWidth - VIEWPORT_MARGIN, top: centerY - actionHeight / 2 },
      { name: 'left-aligned', left: VIEWPORT_MARGIN, top: centerY - actionHeight / 2 },
      { name: 'below-right', left: anchorRect.right - actionWidth, top: anchorRect.bottom + ACTION_GAP },
      { name: 'above-right', left: anchorRect.right - actionWidth, top: anchorRect.top - actionHeight - ACTION_GAP },
    ].map(candidate => ({
      ...candidate,
      left: Math.max(VIEWPORT_MARGIN, Math.min(viewportWidth - actionWidth - VIEWPORT_MARGIN, candidate.left)),
      top: Math.max(VIEWPORT_MARGIN, Math.min(viewportHeight - actionHeight - VIEWPORT_MARGIN, candidate.top)),
    })).map(candidate => ({
      ...candidate,
      right: candidate.left + actionWidth,
      bottom: candidate.top + actionHeight,
    }));
  }

  function chooseActionPlacement(anchorRect, actionWidth, actionHeight, viewportWidth, viewportHeight, occupied = []) {
    const candidates = actionPlacementCandidates(anchorRect, actionWidth, actionHeight, viewportWidth, viewportHeight);
    const valid = candidates.filter(candidate => rectInsideViewport(candidate, viewportWidth, viewportHeight));
    const collisionFree = valid.find(candidate => !occupied.some(rect => rectsOverlap(candidate, rect, 3)));
    if (collisionFree) return { ...collisionFree, fallback: false };
    const fallbackCandidates = valid.length ? valid : candidates;
    return fallbackCandidates
      .map((candidate, index) => ({
        ...candidate,
        fallback: true,
        score: occupied.reduce((sum, rect) => sum + rectOverlapArea(candidate, rect, 3), 0),
        index,
      }))
      .sort((a, b) => a.score - b.score || a.index - b.index)[0];
  }

  function visibleInteractiveRects(excludeEntry) {
    if (!document.querySelectorAll) return [];
    const selector = 'a,button,input,textarea,select,[role="button"],[role="link"],[tabindex]';
    const rects = [];
    document.querySelectorAll(selector).forEach(node => {
      if (!(node instanceof Element) || node === excludeEntry?.host || node.closest('#d115-helper-host,[data-d115-action-host]')) return;
      if (!isVisibleNode(node)) return;
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) rects.push(rect);
    });
    return rects;
  }

  function syncActionPositions() {
    state.positionFrame = 0;
    const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const interactiveRects = visibleInteractiveRects();
    const occupied = interactiveRects.slice();
    state.actionEntries = state.actionEntries.filter(entry => {
      if (!entry.host.isConnected || !state.candidates.has(entry.key)) {
        entry.actionHost.remove();
        return false;
      }
      const rect = entry.host.getBoundingClientRect();
      const visible = isVisibleNode(entry.host)
        && rect.bottom >= 0 && rect.top <= window.innerHeight
        && rect.right >= 0 && rect.left <= window.innerWidth;
      if (!visible) {
        entry.actionHost.style.display = 'none';
        return true;
      }
      // Measure the shadow host before choosing a side. Native site controls
      // are treated as occupied rectangles, so a nearby "打开"/"复制" button
      // cannot be covered by the helper action.
      entry.actionHost.style.display = 'inline-flex';
      entry.actionHost.style.visibility = 'hidden';
      entry.actionHost.style.left = '0px';
      entry.actionHost.style.top = '0px';
      const measured = entry.actionHost.getBoundingClientRect();
      const actionWidth = Math.max(24, measured.width || 72);
      const actionHeight = Math.max(24, measured.height || 28);
      const placement = chooseActionPlacement(rect, actionWidth, actionHeight, viewportWidth, viewportHeight, occupied);
      entry.actionHost.style.visibility = 'visible';
      entry.actionHost.style.left = `${Math.round(placement.left)}px`;
      entry.actionHost.style.top = `${Math.round(placement.top)}px`;
      occupied.push(placement);
      return true;
    });
  }

  function scheduleActionPositions() {
    if (state.positionFrame) return;
    if (typeof window.requestAnimationFrame === 'function') state.positionFrame = window.requestAnimationFrame(syncActionPositions);
    else state.positionFrame = window.setTimeout(syncActionPositions, 0);
  }

  function addActionButton(host, candidate) {
    if (!(host instanceof Element) || host === document.body || host === document.documentElement) return;
    if (host.id === 'd115-helper-host' || host.closest('[data-d115-action-host]')) return;
    const key = candidateKey(candidate);
    let keys = state.boundHosts.get(host);
    if (!keys) { keys = new Set(); state.boundHosts.set(host, keys); }
    if (keys.has(key)) return;
    keys.add(key);
    const actionHost = el('span', {
      'data-d115-action-host': '1',
      style: {
        position: 'fixed',
        zIndex: '2147483644',
        transform: 'none',
        margin: '0',
      },
    });
    const shadow = actionHost.attachShadow({ mode: 'closed' });
    const className = candidate.type === 'share115' ? 'share' : (candidate.type === 'cid115' ? '' : 'offline');
    const action = el('button', { type: 'button', className, text: candidateActionLabel(candidate) });
    action.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      perform(candidate);
    });
    shadow.append(el('style', { text: INLINE_CSS }), action);
    document.documentElement.append(actionHost);
    state.actionEntries.push({ host, actionHost, key });
    scheduleActionPositions();
  }

  function scanPage() {
    if (!state.config.autoScan || !document.body) return;
    let scannedChars = 0;
    let scannedTextNodes = 0;
    const pageKeys = new Set();
    const addressKeys = new Set();
    // The current browser URL is a valid discovery source even when the page
    // body contains no anchor or text node for the share link.
    extractCandidates(location.href).forEach(candidate => {
      const key = candidateKey(candidate);
      if (!key) return;
      addressKeys.add(key);
      rememberCandidate(candidate, '地址栏');
    });
    const register = (host, candidate) => {
      if (!candidate || candidate.type === 'cid115') return;
      pageKeys.add(candidateKey(candidate));
      rememberCandidate(candidate, '页面');
      addActionButton(host, candidate);
    };
    Array.from(document.querySelectorAll('a[href]')).slice(0, 600).forEach(anchor => {
      if (!isVisibleNode(anchor)) return;
      const candidate = parseCandidate(anchor.href) || extractCandidates(anchor.textContent || '')[0];
      register(anchor, candidate);
    });
    const valueSelector = '[data-href],[data-url],[data-clipboard-text],[data-copy],[data-copy-text],input,textarea,button,[role="button"]';
    Array.from(document.querySelectorAll(valueSelector)).slice(0, 800).forEach(resource => {
      collectVisibleResourceValues(resource).forEach(value => {
        extractCandidates(value).forEach(candidate => register(resource, candidate));
      });
    });
    const specialSelector = 'code,pre,[data-resource-link],[class*="resource-link"],[class*="share-link"],[class*="offline-link"]';
    Array.from(document.querySelectorAll(specialSelector)).slice(0, 250).forEach(node => {
      if (!isVisibleNode(node)) return;
      extractCandidates(node.textContent || '').forEach(candidate => register(node, candidate));
    });
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue || node.nodeValue.length < 6) return NodeFilter.FILTER_REJECT;
        if (parent.getClientRects().length === 0) return NodeFilter.FILTER_REJECT;
        if (parent.closest('script,style,noscript,textarea,input,select,button,a,code,pre,#d115-helper-host,[data-d115-action-host]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode()) && scannedTextNodes < MAX_SCAN_TEXT_NODES && scannedChars < MAX_SCAN_CHARS) {
      scannedTextNodes += 1;
      scannedChars += node.nodeValue.length;
      extractCandidates(node.nodeValue).forEach(candidate => register(node.parentElement, candidate));
    }
    for (const [key, candidate] of state.candidates) {
      if (candidate.source === '页面' && !pageKeys.has(key)) state.candidates.delete(key);
      if (candidate.source === '地址栏' && !addressKeys.has(key)) state.candidates.delete(key);
    }
    updateCandidateUi();
    scheduleActionPositions();
  }

  function scheduleScan() {
    window.clearTimeout(state.scanTimer);
    state.scanTimer = window.setTimeout(scanPage, 350);
  }

  function boot() {
    if (!document.body) return;
    ensureUiRoot();
    scanPage();
    const observer = new MutationObserver(() => {
      scheduleScan();
      scheduleActionPositions();
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    window.addEventListener('scroll', scheduleActionPositions, true);
    window.addEventListener('resize', scheduleActionPositions);
    window.addEventListener('popstate', scheduleScan);
    window.addEventListener('hashchange', scheduleScan);
    // SPA sites often change the address bar without rebuilding the whole
    // document. Rescan after history API navigation so a new 115 share URL is
    // recognized and the previous address-bar candidate is removed.
    if (window.history && !window.history.__d115Wrapped) {
      try {
        const history = window.history;
        const pushState = history.pushState;
        const replaceState = history.replaceState;
        history.pushState = function (...args) {
          const result = Reflect.apply(pushState, this, args);
          scheduleScan();
          return result;
        };
        history.replaceState = function (...args) {
          const result = Reflect.apply(replaceState, this, args);
          scheduleScan();
          return result;
        };
        Object.defineProperty(history, '__d115Wrapped', { value: true, configurable: false });
      } catch (_) { /* Some pages expose a non-writable History object. */ }
    }
    GM_registerMenuCommand('打开 115 转存离线助手', () => openPanel());
  }

  installDianyingCapture();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  // Black-box tests can inspect pure helpers; credentials and network handles
  // are never exposed in normal operation.
  if (typeof globalThis !== 'undefined' && globalThis.__D115_TEST__) {
    globalThis.__D115_TEST_API__ = {
      parse115Share,
      parse115Cid,
      canonicalOffline,
      canonicalOfflineAddress,
      extractManualCandidates,
      extractCandidates,
      extractDianyingCandidates,
      rowIsDir,
      rowName,
      list115Dirs,
      listShareFiles,
      receiveShare,
      p115Offline,
      listDian115Subscriptions,
      buildHdhiveUrl,
      buildTmdbUrl,
      rectsOverlap,
      chooseActionPlacement,
    };
  }
})();
