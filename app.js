/* 舞萌DX 点歌页 - 逻辑
 *
 * 数据流：
 *   曲库   ← lxns.net 公共 API（song/list + alias/list），缓存进 localStorage
 *   状态   ← 仓库里的 publishstate.txt（true = 开放点歌）
 *   队列   ← 仓库里的 posts.txt，格式：<难度>:<曲名>，一行一首
 *   凭据   ← config.js 里的 tokenBlob 密文（用 encrypt.html 生成），
 *            提交时才在本机解出口令并用它调 GitHub API；或走 proxy 交给服务端提交
 */
(function () {
  'use strict';

  var CFG = Object.assign({
    owner: '', repo: '', branch: 'main',
    postsPath: 'posts.txt', statePath: 'publishstate.txt',
    submitMode: 'blob', proxyUrl: '', tokenBlob: '', passphrase: '',
    songApi: 'https://maimai.lxns.net/api/v0/maimai/song/list',
    aliasApi: 'https://maimai.lxns.net/api/v0/maimai/alias/list',
    cacheHours: 24, refreshSeconds: 60, checkDeletedSongs: true,
    rules: {}, easyBasicBelow: 7, boardLimit: 50,
    defaultDifficulty: 'EXPERT',
  }, window.MAI_CONFIG || {});

  // difficulty.index 是 lxns 的难度序号；宴会场不分标准/DX，公共曲库也没有它的定数
  var DIFFS = [
    { key: 'BASIC', index: 0 },
    { key: 'ADVANCED', index: 1 },
    { key: 'EXPERT', index: 2 },
    { key: 'MASTER', index: 3 },
    { key: 'REMASTER', index: 4 },
    { key: '宴', index: null },
  ];
  var DIFF_BY_KEY = {};
  DIFFS.forEach(function (d) { DIFF_BY_KEY[d.key] = d; });

  /* 被规则拦下时显示的文案（想改口吻直接改这里） */
  var BLOCK_MESSAGES = {
    remaster: '我是萌新！！无法选择！！',   // 选中 Re:Master
    utage: '我是萌新！！无法选择！！',       // 选中 宴：跟 Re:Master 同理
    deleted: '无法选择删除曲！',            // 选中的曲子已被删除
    easy: '太简单了！',                     // BASIC 且定数太低
    tooHard: '太难了！',                    // 定数超过 levelmax.txt 里的上限
  };

  var DEFAULT_EASY_BELOW = 7; // BASIC 定数低于这个值算"太简单"

  /* 本地 file:// 直接双击打开时，浏览器不允许读取同目录的 levelmax.txt / publishstate.txt，
     规则会失效。这种情况必须明说，不能默默不生效。 */
  var FILE_HINT = ' ⚠ 直接用 file:// 双击打开时浏览器读不到同目录的 levelmax.txt / publishstate.txt，规则不会生效；' +
    '本地测试请起个静态服务器（例如 python -m http.server 8000）再访问 localhost。';

  var LS = {
    pass: 'mai.pass',      // sessionStorage：手动输入的解锁口令，只活到标签页关闭
    diff: 'mai.diff',
    lib: 'mai.lib.v1',
    recent: 'mai.recent.v1',
  };

  /* ------------------------------------------------------------------ *
   * 纯函数（不碰 DOM，可在 Node 里单独测试）
   * ------------------------------------------------------------------ */

  /** 归一化：全角转半角、去空白、转小写、片假名折叠成平假名 */
  function normalize(value) {
    var s = String(value == null ? '' : value);
    if (s.normalize) s = s.normalize('NFKC');
    return s.toLowerCase()
      .replace(/[\u30a1-\u30f6]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0x60);
      })
      .replace(/[\s\u3000]+/g, '');
  }

  /** 从 GitHub Pages 地址推断仓库；cfg 里显式配置优先 */
  function detectRepo(cfg, loc) {
    var out = { owner: cfg.owner || '', repo: cfg.repo || '', branch: cfg.branch || 'main' };
    loc = loc || {};
    var m = /^([^.]+)\.github\.io$/i.exec(loc.hostname || '');
    if (m) {
      var seg = String(loc.pathname || '').split('/').filter(Boolean)[0] || '';
      if (!out.owner) out.owner = m[1];
      if (!out.repo && seg && !/\.html?$/i.test(seg)) out.repo = seg;
    }
    return out;
  }

  /** posts.txt → [{diff, title, raw}]，按第一个冒号切分（曲名里可能有冒号） */
  function parsePosts(text) {
    var rows = [];
    String(text == null ? '' : text).split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      var i = line.indexOf(':');
      if (i < 0) { rows.push({ diff: '', title: line, raw: line }); return; }
      rows.push({ diff: line.slice(0, i).trim(), title: line.slice(i + 1).trim(), raw: line });
    });
    return rows;
  }

  /** 追加一行，统一成 LF 并保证结尾有换行 */
  function appendLine(content, line) {
    var body = String(content == null ? '' : content).replace(/\r\n/g, '\n').replace(/\s+$/, '');
    return (body ? body + '\n' : '') + line + '\n';
  }

  function formatLine(diffKey, title) {
    return diffKey + ':' + String(title == null ? '' : title).trim();
  }

  function samePost(row, diffKey, title) {
    return normalize(row.diff) === normalize(diffKey) && normalize(row.title) === normalize(title);
  }

  /** 取某首歌在指定难度下的谱面（STD / DX），宴会场返回空数组 */
  function chartLevels(song, diffKey) {
    var diff = DIFF_BY_KEY[diffKey];
    if (!song || !diff || diff.index === null) return [];
    var out = [];
    [['STD', song.difficulties && song.difficulties.standard],
     ['DX', song.difficulties && song.difficulties.dx]].forEach(function (pair) {
      var chart = (pair[1] || []).filter(function (c) { return c.difficulty === diff.index; })[0];
      if (chart) {
        out.push({ type: pair[0], level: chart.level, value: chart.level_value, designer: chart.note_designer || '' });
      }
    });
    return out;
  }

  /** BASIC 谱面定数是否全都低于阈值（只要有一条达到阈值，就不算"太简单"） */
  function isTooEasy(song, threshold) {
    var levels = chartLevels(song, 'BASIC');
    if (!levels.length) return false; // 没有 BASIC 谱面时由"缺谱面"提示负责
    var limit = typeof threshold === 'number' ? threshold : DEFAULT_EASY_BELOW;
    return levels.every(function (l) { return typeof l.value === 'number' && l.value < limit; });
  }

  /** 解析 levelmax.txt 的内容
   *  {state:'ok', value:13} / {state:'unset'}（空或不存在=不设上限）
   *  {state:'invalid'}（内容不是数字，拦住并提示，免得静默失效）/ {state:'unknown'}（读不到）
   */
  function parseLevelMax(text) {
    if (text === null || text === undefined) return { state: 'unknown', value: null };
    var raw = String(text).trim();
    if (!raw) return { state: 'unset', value: null };
    var value = Number(raw);
    if (!isFinite(value) || value < 0) return { state: 'invalid', value: null, raw: raw };
    return { state: 'ok', value: value };
  }

  /** 该难度下的谱面定数是否全都超过上限（只要有一张没超，就还有得玩） */
  function isTooHard(song, diffKey, max) {
    if (typeof max !== 'number') return false;
    var levels = chartLevels(song, diffKey);
    if (!levels.length) return false; // 没有谱面时由"缺谱面"提示负责
    return levels.every(function (l) { return typeof l.value === 'number' && l.value > max; });
  }

  /** 规则判定（纯函数，便于穷举测试）：'remaster' | 'utage' | 'deleted' | 'tooHard' | 'easy' | null
   *  - Re:Master：一律不允许
   *  - 宴：跟 Re:Master 同理
   *  - 被删除的曲子：一律不允许（song._deleted 由 findDeletedSongs / disabled 字段标出）
   *  - 定数超过 levelmax.txt 的上限：太难了
   *  - BASIC 且谱面定数全部低于阈值：太简单了
   *  注意：宴会場曲目本身不算删除曲，别误判成 deleted。
   */
  function blockReason(diffKey, song, easyBelow, levelMax) {
    if (diffKey === 'REMASTER') return 'remaster';
    if (diffKey === '宴') return 'utage';
    if (song && song._deleted) return 'deleted';
    if (song && isTooHard(song, diffKey, levelMax)) return 'tooHard';
    if (diffKey === 'BASIC' && song && isTooEasy(song, easyBelow)) return 'easy';
    return null;
  }

  /** 本页只允许写点歌队列；publishstate.txt 是主播专属的只读开关，
   *  页面任何情况下都不许改它（拿它当参数调写入就会在这里抛错）。
   */
  function isWritablePath(path, postsPath) {
    return String(path) === String(postsPath);
  }

  function assertWritablePath(path, postsPath) {
    if (!isWritablePath(path, postsPath)) {
      throw new Error('拒绝写入 ' + path + '：本页只能写 ' + postsPath + '（点歌开关只有主播能改）');
    }
    return true;
  }

  /** 点歌开关：只有明确写着 true 才放行；读不到、为空、其它值一律不放行 */
  function isOpenState(raw) {
    return raw != null && String(raw).trim().toLowerCase() === 'true';
  }

  /** 榜：完全按 posts.txt 的文本顺序排名（第一行 = 第 1 名，越晚提交越靠后），最多取 limit 条 */
  function boardRows(posts, limit) {
    var max = typeof limit === 'number' && limit >= 0 ? limit : 50;
    return (posts || []).slice(0, max).map(function (row, i) {
      return { rank: i + 1, diff: row.diff || '', title: row.title || '', raw: row.raw || '' };
    });
  }

  /** 难度 → 榜上小徽标的样式名（认大小写，也认 hand-edit 出来的 utage） */
  function diffClassName(diffKey) {
    var map = {
      basic: 'basic', advanced: 'advanced', expert: 'expert', master: 'master',
      remaster: 'remaster', '宴': 'utage', utage: 'utage',
    };
    var key = String(diffKey == null ? '' : diffKey).trim().toLowerCase();
    return map[key] || '';
  }

  /** 命中打分：越小越靠前，-1 表示没命中 */
  function rankSong(song, q) {
    var title = song._title || '', artist = song._artist || '', aliases = song._aliases || [];
    if (title === q) return 0;
    if (title.indexOf(q) === 0) return 1;
    if (title.indexOf(q) >= 0) return 2;
    for (var i = 0; i < aliases.length; i++) {
      if (aliases[i] === q) return 3;
      if (aliases[i].indexOf(q) === 0) return 4;
      if (aliases[i].indexOf(q) >= 0) return 5;
    }
    if (artist === q) return 6;
    if (artist.indexOf(q) >= 0) return 7;
    return -1;
  }

  function searchSongs(songs, query, limit) {
    var q = normalize(query);
    if (!q) return [];
    var hits = [];
    for (var i = 0; i < songs.length; i++) {
      var score = rankSong(songs[i], q);
      if (score >= 0) hits.push({ song: songs[i], score: score });
    }
    hits.sort(function (a, b) {
      if (a.score !== b.score) return a.score - b.score;
      if (!!a.song._deleted !== !!b.song._deleted) return a.song._deleted ? 1 : -1; // 同分时能点的排前面
      if (b.song.version !== a.song.version) return (b.song.version || 0) - (a.song.version || 0);
      return a.song.title < b.song.title ? -1 : (a.song.title > b.song.title ? 1 : 0);
    });
    return hits.slice(0, limit || 60).map(function (h) { return h.song; });
  }

  /** 曲目里的 version 是补丁号（如 25503），版本表里只有主版本号（如 25500），取不大于它的最大主版本 */
  function nearestVersionTitle(versions, v) {
    if (v == null) return '未知版本';
    if (versions[v]) return versions[v];
    var best = null;
    Object.keys(versions).forEach(function (key) {
      var n = Number(key);
      if (n <= v && (best === null || n > best)) best = n;
    });
    return best === null ? ('v' + v) : versions[best];
  }

  function newestVersionTitle(versions) {
    var best = null;
    Object.keys(versions).forEach(function (key) {
      var n = Number(key);
      if (best === null || n > best) best = n;
    });
    return best === null ? '' : versions[best];
  }

  /** 上一版列表里有、当前版本列表里没有的歌 = 这个版本被删掉的曲子
   *  （lxns 的 song/list 默认只给当前版本可游玩的曲子，被删的会直接从列表里消失，
   *   所以要拿上一版列表做差集；曲目上的 disabled 字段同理表示已被禁用）
   */
  function findDeletedSongs(currentSongs, olderSongs) {
    if (!Array.isArray(olderSongs)) return [];
    var live = {};
    (currentSongs || []).forEach(function (song) { if (song && song.id != null) live[song.id] = true; });
    var seen = {};
    return olderSongs.filter(function (song) {
      if (!song || song.id == null || live[song.id] || seen[song.id]) return false;
      seen[song.id] = true;
      return true;
    });
  }

  /** 版本表里第二新的主版本号（用来拿"上一版曲库"） */
  function previousVersion(versions) {
    var list = (versions || [])
      .map(function (v) { return v && v.version; })
      .filter(function (n) { return typeof n === 'number' && n > 0; })
      .sort(function (a, b) { return a - b; });
    return list.length >= 2 ? list[list.length - 2] : null;
  }

  function buildAliasMap(aliasResponse) {
    var map = {};
    var list = (aliasResponse && aliasResponse.aliases) || [];
    list.forEach(function (item) {
      if (item && item.song_id != null && item.aliases && item.aliases.length) {
        map[item.song_id] = item.aliases.slice();
      }
    });
    return map;
  }

  /** UTF-8 安全的 base64（GitHub Contents API 用） */
  function utf8ToBase64(str) {
    var bytes = new TextEncoder().encode(String(str));
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function base64ToUtf8(b64) {
    var bin = atob(String(b64 == null ? '' : b64).replace(/\s+/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  var MaiUtil = {
    normalize: normalize, detectRepo: detectRepo, parsePosts: parsePosts,
    appendLine: appendLine, formatLine: formatLine, samePost: samePost,
    chartLevels: chartLevels, rankSong: rankSong, searchSongs: searchSongs, blockReason: blockReason,
    isTooEasy: isTooEasy, isTooHard: isTooHard, parseLevelMax: parseLevelMax,
    boardRows: boardRows, diffClassName: diffClassName,
    isWritablePath: isWritablePath, assertWritablePath: assertWritablePath, isOpenState: isOpenState,
    buildAliasMap: buildAliasMap, utf8ToBase64: utf8ToBase64, base64ToUtf8: base64ToUtf8,
    nearestVersionTitle: nearestVersionTitle, newestVersionTitle: newestVersionTitle,
    findDeletedSongs: findDeletedSongs, previousVersion: previousVersion,
    DIFFS: DIFFS,
  };
  if (typeof window !== 'undefined') window.MaiUtil = MaiUtil;
  if (typeof document === 'undefined') return; // Node 里只取纯函数

  /* ------------------------------------------------------------------ *
   * DOM
   * ------------------------------------------------------------------ */

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    repoLabel: $('repo-label'), chipState: $('chip-state'), chipQueue: $('chip-queue'),
    banner: $('banner'), diffs: $('diffs'), search: $('search'), btnClear: $('btn-clear'),
    libStatus: $('lib-status'), recent: $('recent'), results: $('results'),
    cardBlock: $('card-block'), card: $('card'),
    btnSubmit: $('btn-submit'), btnManual: $('btn-manual'), btnCopy: $('btn-copy'),
    submitHint: $('submit-hint'), footerPath: $('footer-path'), toast: $('toast'),
    dlg: $('dlg-settings'), dlgInfo: $('dlg-info'), dlgHint: $('dlg-hint'),
    fieldPass: $('field-pass'), inputPass: $('input-pass'),
    btnSavePass: $('btn-save-pass'), btnVerify: $('btn-verify-cred'),
    notice: $('notice'),
    board: $('board'), boardTitle: $('board-title'), boardHint: $('board-hint'),
  };

  var state = {
    repo: detectRepo(CFG, typeof location !== 'undefined' ? location : {}),
    diff: readLS(LS.diff) || CFG.defaultDifficulty,
    songs: [], versions: {}, genres: {}, libReady: false,
    selected: null, results: [], activeIndex: -1,
    // published 初值是 false：还没读到开关之前一律不放行（fail-closed）
    posts: [], published: false, statusKnown: false, stateRaw: null,
    levelMax: { state: 'unset', value: null },
    deletedTitles: {},
    recent: readLSJSON(LS.recent) || [],
    token: '', busy: false,
  };
  if (!DIFF_BY_KEY[state.diff]) state.diff = 'EXPERT';

  /* ---------------- localStorage / sessionStorage 小工具 ---------------- */

  function readLS(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function writeLS(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* 隐私模式忽略 */ } }
  function readLSJSON(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function writeLSJSON(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 配额满忽略 */ } }
  function readSS(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } }
  function writeSS(key, value) { try { sessionStorage.setItem(key, value); } catch (e) { /* ignore */ } }
  function removeSS(key) { try { sessionStorage.removeItem(key); } catch (e) { /* ignore */ } }

  function getToken() { return state.token || ''; }

  function effectiveMode() {
    return (CFG.submitMode === 'proxy' && CFG.proxyUrl) ? 'proxy' : 'blob';
  }

  /** 凭据当前处于什么状态，用于设置面板和提示文案 */
  function credentialState() {
    if (effectiveMode() === 'proxy') return 'proxy';
    if (state.token) return 'unlocked';
    if (!CFG.tokenBlob) return 'missing';
    return (CFG.passphrase || readSS(LS.pass)) ? 'ready' : 'need-pass';
  }

  function credentialText() {
    switch (credentialState()) {
      case 'proxy': return '由服务端代提交（' + CFG.proxyUrl + '）';
      case 'unlocked': return '已解锁（只存在内存里，刷新页面后重新解一次）';
      case 'ready': return '已配置密文，提交时自动解锁';
      case 'need-pass': return '已配置密文，缺少口令';
      default: return '未配置：config.js 里的 tokenBlob 还是空的';
    }
  }

  /** 真正解出 Token，只在提交 / 校验时调用，避免每次打开页面都跑一遍 PBKDF2 */
  function unlock(passphrase) {
    if (!CFG.tokenBlob) return Promise.reject(new Error('NO_BLOB'));
    if (!window.MaiCrypto) return Promise.reject(new Error('crypto.js 没加载，无法解密凭据'));
    return window.MaiCrypto.decrypt(CFG.tokenBlob, passphrase).then(function (token) {
      state.token = String(token).trim();
      return state.token;
    });
  }

  function ensureToken() {
    if (state.token) return Promise.resolve(state.token);
    if (!CFG.tokenBlob) return Promise.reject(new Error('NO_BLOB'));
    var passphrase = CFG.passphrase || readSS(LS.pass) || '';
    if (!passphrase) return Promise.reject(new Error('NO_PASSPHRASE'));
    return unlock(passphrase);
  }

  /* ---------------- 提示 ---------------- */

  var toastTimer = null;
  function toast(message, kind) {
    el.toast.textContent = message;
    el.toast.className = 'toast' + (kind ? ' ' + kind : '');
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, 4200);
  }

  function setBanner(text, kind) {
    if (!text) { el.banner.hidden = true; return; }
    el.banner.textContent = text;
    el.banner.className = 'banner' + (kind ? ' ' + kind : '');
    el.banner.hidden = false;
  }

  /* ---------------- 难度 ---------------- */

  function renderDiffs() {
    el.diffs.textContent = '';
    DIFFS.forEach(function (diff) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'diff';
      btn.dataset.diff = diff.key;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(diff.key === state.diff));
      btn.textContent = diff.key;
      btn.addEventListener('click', function () { setDiff(diff.key); });
      el.diffs.appendChild(btn);
    });
  }

  function setDiff(key) {
    if (!DIFF_BY_KEY[key] || key === state.diff) return;
    state.diff = key;
    writeLS(LS.diff, key);
    Array.prototype.forEach.call(el.diffs.children, function (btn) {
      btn.setAttribute('aria-checked', String(btn.dataset.diff === key));
    });
    renderResults();
    renderCard();
    renderActions();
  }

  /* ---------------- 曲库 ---------------- */

  function setLibStatus(text, kind) {
    el.libStatus.textContent = text;
    el.libStatus.className = 'hint' + (kind ? ' ' + kind : '');
  }

  function applyLibrary(data) {
    var deleted = data.deleted || [];
    var deletedIds = {};
    deleted.forEach(function (song) { if (song && song.id != null) deletedIds[song.id] = true; });

    // 被删的曲子也放进搜索列表，这样点到它们才能给出「无法选择删除曲！」
    state.songs = (data.songs || []).concat(deleted);
    var versions = {};
    (data.versions || []).forEach(function (v) { if (v && v.version != null) versions[v.version] = v.title; });
    var genres = {};
    (data.genres || []).forEach(function (g) { if (g && g.genre) genres[g.genre] = g.title; });
    state.versions = versions;
    state.genres = genres;

    var aliasMap = data.aliases || {};
    state.deletedTitles = {};
    state.songs.forEach(function (song) {
      song._deleted = deletedIds[song.id] === true || song.disabled === true;
      var raw = aliasMap[song.id] || [];
      song._title = normalize(song.title);
      song._artist = normalize(song.artist);
      song._aliases = raw.map(normalize);
      song.__rawAliases = raw;
      if (song._deleted) state.deletedTitles[song._title] = true;
    });
    state.libReady = true;

    setLibStatus('曲库 ' + (state.songs.length - deleted.length) + ' 首' +
      (deleted.length ? ' · 已删除 ' + deleted.length + ' 首' : '') +
      ' · ' + newestVersionTitle(state.versions) +
      (data.fromCache ? ' · 本地缓存' : ' · 已更新'));
    renderResults();
    renderActions();
  }

  function fetchJSON(url) {
    return fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function loadLibrary() {
    var cached = readLSJSON(LS.lib);
    var fresh = cached && cached.songs && cached.songs.length &&
      (Date.now() - (cached.savedAt || 0) < CFG.cacheHours * 3600 * 1000);
    if (fresh) {
      cached.fromCache = true;
      applyLibrary(cached);
    } else {
      setLibStatus('正在载入曲库…（首次约 0.8～1.6MB）');
    }

    return fetchJSON(CFG.songApi).then(function (main) {
      var prev = CFG.checkDeletedSongs ? previousVersion(main.versions) : null;
      return Promise.all([
        main,
        fetchJSON(CFG.aliasApi).catch(function () { return null; }), // 别名拿不到不影响搜索
        // 上一版曲库：用来算"这个版本被删掉的曲子"，拿不到就不标记，不影响主流程
        prev ? fetchJSON(CFG.songApi + '?version=' + prev).catch(function () { return null; })
             : Promise.resolve(null),
      ]);
    }).then(function (res) {
      var deleted = findDeletedSongs(res[0].songs, res[2] && res[2].songs);
      var data = {
        savedAt: Date.now(),
        songs: res[0].songs || [],
        versions: res[0].versions || [],
        genres: res[0].genres || [],
        aliases: buildAliasMap(res[1]),
        deleted: deleted.map(function (song) {
          // 只留搜索和展示需要的字段，别把整份旧曲库塞进 localStorage
          return {
            id: song.id, title: song.title, artist: song.artist, genre: song.genre,
            bpm: song.bpm, version: song.version, difficulties: song.difficulties,
          };
        }),
      };
      if (!data.songs.length) throw new Error('曲库为空');
      writeLSJSON(LS.lib, data);
      applyLibrary(data);
    }).catch(function (err) {
      if (!fresh) {
        setLibStatus('曲库载入失败：' + err.message + '。可以先直接手打曲名提交。', 'bad');
        renderActions();
      } else {
        setLibStatus(el.libStatus.textContent + '（更新失败：' + err.message + '）', 'warn');
      }
    });
  }

  /** 曲目里的 version 是补丁号（如 25503），版本表里只有主版本号（如 25500），所以取不大于它的最大主版本 */
  function versionTitle(v) { return nearestVersionTitle(state.versions, v); }

  function genreTitle(g) { return state.genres[g] || g || '未知'; }

  /* ---------------- 搜索结果 ---------------- */

  function highlight(text, query) {
    var frag = document.createDocumentFragment();
    var raw = String(text == null ? '' : text);
    var at = query ? raw.toLowerCase().indexOf(query.toLowerCase()) : -1;
    if (!query || at < 0) { frag.appendChild(document.createTextNode(raw)); return frag; }
    frag.appendChild(document.createTextNode(raw.slice(0, at)));
    var mark = document.createElement('mark');
    mark.textContent = raw.slice(at, at + query.length);
    frag.appendChild(mark);
    frag.appendChild(document.createTextNode(raw.slice(at + query.length)));
    return frag;
  }

  /** 命中来自别名时，把别名显示出来（原始大小写，方便用户理解为什么搜到了） */
  function matchedAlias(song, query) {
    var q = normalize(query);
    if (!q || (song._title || '').indexOf(q) >= 0) return '';
    var list = song.__rawAliases || [];
    for (var i = 0; i < list.length; i++) {
      if (normalize(list[i]).indexOf(q) >= 0) return list[i];
    }
    return '';
  }

  function renderResults() {
    var query = el.search.value.trim();
    el.btnClear.hidden = !query;
    el.search.setAttribute('aria-expanded', 'false');
    el.results.textContent = '';
    el.results.hidden = true;
    state.results = [];
    state.activeIndex = -1;

    renderRecent();
    if (!query || !state.libReady) return;

    var found = searchSongs(state.songs, query, 60);
    state.results = found;
    if (!found.length) {
      el.results.hidden = false;
      var empty = document.createElement('li');
      empty.className = 'results-more';
      empty.textContent = '没找到匹配的曲目，换个关键词或用中文别名试试。';
      el.results.appendChild(empty);
      return;
    }

    found.forEach(function (song, i) {
      var li = document.createElement('li');
      li.className = 'result';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.dataset.index = String(i);

      var main = document.createElement('div');
      main.className = 'result-main';

      var title = document.createElement('div');
      title.className = 'result-title';
      title.appendChild(highlight(song.title, query));

      var sub = document.createElement('div');
      sub.className = 'result-sub';
      sub.textContent = (song.artist || '未知曲师') + ' · ' + versionTitle(song.version) +
        (matchedAlias(song, query) ? ' · 别名 ' + matchedAlias(song, query) : '');
      main.appendChild(title);
      main.appendChild(sub);

      var badge = document.createElement('span');
      var levels = chartLevels(song, state.diff);
      if (song._deleted) {
        badge.className = 'result-badge deleted';
        badge.textContent = '已删除';
      } else if (DIFF_BY_KEY[state.diff].index === null) {
        badge.className = 'result-badge';
        badge.textContent = '宴';
      } else if (levels.length) {
        badge.className = 'result-badge';
        badge.textContent = levels.map(function (l) { return l.type + ' ' + l.level; }).join(' / ');
      } else {
        badge.className = 'result-badge none';
        badge.textContent = '无 ' + state.diff;
      }

      li.appendChild(main);
      li.appendChild(badge);
      li.addEventListener('click', function () { selectSong(song); });
      li.addEventListener('mousemove', function () { setActive(i, false); });
      el.results.appendChild(li);
    });

    el.results.hidden = false;
    el.search.setAttribute('aria-expanded', 'true');
  }

  function setActive(index, scroll) {
    if (!state.results.length) return;
    var max = state.results.length - 1;
    state.activeIndex = index < 0 ? max : (index > max ? 0 : index);
    Array.prototype.forEach.call(el.results.children, function (li, i) {
      li.setAttribute('aria-selected', String(i === state.activeIndex));
    });
    if (scroll) {
      var node = el.results.children[state.activeIndex];
      if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderRecent() {
    el.recent.textContent = '';
    var list = (state.recent || []).slice(0, 8);
    if (!list.length || el.search.value.trim()) { el.recent.hidden = true; return; }
    var label = document.createElement('span');
    label.className = 'hint';
    label.style.margin = '0 4px 0 0';
    label.textContent = '最近点过：';
    el.recent.appendChild(label);
    list.forEach(function (item) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'recent-chip';
      var b = document.createElement('b');
      b.textContent = item.diff;
      chip.appendChild(b);
      chip.appendChild(document.createTextNode(' ' + item.title));
      chip.addEventListener('click', function () { restoreRecent(item); });
      el.recent.appendChild(chip);
    });
    el.recent.hidden = false;
  }

  function restoreRecent(item) {
    if (DIFF_BY_KEY[item.diff]) setDiff(item.diff);
    var target = state.songs.filter(function (s) { return normalize(s.title) === normalize(item.title); })[0];
    if (target) { selectSong(target); return; }
    el.search.value = item.title;
    state.selected = null;
    renderResults();
    renderCard();
    renderActions();
  }

  function selectSong(song) {
    state.selected = song;
    state.activeIndex = -1;
    el.search.value = song.title;
    el.results.hidden = true;
    el.btnClear.hidden = false;
    renderCard();
    renderActions();
    if (el.cardBlock.scrollIntoView) el.cardBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ---------------- 曲目卡片 ---------------- */

  function metaRow(label, valueNode) {
    var row = document.createElement('div');
    row.className = 'row';
    var k = document.createElement('span');
    k.className = 'k';
    k.textContent = label;
    var v = document.createElement('span');
    v.className = 'v';
    if (typeof valueNode === 'string') v.textContent = valueNode;
    else v.appendChild(valueNode);
    row.appendChild(k);
    row.appendChild(v);
    return row;
  }

  function levelList(song) {
    var ul = document.createElement('ul');
    ul.className = 'levels';
    var levels = chartLevels(song, state.diff);
    if (!levels.length) {
      var li = document.createElement('li');
      li.className = 'level';
      li.textContent = DIFF_BY_KEY[state.diff].index === null
        ? '宴会場谱面不提供定数'
        : '该曲目没有 ' + state.diff + ' 谱面';
      ul.appendChild(li);
      return ul;
    }
    levels.forEach(function (l) {
      var li = document.createElement('li');
      li.className = 'level';
      var tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = l.type;
      var num = document.createElement('span');
      num.className = 'num';
      num.textContent = l.level;
      var val = document.createElement('span');
      val.className = 'val';
      val.textContent = l.value != null ? '（' + l.value + '）' : '';
      li.appendChild(tag);
      li.appendChild(document.createTextNode(' ')); // 让读屏/copy 出来是「STD 13+（13.7）」而不是「STD13+（13.7）」
      li.appendChild(num);
      li.appendChild(val);
      ul.appendChild(li);
    });
    return ul;
  }

  function renderCard() {
    var song = state.selected;
    if (!song) { el.cardBlock.hidden = true; el.card.textContent = ''; return; }
    el.card.textContent = '';

    var head = document.createElement('div');
    var h3 = document.createElement('h3');
    h3.className = 'card-title';
    h3.textContent = song.title;
    var artist = document.createElement('p');
    artist.className = 'card-artist';
    artist.textContent = song.artist || '未知曲师';
    head.appendChild(h3);
    head.appendChild(artist);

    var meta = document.createElement('div');
    meta.className = 'card-meta';
    if (song._deleted) meta.appendChild(metaRow('状态', '已删除'));
    meta.appendChild(metaRow('难度', state.diff));
    meta.appendChild(metaRow('定数', levelList(song)));
    meta.appendChild(metaRow('版本', versionTitle(song.version)));
    meta.appendChild(metaRow('分类', genreTitle(song.genre)));
    meta.appendChild(metaRow('BPM', String(song.bpm || '—')));

    el.card.appendChild(head);
    el.card.appendChild(meta);

    var designers = chartLevels(song, state.diff)
      .filter(function (l) { return l.designer && l.designer !== '-'; })
      .map(function (l) { return l.type + ' ' + l.designer; });
    if (designers.length) {
      var note = document.createElement('p');
      note.className = 'card-note';
      note.textContent = '谱面设计：' + designers.join(' · ');
      el.card.appendChild(note);
    }

    var dupCount = countDup(song.title, state.diff);
    if (dupCount) {
      var dup = document.createElement('p');
      dup.className = 'card-dup';
      dup.textContent = '⚠ 队列里已经有 ' + dupCount + ' 首「' + state.diff + ' · ' + song.title + '」了，确定还要再点一次吗？';
      el.card.appendChild(dup);
    }

    el.cardBlock.hidden = false;
  }

  function countDup(title, diffKey) {
    return state.posts.filter(function (row) { return samePost(row, diffKey, title); }).length;
  }

  /* ---------------- 操作区 ---------------- */

  /** 手动指定曲名：输入框里有内容、但没有从搜索结果里选中曲目时启用
   *  （宴会場谱面、曲库没收录的新曲、曲库载入失败时都用得上）
   */
  function manualTitle() {
    var query = el.search.value.trim();
    if (!query || state.selected) return '';
    return query;
  }

  function currentTitle() {
    return state.selected ? state.selected.title : manualTitle();
  }

  /** 规则的模式：'block'（拦下）/ 'warn'（只提示）/ 'off'（不检查），默认 block */
  function ruleMode(kind) {
    var rules = CFG.rules || {};
    var mode = rules[kind];
    return (mode === 'warn' || mode === 'off') ? mode : 'block';
  }

  function easyBelow() {
    return typeof CFG.easyBasicBelow === 'number' ? CFG.easyBasicBelow : DEFAULT_EASY_BELOW;
  }

  function levelMaxValue() {
    return state.levelMax && typeof state.levelMax.value === 'number' ? state.levelMax.value : null;
  }

  /** 等级上限文件本身有问题（读不到 / 内容不是数字）时，整页都不放行 */
  function levelMaxBroken() {
    var st = state.levelMax && state.levelMax.state;
    if (st !== 'unknown' && st !== 'invalid') return false;
    // 本地预览（没配仓库）时页面本来就不能提交，读不到上限也没必要再禁掉"复制点歌文本"
    return !!(state.repo.owner && state.repo.repo);
  }

  function levelMaxText() {
    var lm = state.levelMax || { state: 'unset' };
    if (lm.state === 'ok') return CFG.maxLevelPath + ' → ' + lm.value + '（超过就不能点）';
    if (lm.state === 'invalid') return CFG.maxLevelPath + ' → 内容不是数字，需改成 13.0 这样的小数';
    if (lm.state === 'unknown') return CFG.maxLevelPath + ' → 读取失败';
    return CFG.maxLevelPath + ' → 未设置（不限制等级）';
  }

  /** 规则拦截：Re:Master / 宴 / 删除曲 / 太难 / 太简单的 BASIC
   *  返回 {kind, text, enforced}（enforced=false 表示只提示不拦）或 null（正常）
   */
  function selectionBlock() {
    // 难度/曲目层面的规则
    var kind = blockReason(state.diff, state.selected, easyBelow(), levelMaxValue());
    // 手动打曲名（没从搜索结果里选）时，额外按曲名查一次删除曲
    if (!kind && manualTitle() && state.deletedTitles[normalize(manualTitle())]) kind = 'deleted';
    if (!kind) return null;

    var mode = ruleMode(kind);
    if (mode === 'off') return null;
    var text = BLOCK_MESSAGES[kind] || '';
    if (kind === 'tooHard') text += '（等级上限 ' + levelMaxValue() + '）';
    return { kind: kind, text: text, enforced: mode === 'block' };
  }

  function renderNotice(block) {
    if (!block) { el.notice.hidden = true; el.notice.textContent = ''; return; }
    el.notice.textContent = block.text + (block.enforced ? '' : '（只是提醒，还是可以点）');
    el.notice.className = 'notice ' + block.kind;
    el.notice.hidden = false;
  }

  function renderActions() {
    var title = currentTitle();
    var levels = state.selected ? chartLevels(state.selected, state.diff) : [];
    var locked = !state.published;
    var noRepo = !state.repo.owner || !state.repo.repo;
    var missingChart = !!state.selected && DIFF_BY_KEY[state.diff].index !== null && !levels.length;
    var block = selectionBlock();
    var enforced = !!block && block.enforced; // 只提示的规则不影响按钮
    var maxBroken = levelMaxBroken();         // 等级上限文件有问题 → 整页不放行
    // 点歌关了就彻底关掉：连「复制点歌文本」也不给，免得绕过去。
    // 但仓库压根没配置时属于页面没配好，此时复制是唯一能用的兜底，保留。
    var closed = (locked || maxBroken) && !noRepo;

    renderNotice(block);

    el.btnSubmit.disabled = state.busy || locked || noRepo || maxBroken || !title || missingChart || enforced;
    el.btnCopy.disabled = !title || enforced || closed;
    el.btnManual.hidden = !manualTitle() || enforced;
    if (!el.btnManual.hidden) el.btnManual.textContent = '直接点《' + manualTitle() + '》';

    var hint = '';
    if (block) hint = ''; // 文案已经在上面的提示框里显示了
    else if (noRepo) hint = '这个页面还没配好仓库（config.js 里填 owner/repo），现在只能「复制点歌文本」。' +
      (localReadTrouble() ? '本地 file:// 打开时读不到 levelmax.txt / publishstate.txt，规则不会生效，请用本地服务器打开。' : '');
    else if (locked) hint = state.statusKnown
      ? '当前暂停点歌，等主播开启后再来吧。'
      : '还没读到点歌开关（publishstate.txt），暂时不能提交，刷新页面试试。';
    else if (maxBroken) hint = state.levelMax.state === 'invalid'
      ? 'levelmax.txt 的内容不是数字（要写成 13.0 这样的小数），改好之前不能提交。'
      : '还没读到等级上限（levelmax.txt），暂时不能提交，刷新页面试试。';
    else if (missingChart) hint = '这首曲子没有 ' + state.diff + ' 谱面，换个难度。';
    else if (!title) hint = '先选难度，再搜一首曲子。';
    else if (effectiveMode() === 'blob' && credentialState() === 'missing') hint = '提交凭据还没配置（config.js 的 tokenBlob 是空的），可以先用「复制点歌文本」。';
    else if (effectiveMode() === 'blob' && credentialState() === 'need-pass') hint = '需要先在 ⚙ 里输入一次解锁口令。';
    else if (state.busy) hint = '正在提交…';
    el.submitHint.textContent = hint;
    el.submitHint.className = 'hint warn';
    el.submitHint.hidden = !hint;
  }

  /* ---------------- 远端读写 ---------------- */

  function rawUrl(path) {
    var r = state.repo;
    return 'https://raw.githubusercontent.com/' + r.owner + '/' + r.repo + '/' +
      encodeURIComponent(r.branch) + '/' + path + '?t=' + Date.now();
  }

  /** 页面同目录下的文件（本地预览用；静态服务器会忽略 ?t= 查询串） */
  function localUrl(path) {
    var base = (typeof location !== 'undefined' && location.href) ? location.href : '';
    return new URL(path, base || 'http://localhost/').href + '?t=' + Date.now();
  }

  function fetchText(url) {
    return fetch(url, { cache: 'no-store', headers: { Accept: 'text/plain' } }).then(function (res) {
      if (res.status === 404 || res.status === 403) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    });
  }

  /** 读仓库文件：先走 raw（不吃 API 限额），再走 Contents API（私有仓库需要 Token）；
   *  没配置仓库时（本地预览）退回读页面同目录下的同名文件，方便在本地试规则
   */
  function readFile(path) {
    var r = state.repo;
    if (r.owner && r.repo) {
      return fetchText(rawUrl(path)).then(function (text) {
        if (text !== null) return text;
        return ghGetFile(path).then(function (file) { return file.text; });
      });
    }
    return fetchText(localUrl(path)).then(function (text) {
      if (text === null) throw new Error('读不到 ' + path);
      return text;
    });
  }

  function ghHeaders() {
    var headers = { Accept: 'application/vnd.github+json' };
    var token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  }

  function ghContentsUrl(path) {
    var r = state.repo;
    return 'https://api.github.com/repos/' + r.owner + '/' + r.repo + '/contents/' + path;
  }

  /** Contents API 读文件，返回 {text, sha, size} */
  function ghGetFile(path) {
    var r = state.repo;
    if (!r.owner || !r.repo) return Promise.reject(new Error('仓库信息未配置'));
    var url = ghContentsUrl(path) + '?ref=' + encodeURIComponent(r.branch) + '&t=' + Date.now();
    return fetch(url, { headers: ghHeaders(), cache: 'no-store' }).then(function (res) {
      if (res.status === 404) return { text: '', sha: null, size: 0 };
      if (res.status === 403) throw new Error('GitHub 接口限流或 Token 权限不足（403）');
      if (!res.ok) throw new Error('GitHub ' + res.status);
      return res.json().then(function (data) {
        if (Array.isArray(data)) throw new Error('目标路径不是文件');
        if (data.content) return { text: base64ToUtf8(data.content), sha: data.sha, size: data.size };
        // 文件超过 1MB 时 Contents API 不返回内容
        return fetchText(data.download_url).then(function (text) {
          return { text: text || '', sha: data.sha, size: data.size };
        });
      });
    });
  }

  function ghPutFile(path, text, sha, message) {
    assertWritablePath(path, CFG.postsPath); // 兜底：只允许写点歌队列
    var r = state.repo;
    var body = { message: message, content: utf8ToBase64(text), branch: r.branch };
    if (sha) body.sha = sha;
    return fetch(ghContentsUrl(path), {
      method: 'PUT',
      headers: Object.assign(ghHeaders(), { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    }).then(function (res) {
      if (res.status === 409 || res.status === 422) {
        var err = new Error('文件被同时修改（' + res.status + '）');
        err.conflict = true;
        throw err;
      }
      if (res.status === 401) {
        var e401 = new Error('Token 无效或已过期（401）');
        e401.status = 401;
        throw e401;
      }
      if (res.status === 403) {
        var e403 = new Error('Token 没有本仓库的 Contents 写入权限，或接口限流（403）');
        e403.status = 403;
        throw e403;
      }
      if (!res.ok) throw new Error('GitHub ' + res.status);
      return res.json();
    });
  }

  function setPosts(text) {
    state.posts = parsePosts(text);
    el.chipQueue.textContent = '队列 ' + state.posts.length + ' 首';
    renderCard();
    renderBoard();
  }

  /** 页面最底部的点歌榜：按 posts.txt 的文本顺序，最多列 50 条 */
  function renderBoard() {
    var rows = boardRows(state.posts, CFG.boardLimit);
    el.board.textContent = '';

    if (!rows.length) {
      el.boardHint.textContent = '还没有人点歌，来点第一首吧～';
      el.boardTitle.textContent = '点歌榜';
      return;
    }

    rows.forEach(function (row) {
      var li = document.createElement('li');

      var rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = row.rank + '.';

      var diff = document.createElement('span');
      var cls = diffClassName(row.diff);
      diff.className = 'board-diff ' + (cls || 'none');
      diff.textContent = row.diff || '—';

      var title = document.createElement('span');
      title.className = 'board-title';
      title.textContent = row.title;
      title.title = row.raw;

      li.appendChild(rank);
      li.appendChild(diff);
      li.appendChild(title);
      el.board.appendChild(li);
    });

    var total = state.posts.length;
    el.boardTitle.textContent = '点歌榜（共 ' + total + ' 首）';
    el.boardHint.textContent = total > rows.length
      ? '按提交先后排名，先提交的在前；只显示最早的前 ' + rows.length + ' 首。'
      : '按提交先后排名，先提交的在前。';
  }

  function refreshRemote() {
    var r = state.repo;
    var noRepo = !r.owner || !r.repo;
    return Promise.all([
      readFile(CFG.statePath).catch(function () { return null; }),
      readFile(CFG.postsPath).catch(function () { return null; }),
      CFG.maxLevelPath ? readFile(CFG.maxLevelPath).catch(function () { return null; }) : Promise.resolve(''),
    ]).then(function (res) {
      // publishstate.txt 是只读的（只有主播能改）：只有内容明确是 true 才开放，
      // 读不到 / 为空 / 是别的值，一律不接受点歌。
      var stateText = res[0] == null ? null : String(res[0]).trim();
      state.published = isOpenState(stateText);
      state.statusKnown = stateText !== null;
      state.stateRaw = stateText;

      // levelmax.txt 同样只读：空/不存在 = 不设上限；内容不是数字 = 拦住并提示，免得静默失效
      state.levelMax = parseLevelMax(res[2]);

      if (res[1] !== null) setPosts(res[1]);

      if (noRepo) {
        el.chipState.textContent = '仓库未配置';
        el.chipState.className = 'chip bad';
        setBanner('还没有配置仓库信息：请在 config.js 里填 owner/repo，或从 GitHub Pages 地址打开本页。' +
          localFileNote() + (localReadTrouble() ? FILE_HINT : ''), 'bad');
      } else if (!state.statusKnown) {
        el.chipState.textContent = '开关读取失败';
        el.chipState.className = 'chip bad';
        setBanner('读取不到 publishstate.txt，为了保险暂时不接受点歌，稍后刷新再试。', 'bad');
      } else if (state.published) {
        el.chipState.textContent = '点歌开放';
        el.chipState.className = 'chip ok';
        if (state.levelMax.state === 'unknown') {
          setBanner('读取不到 levelmax.txt（等级上限），为了保险暂时不接受点歌，稍后刷新再试。', 'bad');
        } else if (state.levelMax.state === 'invalid') {
          setBanner('levelmax.txt 里的内容不是数字（应该写成 13.0 这样的小数），改好之前不接受点歌。', 'bad');
        } else {
          setBanner('');
        }
      } else if (stateText === '') {
        el.chipState.textContent = '未开启点歌';
        el.chipState.className = 'chip paused';
        setBanner('publishstate.txt 里不是 true，当前不开放点歌（这个开关只有主播能改）。');
      } else {
        el.chipState.textContent = '已暂停点歌';
        el.chipState.className = 'chip paused';
        setBanner('主播暂时关闭了点歌，稍后再来～');
      }
      renderActions();
    });
  }

  /** 本地预览（没配仓库）时，把读到的开关/上限写进横幅，方便确认规则有没有生效 */
  function localFileNote() {
    var parts = [];
    parts.push(state.statusKnown
      ? 'publishstate.txt=' + (state.stateRaw === '' ? '（空）' : state.stateRaw)
      : 'publishstate.txt 读不到');
    var lm = state.levelMax || { state: 'unset' };
    if (lm.state === 'ok') parts.push('levelmax.txt=' + lm.value);
    else if (lm.state === 'invalid') parts.push('levelmax.txt 格式不对');
    else if (lm.state === 'unknown') parts.push('levelmax.txt 读不到');
    else parts.push('levelmax.txt 为空/不存在');
    return '（本地预览读到：' + parts.join('、') + '）';
  }

  /** 本地预览时读不到同目录文件（典型是 file:// 直接双击打开）→ 规则不会生效，要明确说出来 */
  function localReadTrouble() {
    if (state.repo.owner && state.repo.repo) return false;
    return !state.statusKnown || (state.levelMax && state.levelMax.state === 'unknown');
  }

  /* ---------------- 提交 ---------------- */

  function rememberRecent(diffKey, title) {
    state.recent = [{ diff: diffKey, title: title }].concat(
      (state.recent || []).filter(function (item) {
        return !(normalize(item.title) === normalize(title) && item.diff === diffKey);
      })
    ).slice(0, 8);
    writeLSJSON(LS.recent, state.recent);
    renderRecent();
  }

  function submit(title) {
    var diffKey = state.diff;
    var line = formatLine(diffKey, title);

    var block = selectionBlock();
    if (block && block.enforced) { toast(block.text, 'bad'); return Promise.resolve(); } // warn 模式不拦
    if (levelMaxBroken()) { toast('等级上限文件有问题，暂时不能点歌', 'bad'); return Promise.resolve(); }
    if (!state.published) { toast('当前已暂停点歌', 'bad'); return Promise.resolve(); }
    if (!state.repo.owner || !state.repo.repo) { toast('仓库信息未配置，先在 config.js 里填好', 'bad'); return Promise.resolve(); }

    state.busy = true;
    renderActions();

    // proxy 模式不需要浏览器里的凭据；blob 模式先在本机解开密文
    var credential = effectiveMode() === 'proxy' ? Promise.resolve('') : ensureToken();

    var attempt = 0;
    var run = function () {
      attempt++;
      return ghGetFile(CFG.postsPath).then(function (file) {
        var dups = parsePosts(file.text).filter(function (row) { return samePost(row, diffKey, title); });
        if (dups.length) {
          var ok = window.confirm('「' + diffKey + ' · ' + title + '」已经在队列里出现 ' + dups.length +
            ' 次了。\n确定还要再点一次吗？');
          if (!ok) return { cancelled: true };
        }
        var text = appendLine(file.text, line);
        return put(text, file.sha).then(function () {
          setPosts(text);
          rememberRecent(diffKey, title);
          toast('已提交：' + line, 'ok');
          return { ok: true };
        });
      }).catch(function (err) {
        if (err.conflict && attempt < 3) return run(); // 有人同时提交，取最新内容重试
        throw err;
      });
    };

    return credential.then(function () { return run(); }).catch(function (err) {
      if (err.message === 'NO_BLOB') {
        toast('提交凭据没配置：先用 encrypt.html 生成密文填进 config.js', 'bad');
        openSettings('config.js 里的 tokenBlob 还是空的。打开 encrypt.html，填 Token 和口令生成密文，粘到 config.js。');
      } else if (err.message === 'NO_PASSPHRASE') {
        toast('需要先输入解锁口令', 'bad');
        openSettings('config.js 里没写 passphrase，在这里输入一次加密时用的口令即可（只存在当前标签页）。');
      } else if (err.status === 401 || err.status === 403) {
        state.token = '';
        toast('凭据被 GitHub 拒绝：' + err.message, 'bad');
        openSettings('Token 可能过期或被吊销，也可能没给 Contents: Read and write 权限。重新生成密文替换 config.js 里的 tokenBlob。');
      } else if (err.message && err.message.indexOf('口令不正确') >= 0) {
        state.token = '';
        removeSS(LS.pass);
        toast(err.message, 'bad');
        openSettings('口令不对，或密文和口令不是同一批生成的。');
      } else {
        toast('提交失败：' + err.message, 'bad');
      }
    }).then(function () {
      state.busy = false;
      renderActions();
    });
  }

  function put(text, sha) {
    var message = '点歌：' + formatLine(state.diff, currentTitle());
    var target = { owner: state.repo.owner, repo: state.repo.repo, branch: state.repo.branch, path: CFG.postsPath };
    assertWritablePath(target.path, CFG.postsPath); // 只写点歌队列，绝不碰 publishstate.txt
    if (effectiveMode() === 'proxy') {
      return fetch(CFG.proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner: target.owner, repo: target.repo, branch: target.branch,
          path: target.path, line: formatLine(state.diff, currentTitle()),
        }),
      }).then(function (res) {
        if (!res.ok) throw new Error('提交服务返回 HTTP ' + res.status);
        return res.json().catch(function () { return {}; });
      });
    }
    if (!getToken()) throw new Error('NO_BLOB');
    return ghPutFile(target.path, text, sha, message);
  }

  function copyLine() {
    var title = currentTitle();
    if (!title) return;
    var block = selectionBlock();
    if (block && block.enforced) { toast(block.text, 'bad'); return; } // warn 模式不拦
    if (levelMaxBroken()) { toast('等级上限文件有问题，暂时不能点歌', 'bad'); return; }
    var line = formatLine(state.diff, title);
    var done = function () { toast('已复制：' + line, 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(line).then(done, function () { window.prompt('复制下面这行：', line); });
    } else {
      window.prompt('复制下面这行：', line);
    }
  }

  /* ---------------- 设置 ---------------- */

  function openSettings(hint) {
    el.dlgInfo.textContent = '';
    var rows = [
      ['仓库', (state.repo.owner || '（未配置）') + '/' + (state.repo.repo || '（未配置）')],
      ['分支', state.repo.branch],
      ['点歌文件', CFG.postsPath + '（本页只写这个文件）'],
      ['状态文件', CFG.statePath + '（只读，只有主播能改）'],
      ['等级上限', levelMaxText()],
      ['写入方式', effectiveMode() === 'proxy' ? 'proxy（服务端代提交）' : 'blob（本机解开密文后直连 GitHub）'],
      ['凭据', credentialText()],
    ];
    rows.forEach(function (row) {
      var dt = document.createElement('dt');
      dt.textContent = row[0];
      var dd = document.createElement('dd');
      dd.textContent = row[1];
      el.dlgInfo.appendChild(dt);
      el.dlgInfo.appendChild(dd);
    });

    var needPass = effectiveMode() === 'blob' && !!CFG.tokenBlob && !CFG.passphrase && !state.token;
    el.fieldPass.hidden = !needPass;
    el.btnSavePass.hidden = !needPass;
    el.btnVerify.hidden = effectiveMode() !== 'blob' || !CFG.tokenBlob;
    el.inputPass.value = '';
    el.dlgHint.textContent = hint || (needPass
      ? '输入加密时设置的口令，用来在这台设备上解出提交凭据；口令只放在当前标签页，不会被发送出去。'
      : '这些内容在 config.js 里改；改完刷新本页生效。');

    if (typeof el.dlg.showModal === 'function') el.dlg.showModal();
    else el.dlg.setAttribute('open', '');
  }

  function closeSettings() {
    if (typeof el.dlg.close === 'function') el.dlg.close();
    else el.dlg.removeAttribute('open');
  }

  /** 设置面板里的「验证凭据」：解出 Token 后调一次 GitHub API */
  function verifyCredential() {
    var r = state.repo;
    if (!r.owner || !r.repo) { el.dlgHint.textContent = '还没配置仓库，先在 config.js 里填 owner/repo。'; return; }
    el.dlgHint.textContent = '正在验证…';
    ensureToken().then(function (token) {
      return fetch('https://api.github.com/repos/' + r.owner + '/' + r.repo, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
        cache: 'no-store',
      });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (res.status === 401) throw new Error('Token 无效或已过期（401）');
        if (res.status === 404) throw new Error('仓库找不到，或 Token 没有这个仓库的访问权（404）');
        if (!res.ok) throw new Error('GitHub ' + res.status + ' ' + (body.message || ''));
        var perms = body.permissions || {};
        el.dlgHint.textContent = '✅ 凭据可用：' + body.full_name + '（' + (body.private ? '私有' : '公开') + '）' +
          ' · push=' + (perms.push ? '有' : '无') + '（提交点歌需要 push）';
        renderActions();
      });
    }).catch(function (err) {
      var extra = err.message === 'NO_BLOB' ? 'config.js 里还没有 tokenBlob。'
        : err.message === 'NO_PASSPHRASE' ? '需要先输入口令。' : '';
      el.dlgHint.textContent = '❌ ' + err.message + (extra ? ' ' + extra : '');
    });
  }

  /* ---------------- 事件绑定 ---------------- */

  var searchTimer = null;
  function bind() {
    $('btn-settings').addEventListener('click', function () { openSettings(); });
    $('btn-close-dlg').addEventListener('click', closeSettings);
    el.btnVerify.addEventListener('click', verifyCredential);
    el.btnSavePass.addEventListener('click', function () {
      var value = el.inputPass.value;
      if (!value) { el.dlgHint.textContent = '口令不能为空。'; return; }
      el.dlgHint.textContent = '正在解锁…';
      unlock(value).then(function () {
        writeSS(LS.pass, value);
        el.dlgHint.textContent = '✅ 已解锁，提交时会用这份凭据。';
        renderActions();
      }).catch(function (err) {
        state.token = '';
        el.dlgHint.textContent = '❌ ' + err.message;
      });
    });
    el.inputPass.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); el.btnSavePass.click(); }
    });

    el.btnClear.addEventListener('click', function () {
      el.search.value = '';
      state.selected = null;
      renderResults();
      renderCard();
      renderActions();
      el.search.focus();
    });

    el.search.addEventListener('input', function () {
      state.selected = null;
      renderCard();
      renderActions();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderResults, 110);
    });

    el.search.addEventListener('focus', function () { renderRecent(); });

    el.search.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive(state.activeIndex + 1, true); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(state.activeIndex - 1, true); }
      else if (event.key === 'Escape') { el.results.hidden = true; }
      else if (event.key === 'Enter') {
        event.preventDefault();
        if (state.results.length) {
          selectSong(state.results[state.activeIndex >= 0 ? state.activeIndex : 0]);
        } else if (manualTitle()) {
          el.btnManual.click();
        }
      }
    });

    document.addEventListener('click', function (event) {
      var node = event.target;
      if (node && node.closest && (node.closest('.search') || node.closest('.results'))) return;
      el.results.hidden = true;
    });

    el.btnSubmit.addEventListener('click', function () {
      var title = currentTitle();
      if (title) submit(title);
    });
    el.btnManual.addEventListener('click', function () {
      var title = manualTitle();
      if (title) submit(title);
    });
    el.btnCopy.addEventListener('click', copyLine);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refreshRemote();
    });
  }

  /* ---------------- 启动 ---------------- */

  function init() {
    el.footerPath.textContent = CFG.postsPath;
    var r = state.repo;
    el.repoLabel.textContent = (r.owner && r.repo)
      ? r.owner + '/' + r.repo + ' @ ' + r.branch
      : '未配置仓库（config.js）';
    renderDiffs();
    bind();
    renderRecent();
    renderBoard();
    renderActions();
    refreshRemote();
    loadLibrary();
    setInterval(function () {
      if (!document.hidden) refreshRemote();
    }, Math.max(20, CFG.refreshSeconds) * 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
