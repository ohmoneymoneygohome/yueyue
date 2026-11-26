/**
 * 药药 V2.1
 * 运行环境：小红书小工具（离线 H5 / 容器沙箱）
 * 兼容基线：ES2017 / Chrome 61
 * 说明：不做自动图像识别。药板按优思明 21 片 U 形排列，状态由每日确认记录推导。
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'yaoyao_state_v3';
  var MIN_FS_VERSION = 9490;
  var WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
  var TAB_OF_PAGE = {
    home: 'home',
    checkin: 'home',
    result: 'home',
    calendar: 'calendar',
    day: 'calendar',
    profile: 'profile',
    med: 'profile',
    settings: 'profile',
    leaflet: 'profile'
  };

  var platform = {
    active: false,
    mt: null,
    buildVersion: 0,
    userDataPath: '',
    storage: false,
    fs: false,
    web: false
  };

  var state = createDefaultState();

  var view = {
    page: 'home',
    month: new Date(),
    dateKey: '',
    photoData: '',
    existingPhoto: '',
    quality: null,
    crops: [],
    pillStates: {},
    changed: [],
    status: '',
    dayKey: '',
    dayDraft: '',
    devDate: '',
    skipPhoto: false,
    body: [],
    bodyOther: '',
    loadError: false,
    captureTarget: 'checkin',
    fromPage: 'home',
    breakCheckin: false
  };

  /* ========================================================= 基础工具 */

  function createDefaultState() {
    return {
      version: 5,
      medication: null,
      records: {},
      blister: { size: 21, taken: [] },
      settings: { reminderOn: true, devMode: false, onboarded: false },
      feedback: []
    };
  }

  function $(id) {
    return document.getElementById(id);
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function dateKey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function parseKey(key) {
    var parts = key.split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  function realTodayKey() {
    return dateKey(new Date());
  }

  function todayKey() {
    if (state.settings.devMode && view.devDate) return view.devDate;
    return realTodayKey();
  }

  function isVirtualDate() {
    return !!(state.settings.devMode && view.devDate && view.devDate !== realTodayKey());
  }

  /* 虚拟日期下的“现在”：真实今天用真实时刻，其它日期按当天 23:59 模拟 */
  function simulatedNow(key) {
    var k = key || todayKey();
    if (k === realTodayKey()) return new Date();
    var d = parseKey(k);
    d.setHours(23, 59, 0, 0);
    return d;
  }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function trim(value) {
    return String(value === null || value === undefined ? '' : value).replace(/^\s+|\s+$/g, '');
  }

  var toastTimer = null;
  function toast(message) {
    var el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast is-show';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.className = 'toast';
    }, 2400);
  }

  function statusText(status) {
    if (status === 'taken') return '已确认服用';
    if (status === 'not_taken') return '尚未服用';
    if (status === 'uncertain') return '我不确定';
    return '尚未记录';
  }

  function statusClass(status) {
    if (status === 'taken') return 'ok';
    if (status === 'not_taken') return 'off';
    if (status === 'uncertain') return 'warn';
    return '';
  }

  function pillText(status) {
    if (status === 'filled') return '有药';
    if (status === 'empty') return '空位';
    if (status === 'unknown') return '看不清';
    return '未标记';
  }

  function timeText(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function monthDayText(key) {
    var parts = key.split('-');
    return Number(parts[1]) + '/' + Number(parts[2]);
  }

  function fullDateText(key) {
    var d = parseKey(key);
    return d.getMonth() + 1 + ' 月 ' + d.getDate() + ' 日 · 周' + WEEK_CN[d.getDay()];
  }

  function hhmm(date) {
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function addDays(key, n) {
    var d = parseKey(key);
    d.setDate(d.getDate() + n);
    return dateKey(d);
  }

  function dayDiff(a, b) {
    return Math.round((parseKey(a) - parseKey(b)) / 86400000);
  }

  function shortDate(key) {
    if (!key) return '';
    var parts = String(key).split('-');
    if (parts.length < 3) return '';
    return pad2(Number(parts[1])) + '/' + pad2(Number(parts[2]));
  }

  /* ========================================================= 平台适配 */

  /* Web 兜底存储：小红书容器内不可用 xhs.miniTool 时退到 localStorage（GitHub Pages / 普通浏览器试用） */
  function webStorageAvailable() {
    try {
      if (!window.localStorage) return false;
      var probeKey = '__yaoyao_probe__';
      window.localStorage.setItem(probeKey, '1');
      window.localStorage.removeItem(probeKey);
      return true;
    } catch (err) {
      return false;
    }
  }

  function detectPlatform() {
    var mt = window.xhs && window.xhs.miniTool;
    if (!mt) {
      platform.web = webStorageAvailable();
      return;
    }
    platform.mt = mt;
    platform.active = true;
    platform.storage = typeof mt.setStorage === 'function' && typeof mt.getStorage === 'function';
  }

  function toVersion(value) {
    if (value === null || value === undefined || value === '') return 0;
    var text = String(value);
    if (text.indexOf('.') > -1) {
      var parts = text.split('.');
      return (parseInt(parts[0], 10) || 0) * 1000 +
        (parseInt(parts[1], 10) || 0) * 10 +
        (parseInt(parts[2], 10) || 0);
    }
    return parseInt(text, 10) || 0;
  }

  function initPlatform() {
    var mt = platform.mt;
    if (!mt) return Promise.resolve();

    var task;
    if (typeof mt.getLaunchOptions === 'function') {
      task = mt.getLaunchOptions().then(null, function () { return null; });
    } else {
      task = Promise.resolve(null);
    }

    return task.then(function (options) {
      var env = options && options.miniToolEnv ? options.miniToolEnv : {};
      platform.userDataPath = env.userDataPath || '';
      platform.buildVersion = toVersion(env.buildVersion || (options && options.clientVersion));

      var hasFileApi = typeof mt.mkdir === 'function' &&
        typeof mt.writeFile === 'function' &&
        typeof mt.readFile === 'function';

      platform.fs = hasFileApi &&
        !!platform.userDataPath &&
        (platform.buildVersion === 0 || platform.buildVersion >= MIN_FS_VERSION);
    });
  }

  function loadState() {
    if (!platform.active || !platform.storage) {
      if (platform.web) {
        var webRaw = null;
        try {
          webRaw = window.localStorage.getItem(STORAGE_KEY);
        } catch (err) {
          return Promise.resolve(false);
        }
        if (webRaw) {
          try {
            var webParsed = JSON.parse(webRaw);
            if (webParsed && (webParsed.version === 2 || webParsed.version === 3 || webParsed.version === 4 || webParsed.version === 5)) {
              state = normalizeState(webParsed);
            }
          } catch (err2) {
            /* 数据损坏时忽略，使用默认档案 */
          }
        }
      }
      return Promise.resolve(true);
    }
    return platform.mt.getStorage({ key: STORAGE_KEY }).then(function (res) {
      var raw = res && res.data;
      if (!raw) return true;
      var parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new Error('bad state');
      }
      if (!parsed || (parsed.version !== 2 && parsed.version !== 3 && parsed.version !== 4 && parsed.version !== 5)) return true;
      state = normalizeState(parsed);
      view.loadError = false;
      return true;
    }, function () {
      view.loadError = true;
      return false;
    });
  }

  function normalizeState(input) {
    var next = createDefaultState();
    if (input.medication) {
      var start = input.medication.packStart || input.medication.startDate || '';
      var pauses = [];
      if (Array.isArray(input.medication.pauses)) {
        input.medication.pauses.forEach(function (item) {
          if (!item || !item.start) return;
          pauses.push({ start: item.start, end: item.end || '', keepCount: !!item.keepCount });
        });
      }
      next.medication = {
        name: input.medication.name || '',
        slots: Number(input.medication.slots) || 21,
        time: input.medication.time || '21:00',
        missedAfter: input.medication.missedAfter === 'next_day'
          ? 'next_day'
          : (Number(input.medication.missedAfter) || 2),
        startDate: start,
        packStart: start,
        startPill: Math.max(1, Math.min(Number(input.medication.slots) || 21, Number(input.medication.startPill) || 1)),
        packNo: Number(input.medication.packNo) || 1,
        hasBreak: input.medication.hasBreak !== false,
        note: input.medication.note || '',
        pauses: pauses,
        leaflet: Array.isArray(input.medication.leaflet)
          ? input.medication.leaflet.filter(function (p) { return typeof p === 'string' && p; })
          : []
      };
    }
    if (input.records && typeof input.records === 'object') {
      var keys = Object.keys(input.records);
      keys.forEach(function (key) {
        var item = input.records[key] || {};
        next.records[key] = {
          status: item.status === 'taken' || item.status === 'not_taken' || item.status === 'uncertain' ? item.status : '',
          pillIndex: Number(item.pillIndex) || 0,
          packNo: Number(item.packNo) || 0,
          photo: item.photo || '',
          pillStates: item.pillStates && typeof item.pillStates === 'object' ? item.pillStates : {},
          changed: Array.isArray(item.changed) ? item.changed : [],
          quality: item.quality || null,
          body: item.body && typeof item.body === 'object' ? {
            reactions: Array.isArray(item.body.reactions) ? item.body.reactions : [],
            note: item.body.note || ''
          } : null,
          takenAt: item.takenAt || '',
          createdAt: item.createdAt || '',
          updatedAt: item.updatedAt || ''
        };
      });
    }
    if (input.blister && typeof input.blister === 'object') {
      next.blister.size = Number(input.blister.size) || 21;
      next.blister.taken = Array.isArray(input.blister.taken) ? input.blister.taken : [];
    }
    if (input.settings && typeof input.settings === 'object') {
      next.settings.reminderOn = input.settings.reminderOn !== false;
      next.settings.devMode = input.settings.devMode === true;
      next.settings.onboarded = input.settings.onboarded === true;
    }
    if (Array.isArray(input.feedback)) {
      next.feedback = input.feedback.slice(0, 20);
    }
    return next;
  }

  function persist() {
    if (!platform.active) {
      if (!platform.web) return Promise.resolve(false);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        return Promise.resolve(true);
      } catch (err) {
        toast('浏览器存储写入失败，记录可能没有保存');
        return Promise.resolve(false);
      }
    }
    if (!platform.storage) {
      toast('当前客户端不支持本地存储，记录无法保存');
      return Promise.resolve(false);
    }
    return platform.mt.setStorage({
      key: STORAGE_KEY,
      data: JSON.stringify(state)
    }).then(function (res) {
      if (res && res.errMsg === 'setStorage:ok') return true;
      toast('保存失败，请重试');
      return false;
    }, function () {
      toast('本机写入失败，记录可能没有保存');
      return false;
    });
  }

  function savePhoto(dataUrl) {
    if (!platform.fs) return Promise.resolve('');
    var base64 = dataUrl.indexOf(',') > -1 ? dataUrl.split(',')[1] : dataUrl;
    var dir = platform.userDataPath + '/photos';
    var filePath = dir + '/' + (view.dateKey || todayKey()) + '.jpg';

    return platform.mt.mkdir({ dirPath: dir, recursive: true }).then(null, function () {
      return null;
    }).then(function () {
      return platform.mt.writeFile({ filePath: filePath, data: base64, encoding: 'base64' });
    }).then(function () {
      return filePath;
    }, function () {
      toast('照片保存失败，这条记录将不含照片');
      return '';
    });
  }

  /* ========================================================= 业务数据 */

  function blisterSize() {
    if (state.medication && Number(state.medication.slots)) {
      return Number(state.medication.slots);
    }
    return state.blister.size || 21;
  }

  function packNo() {
    return state.medication ? (Number(state.medication.packNo) || 1) : 1;
  }

  function packStart() {
    var med = state.medication;
    if (!med) return todayKey();
    return med.packStart || med.startDate || todayKey();
  }

  function startPill() {
    if (!state.medication) return 1;
    return Math.max(1, Math.min(blisterSize(), Number(state.medication.startPill) || 1));
  }

  function hasBreakPeriod() {
    var med = state.medication;
    return !!(med && Number(med.slots) === 21 && med.hasBreak !== false);
  }

  function pauseList() {
    var med = state.medication;
    return med && Array.isArray(med.pauses) ? med.pauses : [];
  }

  function activePause(key) {
    var list = pauseList();
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (key >= p.start && (!p.end || key < p.end)) return p;
    }
    return null;
  }

  function isPausedDate(key) {
    return !!activePause(key);
  }

  function upcomingPause(key) {
    var list = pauseList();
    for (var i = 0; i < list.length; i++) {
      if (!list[i].end && list[i].start > key) return list[i];
    }
    return null;
  }

  function pauseDayNumber(key) {
    var p = activePause(key);
    return p ? dayDiff(key, p.start) + 1 : 0;
  }

  function pauseScheduleEnd(p) {
    return p.end || addDays(todayKey(), 1);
  }

  function isPausedForSchedule(key) {
    var list = pauseList();
    var start = packStart();
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.keepCount) continue;
      if (p.start < start) continue;
      if (key >= p.start && key < pauseScheduleEnd(p)) return true;
    }
    return false;
  }

  function pausedDaysBefore(key) {
    var list = pauseList();
    var start = packStart();
    var total = 0;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.keepCount) continue;
      if (p.start < start) continue;
      var end = pauseScheduleEnd(p);
      if (end > key) end = key;
      if (p.start < key && end > p.start) total += dayDiff(end, p.start);
    }
    return total;
  }

  function pillDateOf(index) {
    var size = blisterSize();
    var target = Math.max(1, Math.min(Number(index) || 1, size));
    if (target < startPill()) return '';
    var d = packStart();
    var count = startPill() - 1;
    var guard = 0;
    while (guard < 2000) {
      if (!isPausedForSchedule(d)) {
        count++;
        if (count === target) return d;
      }
      d = addDays(d, 1);
      guard++;
    }
    return d;
  }

  function breakDateOf(day) {
    return addDays(pillDateOf(blisterSize()), Number(day) - 1);
  }

  function pillIndexOn(key) {
    if (!state.medication || isPausedDate(key)) return 0;
    var diff = dayDiff(key, packStart()) - pausedDaysBefore(key);
    if (diff < 0 || diff >= blisterSize() - startPill() + 1) return 0;
    return diff + startPill();
  }

  function breakDayNumber(key) {
    if (!hasBreakPeriod() || isPausedDate(key)) return 0;
    var diff = dayDiff(key, pillDateOf(blisterSize()));
    if (diff >= 1 && diff <= 7) return diff;
    return 0;
  }

  function pillCellInfo(index) {
    if (index < startPill()) {
      return { key: '', state: 'unrecorded', dateText: '未记录' };
    }
    var key = pillDateOf(index);
    var rec = state.records[key];
    var today = todayKey();
    if (rec && rec.status === 'taken') {
      return { key: key, state: 'taken', dateText: shortDate(key) };
    }
    if (rec && rec.status === 'uncertain') return { key: key, state: 'uncertain', dateText: '' };
    if (key > today) return { key: key, state: 'upcoming', dateText: '' };
    if (key === today) {
      if (missedInfo(key)) return { key: key, state: 'missed', dateText: '' };
      return { key: key, state: 'pending', dateText: '' };
    }
    return { key: key, state: 'missed', dateText: '' };
  }

  function takenPillCount() {
    var count = 0;
    var size = blisterSize();
    for (var i = 1; i <= size; i++) {
      if (pillCellInfo(i).state === 'taken') count++;
    }
    return count;
  }

  function blisterFootText() {
    var med = state.medication;
    if (!med) return '先建立档案，再设置服药时间';
    if (isPausedDate(todayKey())) {
      return '手动停止服药第 ' + pauseDayNumber(todayKey()) + ' 天 · 无需记录';
    }
    var bd = breakDayNumber(todayKey());
    if (bd) return '今天停药期第 ' + bd + ' 天';
    var idx = pillIndexOn(todayKey());
    var todayRec = state.records[todayKey()];
    if (idx && todayRec && todayRec.status === 'taken') {
      return '今天第 ' + idx + ' 片 · 已服 ' +
        (timeText(todayRec.takenAt || todayRec.updatedAt || todayRec.createdAt) || '--');
    }
    if (idx) return '今天第 ' + idx + ' 片 · 习惯时间 ' + (med.time || '21:00');
    if (todayKey() > pillDateOf(blisterSize())) return '本板已服完，记得换新板';
    return '本板从 ' + shortDate(packStart()) + ' 开始';
  }

  function missedAfterValue() {
    var med = state.medication;
    if (!med) return 2;
    if (med.missedAfter === 'next_day') return 'next_day';
    var n = Number(med.missedAfter);
    if (!n || n <= 0) return 2;
    return Math.min(24, Math.max(1, n));
  }

  function reminderDateOf(key) {
    var med = state.medication;
    var text = (med && med.time) ? String(med.time) : '21:00';
    var parts = text.split(':');
    var d = parseKey(key);
    d.setHours(Number(parts[0]) || 0, Number(parts[1]) || 0, 0, 0);
    return d;
  }

  /* 从这一刻起算作漏服：设定时间 + 漏服阈值，或第二天 0 点 */
  function missedSinceOf(key) {
    var after = missedAfterValue();
    if (after === 'next_day') {
      var next = parseKey(key);
      next.setDate(next.getDate() + 1);
      next.setHours(0, 0, 0, 0);
      return next;
    }
    return new Date(reminderDateOf(key).getTime() + after * 3600000);
  }

  function formatDuration(ms) {
    var total = Math.max(0, Math.floor(ms / 60000));
    var h = Math.floor(total / 60);
    var m = total % 60;
    if (h <= 0) return m + ' 分钟';
    if (m === 0) return h + ' 小时';
    return h + ' 小时 ' + m + ' 分钟';
  }

  function missedInfo(key) {
    var med = state.medication;
    if (!med) return null;
    var now = simulatedNow(key);
    if (now.getTime() < missedSinceOf(key).getTime()) return null;
    var late = now.getTime() - reminderDateOf(key).getTime();
    return { ms: late, text: formatDuration(late) };
  }

  function isPastReminder() {
    var med = state.medication;
    if (!med || !med.time) return false;
    return simulatedNow(todayKey()).getTime() >= reminderDateOf(todayKey()).getTime();
  }

  function previousRecordBefore(key, needMarked) {
    var best = '';
    var keys = Object.keys(state.records);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k >= key) continue;
      var rec = state.records[k];
      if (!rec) continue;
      if (needMarked && !(rec.pillStates && Object.keys(rec.pillStates).length)) continue;
      if (!best || k > best) best = k;
    }
    return best ? { key: best, record: state.records[best] } : null;
  }

  function previousPhotoBefore(key) {
    var keys = Object.keys(state.records).sort();
    for (var i = keys.length - 1; i >= 0; i--) {
      var k = keys[i];
      if (k >= key) continue;
      if (state.records[k] && state.records[k].photo) {
        return { key: k, record: state.records[k] };
      }
    }
    return null;
  }

  function computeChanged() {
    var prev = previousRecordBefore(view.dateKey || todayKey(), true);
    if (!prev) return [];
    var out = [];
    var size = blisterSize();
    for (var i = 1; i <= size; i++) {
      var cur = view.pillStates[i];
      var old = prev.record.pillStates[i];
      if (cur && old && cur !== old) out.push(i);
    }
    return out;
  }

  function countPills() {
    var filled = 0;
    var empty = 0;
    var unknown = 0;
    var size = blisterSize();
    for (var i = 1; i <= size; i++) {
      var st = view.pillStates[i];
      if (st === 'filled') filled++;
      else if (st === 'empty') empty++;
      else if (st === 'unknown') unknown++;
    }
    return {
      filled: filled,
      empty: empty,
      unknown: unknown,
      marked: filled + empty + unknown,
      total: size
    };
  }

  function monthStats(year, month) {
    var days = new Date(year, month + 1, 0).getDate();
    var today = todayKey();
    var stats = { taken: 0, notTaken: 0, uncertain: 0, paused: 0, none: 0 };
    for (var day = 1; day <= days; day++) {
      var key = year + '-' + pad2(month + 1) + '-' + pad2(day);
      if (key > today) continue;
      var rec = state.records[key];
      if (isPausedDate(key)) {
        if (!rec) { stats.paused++; continue; }
      }
      if (!rec) stats.none++;
      else if (rec.status === 'taken') stats.taken++;
      else if (rec.status === 'not_taken') stats.notTaken++;
      else stats.uncertain++;
    }
    return stats;
  }

  function percentText(part, total) {
    return total ? Math.round(part / total * 100) + '%' : '0%';
  }

  function adverseReactions(record) {
    return record && record.body && Array.isArray(record.body.reactions)
      ? record.body.reactions
      : [];
  }

  function scheduledPillOn(key) {
    var current = pillIndexOn(key);
    if (current) return current;
    var record = state.records[key];
    return record && Number(record.pillIndex) ? Number(record.pillIndex) : 0;
  }

  function buildRecordStats() {
    var stats = {
      recordDays: 0,
      takenDays: 0,
      missedDays: 0,
      uncertainDays: 0,
      dueDays: 0,
      bodyDays: 0,
      adverseDays: 0,
      fullPacks: 0,
      months: {},
      years: {},
      reactions: {},
      cycles: {},
      cycleList: []
    };
    var today = todayKey();
    var keyMap = {};
    Object.keys(state.records).forEach(function (key) { keyMap[key] = true; });

    if (state.medication) {
      var d = packStart();
      var guard = 0;
      while (d <= today && guard < 2000) {
        keyMap[d] = true;
        d = addDays(d, 1);
        guard++;
      }
    }

    Object.keys(keyMap).sort().forEach(function (key) {
      if (key > today) return;
      var record = state.records[key];
      var reactions = adverseReactions(record);
      var hasBody = !!(record && record.body);
      if (record && record.status) stats.recordDays++;
      if (hasBody) {
        stats.bodyDays++;
        if (reactions.length) {
          stats.adverseDays++;
          reactions.forEach(function (name) {
            stats.reactions[name] = (stats.reactions[name] || 0) + 1;
          });
        }
      }

      var paused = isPausedDate(key);
      var breakNo = breakDayNumber(key);
      var pill = scheduledPillOn(key);
      if (!pill || paused || breakNo) return;

      var taken = !!(record && record.status === 'taken');
      var uncertain = !!(record && record.status === 'uncertain');
      var missed = !taken && !uncertain && (key < today || !!missedInfo(key));
      stats.dueDays++;
      if (taken) stats.takenDays++;
      if (uncertain) stats.uncertainDays++;
      if (missed) stats.missedDays++;

      var monthKey = key.slice(0, 7);
      var yearKey = key.slice(0, 4);
      if (!stats.months[monthKey]) stats.months[monthKey] = { taken: 0, missed: 0, uncertain: 0 };
      if (!stats.years[yearKey]) stats.years[yearKey] = { taken: 0, missed: 0, uncertain: 0 };
      if (taken) {
        stats.months[monthKey].taken++;
        stats.years[yearKey].taken++;
      } else if (uncertain) {
        stats.months[monthKey].uncertain++;
        stats.years[yearKey].uncertain++;
      } else if (missed) {
        stats.months[monthKey].missed++;
        stats.years[yearKey].missed++;
      }

      var cycleNo = record && Number(record.packNo)
        ? Number(record.packNo)
        : (pillIndexOn(key) ? packNo() : 0);
      if (!cycleNo) return;
      if (!stats.cycles[cycleNo]) {
        stats.cycles[cycleNo] = {
          packNo: cycleNo,
          days: 0,
          recorded: 0,
          taken: 0,
          missed: 0,
          bodyDays: 0,
          adverseDays: 0,
          pills: {},
          recordedPills: {},
          full: false
        };
      }
      var cycle = stats.cycles[cycleNo];
      cycle.days++;
      cycle.pills[pill] = true;
      if (record && record.status) {
        cycle.recorded++;
        cycle.recordedPills[pill] = true;
      }
      if (taken) cycle.taken++;
      if (missed) cycle.missed++;
      if (hasBody) cycle.bodyDays++;
      if (reactions.length) cycle.adverseDays++;
    });

    Object.keys(stats.cycles).forEach(function (key) {
      var cycle = stats.cycles[key];
      var expected = cycle.packNo === packNo()
        ? blisterSize() - startPill() + 1
        : blisterSize();
      cycle.full = Object.keys(cycle.recordedPills).length >= expected;
      if (cycle.full) stats.fullPacks++;
      stats.cycleList.push(cycle);
    });
    stats.cycleList.sort(function (a, b) { return b.packNo - a.packNo; });
    return stats;
  }

  function metricHtml(label, value, note) {
    return '<div class="metric-item"><span>' + label + '</span><strong>' + value + '</strong>' +
      (note ? '<small>' + note + '</small>' : '') + '</div>';
  }

  function renderRecordStats(year, month) {
    var stats = buildRecordStats();
    $('recordOverview').innerHTML =
      metricHtml('完整记录药板', stats.fullPacks + ' 板', '有效药位均有记录') +
      metricHtml('服药天数', stats.takenDays + ' 天', '不含停药与手动停药') +
      metricHtml('记录天数', stats.recordDays + ' 天', '所有已确认记录') +
      metricHtml('漏服次数', stats.missedDays + ' 次', '按当前漏服规则') +
      metricHtml('漏服率', percentText(stats.missedDays, stats.dueDays), '漏服 / 应服药天数') +
      metricHtml('身体状态记录', stats.bodyDays + ' 天', '含良好与不适');

    var selected = stats.months[year + '-' + pad2(month + 1)] || { taken: 0, missed: 0, uncertain: 0 };
    $('monthSummary').innerHTML =
      '<span>本月已服<b>' + selected.taken + '</b></span>' +
      '<span>漏服<b>' + selected.missed + '</b></span>' +
      '<span>不确定<b>' + selected.uncertain + '</b></span>';

    $('chartYear').textContent = year + ' 年';
    var maxMonth = 0;
    var m;
    for (m = 0; m < 12; m++) {
      var item = stats.months[year + '-' + pad2(m + 1)] || { taken: 0, missed: 0, uncertain: 0 };
      maxMonth = Math.max(maxMonth, item.taken + item.missed + item.uncertain);
    }
    var monthHtml = '';
    for (m = 0; m < 12; m++) {
      var data = stats.months[year + '-' + pad2(m + 1)] || { taken: 0, missed: 0, uncertain: 0 };
      var total = data.taken + data.missed + data.uncertain;
      var height = maxMonth && total ? Math.max(8, Math.round(total / maxMonth * 100)) : 0;
      monthHtml += '<div class="month-col" title="' + (m + 1) + ' 月：已服 ' + data.taken +
        ' 天，漏服 ' + data.missed + ' 次，不确定 ' + data.uncertain + ' 天">' +
        '<div class="month-track"><div class="month-stack' + (total ? '' : ' is-zero') + '" style="height:' + height + '%">' +
        '<i class="seg-uncertain" style="height:' + (total ? data.uncertain / total * 100 : 0) + '%"></i>' +
        '<i class="seg-missed" style="height:' + (total ? data.missed / total * 100 : 0) + '%"></i>' +
        '<i class="seg-taken" style="height:' + (total ? data.taken / total * 100 : 0) + '%"></i>' +
        '</div></div><span>' + (m + 1) + '月</span></div>';
    }
    $('monthChart').innerHTML = monthHtml;

    var years = Object.keys(stats.years);
    if (years.indexOf(String(year)) === -1) years.push(String(year));
    years.sort(function (a, b) { return Number(b) - Number(a); });
    var maxYear = 0;
    years.forEach(function (y) {
      var item = stats.years[y] || { taken: 0, missed: 0, uncertain: 0 };
      maxYear = Math.max(maxYear, item.taken + item.missed + item.uncertain);
    });
    var yearHtml = '';
    years.forEach(function (y) {
      var item = stats.years[y] || { taken: 0, missed: 0, uncertain: 0 };
      var total = item.taken + item.missed + item.uncertain;
      yearHtml += '<div class="year-row"><span>' + y + '</span>' +
        '<div class="year-track">' +
        '<i class="seg-taken" style="width:' + (maxYear ? item.taken / maxYear * 100 : 0) + '%"></i>' +
        '<i class="seg-missed" style="width:' + (maxYear ? item.missed / maxYear * 100 : 0) + '%"></i>' +
        '<i class="seg-uncertain" style="width:' + (maxYear ? item.uncertain / maxYear * 100 : 0) + '%"></i>' +
        '</div><b>' + total + ' 天</b></div>';
    });
    $('yearChart').innerHTML = yearHtml;

    $('bodyOverview').innerHTML =
      metricHtml('不良反应天数', stats.adverseDays + ' 天', '有任一不适') +
      metricHtml('不良反应率', percentText(stats.adverseDays, stats.bodyDays), '不适 / 身体记录') +
      metricHtml('良好天数', Math.max(0, stats.bodyDays - stats.adverseDays) + ' 天', '无不适记录');

    var reactionNames = ['痛经', '出血', '恶心', '其他'];
    var maxReaction = 0;
    reactionNames.forEach(function (name) {
      maxReaction = Math.max(maxReaction, stats.reactions[name] || 0);
    });
    var reactionHtml = '';
    reactionNames.forEach(function (name) {
      var count = stats.reactions[name] || 0;
      reactionHtml += '<div class="reaction-row"><span>' + name + '</span>' +
        '<div class="reaction-track"><i style="width:' + (maxReaction ? count / maxReaction * 100 : 0) + '%"></i></div>' +
        '<b>' + count + ' 天</b></div>';
    });
    $('reactionChart').innerHTML = reactionHtml;

    var adverseCycles = stats.cycleList.filter(function (cycle) { return cycle.adverseDays > 0; }).length;
    $('cycleSummary').innerHTML = stats.cycleList.length
      ? '<div class="cycle-summary"><strong>' + adverseCycles + ' / ' + stats.cycleList.length + '</strong>' +
        '<span>个服药周期有不良反应 · 周期比率 ' + percentText(adverseCycles, stats.cycleList.length) + '</span></div>'
      : '<p class="empty">还没有可统计的服药周期。</p>';

    var cycleHtml = '';
    stats.cycleList.forEach(function (cycle) {
      var rate = percentText(cycle.adverseDays, cycle.bodyDays);
      var width = cycle.bodyDays ? cycle.adverseDays / cycle.bodyDays * 100 : 0;
      cycleHtml += '<div class="cycle-item">' +
        '<div class="cycle-top"><strong>第 ' + cycle.packNo + ' 板' +
        (cycle.full ? '<span class="cycle-badge">完整记录</span>' : '') + '</strong>' +
        '<span>不适 ' + cycle.adverseDays + ' / ' + cycle.bodyDays + ' 天 · ' + rate + '</span></div>' +
        '<div class="cycle-track"><i style="width:' + width + '%"></i></div>' +
        '<p>服药 ' + cycle.taken + ' 天 · 漏服 ' + cycle.missed + ' 次 · 有效记录 ' + cycle.recorded + ' 天</p></div>';
    });
    $('cycleStats').innerHTML = cycleHtml;
  }

  /* ========================================================= 图片处理 */

  function finalizeQuality(q) {
    if (!q) return null;
    q.score = Math.max(20, Math.min(100, Math.round(q.score)));
    q.label = q.score >= 85 ? '良好' : (q.score >= 65 ? '一般' : '较差');
    return q;
  }

  function analyzeImage(img) {
    var maxSide = 220;
    var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    var w = Math.max(1, Math.round(img.width * scale));
    var h = Math.max(1, Math.round(img.height * scale));
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);

    var data = null;
    try {
      data = ctx.getImageData(0, 0, w, h).data;
    } catch (err) {
      return { score: 80, issues: ['无法读取照片像素，只能依据画面自行判断'], brightness: 128, sharpness: 100, contrast: 30 };
    }

    var gray = new Array(w * h);
    var sum = 0;
    for (var i = 0, j = 0; i < data.length; i += 4, j++) {
      var g = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      gray[j] = g;
      sum += g;
    }
    var mean = sum / (w * h);
    var varSum = 0;
    for (var k = 0; k < gray.length; k++) {
      var d = gray[k] - mean;
      varSum += d * d;
    }
    var std = Math.sqrt(varSum / gray.length);

    var lapSum = 0;
    var lapSq = 0;
    var n = 0;
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var idx = y * w + x;
        var lap = 4 * gray[idx] - gray[idx - 1] - gray[idx + 1] - gray[idx - w] - gray[idx + w];
        lapSum += lap;
        lapSq += lap * lap;
        n++;
      }
    }
    var lapVar = n ? Math.max(0, lapSq / n - (lapSum / n) * (lapSum / n)) : 0;

    var issues = [];
    var score = 100;

    if (mean < 50) {
      issues.push('照片整体偏暗，建议在更亮的地方重拍');
      score -= 24;
    } else if (mean > 250) {
      issues.push('照片偏亮，可能过曝，药位细节会丢失');
      score -= 12;
    }
    if (lapVar < 40) {
      issues.push('画面偏模糊，拍摄时尽量拿稳手机');
      score -= 30;
    } else if (lapVar < 80) {
      score -= 10;
    }
    if (std < 12) {
      issues.push('明暗对比偏低，药板轮廓不够清楚');
      score -= 12;
    }

    return {
      score: score,
      issues: issues,
      brightness: Math.round(mean),
      sharpness: Math.round(lapVar),
      contrast: Math.round(std)
    };
  }

  function compressImage(file, callback) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var quality = analyzeImage(img);

        if (img.width < 600 || img.height < 600) {
          quality.issues.push('照片分辨率偏低，尽量用原相机拍摄整板');
          quality.score -= 10;
        }
        quality = finalizeQuality(quality);

        var maxSide = 1000;
        var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        var dataUrl = '';
        try {
          dataUrl = canvas.toDataURL('image/jpeg', 0.72);
        } catch (err) {
          dataUrl = '';
        }
        callback(dataUrl, quality);
      };
      img.onerror = function () { callback('', null); };
      img.src = reader.result;
    };
    reader.onerror = function () { callback('', null); };
    reader.readAsDataURL(file);
  }

  function buildCrops(dataUrl, slots, callback) {
    var img = new Image();
    img.onload = function () {
      var cols = 7;
      var rows = Math.ceil(slots / 7);
      var cw = img.width / cols;
      var ch = img.height / rows;
      var crops = [];

      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          var index = r * cols + c + 1;
          if (index > slots) break;

          var padX = cw * 0.1;
          var padY = ch * 0.1;
          var side = Math.min(cw - padX * 2, ch - padY * 2);
          var cx = c * cw + cw / 2;
          var cy = r * ch + ch / 2;
          var sx = Math.max(0, Math.min(img.width - side, cx - side / 2));
          var sy = Math.max(0, Math.min(img.height - side, cy - side / 2));

          var canvas = document.createElement('canvas');
          canvas.width = 260;
          canvas.height = 260;
          var ctx = canvas.getContext('2d');
          try {
            ctx.drawImage(img, sx, sy, side, side, 0, 0, 260, 260);
            crops.push(canvas.toDataURL('image/jpeg', 0.7));
          } catch (err) {
            crops.push('');
          }
        }
      }
      callback(crops);
    };
    img.onerror = function () { callback([]); };
    img.src = dataUrl;
  }

  /* ========================================================= 渲染：公共 */

  function renderAll() {
    renderHome();
    renderMascot();
    renderCheckin();
    renderResult();
    renderCalendar();
    renderProfile();
    renderSettings();
    renderMedForm();
  }

  /* ========================================================= 渲染：首页 */

  var MASCOT_LABEL = {
    taken: '今天已服药',
    pending: '今天待服药',
    missed: '今天漏服',
    break: '停药期',
    paused: '手动停止服药',
    uncertain: '今天不确定',
    empty: '尚未建立档案',
    finished: '本板已服完'
  };

  function mascotState() {
    var med = state.medication;
    if (!med) return 'empty';
    var key = todayKey();
    if (activePause(key)) return 'paused';
    if (breakDayNumber(key)) return 'break';
    var rec = state.records[key];
    if (rec) {
      if (rec.status === 'taken') return 'taken';
      if (rec.status === 'not_taken') return 'missed';
      return 'uncertain';
    }
    if (dayDiff(key, packStart()) >= blisterSize()) return 'finished';
    if (pillIndexOn(key) && state.settings.reminderOn && missedInfo(key)) return 'missed';
    return 'pending';
  }

  function renderMascot() {
    var btn = $('mascotBtn');
    if (!btn) return;
    var name = mascotState();
    btn.className = 'mascot state-' + name;
    btn.setAttribute('aria-label', '我的 · ' + (MASCOT_LABEL[name] || '状态'));
    btn.setAttribute('title', MASCOT_LABEL[name] || '我的');
  }

  function renderReminderList(container, items) {
    if (!container) return;
    container.innerHTML = '';
    if (!items || !items.length) { container.hidden = true; return; }
    container.hidden = false;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var row = document.createElement('div');
      row.className = 'tr-item tr-' + it.level;
      if (it.level === 'hint') {
        row.textContent = it.text;
      } else {
        var badge = document.createElement('span');
        badge.className = 'tr-badge';
        badge.textContent = it.level === 'alert' ? '告警' : '提醒';
        var txt = document.createElement('span');
        txt.className = 'tr-text';
        txt.textContent = it.text;
        row.appendChild(badge);
        row.appendChild(txt);
        if (it.action) {
          var btn = document.createElement('button');
          btn.className = 'link-btn';
          btn.setAttribute('data-action', it.action);
          btn.textContent = it.actionText || '查看';
          row.appendChild(btn);
        }
      }
      container.appendChild(row);
    }
  }

  function renderHome() {
    var today = todayKey();
    var shown = parseKey(today);
    $('homeDate').textContent = (shown.getMonth() + 1) + ' 月 ' + shown.getDate() + ' 日';
    $('homeWeek').textContent = '周' + WEEK_CN[shown.getDay()] +
      (isVirtualDate() ? ' · 虚拟日期' : ' · ' + hhmm(new Date()));

    $('loadErrorNotice').hidden = !view.loadError;

    var record = state.records[todayKey()];
    var med = state.medication;
    var card = $('todayCard');
    var statusEl = $('todayStatus');
    var title = $('todayTitle');
    var lead = $('todayLead');
    var secondary = $('todaySecondary');
    var captureLabel = $('captureLabel');
    var captureBtn = $('captureBtn');

    card.className = 'today-card today-hero';
    secondary.hidden = true;
    captureBtn.className = 'shutter';
    captureBtn.hidden = false;
    captureBtn.setAttribute('data-action', 'start-checkin');

    var breakNo = med ? breakDayNumber(todayKey()) : 0;
    var paused = med ? activePause(todayKey()) : null;
    var pendingPause = med ? upcomingPause(todayKey()) : null;
    var pillIdx = med ? pillIndexOn(todayKey()) : 0;
    var pillPrefix = pillIdx ? '第 ' + pillIdx + ' 片 · ' : '';
    var canSwitch = !!med && (!!paused || (!breakNo && todayKey() <= pillDateOf(blisterSize())));
    var showMissedAlert = false;

    $('recordSwitch').hidden = !canSwitch;
    $('pauseOpt').className = 'rs-opt' + (paused ? ' is-on' : '');
    $('resumeOpt').className = 'rs-opt' + (paused ? '' : ' is-on');

    if (paused) {
      card.className = 'today-card today-hero is-paused';
      captureBtn.className = 'shutter is-paused';
      captureBtn.setAttribute('data-action', '');
      statusEl.className = 'status paused';
      statusEl.textContent = '手动停药';
      title.textContent = '手动停止服药第 ' + pauseDayNumber(todayKey()) + ' 天';
      lead.textContent = '记录已暂停，点右下角「继续记录」可以随时恢复。';
      captureLabel.textContent = '暂停中';
      if (record) {
        secondary.hidden = false;
        secondary.textContent = '查看今天的记录';
      }
    } else if (!med) {
      card.className = 'today-card today-hero is-empty';
      captureBtn.className = 'shutter is-empty';
      statusEl.className = 'status pending';
      statusEl.textContent = '待建立档案';
      title.textContent = '先建立药品档案';
      lead.textContent = '点一下圆圈，填写药品名称和药位数，药药就能按你的药板来记录。';
      captureLabel.textContent = '建立档案';
    } else if (breakNo) {
      card.className = 'today-card today-hero is-break';
      captureBtn.className = 'shutter is-break';
      captureBtn.setAttribute('data-action', 'break-checkin');
      captureBtn.setAttribute('aria-label', '停药期快速打卡');
      statusEl.className = 'status break';
      statusEl.textContent = '停药期';
      title.textContent = '今天是停药期第 ' + breakNo + ' 天';
      lead.textContent = record
        ? '今天已打卡。停药期也可以每天打开记一下身体状况，保持习惯不容易漏服。'
        : '本板药片已经服完，接下来 7 天无需服药。每天打开记一下身体状况，保持习惯不容易漏服。';
      captureLabel.textContent = record ? '再记一下' : '快速打卡';
      if (record) {
        secondary.hidden = false;
        secondary.textContent = '查看今天的记录';
      }
    } else if (!record && todayKey() > pillDateOf(blisterSize())) {
      card.className = 'today-card today-hero is-empty';
      captureBtn.className = 'shutter is-empty';
      captureBtn.setAttribute('data-action', 'new-blister');
      statusEl.className = 'status pending';
      statusEl.textContent = '本板已结束';
      title.textContent = '这一板已经服完';
      lead.textContent = '点一下圆圈换到下一板，药板会从今天重新开始。';
      captureLabel.textContent = '换新板';
    } else if (!record) {
      var missed = (med && pillIdx) ? missedInfo(todayKey()) : null;
      if (state.settings.reminderOn && missed) {
        card.className = 'today-card today-hero is-missed';
        captureBtn.className = 'shutter is-missed';
        statusEl.className = 'status off';
        statusEl.textContent = '漏服';
        title.textContent = '漏服 ' + missed.text;
        lead.textContent = '今天该吃第 ' + pillIdx + ' 片，已经超过习惯服药时间。' +
          '如果其实已经吃了，点一下圆圈补记今天的服药情况。';
        captureLabel.textContent = '补记今天';
        showMissedAlert = true;
      } else if (state.settings.reminderOn && isPastReminder()) {
        captureBtn.className = 'shutter is-pending';
        card.className = 'today-card today-hero is-pending';
        statusEl.className = 'status pending';
        statusEl.textContent = '待确认';
        title.textContent = '已经过了你平时的服药时间';
        lead.textContent = '今天还没有记录。' + (pillIdx ? '今天该吃第 ' + pillIdx + ' 片，' : '') +
          '点一下圆圈拍照，再确认服药情况。';
        captureLabel.textContent = '点一下拍照';
      } else {
        captureBtn.className = 'shutter is-pending';
        card.className = 'today-card today-hero is-empty';
        statusEl.className = 'status';
        statusEl.textContent = '尚未记录';
        title.textContent = '今天还没有记录';
        lead.textContent = pillIdx
          ? '今天该吃第 ' + pillIdx + ' 片，点一下圆圈拍照记录。'
          : '点一下圆圈拍张药板照片，再确认今天的服药情况。';
        captureLabel.textContent = '点一下拍照';
      }
    } else if (record.status === 'taken') {
      card.className = 'today-card today-hero is-done';
      captureBtn.className = 'shutter is-taken';
      statusEl.className = 'status ok';
      statusEl.textContent = '已记录';
      title.textContent = '今天已确认服用';
      lead.textContent = pillPrefix + '记录时间 ' +
        (timeText(record.takenAt || record.updatedAt || record.createdAt) || '--') + '。';
      captureLabel.textContent = '重新拍照';
      secondary.hidden = false;
      secondary.textContent = '查看今天的记录';
    } else if (record.status === 'not_taken') {
      card.className = 'today-card today-hero is-missed';
      captureBtn.className = 'shutter is-missed';
      statusEl.className = 'status off';
      statusEl.textContent = '尚未服用';
      title.textContent = '今天标记为尚未服用';
      lead.textContent = '今天还没有吃，先如实记下。点圆圈可以重新记录。';
      captureLabel.textContent = '重新记录';
      showMissedAlert = true;
      secondary.hidden = false;
      secondary.textContent = '查看今天的记录';
    } else {
      card.className = 'today-card today-hero is-uncertain';
      captureBtn.className = 'shutter is-uncertain';
      statusEl.className = 'status warn';
      statusEl.textContent = '不确定';
      title.textContent = '今天的记录是不确定';
      lead.textContent = '记不清也没关系，如实记录比猜测更有用。点圆圈可以重新拍照。';
      captureLabel.textContent = '重新记录';
      secondary.hidden = false;
      secondary.textContent = '查看今天的记录';
    }

    if (!paused && pendingPause && !breakNo && todayKey() <= pillDateOf(blisterSize())) {
      lead.textContent += ' 已安排' +
        (pendingPause.start === addDays(todayKey(), 1) ? '明天' : ' ' + monthDayText(pendingPause.start)) +
        '开始停止服药。';
    }
    // 今日卡分级提醒：提示 / 提醒（黄）/ 告警（红）
    var reminders = [];
    if (showMissedAlert) {
      reminders.push({ level: 'alert', text: '漏服后的处理请以药品说明书为准，或咨询医生/药师。', action: 'open-leaflet', actionText: '查看说明书' });
    }
    if (med && !breakNo && !paused && pillIdx > 0 && todayKey() <= pillDateOf(blisterSize())) {
      var takenToday = !!(record && record.status === 'taken');
      var remaining = blisterSize() - pillIdx + (takenToday ? 0 : 1);
      if (remaining > 0 && remaining <= 5) {
        reminders.push({ level: 'reminder', text: '本板还剩 ' + remaining + ' 颗，药品不足，请提前采购和准备。' });
      }
    }
    renderReminderList($('todayReminders'), reminders);

    $('heroFoot').hidden = secondary.hidden && !canSwitch;

    renderBlister();
    renderStats();
    renderRecent();
    renderDevPanel();
  }

  function renderDevPanel() {
    var panel = $('devPanel');
    if (!panel) return;
    var on = !!state.settings.devMode;
    panel.hidden = !on;
    if (!on) return;
    if (!view.devDate) view.devDate = realTodayKey();
    $('devDateText').textContent = fullDateText(view.devDate) +
      (view.devDate === realTodayKey() ? ' · 今天' : '');
    $('devHint').textContent = state.records[view.devDate] ? '这一天已有记录' : '虚拟今天';
  }

  function devAddRecord(status) {
    if (!state.medication) {
      toast('先建立药品档案');
      return;
    }
    var key = view.devDate || todayKey();
    var prev = state.records[key] || {};
    var now = new Date().toISOString();
    state.records[key] = {
      status: status,
      pillIndex: pillIndexOn(key),
      packNo: pillIndexOn(key) ? packNo() : (Number(prev.packNo) || 0),
      photo: prev.photo || '',
      pillStates: prev.pillStates || {},
      changed: prev.changed || [],
      quality: prev.quality || null,
      body: prev.body || null,
      takenAt: status === 'taken' ? (prev.takenAt || now) : '',
      createdAt: prev.createdAt || now,
      updatedAt: now
    };
    view.devDate = addDays(key, 1);
    persist().then(function (ok) {
      renderAll();
      if (ok) toast(shortDate(key) + ' 已记为' + statusText(status));
      else if (!platform.active && !platform.web) toast('预览模式：测试记录只保留在当前页面');
    });
  }

  function devClearRecord() {
    var key = view.devDate || todayKey();
    if (!state.records[key]) {
      toast('这一天还没有记录');
      return;
    }
    delete state.records[key];
    persist().then(function (ok) {
      renderAll();
      if (ok) toast(shortDate(key) + ' 的记录已清空');
    });
  }

  function blisterCell(index) {
    var info = pillCellInfo(index);
    var cls = 'bpill is-' + info.state + (info.key === todayKey() ? ' is-today' : '');
    var mark = info.state === 'uncertain' ? '<span class="bpill-mark">?</span>' : '';
    return '<button class="' + cls + '" data-action="open-day" data-date="' + info.key + '"' +
      (info.state === 'unrecorded' ? ' disabled aria-label="第 ' + index + ' 片，开始记录前未记录"' : '') + '>' +
      '<span class="bpill-dot"><i>' + index + '</i>' + mark + '</span>' +
      '<span class="bpill-date">' + esc(info.dateText) + '</span>' +
      '</button>';
  }

  function leafletEntryHtml() {
    var med = state.medication;
    var name = med && med.name ? med.name : '说明书';
    return '<button type="button" class="blister-groove is-leaflet" data-action="open-leaflet" aria-label="查看 ' + esc(name) + ' 的说明书">' +
      '<span class="groove-name">' + esc(name) + '</span>' +
      '<span class="groove-cue">说明书 ›</span></button>';
  }

  function renderBlister() {
    var size = blisterSize();
    var med = state.medication;
    var grid = $('blisterGrid');

    if (!med) {
      grid.innerHTML = '<div class="blister-empty">建立药品档案后，这里会显示你的药板。</div>';
      $('packBadgeRow').hidden = true;
      $('blisterLegend').hidden = true;
      $('packBadge').textContent = '第 1 板 · 21 片';
      $('packHint').textContent = '点药片查看当天';
      $('blisterProgress').textContent = '0 / ' + size;
      $('blisterBar').style.width = '0%';
      $('breakWrap').hidden = true;
      $('medNameText').textContent = '尚未建立药品档案';
      $('medMetaText').textContent = '建立档案后，才能开始每日记录';
      $('medNextTime').textContent = '先建立档案，再设置服药时间';
      $('medBlisterText').textContent = '第 1 板 · 已服 0 / ' + size;
      return;
    }

    var html = '';
    if (size === 21) {
      html += '<div class="blister-row is-top">';
      for (var i = 1; i <= 10; i++) html += blisterCell(i);
      html += '</div>';
      html += '<div class="blister-row is-mid">' +
        leafletEntryHtml() +
        blisterCell(11) + '</div>';
      html += '<div class="blister-row is-bottom">';
      for (var j = 21; j >= 12; j--) html += blisterCell(j);
      html += '</div>';
    } else {
      html += '<div class="blister-grid-alt">';
      for (var k = 1; k <= size; k++) html += blisterCell(k);
      html += leafletEntryHtml();
      html += '</div>';
    }
    grid.innerHTML = html;
    $('packBadgeRow').hidden = false;
    $('blisterLegend').hidden = false;

    var count = takenPillCount();
    var percent = size ? Math.round(count / size * 100) : 0;
    $('blisterProgress').textContent = count + ' / ' + size;
    $('blisterBar').style.width = percent + '%';
    $('packBadge').textContent = '第 ' + packNo() + ' 板 · ' + size + ' 片';
    $('packHint').textContent = shortDate(packStart()) + (startPill() > 1 ? ' 从第 ' + startPill() + ' 片开始' : ' 开始');
    $('unrecordedLegend').hidden = startPill() <= 1;

    var breakOn = hasBreakPeriod() && size === 21;
    $('breakWrap').hidden = !breakOn;
    if (breakOn) {
      var bh = '';
      for (var b = 1; b <= 7; b++) {
        var bkey = breakDateOf(b);
        bh += '<button class="bpill is-break' + (bkey === todayKey() ? ' is-today' : '') +
          '" data-action="open-day" data-date="' + bkey + '">' +
          '<span class="bpill-dot"><i>停' + b + '</i></span>' +
          '<span class="bpill-date">' + shortDate(bkey) + '</span></button>';
      }
      $('breakRow').innerHTML = bh;
    } else {
      $('breakRow').innerHTML = '';
    }

    $('medNameText').textContent = med.name;
    $('medMetaText').textContent = '每天 ' + (med.time || '21:00') + ' · ' + size + ' 片';
    $('medNextTime').textContent = blisterFootText();
    $('medBlisterText').textContent = '第 ' + packNo() + ' 板 · 已服 ' + count + ' / ' + size;
  }

  function renderStats() {
    var keys = Object.keys(state.records);
    var taken = 0;
    var uncertain = 0;
    var today = todayKey();

    keys.forEach(function (key) {
      if (key > today) return;
      var status = state.records[key].status;
      if (status === 'taken') taken++;
      else if (status === 'uncertain') uncertain++;
    });

    $('statDays').textContent = keys.filter(function (k) { return k <= today; }).length;
    $('statTaken').textContent = taken;
    $('statUncertain').textContent = uncertain;
  }

  function renderRecent() {
    var list = $('recentList');
    var keys = Object.keys(state.records).sort(function (a, b) {
      return a < b ? 1 : -1;
    }).slice(0, 3);

    if (!keys.length) {
      list.innerHTML = '<div class="empty">还没有记录。<br>今天拍一张药板照片就可以开始。</div>';
      return;
    }

    var html = '';
    keys.forEach(function (key) {
      var record = state.records[key];
      var mainLabel = breakDayNumber(key) ? '停药期打卡' : statusText(record.status);
      html += '<button class="record" data-action="open-day" data-date="' + key + '">' +
        '<span class="record-date">' + monthDayText(key) + '</span>' +
        '<span class="record-main">' + esc(mainLabel) +
        '<span class="record-sub">' + (timeText(record.updatedAt || record.createdAt) || '--') + ' 记录' +
        (record.photo ? ' · 有照片' : '') + '</span></span>' +
        '<span class="record-dot ' + esc(record.status) + '"></span>' +
        '</button>';
    });
    list.innerHTML = html;
  }

  /* ========================================================= 渲染：拍照 */

  function renderCheckin() {
    var hasPhoto = !!view.photoData;
    var showPreview = hasPhoto || view.skipPhoto;
    $('captureStep').hidden = showPreview;
    $('previewStep').hidden = !showPreview;

    var last = previousPhotoBefore(todayKey());
    $('lastPhotoBtn').hidden = !last;

    $('previewTitle').textContent = hasPhoto ? '照片预览' : '今天的记录';
    $('qualityBadge').hidden = !hasPhoto;
    $('qualityCard').hidden = !hasPhoto;
    $('previewShot').hidden = !hasPhoto;
    $('markPillsBtn').hidden = !hasPhoto;

    var breakPrimary = document.querySelector('#previewStep .btn-row .btn.primary');
    var breakSecondary = document.querySelector('#previewStep .secondary-row');
    var breakRetake = $('retakeBtn');
    if (view.breakCheckin) {
      $('previewTitle').textContent = '停药期打卡';
      if (breakPrimary) { breakPrimary.textContent = '保存打卡'; breakPrimary.setAttribute('data-action', 'save-break-checkin'); }
      if (breakSecondary) breakSecondary.hidden = true;
      if (breakRetake) breakRetake.hidden = true;
    } else {
      if (breakPrimary) { breakPrimary.textContent = '确认已服用'; breakPrimary.setAttribute('data-action', 'confirm-taken'); }
      if (breakSecondary) breakSecondary.hidden = false;
      if (breakRetake) breakRetake.hidden = false;
    }

    var retake = $('retakeBtn');
    retake.textContent = hasPhoto ? '重新拍摄' : '去拍照';
    retake.setAttribute('data-action', hasPhoto ? 'retake' : 'open-camera');

    var img = $('photoPreview');
    if (hasPhoto) {
      img.src = view.photoData;
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }

    renderBody();
    if (hasPhoto) renderQuality();
  }

  function renderBody() {
    var chips = $('bodyChips');
    if (!chips) return;
    var good = view.body.length === 0;
    var buttons = chips.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var key = buttons[i].getAttribute('data-body');
      var on = key === 'good' ? good : view.body.indexOf(key) > -1;
      buttons[i].className = 'body-chip' + (on ? ' is-on' : '');
    }
    var otherOn = view.body.indexOf('其他') > -1;
    $('bodyOtherWrap').hidden = !otherOn;
    $('bodyOther').value = otherOn ? view.bodyOther : '';
  }

  function pickBody(key) {
    if (key === 'good') {
      view.body = [];
      view.bodyOther = '';
    } else {
      var i = view.body.indexOf(key);
      if (i > -1) view.body.splice(i, 1);
      else view.body.push(key);
      if (view.body.indexOf('其他') === -1) view.bodyOther = '';
    }
    renderBody();
  }

  function renderQuality() {
    var q = view.quality;
    var badge = $('qualityBadge');
    var score = $('qualityScore');
    var label = $('qualityLabel');
    var bar = $('qualityBar');
    var issues = $('qualityIssues');
    var hint = $('qualityHint');

    if (!q) {
      badge.textContent = '已读取';
      badge.className = 'quality-badge';
      score.textContent = '--';
      bar.style.width = '0%';
      issues.innerHTML = '';
      hint.textContent = '照片已读取，可以继续确认。';
      return;
    }

    badge.textContent = q.label;
    badge.className = 'quality-badge' + (q.label === '一般' ? ' is-mid' : (q.label === '较差' ? ' is-low' : ''));
    score.textContent = q.score + ' 分 · ' + q.label;
    bar.style.width = q.score + '%';
    bar.style.background = q.label === '良好' ? '#7f9f84' : (q.label === '一般' ? '#d5b76a' : '#c99174');

    var html = '';
    if (q.issues && q.issues.length) {
      q.issues.forEach(function (item) {
        html += '<li>' + esc(item) + '</li>';
      });
      issues.innerHTML = html;
      hint.textContent = '建议按提示调整后重拍；如果确实拍不到更好，也可以继续。';
    } else {
      issues.innerHTML = '';
      hint.textContent = '亮度、对比度和清晰度看起来可以，可以直接确认已服用。';
    }
  }

  /* ========================================================= 渲染：识别结果 */

  function layoutOverlay() {
    var shot = document.querySelector('.result-shot');
    var img = $('resultPhoto');
    var overlay = $('pillOverlay');
    if (!shot || !img || !overlay) return;

    if (img.hidden || !img.naturalWidth) {
      overlay.style.left = '0';
      overlay.style.top = '0';
      overlay.style.right = '0';
      overlay.style.bottom = '0';
      overlay.style.width = 'auto';
      overlay.style.height = 'auto';
      return;
    }

    var boxW = shot.clientWidth;
    var boxH = shot.clientHeight;
    var scale = Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight);
    var w = Math.round(img.naturalWidth * scale);
    var h = Math.round(img.naturalHeight * scale);

    overlay.style.left = Math.round((boxW - w) / 2) + 'px';
    overlay.style.top = Math.round((boxH - h) / 2) + 'px';
    overlay.style.width = w + 'px';
    overlay.style.height = h + 'px';
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
  }

  function renderResult() {
    var size = blisterSize();
    var rows = Math.ceil(size / 7);
    var photo = view.photoData || view.existingPhoto;
    var shot = document.querySelector('.result-shot');
    var img = $('resultPhoto');
    var overlay = $('pillOverlay');

    if (photo) {
      img.src = photo;
      img.hidden = false;
      shot.className = 'result-shot';
    } else {
      img.removeAttribute('src');
      img.hidden = true;
      shot.className = 'result-shot is-nophoto';
    }
    layoutOverlay();

    overlay.style.gridTemplateColumns = 'repeat(7, 1fr)';
    overlay.style.gridTemplateRows = 'repeat(' + rows + ', 1fr)';

    view.changed = view.changed || [];
    var html = '';
    for (var i = 1; i <= size; i++) {
      var st = view.pillStates[i] || '';
      var cls = 'pill-cell' + (st ? ' is-' + st : '') +
        (view.changed.indexOf(i) > -1 ? ' is-changed' : '');
      html += '<button class="' + cls + '" data-action="open-pill" data-index="' + i + '">' +
        '<span class="cell-num">' + i + '</span>' +
        (view.changed.indexOf(i) > -1 ? '<span class="cell-flag">变</span>' : '') +
        '</button>';
    }
    overlay.innerHTML = html;

    var counts = countPills();
    var percent = counts.total ? Math.round(counts.marked / counts.total * 100) : 0;

    $('resultMarks').textContent = '已标记 ' + counts.marked + ' / ' + counts.total;
    $('changedPill').textContent = '变化 ' + view.changed.length + ' 格';
    $('changedPill').className = 'status' + (view.changed.length ? ' warn' : '');
    $('completeText').textContent = percent + '%';
    $('completeBar').style.width = percent + '%';

    var chips = '';
    chips += '<span class="chip filled">有药 ' + counts.filled + '</span>';
    chips += '<span class="chip empty">空位 ' + counts.empty + '</span>';
    chips += '<span class="chip unknown">看不清 ' + counts.unknown + '</span>';
    chips += '<span class="chip unmarked">未标记 ' + (counts.total - counts.marked) + '</span>';
    chips += '<span class="chip changed">有变化 ' + view.changed.length + '</span>';
    $('summaryChips').innerHTML = chips;

    var notes = [];
    var issues = (view.quality && view.quality.issues) ? view.quality.issues : [];
    if (issues.length) {
      notes.push('照片质量：' + issues.join('；'));
    }
    if (counts.marked < counts.total) {
      notes.push('还有 ' + (counts.total - counts.marked) + ' 个药位未标记，未标记不计入变化统计。');
    }
    var notice = $('resultNotice');
    if (notes.length) {
      notice.innerHTML = '<strong>需要注意</strong>' + notes.map(function (n) { return esc(n); }).join('<br>');
      notice.hidden = false;
    } else {
      notice.hidden = true;
    }

    var prev = previousRecordBefore(view.dateKey || todayKey(), true);
    var compare = $('resultCompare');
    if (prev) {
      compare.innerHTML = '对比 ' + monthDayText(prev.key) + ' 的药位标记：' +
        (view.changed.length ? '有 <b>' + view.changed.length + '</b> 格状态不同。' : '没有发现状态不同的药位。');
      compare.hidden = false;
    } else {
      compare.innerHTML = '这是第一份带药位标记的记录，暂时没有可对比的上一张。';
      compare.hidden = false;
    }

    var opts = $('confirmList').querySelectorAll('.confirm-opt');
    for (var k = 0; k < opts.length; k++) {
      var on = opts[k].getAttribute('data-status') === view.status;
      opts[k].className = 'confirm-opt' + (on ? ' is-on' : '');
    }

    var hint = $('resultHint');
    if (hint) {
      if (view.crops && view.crops.length) {
        hint.textContent = '网格按 7 列等分照片，只用于定位；点药位可放大局部并标记。';
      } else if (photo) {
        hint.textContent = '这张照片没有可用的局部放大，点药位可以直接修改标记。';
      } else {
        hint.textContent = '这一天没有保存照片，点药位可以直接修改标记。';
      }
    }
  }

  /* ========================================================= 渲染：日历 */

  function calendarDayState(key) {
    var record = state.records[key];
    if (isPausedDate(key)) return 'paused';
    if (breakDayNumber(key)) return 'break';
    if (record && record.status === 'taken') return 'taken';
    if (record && record.status === 'uncertain') return 'uncertain';
    if (record && record.status === 'not_taken') return 'missed';

    var pill = scheduledPillOn(key);
    if (pill && (key < todayKey() || missedInfo(key))) return 'missed';
    if (pill && key === todayKey()) return 'pending';
    return 'empty';
  }

  function linkedPackInfo(key) {
    if (!state.medication || key > todayKey() || isPausedDate(key) || breakDayNumber(key)) return null;
    var record = state.records[key];
    var currentPill = pillIndexOn(key);
    var pill = currentPill || (record && Number(record.pillIndex)) || 0;
    if (!pill) return null;
    var pack = record && Number(record.packNo)
      ? Number(record.packNo)
      : (currentPill ? packNo() : 0);
    return { pack: pack, pill: pill };
  }

  function sameLinkedPack(a, b) {
    var left = linkedPackInfo(a);
    var right = linkedPackInfo(b);
    if (!left || !right) return false;
    if (left.pack && right.pack && left.pack !== right.pack) return false;
    return right.pill === left.pill + 1;
  }

  function renderCalendar() {
    var year = view.month.getFullYear();
    var month = view.month.getMonth();
    var start = new Date(year, month, 1);
    start.setDate(start.getDate() - 15);
    var end = new Date(year, month + 1, 15);
    var offset = (start.getDay() + 6) % 7;
    var grid = $('calGrid');
    var html = '';
    var weekdays = ['一', '二', '三', '四', '五', '六', '日'];
    var stateNames = {
      taken: '已服', pending: '待服', missed: '漏服', uncertain: '不确定',
      break: '停药期', paused: '手动停药', empty: '未记录'
    };

    $('calTitle').textContent = year + ' 年 ' + (month + 1) + ' 月';
    $('calRange').textContent = shortDate(dateKey(start)) + ' – ' + shortDate(dateKey(end));

    weekdays.forEach(function (name) {
      html += '<div class="cal-wd">' + name + '</div>';
    });
    for (var b = 0; b < offset; b++) html += '<div class="cal-blank"></div>';

    var cells = offset;
    for (var d = new Date(start.getTime()); d <= end; d.setDate(d.getDate() + 1)) {
      var key = dateKey(d);
      var day = d.getDate();
      var stateName = calendarDayState(key);
      var linked = !!linkedPackInfo(key);
      var linkLeft = linked && d.getDay() !== 1 && sameLinkedPack(addDays(key, -1), key);
      var linkRight = linked && d.getDay() !== 0 && sameLinkedPack(key, addDays(key, 1));
      var cls = 'cal-day is-' + stateName;
      if (d.getMonth() !== month) cls += ' is-adjacent';
      if (linked) cls += ' is-linked';
      if (linkLeft) cls += ' link-left';
      if (linkRight) cls += ' link-right';
      if (key === todayKey()) cls += ' is-today';
      var record = state.records[key];
      var reactions = adverseReactions(record);
      var adverseText = reactions.length ? esc(reactions.join(' / ')) : '';
      if (reactions.length) cls += ' has-adverse';
      var pill = pillIndexOn(key);
      var title = (d.getMonth() + 1) + ' 月 ' + day + ' 日 · ' + stateNames[stateName] +
        (pill ? ' · 第 ' + pill + ' 片' : '') +
        (reactions.length ? ' · 不良反应：' + reactions.join('、') : '');
      html += '<button class="' + cls + '" data-action="open-day" data-date="' + key + '" title="' + title + '">' +
        '<span>' + day + '</span>' +
        (adverseText ? '<small class="cal-adverse">' + adverseText + '</small>' : '') +
        (day === 1 ? '<small class="cal-month-mark">' + (d.getMonth() + 1) + '月</small>' : '') +
        '</button>';
      cells++;
    }
    while (cells % 7) {
      html += '<div class="cal-blank"></div>';
      cells++;
    }
    grid.innerHTML = html;
    renderRecordStats(year, month);
  }

  /* ========================================================= 渲染：历史详情 */

  function renderDay() {
    var key = view.dayKey;
    var record = state.records[key];
    var date = parseKey(key);
    var today = todayKey();
    var isFuture = key > today;
    var breakNo = breakDayNumber(key);
    var paused = isPausedDate(key);
    var pauseNo = pauseDayNumber(key);
    var pillIdx = pillIndexOn(key);

    $('dayTitle').textContent = (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日';
    $('daySub').textContent = '周' + WEEK_CN[date.getDay()] + ' · ' +
      (paused ? '手动停止服药' :
        (breakNo ? '无需服药' : (record ? statusText(record.status) : '未记录')));

    var meta = [];
    if (paused) meta.push('手动停止服药第 ' + pauseNo + ' 天 · 无需打卡');
    else if (breakNo) meta.push('停药期第 ' + breakNo + ' 天 · 无需服药');
    else if (pillIdx) meta.push('本板第 ' + pillIdx + ' 片');
    if (record) {
      if (record.status === 'taken') {
        var at = record.takenAt || record.updatedAt || record.createdAt;
        if (at) meta.push('服药时间 ' + timeText(at));
      } else {
        var rt = record.updatedAt || record.createdAt;
        if (rt) meta.push('记录时间 ' + timeText(rt));
      }
    } else if (isFuture) {
      meta.push('未来的日期，等当天再记录');
    } else if (!breakNo) {
      meta.push('这一天没有记录');
    }
    $('dayMeta').innerHTML = meta.map(function (t) {
      return '<span>' + esc(t) + '</span>';
    }).join('');

    var body = record && record.body;
    var bodyBox = $('dayBody');
    if (!body) {
      bodyBox.innerHTML = '<p class="body-empty">这一天没有记录身体状况。</p>';
    } else if (!body.reactions || !body.reactions.length) {
      bodyBox.innerHTML = '<span class="body-tag is-good">良好</span>';
    } else {
      var bodyHtml = '';
      body.reactions.forEach(function (r) {
        bodyHtml += '<span class="body-tag">' +
          esc(r === '其他' && body.note ? '其他 · ' + body.note : r) + '</span>';
      });
      bodyBox.innerHTML = bodyHtml;
    }

    var shot = $('dayShot');
    if (record && record.photo) {
      shot.innerHTML = '<img src="' + esc(record.photo) + '" alt="当日药板照片">';
      $('dayPhotoBtn').hidden = false;
    } else {
      shot.innerHTML = '<div class="day-empty">' +
        (paused ? '这一天手动停止服药，无需打卡。' :
          (breakNo ? '这一天是停药期，无需服药。' : (record
            ? '这一天没有保存照片。'
            : '这一天没有记录。<br>没有记录不代表一定漏服，也不代表已经服用。'))) +
        '</div>';
      $('dayPhotoBtn').hidden = true;
    }

    var pills = $('dayPills');
    var legend = $('dayLegend');
    var states = record && record.pillStates ? record.pillStates : null;
    var hasStates = states && Object.keys(states).length;

    if (hasStates) {
      var size = blisterSize();
      var html = '';
      for (var i = 1; i <= size; i++) {
        var st = states[i] || '';
        var cls = 'read-cell' + (st ? ' is-' + st : '') +
          (record.changed && record.changed.indexOf(i) > -1 ? ' is-changed' : '');
        html += '<div class="' + cls + '"><span>' + i + '</span></div>';
      }
      pills.innerHTML = html;
      pills.hidden = false;
      legend.innerHTML = '<span><i class="dot filled"></i>有药</span>' +
        '<span><i class="dot empty"></i>空位</span>' +
        '<span><i class="dot unknown"></i>看不清</span>' +
        '<span><i class="dot changed"></i>有变化</span>';
      legend.hidden = false;
    } else {
      pills.innerHTML = '';
      pills.hidden = true;
      legend.innerHTML = '<span><i class="dot none"></i>这一天没有药位标记</span>';
      legend.hidden = false;
    }

    $('dayConfirmCard').hidden = isFuture || !!breakNo || paused;
    $('dayActions').hidden = !(key === today && !breakNo && !paused);

    var current = record ? record.status : view.dayDraft;
    var buttons = $('dayChoice').querySelectorAll('button');
    for (var b = 0; b < buttons.length; b++) {
      var on = current && buttons[b].getAttribute('data-status') === current;
      buttons[b].className = on ? 'is-on' : '';
    }
  }

  /* ========================================================= 渲染：我的 */

  function renderProfile() {
    var med = state.medication;
    $('profileMedName').textContent = med ? med.name : '尚未建立药品档案';
    $('profileMedMeta').textContent = med
      ? '第 ' + packNo() + ' 板 · ' + blisterSize() + ' 片 · 每天 ' + (med.time || '21:00') +
        ' · 已记录 ' + Object.keys(state.records).length + ' 天'
      : '建立档案后，才能开始每日记录';
    $('menuMedDesc').textContent = med
      ? med.name + ' · 第 ' + packNo() + ' 板 · ' + blisterSize() + ' 片'
      : '名称、药位数、服药时间';
    $('menuReminderDesc').textContent = state.settings.reminderOn
      ? '打开时提示 · ' + (med && med.time ? med.time : '21:00')
      : '已关闭打开时提示';
    var leafletCount = med && Array.isArray(med.leaflet) ? med.leaflet.length : 0;
    var menuLeafletDesc = $('menuLeafletDesc');
    if (menuLeafletDesc) menuLeafletDesc.textContent = med
      ? (leafletCount ? ('已拍 ' + leafletCount + ' 张 · 点击查看') : '拍照保存，随时查看')
      : '建立档案后可拍照保存';

    var devOn = !!state.settings.devMode;
    $('devModeBtn').setAttribute('aria-pressed', devOn ? 'true' : 'false');
    $('devModeSwitch').className = 'switch' + (devOn ? ' is-on' : '');
    $('devModeDesc').textContent = devOn
      ? '已开启 · 首页可连续添加测试记录'
      : '首页显示日期面板，可连续添加测试记录';
  }

  function renderSettings() {
    var sw = $('reminderSwitch');
    sw.className = 'switch' + (state.settings.reminderOn ? ' is-on' : '');
    sw.setAttribute('aria-pressed', state.settings.reminderOn ? 'true' : 'false');
    $('settingsTime').value = (state.medication && state.medication.time) ? state.medication.time : '21:00';
  }

  function renderMedStartPill(value) {
    var slots = Number($('medSlots').value) || 21;
    var current = Math.max(2, Math.min(slots, Number(value) || 2));
    var html = '';
    for (var i = 2; i <= slots; i++) {
      html += '<option value="' + i + '">第 ' + i + ' 片（之前 ' + (i - 1) + ' 片未记录）</option>';
    }
    $('medStartPill').innerHTML = html;
    $('medStartPill').value = String(current);
  }

  function renderMedForm() {
    var med = state.medication;
    $('medName').value = med ? med.name : '';
    $('medSlots').value = String(med ? Number(med.slots) : 21);
    $('medTime').value = med && med.time ? med.time : '21:00';
    $('medMissed').value = med && med.missedAfter === 'next_day'
      ? 'next_day'
      : String(med ? (Number(med.missedAfter) || 2) : 2);
    $('medNote').value = med && med.note ? med.note : '';

    var hasBreak = !med || med.hasBreak !== false;
    var sw = $('medBreakSwitch');
    sw.className = 'switch' + (hasBreak ? ' is-on' : '');
    sw.setAttribute('aria-pressed', hasBreak ? 'true' : 'false');

    var firstPill = med ? Math.max(1, Number(med.startPill) || 1) : 1;
    var midway = firstPill > 1;
    var midwaySw = $('medMidwaySwitch');
    midwaySw.className = 'switch' + (midway ? ' is-on' : '');
    midwaySw.setAttribute('aria-pressed', midway ? 'true' : 'false');
    $('medStartPillWrap').hidden = !midway;
    renderMedStartPill(midway ? firstPill : 2);
    renderLeafletEditor();
  }

  /* ========================================================= 页面切换 */

  function switchPage(name) {
    view.page = name;

    var pages = document.querySelectorAll('.page');
    for (var i = 0; i < pages.length; i++) {
      pages[i].className = pages[i].getAttribute('data-page') === name ? 'page is-active' : 'page';
    }

    var tab = TAB_OF_PAGE[name] || name;
    var tabs = document.querySelectorAll('.tab');
    for (var j = 0; j < tabs.length; j++) {
      tabs[j].className = tabs[j].getAttribute('data-nav') === tab ? 'tab is-active' : 'tab';
    }

    var tabbar = document.querySelector('.tabbar');
    if (tabbar) tabbar.hidden = (name === 'checkin' || name === 'result');

    window.scrollTo(0, 0);

    if (name === 'home') renderHome();
    else if (name === 'checkin') renderCheckin();
    else if (name === 'calendar') renderCalendar();
    else if (name === 'profile') renderProfile();
    else if (name === 'settings') renderSettings();
    else if (name === 'med') renderMedForm();
    else if (name === 'leaflet') renderLeafletPage();
  }

  function openCheckin() {
    var key = todayKey();
    var record = state.records[key];

    view.dateKey = key;
    view.photoData = '';
    view.existingPhoto = '';
    view.quality = null;
    view.crops = [];
    view.pillStates = {};
    view.changed = [];
    view.status = record ? record.status : '';
    view.skipPhoto = false;
    view.breakCheckin = false;
    view.body = record && record.body && Array.isArray(record.body.reactions)
      ? record.body.reactions.slice()
      : [];
    view.bodyOther = record && record.body && record.body.note ? record.body.note : '';

    renderCheckin();
    switchPage('checkin');
  }

  function openBreakCheckin() {
    if (!state.medication) {
      switchPage('med');
      toast('先建立药品档案，再开始打卡');
      return;
    }
    var key = todayKey();
    var record = state.records[key];
    view.dateKey = key;
    view.photoData = '';
    view.existingPhoto = '';
    view.quality = null;
    view.crops = [];
    view.pillStates = {};
    view.changed = [];
    view.status = record ? record.status : '';
    view.skipPhoto = true;
    view.breakCheckin = true;
    view.body = record && record.body && Array.isArray(record.body.reactions)
      ? record.body.reactions.slice()
      : [];
    view.bodyOther = record && record.body && record.body.note ? record.body.note : '';
    renderCheckin();
    switchPage('checkin');
  }

  function viewToday() {
    var key = todayKey();
    var record = state.records[key];
    if (!record) {
      toast('今天还没有记录');
      return;
    }
    openDay(key);
  }

  function openDay(key) {
    view.dayKey = key;
    var record = state.records[key];
    view.dayDraft = record ? record.status : '';
    renderDay();
    switchPage('day');
  }

  /* ========================================================= 弹层 */

  function showSheet(html) {
    $('sheetBody').innerHTML = html;
    $('sheetMask').hidden = false;
  }

  function closeSheet() {
    $('sheetMask').hidden = true;
    $('sheetBody').innerHTML = '';
  }

  function openPauseSheet() {
    if (!state.medication) return;
    var up = upcomingPause(todayKey());
    var hasToday = !!state.records[todayKey()];
    var html = '<h3>手动停止服药</h3>' +
      '<p class="sheet-sub">药药只记录你的选择，停药与恢复请遵医嘱。</p>' +
      '<div class="confirm-list">' +
      '<button class="confirm-opt" data-action="pause-start" data-when="today">' +
      '<span class="opt-ico">今</span>' +
      '<span class="opt-body"><strong>从今天开始停止</strong><span>' +
      (hasToday ? '今天已有记录，会保留这条记录；从现在起停止打卡' : '今天起不再打卡，今天是停止第 1 天') +
      '</span></span></button>' +
      '<button class="confirm-opt" data-action="pause-start" data-when="tomorrow">' +
      '<span class="opt-ico">明</span>' +
      '<span class="opt-body"><strong>从明天开始停止</strong><span>今天仍可正常记录，明天起不再打卡</span></span></button>' +
      '</div>' +
      (up ? '<button class="btn ghost block" data-action="cancel-pause">取消已安排的停止（' +
        monthDayText(up.start) + ' 开始）</button>' : '') +
      '<button class="btn ghost block" data-action="close-sheet">取消</button>';
    showSheet(html);
  }

  function nextPillOnResume() {
    var size = blisterSize();
    var d = packStart();
    var count = startPill() - 1;
    var guard = 0;
    while (d < todayKey() && guard < 2000) {
      if (!isPausedForSchedule(d)) count++;
      d = addDays(d, 1);
      guard++;
    }
    return count < size ? count + 1 : 0;
  }

  function nextPillOnResumeContinuous() {
    var size = blisterSize();
    var pill = dayDiff(todayKey(), packStart()) + startPill();
    if (pill < 1 || pill > size) return 0;
    return pill;
  }

  function openResumeSheet() {
    var p = activePause(todayKey());
    if (!p) return;
    var days = pauseDayNumber(todayKey());
    var next = nextPillOnResume();
    var calNext = nextPillOnResumeContinuous();
    var html = '<h3>继续记录</h3>' +
      '<p class="sheet-sub">已停止 ' + days + ' 天。选择药板接下来怎么接。</p>' +
      '<div class="confirm-list">' +
      (next ? '<button class="confirm-opt" data-action="resume-med" data-mode="continue">' +
      '<span class="opt-ico">续</span>' +
      '<span class="opt-body"><strong>继续本板</strong><span>暂停的天数顺延，下次从第 ' + next + ' 片继续</span></span></button>' : '') +
      (calNext ? '<button class="confirm-opt" data-action="resume-med" data-mode="continuous">' +
      '<span class="opt-ico">连</span>' +
      '<span class="opt-body"><strong>接着停药那天</strong><span>暂停的天数计入药板，今天从第 ' + calNext + ' 片继续</span></span></button>' : '') +
      '<button class="confirm-opt" data-action="resume-med" data-mode="new">' +
      '<span class="opt-ico">新</span>' +
      '<span class="opt-body"><strong>换新板</strong><span>从第 1 片重新开始，旧板剩余药片不再使用</span></span></button>' +
      '</div>' +
      '<button class="btn ghost block" data-action="close-sheet">取消</button>';
    showSheet(html);
  }

  function schedulePause(start) {
    var med = state.medication;
    if (!med) return;
    var list = (med.pauses || []).slice();
    for (var i = list.length - 1; i >= 0; i--) {
      if (!list[i].end) list.splice(i, 1);
    }
    list.push({ start: start, end: '' });
    med.pauses = list;
    persist().then(function (ok) {
      closeSheet();
      renderAll();
      if (ok) toast(start === todayKey() ? '已从今天开始停止记录' : '已安排明天开始停止记录');
    });
  }

  function cancelPause() {
    var med = state.medication;
    if (!med) return;
    med.pauses = (med.pauses || []).filter(function (p) { return !!p.end; });
    persist().then(function (ok) {
      closeSheet();
      renderAll();
      if (ok) toast('已取消停止安排');
    });
  }

  function resumeMed(mode) {
    var med = state.medication;
    var p = activePause(todayKey());
    if (!med || !p) {
      closeSheet();
      return;
    }
    p.end = todayKey();
    if (mode === 'continuous') {
      p.keepCount = true;
    } else if (mode === 'new') {
      med.packNo = packNo() + 1;
      med.packStart = todayKey();
      med.startDate = todayKey();
      med.startPill = 1;
      state.blister.taken = [];
    }
    persist().then(function (ok) {
      closeSheet();
      renderAll();
      if (ok) {
        toast(mode === 'new' ? ('已换到第 ' + packNo() + ' 板并继续记录')
          : (mode === 'continuous' ? '已继续记录，暂停天数计入药板'
          : '已继续记录'));
      }
    });
  }

  function openPill(index) {
    var st = view.pillStates[index];
    var crop = view.crops[index - 1] || '';
    var html = '<h3>第 ' + index + ' 格</h3>' +
      '<p class="sheet-sub">对照局部照片，标记这一格现在的外观。当前：' + esc(pillText(st)) + '</p>';

    if (crop) {
      html += '<div class="crop-shot"><img src="' + esc(crop) + '" alt="第 ' + index + ' 格局部照片">' +
        '<p>局部照片 · 第 ' + index + ' 格</p></div>';
    } else {
      html += '<p class="help">这张照片没有可用的局部放大，请直接对照上方的整张照片判断。</p>';
    }

    html += '<div class="status-choice">' +
      pillOption(index, 'filled', '有药', '药位里能看到药片，或外观与上次一样') +
      pillOption(index, 'empty', '空位', '药位已经空了，或外观与上次明显不同') +
      pillOption(index, 'unknown', '看不清', '反光、模糊或角度挡住，无法判断') +
      '</div>' +
      '<button class="btn ghost block" data-action="close-sheet">取消</button>';

    showSheet(html);
  }

  function pillOption(index, status, label, desc) {
    var on = view.pillStates[index] === status;
    var ico = status === 'filled' ? '药' : (status === 'empty' ? '空' : '?');
    return '<button class="confirm-opt' + (on ? ' is-on' : '') + '" data-action="set-pill" data-index="' +
      index + '" data-status="' + status + '">' +
      '<span class="opt-ico">' + ico + '</span>' +
      '<span class="opt-body"><strong>' + label + '</strong><span>' + desc + '</span></span>' +
      '</button>';
  }

  function openLastPhoto() {
    var last = previousPhotoBefore(todayKey());
    if (!last) {
      toast('还没有更早的照片');
      return;
    }
    showSheet('<h3>上次拍摄的照片</h3>' +
      '<p class="sheet-sub">' + esc(fullDateText(last.key)) + ' · ' + esc(statusText(last.record.status)) + '</p>' +
      '<img src="' + esc(last.record.photo) + '" alt="上次药板照片">' +
      '<button class="btn ghost block" data-action="close-sheet">关闭</button>');
  }

  function openPrivacy() {
    showSheet('<h3>隐私政策</h3>' +
      '<p class="sheet-sub">最后更新：2026 年 11 月</p>' +
      '<p>药药不注册账号，不采集姓名、手机号、定位或通讯录。</p>' +
      '<p style="margin-top:10px">药品档案、每日记录、药位标记和照片，只写入当前小红书小工具在本机的沙箱存储，不会上传到服务器，也不会同步到其他设备。</p>' +
      '<p style="margin-top:10px">导出的记录图片由本机生成，只有你主动保存时才会写入系统相册。</p>' +
      '<p style="margin-top:10px">数据备份由你主动生成并复制保存，备份文本包含服药记录等私密信息，请妥善保管，不要分享给他人。</p>' +
      '<p style="margin-top:10px">药药不判断避孕效果，不评估怀孕风险，不提供补服、剂量或停药建议；漏服等情况的处理请以药品说明书为准，或咨询医生、药师。</p>' +
      '<p style="margin-top:10px">卸载小工具、清理沙箱或手动删除数据后，未备份的记录与照片无法恢复。</p>' +
      '<button class="btn ghost block" data-action="close-sheet">知道了</button>');
  }

  function openAbout() {
    showSheet('<h3>关于药药</h3>' +
      '<p class="sheet-sub">V2.1 · 个人服药记录工具</p>' +
      '<p>药药帮你把每天的服药情况记清楚：拍一张药板照片，点「确认已服用」就能完成记录；药板按 21 片 U 形排列，哪一天吃了、哪一天漏了，一眼能看到。</p>' +
      '<p style="margin-top:10px">它不做自动图像识别，不判断避孕效果，不评估怀孕风险，不提供漏服补服方案，也不替代说明书或医生建议。</p>' +
      '<p style="margin-top:10px">所有数据都在本机，没有云端同步，也没有社区、积分和排行榜。</p>' +
      '<button class="btn ghost block" data-action="close-sheet">关闭</button>');
  }

  function openFeedback() {
    showSheet('<h3>意见反馈</h3>' +
      '<p class="sheet-sub">小红书小工具无法联网提交反馈。这里写下的内容只会保存在本机，不会上传。</p>' +
      '<textarea id="feedbackText" rows="4" placeholder="例如：哪里不好用、希望增加什么" maxlength="300"></textarea>' +
      '<button class="btn primary block" data-action="submit-feedback">保存反馈</button>' +
      '<button class="btn ghost block" data-action="close-sheet">取消</button>');
  }

  function openWelcome() {
    showSheet('<h3>欢迎使用药药</h3>' +
      '<p class="sheet-sub">每天 10 秒，把服药情况记清楚。</p>' +
      '<p>1. 建立档案：填药名、每板药位数和习惯服药时间；已经在吃这一板，可以选择从第几片开始。</p>' +
      '<p style="margin-top:10px">2. 每天打卡：拍张药板照片，点「确认已服用」即可；漏服、不确定也能如实记下。</p>' +
      '<p style="margin-top:10px">3. 数据只在本机：不上传、不同步。换手机或清理数据前，记得在「我的 → 备份数据」导出备份。</p>' +
      '<p class="sheet-sub" style="margin-top:10px">药药不判断避孕效果，不提供补服或用药建议，具体以药品说明书和医生建议为准。</p>' +
      '<button class="btn primary block" data-action="welcome-med">建立我的药品档案</button>' +
      '<button class="btn ghost block" data-action="welcome-skip">先看看</button>');
  }

  function finishWelcome() {
    state.settings.onboarded = true;
    persist();
    closeSheet();
  }

  function maybeWelcome() {
    if (state.settings.onboarded) return;
    if (state.medication || Object.keys(state.records).length) return;
    openWelcome();
  }

  function openDayPhoto() {
    var record = state.records[view.dayKey];
    if (!record || !record.photo) {
      toast('这一天没有照片');
      return;
    }
    showSheet('<h3>当日照片</h3>' +
      '<p class="sheet-sub">' + esc(fullDateText(view.dayKey)) + '</p>' +
      '<img src="' + esc(record.photo) + '" alt="当日药板照片">' +
      '<button class="btn ghost block" data-action="close-sheet">关闭</button>');
  }

  function confirmClear() {
    showSheet('<h3>清除全部数据</h3>' +
      '<p class="sheet-sub">本机的药品档案、全部记录、药位标记和照片都会被删除，无法恢复。</p>' +
      '<div class="sheet-actions">' +
      '<button class="btn plain" data-action="close-sheet">取消</button>' +
      '<button class="btn primary" data-action="confirm-clear">确认清除</button>' +
      '</div>');
  }

  function confirmNewBlister() {
    if (!state.medication) {
      switchPage('med');
      toast('先建立药品档案');
      return;
    }
    var nextNo = packNo() + 1;
    showSheet('<h3>换到第 ' + nextNo + ' 板？</h3>' +
      '<p class="sheet-sub">第 ' + nextNo + ' 板会从今天开始，本板开始日期改为今天。历史记录与照片不会受影响。</p>' +
      '<div class="sheet-actions">' +
      '<button class="btn plain" data-action="close-sheet">取消</button>' +
      '<button class="btn primary" data-action="confirm-new-blister">换新板</button>' +
      '</div>');
  }

  function showExportPreview(url) {
    showSheet('<h3>近 7 天记录图片</h3>' +
      '<p class="sheet-sub">预览模式下无法写入系统相册。在小红书小工具内运行时会尝试保存到相册。</p>' +
      '<img src="' + url + '" alt="记录导出图片">' +
      '<button class="btn ghost block" data-action="close-sheet">关闭</button>');
  }

  /* ========================================================= 动作 */

  function startCheckin() {
    if (!state.medication) {
      switchPage('med');
      toast('先建立药品档案，再开始打卡');
      return;
    }
    if (isPausedDate(todayKey())) {
      toast('已手动停止服药，点「继续记录」可以恢复');
      return;
    }
    if (breakDayNumber(todayKey())) {
      openBreakCheckin();
      return;
    }
    openCheckin();
  }

  function handleFile(file) {
    if (!file) return;
    if (file.type && file.type.indexOf('image/') !== 0) {
      toast('请选择图片文件');
      return;
    }
    toast('正在检查照片…');
    compressImage(file, function (dataUrl, quality) {
      if (!dataUrl) {
        toast('图片处理失败，请重试');
        return;
      }
      view.photoData = dataUrl;
      view.existingPhoto = '';
      view.skipPhoto = false;
      view.quality = quality;
      view.crops = [];
      buildCrops(dataUrl, blisterSize(), function (crops) {
        view.crops = crops;
      });
      renderCheckin();
      toast(quality && quality.issues.length ? '照片已读取，检查发现一些问题' : '照片检查完成');
    });
  }

  function setPill(index, status) {
    var num = Number(index);
    if (!num || num < 1 || num > blisterSize()) return;
    view.pillStates[num] = status;
    view.changed = computeChanged();
    renderResult();
    closeSheet();
    toast('第 ' + num + ' 格已标记为' + pillText(status));
  }

  function chooseStatus(status) {
    view.status = status;
    renderResult();
  }

  function saveRecord(quickStatus) {
    if (quickStatus) view.status = quickStatus;
    if (!view.status) {
      toast('请先选择今天的服药情况');
      return;
    }

    var btn = $('saveRecordBtn');
    if (btn.classList.contains('is-busy')) return;
    btn.classList.add('is-busy');
    btn.textContent = '保存中…';

    var finish = function (photoPath) {
      var key = view.dateKey || todayKey();
      var previous = state.records[key] || {};
      var now = new Date().toISOString();

      state.records[key] = {
        status: view.status,
        pillIndex: pillIndexOn(key),
        packNo: pillIndexOn(key) ? packNo() : (Number(previous.packNo) || 0),
        photo: photoPath || (platform.active ? '' : view.photoData) ||
          view.existingPhoto || previous.photo || '',
        pillStates: view.pillStates,
        changed: view.changed || [],
        quality: view.quality
          ? { score: view.quality.score, label: view.quality.label, issues: view.quality.issues }
          : (previous.quality || null),
        body: {
          reactions: view.body.slice(),
          note: trim(view.bodyOther)
        },
        takenAt: view.status === 'taken' ? (previous.takenAt || now) : '',
        createdAt: previous.createdAt || now,
        updatedAt: now
      };

      persist().then(function (ok) {
        btn.classList.remove('is-busy');
        btn.textContent = '保存这一天的记录';
        view.photoData = '';
        view.crops = [];
        view.skipPhoto = false;
        renderAll();
        switchPage('home');
        if (ok) {
          toast(view.status === 'taken' ? '已记下今天的服药时间' : '今天的记录已保存');
        } else if (!platform.active) {
          toast('预览模式：当前浏览器无法保存，记录只保留在当前页面');
        }
      });
    };

    if (view.photoData) {
      savePhoto(view.photoData).then(finish);
    } else {
      finish('');
    }
  }

  function saveDayStatus(status) {
    var key = view.dayKey;
    if (!key || key > todayKey()) {
      toast('未来的日期，等当天再记录');
      return;
    }
    var record = state.records[key];
    var now = new Date().toISOString();

    if (!record) {
      record = {
        status: status,
        pillIndex: pillIndexOn(key),
        packNo: pillIndexOn(key) ? packNo() : 0,
        photo: '',
        pillStates: {},
        changed: [],
        quality: null,
        body: null,
        takenAt: status === 'taken' ? now : '',
        createdAt: now,
        updatedAt: now
      };
      state.records[key] = record;
    } else {
      record.status = status;
      record.updatedAt = now;
      if (!record.pillIndex) record.pillIndex = pillIndexOn(key);
      if (!record.packNo && record.pillIndex) record.packNo = packNo();
      if (status === 'taken') {
        if (!record.takenAt) record.takenAt = now;
      } else {
        record.takenAt = '';
      }
    }

    view.dayDraft = status;
    persist().then(function (ok) {
      renderAll();
      renderDay();
      if (ok) toast('已更新为' + statusText(status));
    });
  }

  function saveMedication() {
    var name = trim($('medName').value);
    var slots = Number($('medSlots').value);
    var time = $('medTime').value || '21:00';
    var existingMed = state.medication;
    var packStartDate = existingMed ? (existingMed.packStart || existingMed.startDate || todayKey()) : todayKey();
    var packNoValue = existingMed ? Math.max(1, Number(existingMed.packNo) || 1) : 1;
    var hasBreak = $('medBreakSwitch').getAttribute('aria-pressed') !== 'false';
    var midway = $('medMidwaySwitch').getAttribute('aria-pressed') === 'true';
    var firstPill = midway ? Math.max(2, Math.min(slots, Number($('medStartPill').value) || 2)) : 1;
    var missedRaw = $('medMissed').value;
    var missedAfter = missedRaw === 'next_day' ? 'next_day' : Math.min(24, Math.max(1, Number(missedRaw) || 2));
    var note = trim($('medNote').value);

    if (!name) {
      toast('请填写药品名称');
      return;
    }
    if (slots !== 21 && slots !== 28) {
      toast('药位数请选择 21 或 28');
      return;
    }

    var keepPauses = [];
    if (state.medication &&
        Number(state.medication.slots) === slots &&
        (state.medication.packStart || state.medication.startDate) === packStartDate &&
        (Number(state.medication.packNo) || 1) === packNoValue) {
      keepPauses = state.medication.pauses || [];
    }

    state.medication = {
      name: name,
      slots: slots,
      time: time,
      missedAfter: missedAfter,
      startDate: packStartDate,
      packStart: packStartDate,
      startPill: firstPill,
      packNo: packNoValue,
      hasBreak: hasBreak,
      note: note,
      pauses: keepPauses,
      leaflet: (existingMed && Array.isArray(existingMed.leaflet)) ? existingMed.leaflet.slice() : []
    };

    if (state.blister.size !== slots) {
      state.blister.size = slots;
      state.blister.taken = [];
    }

    persist().then(function (ok) {
      renderAll();
      switchPage('home');
      if (ok) toast('药品档案已保存');
      else if (!platform.active && !platform.web) toast('预览模式：档案只保留在当前页面');
    });
  }

  function saveSettingsTime() {
    if (!state.medication) {
      toast('先建立药品档案，再设置服药时间');
      switchPage('med');
      return;
    }
    state.medication.time = $('settingsTime').value || '21:00';
    persist().then(function (ok) {
      renderAll();
      if (ok) toast('提醒时间已保存');
    });
  }

  function clearAllData() {
    var done = function () {
      state = createDefaultState();
      view.photoData = '';
      view.existingPhoto = '';
      view.quality = null;
      view.crops = [];
      view.pillStates = {};
      view.changed = [];
      view.status = '';
      view.dayKey = '';
      renderAll();
      switchPage('home');
      toast('本机数据已清除');
    };

    if (platform.active && platform.mt && typeof platform.mt.clearStorage === 'function') {
      platform.mt.clearStorage().then(done, function () {
        toast('清除失败，请稍后重试');
      });
    } else {
      done();
    }
  }

  function submitFeedback() {
    var el = $('feedbackText');
    var text = el ? trim(el.value) : '';
    if (!text) {
      toast('写一点内容再保存');
      return;
    }
    state.feedback.unshift({ text: text, at: new Date().toISOString() });
    state.feedback = state.feedback.slice(0, 20);
    persist().then(function (ok) {
      closeSheet();
      toast(ok ? '反馈已保存在本机' : '预览模式：反馈只保留在当前页面');
    });
  }

  /* ========================================================= 数据导出 */

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function lastNDays(n) {
    var out = [];
    var base = new Date();
    for (var i = n - 1; i >= 0; i--) {
      var d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
      out.push(dateKey(d));
    }
    return out;
  }

  function buildExportImage() {
    var days = lastNDays(7);
    var W = 750;
    var rowH = 88;
    var headH = 236;
    var footH = 120;
    var H = headH + days.length * rowH + footH;

    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d');

    ctx.fillStyle = '#fbfaf6';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#1e3a2c';
    ctx.font = 'bold 42px "PingFang SC", -apple-system, sans-serif';
    ctx.fillText('药药 · 近 7 天记录', 48, 88);

    ctx.fillStyle = '#8b948c';
    ctx.font = '22px "PingFang SC", -apple-system, sans-serif';
    var now = new Date();
    ctx.fillText('导出于 ' + now.getFullYear() + ' 年 ' + (now.getMonth() + 1) + ' 月 ' + now.getDate() + ' 日', 48, 126);

    var taken = 0;
    var notTaken = 0;
    var uncertain = 0;
    days.forEach(function (key) {
      var rec = state.records[key];
      if (!rec) return;
      if (rec.status === 'taken') taken++;
      else if (rec.status === 'not_taken') notTaken++;
      else uncertain++;
    });

    ctx.fillStyle = '#35513f';
    ctx.font = '24px "PingFang SC", -apple-system, sans-serif';
    ctx.fillText('已确认 ' + taken + ' 天 · 尚未 ' + notTaken + ' 天 · 不确定 ' + uncertain + ' 天', 48, 172);

    var med = state.medication;
    ctx.fillStyle = '#8b948c';
    ctx.font = '20px "PingFang SC", -apple-system, sans-serif';
    ctx.fillText(med ? med.name + ' · 第 ' + packNo() + ' 板 · 每板 ' + blisterSize() + ' 片' : '尚未建立药品档案', 48, 206);

    for (var i = 0; i < days.length; i++) {
      var key = days[i];
      var rec = state.records[key];
      var y = headH + i * rowH;

      ctx.fillStyle = '#ffffff';
      roundRect(ctx, 40, y, W - 80, rowH - 12, 18);
      ctx.fill();

      var d = parseKey(key);
      ctx.fillStyle = '#3b4c42';
      ctx.font = 'bold 24px "PingFang SC", -apple-system, sans-serif';
      ctx.fillText((d.getMonth() + 1) + '/' + d.getDate() + ' 周' + WEEK_CN[d.getDay()], 68, y + 48);

      var color = '#c9cec6';
      var text = '未记录';
      if (rec) {
        if (rec.status === 'taken') { color = '#7f9f84'; text = '已确认服用'; }
        else if (rec.status === 'not_taken') { color = '#c99174'; text = '尚未服用'; }
        else { color = '#d5b76a'; text = '我不确定'; }
      }

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(W - 320, y + 38, 7, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#1e3a2c';
      ctx.font = '24px "PingFang SC", -apple-system, sans-serif';
      ctx.fillText(text, W - 300, y + 47);

      if (rec && rec.pillStates) {
        var marked = Object.keys(rec.pillStates).length;
        ctx.fillStyle = '#8b948c';
        ctx.font = '19px "PingFang SC", -apple-system, sans-serif';
        ctx.fillText('药位标记 ' + marked + '/' + blisterSize() + (rec.photo ? ' · 有照片' : ''), 68, y + 74);
      }
    }

    ctx.fillStyle = '#aeb6ae';
    ctx.font = '19px "PingFang SC", -apple-system, sans-serif';
    ctx.fillText('药药只记录你确认的情况，不代表避孕效果，也不替代说明书或医生建议。', 48, H - 46);

    try {
      return canvas.toDataURL('image/jpeg', 0.92);
    } catch (err) {
      return '';
    }
  }

  function exportData() {
    var url = buildExportImage();
    if (!url) {
      toast('导出图片生成失败，请重试');
      return;
    }
    var mt = platform.mt;
    if (platform.active && mt && typeof mt.saveImageToPhotosAlbum === 'function') {
      mt.saveImageToPhotosAlbum({ imageUrl: url }).then(function () {
        toast('记录图片已保存到相册');
      }, function () {
        showExportPreview(url);
      });
    } else {
      showExportPreview(url);
    }
  }

  /* ========================================================= 数据备份 / 恢复 */

  /* 备份只含文字记录与档案，剔除照片（base64 体积大），照片仍留在本机 */
  function buildBackup() {
    var data = normalizeState(state);
    if (data.medication) data.medication.leaflet = [];
    Object.keys(data.records).forEach(function (key) {
      if (data.records[key]) data.records[key].photo = '';
    });
    return JSON.stringify({
      app: 'yaoyao',
      kind: 'backup',
      version: 5,
      exportedAt: new Date().toISOString(),
      data: data
    });
  }

  function openBackup() {
    if (!state.medication && !Object.keys(state.records).length) {
      toast('还没有记录可备份');
      return;
    }
    var json = buildBackup();
    showSheet('<h3>备份数据</h3>' +
      '<p class="sheet-sub">把下面这段文本复制，保存到备忘录或文件传输助手。换手机、清理数据前建议先备份。</p>' +
      '<p class="sheet-sub">备份包含药品档案和全部文字记录，不含照片；照片仍只保存在本机。</p>' +
      '<textarea id="backupText" rows="6" readonly>' + esc(json) + '</textarea>' +
      '<button class="btn primary block" data-action="copy-backup">复制备份文本</button>' +
      '<button class="btn ghost block" data-action="close-sheet">关闭</button>');
  }

  function copyBackup() {
    var el = $('backupText');
    if (!el) return;
    el.focus();
    el.select();
    if (el.setSelectionRange) el.setSelectionRange(0, el.value.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    toast(ok ? '备份文本已复制，请粘贴到备忘录保存' : '请长按文本全选后手动复制');
  }

  function openImport() {
    showSheet('<h3>恢复数据</h3>' +
      '<p class="sheet-sub">粘贴之前复制的备份文本。恢复会覆盖本机现有的档案和记录，本机已有照片若不在备份中会丢失，建议先备份当前数据。</p>' +
      '<textarea id="importText" rows="6" placeholder="长按粘贴备份文本"></textarea>' +
      '<button class="btn primary block" data-action="confirm-import">确认恢复并覆盖</button>' +
      '<button class="btn ghost block" data-action="close-sheet">取消</button>');
  }

  function importBackup() {
    var el = $('importText');
    var raw = el ? trim(el.value) : '';
    if (!raw) {
      toast('请先粘贴备份文本');
      return;
    }
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (err) { parsed = null; }
    if (!parsed || parsed.app !== 'yaoyao' || !parsed.data || typeof parsed.data !== 'object') {
      toast('这不是药药的备份文本，请检查后重试');
      return;
    }
    state = normalizeState(parsed.data);
    state.settings.onboarded = true;
    persist().then(function (ok) {
      closeSheet();
      renderAll();
      switchPage('home');
      toast(ok === false ? '已恢复到当前页面，但本机保存失败，请重试' : '恢复成功，记录已找回');
    });
  }

  /* ========================================================= 说明书照片 */

  function leafletThumbsHtml() {
    var med = state.medication;
    var list = med && Array.isArray(med.leaflet) ? med.leaflet : [];
    if (!list.length) return '';
    var html = '';
    for (var i = 0; i < list.length; i++) {
      html += '<div class="leaflet-thumb">' +
        '<img src="' + esc(list[i]) + '" alt="说明书照片 ' + (i + 1) + '" data-action="leaflet-view" data-index="' + i + '">' +
        '<button type="button" class="leaflet-del" data-action="leaflet-remove" data-index="' + i + '" aria-label="删除第 ' + (i + 1) + ' 张说明书照片">×</button>' +
        '</div>';
    }
    return html;
  }

  function renderLeafletPage() {
    var med = state.medication;
    var lead = $('leafletLead');
    var grid = $('leafletGrid');
    var empty = $('leafletEmpty');
    if (lead) {
      if (!med) lead.textContent = '先建立药品档案，再拍照保存说明书。';
      else {
        var n = (med.leaflet || []).length;
        lead.textContent = n
          ? ('已保存 ' + n + ' 张说明书照片，可继续添加或删除重拍。')
          : '拍照保存药品说明书，关键信息随时能看。';
      }
    }
    var html = leafletThumbsHtml();
    if (grid) grid.innerHTML = html;
    if (empty) empty.hidden = !!html;
  }

  function renderLeafletEditor() {
    var grid = $('medLeafletGrid');
    var empty = $('medLeafletEmpty');
    if (!grid) return;
    var html = leafletThumbsHtml();
    grid.innerHTML = html;
    if (empty) empty.hidden = !!html;
  }

  function openLeaflet() {
    if (!state.medication) {
      renderMedForm();
      switchPage('med');
      toast('先建立药品档案，再拍照保存说明书');
      return;
    }
    view.fromPage = view.page;
    renderLeafletPage();
    switchPage('leaflet');
  }

  function handleLeafletFile(file) {
    if (!file) return;
    if (file.type && file.type.indexOf('image/') !== 0) { toast('请选择图片文件'); return; }
    if (!state.medication) { toast('先建立药品档案'); return; }
    toast('正在添加说明书照片…');
    compressImage(file, function (dataUrl) {
      if (!dataUrl) { toast('图片处理失败，请重试'); return; }
      addLeafletPhoto(dataUrl);
    });
  }

  function addLeafletPhoto(dataUrl) {
    if (!state.medication) return;
    var finish = function (ref) {
      if (!state.medication) return;
      if (!Array.isArray(state.medication.leaflet)) state.medication.leaflet = [];
      state.medication.leaflet.push(ref);
      persist().then(function () {
        renderLeafletPage();
        renderLeafletEditor();
        renderProfile();
        toast('已添加说明书照片');
      });
    };
    if (platform.fs) {
      saveLeafletPhoto(dataUrl).then(finish);
    } else {
      finish(dataUrl);
    }
  }

  function saveLeafletPhoto(dataUrl) {
    if (!platform.fs) return Promise.resolve('');
    var base64 = dataUrl.indexOf(',') > -1 ? dataUrl.split(',')[1] : dataUrl;
    var dir = platform.userDataPath + '/leaflet';
    var filePath = dir + '/leaflet_' + Date.now() + '_' + Math.floor(Math.random() * 1000) + '.jpg';
    return platform.mt.mkdir({ dirPath: dir, recursive: true }).then(null, function () {
      return null;
    }).then(function () {
      return platform.mt.writeFile({ filePath: filePath, data: base64, encoding: 'base64' });
    }).then(function () {
      return filePath;
    }, function () {
      toast('照片保存失败，请重试');
      return '';
    });
  }

  function removeLeafletPhoto(index) {
    var med = state.medication;
    if (!med || !Array.isArray(med.leaflet) || index < 0 || index >= med.leaflet.length) return;
    med.leaflet.splice(index, 1);
    persist().then(function () {
      renderLeafletPage();
      renderLeafletEditor();
      renderProfile();
      toast('已删除');
    });
  }

  function viewLeafletPhoto(index) {
    var med = state.medication;
    var ref = med && Array.isArray(med.leaflet) ? med.leaflet[index] : '';
    if (!ref) { toast('照片加载失败'); return; }
    showSheet('<h3>说明书照片</h3>' +
      '<p class="sheet-sub">第 ' + (index + 1) + ' 张 · 可在说明书页删除或重拍</p>' +
      '<img src="' + esc(ref) + '" alt="说明书照片">' +
      '<button class="btn ghost block" data-action="close-sheet">关闭</button>');
  }

  /* ========================================================= 事件 */

  function bindEvents() {
    document.addEventListener('click', onClick);

    $('cameraInput').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (view.captureTarget === 'leaflet') handleLeafletFile(file);
      else handleFile(file);
      view.captureTarget = 'checkin';
      event.target.value = '';
    });

    $('albumInput').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (view.captureTarget === 'leaflet') handleLeafletFile(file);
      else handleFile(file);
      view.captureTarget = 'checkin';
      event.target.value = '';
    });

    $('bodyOther').addEventListener('input', function () {
      view.bodyOther = this.value;
    });

    $('medSlots').addEventListener('change', function () {
      renderMedStartPill($('medStartPill').value);
    });

    $('sheetMask').addEventListener('click', function (event) {
      if (event.target === $('sheetMask')) closeSheet();
    });

    $('resultPhoto').addEventListener('load', layoutOverlay);
    window.addEventListener('resize', layoutOverlay);

    document.addEventListener('error', function (event) {
      var target = event.target;
      if (target && target.tagName === 'IMG') {
        toast('照片加载失败，可能已被清理');
      }
    }, true);
  }

  function onClick(event) {
    var node = event.target;
    var action = '';
    var nav = '';

    while (node && node.nodeType === 1) {
      if (node.getAttribute('data-nav')) {
        nav = node.getAttribute('data-nav');
        break;
      }
      if (node.getAttribute('data-action')) {
        action = node.getAttribute('data-action');
        break;
      }
      if (node === document.body) break;
      node = node.parentNode;
    }

    if (nav) {
      if (nav === 'checkin') {
        startCheckin();
      } else {
        switchPage(nav);
      }
      return;
    }

    if (!action) return;
    handleAction(action, node);
  }

  function handleAction(action, node) {
    switch (action) {
      case 'start-checkin':
        startCheckin();
        break;
      case 'break-checkin':
        openBreakCheckin();
        break;
      case 'save-break-checkin':
        saveRecord('not_taken');
        break;
      case 'view-today':
        viewToday();
        break;
      case 'open-camera':
        $('cameraInput').click();
        break;
      case 'open-album':
        $('albumInput').click();
        break;
      case 'retake':
        view.photoData = '';
        view.quality = null;
        view.crops = [];
        view.skipPhoto = false;
        renderCheckin();
        break;
      case 'skip-photo':
        view.skipPhoto = true;
        renderCheckin();
        break;
      case 'body-pick':
        pickBody(node.getAttribute('data-body'));
        break;
      case 'confirm-photo':
        if (!view.photoData) {
          toast('请先拍摄或选择一张照片');
          return;
        }
        view.status = '';
        view.pillStates = {};
        view.changed = [];
        renderResult();
        switchPage('result');
        toast('请逐格标记药位外观');
        break;
      case 'confirm-taken':
        if (!view.photoData && !view.skipPhoto) {
          toast('请先拍照，或选择不拍照直接记录');
          return;
        }
        saveRecord('taken');
        break;
      case 'confirm-not-taken':
        if (!view.photoData && !view.skipPhoto) {
          toast('请先拍照，或选择不拍照直接记录');
          return;
        }
        saveRecord('not_taken');
        break;
      case 'confirm-uncertain':
        if (!view.photoData && !view.skipPhoto) {
          toast('请先拍照，或选择不拍照直接记录');
          return;
        }
        saveRecord('uncertain');
        break;
      case 'view-last-photo':
        openLastPhoto();
        break;
      case 'open-pill':
        openPill(node.getAttribute('data-index'));
        break;
      case 'set-pill':
        setPill(node.getAttribute('data-index'), node.getAttribute('data-status'));
        break;
      case 'choose-status':
        chooseStatus(node.getAttribute('data-status'));
        break;
      case 'save-record':
        saveRecord();
        break;
      case 'prev-month':
        view.month = new Date(view.month.getFullYear(), view.month.getMonth() - 1, 1);
        renderCalendar();
        break;
      case 'next-month':
        view.month = new Date(view.month.getFullYear(), view.month.getMonth() + 1, 1);
        renderCalendar();
        break;
      case 'goto-today':
        view.month = new Date();
        renderCalendar();
        break;
      case 'open-day':
        openDay(node.getAttribute('data-date'));
        break;
      case 'day-status':
        saveDayStatus(node.getAttribute('data-status'));
        break;
      case 'day-retake':
        openCheckin();
        break;
      case 'day-photo':
        openDayPhoto();
        break;
      case 'back-calendar':
        renderCalendar();
        switchPage('calendar');
        break;
      case 'back-checkin':
        if (view.photoData) {
          renderCheckin();
          switchPage('checkin');
        } else {
          switchPage('home');
        }
        break;
      case 'back-profile':
        switchPage('profile');
        break;
      case 'back-leaflet':
        switchPage(view.fromPage || 'home');
        break;
      case 'open-leaflet':
        openLeaflet();
        break;
      case 'leaflet-camera':
        if (!state.medication) { renderMedForm(); switchPage('med'); toast('先建立药品档案'); break; }
        view.captureTarget = 'leaflet';
        $('cameraInput').click();
        break;
      case 'leaflet-album':
        if (!state.medication) { renderMedForm(); switchPage('med'); toast('先建立药品档案'); break; }
        view.captureTarget = 'leaflet';
        $('albumInput').click();
        break;
      case 'leaflet-view':
        viewLeafletPhoto(Number(node.getAttribute('data-index')));
        break;
      case 'leaflet-remove':
        removeLeafletPhoto(Number(node.getAttribute('data-index')));
        break;
      case 'open-med':
        renderMedForm();
        switchPage('med');
        break;
      case 'save-med':
        saveMedication();
        break;
      case 'new-blister':
        confirmNewBlister();
        break;
      case 'open-pause':
        openPauseSheet();
        break;
      case 'open-resume':
        openResumeSheet();
        break;
      case 'pause-start':
        schedulePause(node.getAttribute('data-when') === 'today'
          ? todayKey()
          : addDays(todayKey(), 1));
        break;
      case 'cancel-pause':
        cancelPause();
        break;
      case 'resume-med':
        resumeMed(node.getAttribute('data-mode'));
        break;
      case 'confirm-new-blister':
        if (state.medication) {
          state.medication.packNo = packNo() + 1;
          state.medication.packStart = todayKey();
          state.medication.startDate = todayKey();
          state.medication.startPill = 1;
        }
        state.blister.taken = [];
        persist().then(function () {
          closeSheet();
          renderAll();
          toast('已换到第 ' + packNo() + ' 板');
        });
        break;
      case 'toggle-med-midway':
        var midwaySw = $('medMidwaySwitch');
        var midwayOn = midwaySw.getAttribute('aria-pressed') !== 'true';
        midwaySw.className = 'switch' + (midwayOn ? ' is-on' : '');
        midwaySw.setAttribute('aria-pressed', midwayOn ? 'true' : 'false');
        $('medStartPillWrap').hidden = !midwayOn;
        if (midwayOn) renderMedStartPill($('medStartPill').value);
        break;
      case 'toggle-med-break':
        var breakSw = $('medBreakSwitch');
        var breakOn = breakSw.getAttribute('aria-pressed') !== 'true';
        breakSw.className = 'switch' + (breakOn ? ' is-on' : '');
        breakSw.setAttribute('aria-pressed', breakOn ? 'true' : 'false');
        break;
      case 'toggle-dev-mode':
        state.settings.devMode = !state.settings.devMode;
        view.devDate = state.settings.devMode ? (view.devDate || realTodayKey()) : '';
        persist().then(function () {
          renderAll();
          toast(state.settings.devMode ? '开发者模式已开启' : '开发者模式已关闭');
        });
        break;
      case 'dev-prev':
        view.devDate = addDays(view.devDate || realTodayKey(), -1);
        renderHome();
        break;
      case 'dev-next':
        view.devDate = addDays(view.devDate || realTodayKey(), 1);
        renderHome();
        break;
      case 'dev-today':
        view.devDate = realTodayKey();
        renderHome();
        break;
      case 'dev-add':
        devAddRecord(node.getAttribute('data-status'));
        break;
      case 'dev-open':
        openDay(view.devDate || realTodayKey());
        break;
      case 'dev-clear':
        devClearRecord();
        break;
      case 'toggle-reminder':
        state.settings.reminderOn = !state.settings.reminderOn;
        renderSettings();
        renderProfile();
        persist();
        break;
      case 'save-settings-time':
        saveSettingsTime();
        break;
      case 'export-data':
        exportData();
        break;
      case 'backup-data':
        openBackup();
        break;
      case 'copy-backup':
        copyBackup();
        break;
      case 'import-data':
        openImport();
        break;
      case 'confirm-import':
        importBackup();
        break;
      case 'welcome-med':
        finishWelcome();
        switchPage('med');
        break;
      case 'welcome-skip':
        finishWelcome();
        break;
      case 'clear-data':
        confirmClear();
        break;
      case 'confirm-clear':
        clearAllData();
        break;
      case 'open-privacy':
        openPrivacy();
        break;
      case 'open-about':
        openAbout();
        break;
      case 'open-feedback':
        openFeedback();
        break;
      case 'submit-feedback':
        submitFeedback();
        break;
      case 'close-sheet':
        closeSheet();
        break;
      case 'retry-load':
        loadState().then(function (ok) {
          view.loadError = !ok;
          renderAll();
          if (ok) toast('本机记录已重新读取');
        });
        break;
      default:
        break;
    }
  }

  /* ========================================================= 启动 */

  var bootAt = Date.now();

  function hideLoading() {
    var wait = Math.max(0, 420 - (Date.now() - bootAt));
    setTimeout(function () {
      $('loadingOverlay').hidden = true;
    }, wait);
  }

  function boot() {
    bindEvents();
    detectPlatform();

    if (!platform.active) {
      $('previewBanner').hidden = false;
      $('previewBanner').textContent = platform.web
        ? '浏览器模式 · 记录保存在本浏览器，清理缓存前记得在「我的 → 备份数据」导出'
        : '预览模式 · 当前浏览器无法保存数据，记录只保留在本页';
    }

    initPlatform().then(function () {
      return loadState();
    }).then(function (ok) {
      view.loadError = ok === false;
      renderAll();
      switchPage('home');
      hideLoading();
      maybeWelcome();
    }, function () {
      view.loadError = true;
      renderAll();
      switchPage('home');
      hideLoading();
    });
  }

  boot();
})();
