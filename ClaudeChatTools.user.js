// ==UserScript==
// @name         Claude 對話工具
// @namespace    https://github.com/bgtsai/claude-chat-tools
// @version      0.2.0
// @description  claude.ai 對話工具：上下文用量（頁首標籤、詳細面板、底部燈帶、送出時附用量標記）、/context 方格圖、交接對話串。合併自 claude-context-meter、claude-context-usage-grid、claude-chat-handover
// @author       bgtsai
// @match        https://claude.ai/*
// @grant        none
// @run-at       document-start
// @homepageURL  https://github.com/bgtsai/claude-chat-tools
// @downloadURL  https://raw.githubusercontent.com/bgtsai/claude-chat-tools/main/ClaudeChatTools.user.js
// @updateURL    https://raw.githubusercontent.com/bgtsai/claude-chat-tools/main/ClaudeChatTools.user.js
// ==/UserScript==

// 三支合成一支（2026-11-13 使用者定案）：用量要在 document-start 包 fetch，所以整支用 document-start；
// 方格圖與交接原本是 document-idle，要碰 document.body，等 DOMContentLoaded 再啟動。
// 用量沿用舊前綴 ccm:（localStorage），舊設定不用搬；交接只用 sessionStorage，方格圖不存東西。
(function () {
    'use strict';
    const TOOLS_VERSION = '0.2.0';
    const TOOLS = {}; // 模組之間的介面：handover.run（交接模組）、meter（用量模組的 state 與設定）
    const whenReady = fn => { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true }); else fn(); };

    // ════════ 模組一：上下文用量（原 claude-context-meter v0.4.0）════════
    (function () {

    // 為什麼 @grant none：要包的是頁面自己的 fetch；宣告任何 @grant 會進沙盒，window.fetch 改到沙盒副本、靜默失效。
    // 為什麼 document-start：網頁很早就存下原生 fetch；晚一步包，部分請求不會經過我們（2026-11-12 實測）。
    const VERSION = TOOLS_VERSION;

    // 推導見 README「預設值」；2026-11-12 以 /context 實測
    const CFG = {
        DEFAULT_FIXED: 135000,        // F：/context 總量 − 訊息
        DEFAULT_K: 1.82,              // k：/context 的訊息 ÷ 對話樹估算
        DEFAULT_WINDOW: 1000000,      // 上下文視窗（/context 的「/ 1m」）
        RULES_R: 42000,               // R：新對話串要讀的規則
        HANDOFF_H: 5000,              // H：交接內容
        WORK_W: 40000,                // W：新對話串要重讀的工作資料
        NEXT_ROUNDS: 15,              // 下一階段預估輪數（沒有其他資訊時的預設）
        K_READ: 0.1, K_WRITE: 1.25,   // 快取讀取／寫入相對正常價的比例（01 第⑫條）
        WARN_PCT: 0.70,               // 開始提醒的用量（黃）
        HIGH_PCT: 0.80,               // 紅：再往上可能來不及歸檔＋交接就被自動壓縮（96.7 萬壓縮 − 歸檔交接約 15 萬，推測值，待實測）
        WARN_STEP: 0.10,              // 之後每增加多少再提醒一次
        AUTO_CTX: true,               // 自動送 /context 校正
        AUTO_FIRST_MIN_MSGS: 2,       // 沒有校正點時，至少幾則訊息才送
        AUTO_RECHECK_PCT: 0.65,       // 估算到這個用量、且上次校正低於 AUTO_RECHECK_BELOW 時再送一次
        AUTO_RECHECK_BELOW: 0.60,
        CONT_MAX: 15,                 // 連續自動續做上限（可能在空轉）
        CONT_NEAR_PCT: 0.05,          // 加上下一批後離門檻不到這麼多 → 先送 /context 校正再判斷
        CTX_WAIT_MS: 30000,           // 代送 /context 後等輸出的上限；逾時照估算判斷並照送
        CALLS_PER_BATCH: 30,          // 沒有前幾批可平均時，每批的工具呼叫次數（估計值）
        SWITCH_COST_FACTOR: 2.5,      // 換串成本＝公式 × 這個倍數（沒實測資料時；交接檔：約公式的 2～3 倍）
        AUTO_HANDOFF_MAX: 5,          // 連續自動交接上限；手動交接歸零（使用者定案）
        TAG_ON_SEND: true,            // 送出訊息時在尾端附用量標記，讓 Claude 每輪讀得到（使用者定案，2026-11-12）
        REFRESH_THROTTLE_MS: 1500,    // 同一輪結束常連續觸發好幾次，合併成一次（節流，不是防手震）
    };
    const LS = 'ccm:';                // localStorage 前綴（專案前綴，避免撞名）
    const SESSION_RE = /\/v1\/code\/sessions\/cse_[A-Za-z0-9]+/;
    const ORG_RE = /\/api\/organizations\/([0-9a-f-]{36})\//;
    const CHAT_RE = /\/chat\/([0-9a-f-]{36})/;
    const CTX_HEAD = '## Context' + ' Usage'; // 拆開寫：避免本檔被別的工具用文字搜尋時誤判
    const SEL = {
        input: '[data-testid="chat-input"]', send: 'button[data-testid="chat-input-send"]',
        titleSplit: '[data-testid="session-title-split"]', // 頁首「標題 ⌄」那一排（跟 claude-chat-handover 同一組選擇器）
        moreBtn: 'button[aria-haspopup="menu"]',          // 標題旁的 ⌄
    };

    const state = { orgId: null, last: null, err: null, autoPending: false };
    const SWITCH_FACTOR = () => { const h = load('hcost', null); return h && h.factor ? h.factor : CFG.SWITCH_COST_FACTOR; };
    TOOLS.meter = { state, opts: () => opts(), save: (k, v) => save(k, v), load: (k, d) => load(k, d) };
    window.__ccm = state; // 給除錯用（Claude in Chrome 讀得到）

    const load = (k, d) => { try { const v = localStorage.getItem(LS + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
    const save = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { /* 存不了不影響顯示 */ } };

    // ── 1. 攔 fetch：看到工作階段 GET 就代表一輪剛結束 ──
    const origFetch = window.fetch;
    window.fetch = async function (...a) {
        const r = await origFetch.apply(this, a);
        try {
            const u = String(a[0] && a[0].url || a[0]);
            const mo = u.match(ORG_RE);
            if (mo) state.orgId = mo[1];
            const me = (a[1] && a[1].method) || (a[0] && a[0].method) || 'GET';
            if (me === 'GET' && SESSION_RE.test(u)) scheduleRefresh();
        } catch (e) { state.err = 'hook: ' + e; }
        return r;
    };

    let lastRun = 0, timer = null;
    function scheduleRefresh() {
        if (timer) return;
        const wait = Math.max(0, CFG.REFRESH_THROTTLE_MS - (Date.now() - lastRun));
        timer = setTimeout(() => { timer = null; lastRun = Date.now(); refresh().catch(e => { state.err = 'refresh: ' + e; render(); }); }, wait);
    }

    // ── 2. 估算 ──
    function estTokens(s) {
        let cjk = 0, other = 0;
        for (const ch of s) { if (/[　-鿿가-힯＀-￯]/.test(ch)) cjk++; else other++; }
        return cjk + other / 3.5;
    }
    function blockText(b) {
        if (!b) return '';
        if (b.type === 'text') return b.text || '';
        if (b.type === 'thinking') return ''; // 舊回合的思考不在後續的上下文裡
        if (b.type === 'tool_use') return JSON.stringify(b.input || {});
        return JSON.stringify(b.content || '');
    }
    function msgTokens(m) {
        let s = (m.content || []).map(blockText).join('\n');
        (m.attachments || []).forEach(x => { if (x && x.extracted_content) s += x.extracted_content; });
        return estTokens(s);
    }
    function trunkOf(tree) {
        const byId = new Map((tree.chat_messages || []).map(m => [m.uuid, m]));
        const out = []; let cur = tree.current_leaf_message_uuid; const seen = new Set();
        while (cur && byId.has(cur) && !seen.has(cur)) { seen.add(cur); const m = byId.get(cur); out.push(m); cur = m.parent_message_uuid; }
        return out.reverse();
    }
    // /context 輸出：Tokens: 404.4k / 1m (40%)、| Messages | 269.5k |
    function parseNum(s) { const m = String(s).trim().match(/^([\d.]+)\s*([km]?)$/i); if (!m) return null; return parseFloat(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1); }
    function parseContext(text) {
        const t = text.match(/\*\*Tokens:\*\*\s*([\d.]+[km]?)\s*\/\s*([\d.]+[km]?)/i);
        const msg = text.match(/\|\s*Messages\s*\|\s*([\d.]+[km]?)\s*\|/i);
        if (!t || !msg) return null;
        const total = parseNum(t[1]), win = parseNum(t[2]), messages = parseNum(msg[1]);
        return total && win && messages ? { total, win, messages } : null;
    }

    async function refresh() {
        const cm = location.pathname.match(CHAT_RE);
        if (!cm || !state.orgId) return;
        const cid = cm[1];
        const r = await origFetch('/api/organizations/' + state.orgId + '/chat_conversations/' + cid + '?tree=true&rendering_mode=messages&render_all_tools=true', { credentials: 'include' });
        if (!r.ok) { state.err = '對話樹 HTTP ' + r.status; render(); return; }
        const trunk = trunkOf(await r.json());
        const per = trunk.map(msgTokens);
        const estNow = per.reduce((a, b) => a + b, 0);

        // 最近一次 /context
        let calib = null;
        for (let i = trunk.length - 1; i >= 0 && !calib; i--) {
            const txt = (trunk[i].content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n');
            if (txt.startsWith(CTX_HEAD)) {
                const p = parseContext(txt);
                if (p) { const before = per.slice(0, i).reduce((a, b) => a + b, 0); calib = { ...p, idx: i, before, k: before > 0 ? p.messages / before : CFG.DEFAULT_K, fixed: p.total - p.messages }; }
            }
        }
        if (calib) save('lastCalib', { fixed: calib.fixed, k: calib.k, win: calib.win, at: Date.now() });
        const g = load('lastCalib', null);
        const fixed = calib ? calib.fixed : (g ? g.fixed : CFG.DEFAULT_FIXED);
        const k = calib ? calib.k : (g ? g.k : CFG.DEFAULT_K);
        const win = calib ? calib.win : (g ? g.win : CFG.DEFAULT_WINDOW);
        // 有校正點時等同「/context 總量 ＋ k ×（之後新增的估算）」：k × 校正點之前的估算 ＝ 訊息，代數上相同
        const C = fixed + k * estNow;

        const B = fixed + CFG.RULES_R + CFG.HANDOFF_H + CFG.WORK_W;
        const nStar = C > B ? (CFG.K_WRITE * B) / (CFG.K_READ * (C - B)) : Infinity;
        const pct = C / win;
        const switchWorth = CFG.NEXT_ROUNDS >= nStar;

        state.last = { cid, t: Date.now(), C: Math.round(C), pct, win, fixed: Math.round(fixed), k: +k.toFixed(3), estNow: Math.round(estNow), msgs: trunk.length,
            calib: calib ? { total: calib.total, messages: calib.messages, idx: calib.idx, ago: trunk.length - 1 - calib.idx } : null,
            source: calib ? '此對話串的 /context' : (g ? '其他對話串的校正' : '預設值'), B: Math.round(B), nStar, switchWorth };
        const ci = contInfo(trunk);
        if (ci) { const calls = ci.left * callsPerBatch(trunk), ns = nStar * SWITCH_FACTOR(); state.last.cont = { left: ci.left, calls, nStar: ns, switchWorth: calls >= ns }; }
        state.last.autoN = autoCount(trunk);
        state.last.continuing = !!ci || (trunk.length && trunk[trunk.length - 1].sender === 'human' && textOf(trunk[trunk.length - 1]).trim().startsWith(AUTO_PREFIX + '繼續'));
        state.err = null;
        warnIfNeeded(cid, pct);
        render();
        if (!autoFlow(cid, trunk, calib)) maybeAutoContext(cid, trunk, pct, calib);
    }

    // ── 3. 提醒：70% 起每 +10% 一次；換串划算時標示 ──
    function warnIfNeeded(cid, pct) {
        if (pct < CFG.WARN_PCT) return;
        const level = Math.floor((pct - CFG.WARN_PCT) / CFG.WARN_STEP + 1e-9);
        const key = 'warned:' + cid;
        if (load(key, -1) >= level) return;
        save(key, level);
        state.flash = Date.now();
    }

    // ── 4. 自動 /context：同一輪只送一次（取代舊的「每串 3 次、間隔 15 分鐘」，使用者定案 2026-11-13）──
    async function maybeAutoContext(cid, trunk, pct, calib) {
        if (!CFG.AUTO_CTX || state.autoPending || state.pendCont) return;
        const nMsgs = trunk.length, lastU = trunk.length ? trunk[trunk.length - 1].uuid : '';
        if (load('autoctx:' + cid, '') === lastU) return;
        const need = (!calib && nMsgs >= CFG.AUTO_FIRST_MIN_MSGS)
            || (calib && pct >= CFG.AUTO_RECHECK_PCT && calib.total / calib.win < CFG.AUTO_RECHECK_BELOW);
        if (!need) return;
        const ed = document.querySelector(SEL.input);
        if (!ed || ed.innerText.trim()) return; // 使用者有沒送出的字就不動，下一輪再說
        if (await sendContext('自動 /context')) save('autoctx:' + cid, lastU);
    }
    // 把一段文字填進輸入框並送出（/context、〔自動〕訊息共用）；輸入框有字時不送。成功回 true
    async function fillSend(text, who) {
        const ed = document.querySelector(SEL.input);
        if (!ed || ed.innerText.trim() || state.autoPending) return false;
        state.autoPending = true; render();
        const norm = s => s.replace(/\s+/g, '');
        try {
            ed.focus();
            const dt = new DataTransfer(); dt.setData('text/plain', text);
            ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
            await sleep(300);
            if (norm(ed.innerText) !== norm(text)) { clearEd(ed); document.execCommand('insertText', false, text); }
            await sleep(300);
            if (norm(ed.innerText) !== norm(text)) { state.err = who + '：填入失敗'; return false; }
            const btn = document.querySelector(SEL.send);
            if (!btn) { state.err = who + '：找不到送出鈕'; return false; }
            passSend = true; try { btn.click(); } finally { passSend = false; }
            await sleep(1500);
            if (ed.innerText.trim()) { state.err = who + '：送出後輸入框沒清空'; return false; }
            return true;
        } finally { state.autoPending = false; render(); }
    }
    function clearEd(ed) { const s = getSelection(); s.selectAllChildren(ed); document.execCommand('delete', false); }
    async function sendContext(who) {
        const ok = await fillSend('/context', who);
        if (ok) state.calibWait = { idx: state.last && state.last.calib ? state.last.calib.idx : -1, t: Date.now() };
        return ok;
    }
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // ── 4b. 自動續做（交接檔「已定案・自動續做」；mockup 1–5、9 區）──
    // Claude 一批做完，回覆最後一行寫〔續做〕；腳本讀對話樹判斷用量，以使用者身分送〔自動〕繼續／停。
    // 只是看用量，不是新的授權：Claude 只在使用者已同意的分批計畫裡寫〔續做〕。
    const CONT_RE = /^〔續做〕下一批：(.+?)；預估\s*([\d.]+)\s*萬；剩\s*(\d+)\s*批/;
    const READY_RE = /^〔交接就緒〕開場白\s*(\d+)\s*字\s*$/m;
    const AUTO_PREFIX = '〔自動〕';
    const OPT_DEF = { thr: 0.80, onStop: 'handoff', autoHandoff: false, autoAllow: false };
    const opts = () => Object.assign({}, OPT_DEF, load('opt', {}));
    const setOpt = (k, v) => { const o = load('opt', {}); o[k] = v; save('opt', o); render(); };
    const effOnStop = o => (o.thr >= 0.85 ? 'draft' : o.onStop); // 85% 時剩下的空間來不及歸檔
    const textOf = m => (m.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n');
    const lastLine = t => { const a = t.trim().split('\n'); return a[a.length - 1].trim(); };
    // 使用者最後一則自己打的訊息：human、不是〔自動〕、不是 / 指令
    function lastUserIdx(trunk) {
        for (let i = trunk.length - 1; i >= 0; i--) {
            const m = trunk[i]; if (m.sender !== 'human') continue;
            const t = textOf(m).trim(); if (!t.startsWith(AUTO_PREFIX) && !t.startsWith('/')) return i;
        }
        return -1;
    }
    const autoCount = trunk => trunk.slice(lastUserIdx(trunk) + 1).filter(m => m.sender === 'human' && textOf(m).trim().startsWith(AUTO_PREFIX + '繼續')).length;
    // 一批＝兩則 human 之間所有助理訊息的工具呼叫；只算以〔續做〕結尾的批，取平均（一輪＝重讀一次上下文）
    function callsPerBatch(trunk) {
        const batches = []; let n = 0, lastTxt = '';
        for (const m of trunk) {
            if (m.sender === 'human') { if (CONT_RE.test(lastLine(lastTxt))) batches.push(n); n = 0; lastTxt = ''; continue; }
            n += (m.content || []).filter(b => b.type === 'tool_use').length; const t = textOf(m); if (t.trim()) lastTxt = t;
        }
        const recent = batches.slice(-3);
        return recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : CFG.CALLS_PER_BATCH;
    }
    function contInfo(trunk) {
        const last = trunk[trunk.length - 1];
        if (!last || last.sender !== 'assistant') return null;
        const cm = lastLine(textOf(last)).match(CONT_RE);
        return cm ? { uuid: last.uuid, idx: trunk.length - 1, name: cm[1], est: parseFloat(cm[2]) * 1e4, left: +cm[3] } : null;
    }
    const P = x => Math.round(x * 100);
    function stopLine2(kind) {
        if (kind === 'max') return '記好草稿與進度，然後停下來等我。';
        return { draft: '記好草稿與進度，然後停下來等我。', archive: '先歸檔，然後停下來等我。', handoff: '先歸檔，再準備交接內容，然後停下來等我。' }[effOnStop(opts())];
    }
    async function decide(cid, trunk, info, note) {
        save('cont:' + cid, info.uuid);
        const L = state.last, o = opts(), n = autoCount(trunk);
        const after = L.pct + info.est / L.win;
        const c = L.cont || {};
        let stop = null, kind = '';
        if (after >= o.thr) { kind = 'thr'; stop = '現在 ' + P(L.pct) + '%，加上下一批約 ' + P(after) + '%，超過門檻 ' + P(o.thr) + '%。'; }
        else if (c.switchWorth) { kind = 'switch'; stop = '建議換串。剩 ' + info.left + ' 批約 ' + Math.round(c.calls) + ' 次工具呼叫，換新對話串約 ' + Math.ceil(c.nStar) + ' 次後回本。'; }
        else if (n >= CFG.CONT_MAX) { kind = 'max'; stop = '已經連續自動續做 ' + CFG.CONT_MAX + ' 次，可能在空轉。'; }
        const tail = note ? note : '';
        const msg = stop ? AUTO_PREFIX + '停：' + stop + tail + '\n' + stopLine2(kind) : AUTO_PREFIX + '繼續（第 ' + (n + 1) + ' 次）。' + tail;
        const ok = await fillSend(msg + '\n' + tagText(), '自動續做');
        if (ok && stop && kind !== 'max' && effOnStop(o) === 'handoff' && o.autoHandoff) save('await:' + cid, 1);
        state.contLog = { t: Date.now(), msg: msg.split('\n')[0], ok };
    }
    // 回傳 true＝這一輪由續做流程處理（含要不要送 /context），一般的自動 /context 不再插手
    function autoFlow(cid, trunk, calib) {
        if (state.pendCont && state.pendCont.cid === cid) {
            const p = state.pendCont;
            const got = calib && calib.idx > p.info.idx;
            if (got || Date.now() - p.t > CFG.CTX_WAIT_MS) { state.pendCont = null; decide(cid, trunk, p.info, got ? '已校正用量。' : '（校正失敗，用估算）'); }
            else if (!state.pendTimer) state.pendTimer = setTimeout(() => { state.pendTimer = null; scheduleRefresh(); }, CFG.CTX_WAIT_MS + 500);
            return true;
        }
        const last = trunk[trunk.length - 1];
        if (last && last.sender === 'assistant') { const t = textOf(last), rm = t.match(READY_RE); if (rm) { handleReady(cid, last, t, rm); return true; } }
        const info = contInfo(trunk);
        if (!info) return false;
        if (load('cont:' + cid, '') === info.uuid) return true; // 同一則回覆只回一次
        const ed = document.querySelector(SEL.input);
        if (!ed || ed.innerText.trim()) return true;           // 使用者在打字：不動
        const L = state.last, o = opts();
        const near = L.pct + info.est / L.win >= o.thr - CFG.CONT_NEAR_PCT;
        const fresh = calib && calib.idx > lastUserIdx(trunk);
        // 離門檻近、或這串還沒有任何校正（新串量起點）→ 先代送 /context，輸出出現後一定補送〔自動〕訊息（mockup 9 區）
        if ((near || !calib) && !fresh && load('autoctx:' + cid, '') !== info.uuid) {
            save('autoctx:' + cid, info.uuid);
            state.pendCont = { cid, t: Date.now(), info };
            sendContext('續做校正').then(ok => { if (!ok && state.pendCont) { state.pendCont = null; decide(cid, trunk, info, '（校正失敗，用估算）'); } });
            return true;
        }
        decide(cid, trunk, info, '');
        return true;
    }

    // ── 4c. 自動交接：讀〔交接就緒〕下面的程式碼區塊（不經剪貼簿）──
    function handleReady(cid, last, txt, rm) {
        if (load('ready:' + cid, '') === last.uuid) return;
        const N = +rm[1];
        const all = txt.match(/```[^\n]*\n[\s\S]*?\n```/g) || [];
        const bm = txt.slice(txt.indexOf(rm[0]) + rm[0].length).match(/```[^\n]*\n([\s\S]*?)\n```/);
        if (all.length !== 1 || !bm || [...bm[1]].length !== N) {
            state.err = '交接就緒：開場白要剛好一個程式碼區塊、' + N + ' 字（讀到 ' + all.length + ' 個、' + (bm ? [...bm[1]].length : 0) + ' 字），不動作';
            render(); return; // 不記成已處理：每輪重檢、錯誤訊息一直留著
        }
        save('ready:' + cid, last.uuid);
        state.handoffText = bm[1];
        const o = opts(), n = load('ahn', 0);
        if (o.autoHandoff && load('await:' + cid, 0) && n < CFG.AUTO_HANDOFF_MAX && TOOLS.handover) {
            save('ahn', n + 1); save('await:' + cid, 0);
            TOOLS.handover.run(bm[1], { auto: true });
        }
        render();
    }

    // ── 5. 頁首標籤：⌄ 右邊、「交接對話串」左邊 ──
    // 那一排是 claude.ai 框架管的；重繪會把我們的節點清掉，所以用 MutationObserver 補插（做法同 claude-chat-handover）。
    // 永遠插在 ⌄ 正後面；交接鈕 v1.2.0 起看到 .ccm-meter 會排在它後面，兩邊各自補插也不會互換位置。
    // 字級、高度照同一排的既有元件（03 第⑮節）：2026-11-12 量到 14px／行高 20、⌄ 高 28、交接鈕左邊距 8、圓角 8。
    let el = null;
    function mount() {
        const split = document.querySelector(SEL.titleSplit);
        const more = split && split.querySelector(SEL.moreBtn);
        if (!more) return false;
        if (!el) {
            el = document.createElement('span');
            el.id = 'ccm-badge';
            el.className = 'ccm-meter';
            el.setAttribute('role', 'button');
            el.addEventListener('click', e => { e.stopPropagation(); togglePanel(); });
        }
        if (more.nextElementSibling !== el) {
            const h = Math.round(more.getBoundingClientRect().height) || 28;
            el.style.cssText = 'display:inline-flex;align-items:center;flex:0 0 auto;white-space:nowrap;box-sizing:border-box;'
                + 'height:' + h + 'px;margin-left:8px;padding:0 10px;border-radius:8px;font-size:14px;line-height:20px;cursor:pointer';
            more.after(el);
        }
        return true;
    }
    function render() {
        if (!document.body) return;
        const onChat = CHAT_RE.test(location.pathname);
        if (!onChat || !mount()) { if (el) el.style.display = 'none'; if (strip) renderStrip(null); closePanel(); return; }
        const L = state.last;
        el.style.display = L || state.err ? 'inline-flex' : 'none';
        if (!L) { el.textContent = '—'; el.title = state.err || ''; paint('normal'); renderStrip(null); renderPanel(); return; }
        el.textContent = Math.round(L.pct * 100) + '%' + (L.switchWorth ? '・建議換串' : '');
        el.title = '點一下看詳細資料';
        paint(L.pct >= opts().thr ? 'high' : (L.pct >= CFG.WARN_PCT || L.switchWorth) ? 'warn' : 'normal');
        renderStrip(L.pct >= opts().thr ? 'red' : L.pct >= CFG.WARN_PCT ? 'yellow' : L.switchWorth ? 'blue' : null);
        renderPanel();
    }

    // ── 6. 詳細面板（點標籤開關）：主數字 → 判斷 → 依據 → 〔校正〕（mockup【28_圖】定案）──
    // 掛在 body、fixed 對齊標籤左下：放進框架那一排會被重繪清掉（03 第⑨節）。
    let panel = null;
    const isDark = () => { const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [255, 255, 255]; return (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) < 128; };
    const man = n => (n / 1e4).toFixed(1).replace(/\.0$/, '') + ' 萬';
    function onEsc(e) { if (e.key === 'Escape' && panel) { e.preventDefault(); e.stopPropagation(); closePanel(); } }
    function onOutside(e) { if (panel && !panel.contains(e.target) && !(el && el.contains(e.target))) closePanel(); }
    function closePanel() {
        if (!panel) return;
        panel.remove(); panel = null;
        document.removeEventListener('keydown', onEsc, true);
        document.removeEventListener('pointerdown', onOutside, true);
    }
    function togglePanel() {
        if (panel) { closePanel(); return; }
        panel = document.createElement('div');
        panel.className = 'ccm-panel';
        document.body.append(panel);
        document.addEventListener('keydown', onEsc, true);      // 捕獲階段：一次只關最上層（03 第⑮節）
        document.addEventListener('pointerdown', onOutside, true);
        renderPanel();
    }
    function renderPanel() {
        if (!panel) return;
        if (!el || !el.isConnected || el.style.display === 'none') { closePanel(); return; }
        const L = state.last, d = isDark();
        const r = el.getBoundingClientRect();
        const fg = d ? '#eeeeee' : '#1f1f1f', dim = d ? '#a6a6a6' : '#767676', line = d ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.10)';
        panel.style.cssText = 'position:fixed;z-index:2147483646;box-sizing:border-box;width:344px;padding:12px 14px;border-radius:8px;'
            + 'font-size:14px;line-height:20px;left:' + Math.round(r.left) + 'px;top:' + Math.round(r.bottom + 8) + 'px;max-height:calc(100vh - ' + Math.round(r.bottom + 24) + 'px);overflow:auto;'
            + 'background:' + (d ? '#30302e' : '#f4f4f2') + ';color:' + fg + ';border:1px solid ' + line + ';box-shadow:0 4px 16px rgba(0,0,0,' + (d ? '.5' : '.14') + ')';
        const busy = state.autoPending || !!state.calibWait;
        const ed = document.querySelector(SEL.input);
        const typing = !!(ed && ed.innerText.trim());
        const row = (txt, css) => { const x = document.createElement('div'); x.style.cssText = css || ''; x.textContent = txt; return x; };
        const parts = [];
        if (L) {
            parts.push(row(man(L.C) + ' / ' + man(L.win) + '（' + Math.round(L.pct * 100) + '%）', 'font-weight:600'));
            const j = document.createElement('div'); j.style.marginTop = '8px';
            j.append('換新對話串約 ', Object.assign(document.createElement('b'), { textContent: (isFinite(L.nStar) ? Math.ceil(L.nStar) : '—') + ' 輪' }),
                '後回本，下一階段預估 ' + CFG.NEXT_ROUNDS + ' 輪', document.createElement('br'),
                Object.assign(document.createElement('b'), { textContent: L.switchWorth ? '建議換' : '不用換' }));
            parts.push(j);
            const basis = row('', 'margin-top:8px;padding-top:8px;border-top:1px solid ' + line + ';color:' + dim);
            basis.append('校正：' + L.source + (L.calib ? '（' + L.calib.ago + ' 則訊息前）' : ''), document.createElement('br'),
                '固定部分 F ' + man(L.fixed) + '・係數 k ' + L.k + '・v' + VERSION);
            parts.push(basis);
        } else parts.push(row(state.err ? '⚠ ' + state.err : '還沒有資料', 'color:' + dim));
        if (L && state.err) parts.push(row('⚠ ' + state.err, 'margin-top:6px;color:' + (d ? '#ffd37a' : '#9a5b00')));
        const act = row('', 'margin-top:10px;display:flex;align-items:center;gap:10px');
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ccm-calib';
        b.textContent = busy ? '校正中…' : '校正';
        const off = busy || typing;
        b.style.cssText = 'height:28px;padding:0 12px;border-radius:8px;box-sizing:border-box;font:inherit;color:inherit;cursor:' + (off ? 'default' : 'pointer') + ';'
            + 'background:' + (d ? '#3a3a3a' : '#ffffff') + ';border:1px solid ' + (d ? 'rgba(255,255,255,.25)' : 'rgba(0,0,0,.25)') + ';opacity:' + (off ? '.45' : '1');
        b.setAttribute('aria-disabled', off ? 'true' : 'false');
        const why = row(typing && !busy ? '輸入框有字，先送出或清空' : '', 'color:' + (d ? '#ffd37a' : '#9a5b00'));
        why.className = 'ccm-why';
        b.addEventListener('click', () => { if (!off) sendContext('校正'); });
        act.append(b, why);
        parts.push(act);
        parts.push(...autoSections(d, dim, line));
        panel.replaceChildren(...parts);
    }
    // ── 6b. 面板的「自動續做」「自動交接」「自動允許授權」三段（mockup 1–3、6–7 區）──
    // 分段選項照語音輸入法設定頁的 .seg（選中 65×28、間距 16、框圓角 12、選中圓角 9；03 第㉒節）
    function seg(d, items, cur, onPick, disabled) {
        const box = document.createElement('div');
        box.className = 'ccm-seg';
        box.style.cssText = 'display:inline-flex;gap:16px;padding:3px;border-radius:12px;background:' + (d ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.05)') + ';border:1px solid ' + (d ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.08)');
        for (const [v, label] of items) {
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = label; b.dataset.v = String(v);
            const on = v === cur, off = disabled && disabled.includes(v);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
            if (off) b.setAttribute('aria-disabled', 'true');
            b.style.cssText = 'width:65px;height:28px;padding:0;border:0;border-radius:9px;font:inherit;font-size:13px;line-height:1;white-space:nowrap;cursor:' + (off ? 'default' : 'pointer') + ';'
                + (on ? 'background:' + (d ? '#F5F5F7' : '#1D1D1F') + ';color:' + (d ? '#1B1B1F' : '#FFFFFF') + ';box-shadow:0 1px 3px rgba(0,0,0,.25)'
                      : 'background:none;color:' + (off ? (d ? '#6b6b69' : '#b3b3b0') : (d ? '#a6a6a6' : '#767676')));
            b.addEventListener('click', e => { e.stopPropagation(); if (!off && !on) onPick(v); });
            box.append(b);
        }
        return box;
    }
    function toggle(d, on, dis, onFlip, label) {
        const b = document.createElement('button');
        b.type = 'button'; b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', on ? 'true' : 'false'); b.setAttribute('aria-label', label);
        if (dis) b.setAttribute('aria-disabled', 'true');
        b.style.cssText = 'position:relative;flex:0 0 auto;width:36px;height:20px;padding:0;border:0;border-radius:10px;cursor:' + (dis ? 'default' : 'pointer') + ';opacity:' + (dis ? '.45' : '1') + ';background:' + (on ? (d ? '#F5F5F7' : '#1D1D1F') : (d ? 'rgba(255,255,255,.25)' : 'rgba(0,0,0,.25)'));
        const k = document.createElement('span');
        k.style.cssText = 'position:absolute;top:2px;left:' + (on ? 18 : 2) + 'px;width:16px;height:16px;border-radius:8px;background:' + (on ? (d ? '#1B1B1F' : '#FFFFFF') : (d ? '#30302e' : '#f4f4f2'));
        b.append(k);
        b.addEventListener('click', e => { e.stopPropagation(); if (!dis) onFlip(!on); });
        return b;
    }
    function autoSections(d, dim, line) {
        const o = opts(), L = state.last || {}, warnC = d ? '#ffd37a' : '#9a5b00';
        const div = (css, txt) => { const x = document.createElement('div'); x.style.cssText = css || ''; if (txt != null) x.textContent = txt; return x; };
        const small = (txt, c) => div('font-size:13px;line-height:18px;color:' + (c || dim), txt);
        const head = (label, status, sw) => {
            const h = div('display:flex;justify-content:space-between;align-items:center;gap:8px');
            const l = div('display:flex;align-items:center;gap:8px'); if (sw) l.append(sw); l.append(label);
            h.append(l, Object.assign(small(status), { className: 'ccm-status' })); return h;
        };
        const out = [];
        // 自動續做
        const s1 = div('margin-top:12px;padding-top:12px;border-top:1px solid ' + line); s1.className = 'ccm-sec-cont';
        s1.append(head('自動續做', L.continuing ? '續做中・已自動 ' + (L.autoN || 0) + ' 次（上限 ' + CFG.CONT_MAX + '）' : '沒有在續做'));
        s1.append(div('margin-top:10px', '停止門檻'), small('加上下一批的預估後超過就停；紅燈也照這條線'));
        const t = div('margin-top:8px'); t.append(seg(d, [[0.70, '70%'], [0.75, '75%'], [0.80, '80%'], [0.85, '85%']], o.thr, v => setOpt('thr', v))); s1.append(t);
        s1.append(div('margin-top:14px', '停下來時'), small('到門檻、建議換串、連續自動 ' + CFG.CONT_MAX + ' 次都會停'));
        const hi = o.thr >= 0.85;
        const u = div('margin-top:8px'); u.append(seg(d, [['draft', '只記草稿'], ['archive', '先歸檔'], ['handoff', '歸檔交接']], effOnStop(o), v => setOpt('onStop', v), hi ? ['archive', 'handoff'] : null)); s1.append(u);
        if (hi) s1.append(Object.assign(small('門檻 85% 時剩下的空間來不及歸檔，只能只記草稿', warnC), { style: 'margin-top:6px;font-size:13px;line-height:18px;color:' + warnC }));
        out.push(s1);
        // 自動交接
        const s2 = div('margin-top:12px;padding-top:12px;border-top:1px solid ' + line); s2.className = 'ccm-sec-handoff';
        const n = load('ahn', 0), canH = effOnStop(o) === 'handoff';
        const st = !o.autoHandoff || !canH ? '沒有開啟' : n >= CFG.AUTO_HANDOFF_MAX ? '已達上限 ' + CFG.AUTO_HANDOFF_MAX + ' 次，下次要手動交接' : '已自動交接 ' + n + ' 次（上限 ' + CFG.AUTO_HANDOFF_MAX + '）';
        s2.append(head('自動交接', st, toggle(d, o.autoHandoff && canH, !canH, v => setOpt('autoHandoff', v), '自動交接')));
        s2.append(canH ? small('手動按「交接對話串」會把次數歸零') : Object.assign(small('「停下來時」選「歸檔交接」才能自動交接', warnC), { style: 'margin-top:6px;font-size:13px;line-height:18px;color:' + warnC }));
        out.push(s2);
        // 自動允許授權
        const s3 = div('margin-top:12px;padding-top:12px;border-top:1px solid ' + line); s3.className = 'ccm-sec-allow';
        const cid = (location.pathname.match(CHAT_RE) || [])[1] || '';
        const logs = load('allowlog:' + cid, []);
        s3.append(head('自動允許授權', '本串已代按 ' + logs.length + ' 次', toggle(d, o.autoAllow, false, v => setOpt('autoAllow', v), '自動允許授權')));
        if (logs.length) {
            const lst = div('margin-top:6px;font-size:13px;line-height:20px');
            (panel.__allLogs ? logs.slice().reverse() : logs.slice(-3).reverse()).forEach(x => lst.append(div('', x.time + ' ' + x.what)));
            s3.append(lst);
            if (logs.length > 3) {
                const more = document.createElement('button'); more.type = 'button'; more.textContent = panel.__allLogs ? '只顯示最近 3 筆' : '顯示全部';
                more.style.cssText = 'margin-top:4px;padding:0;border:0;background:none;font:inherit;font-size:13px;color:' + dim + ';text-decoration:underline;cursor:pointer';
                more.addEventListener('click', e => { e.stopPropagation(); panel.__allLogs = !panel.__allLogs; renderPanel(); });
                s3.append(more);
            }
        }
        s3.append(small('只會按 claude.ai 畫面上的「允許」按鈕（有「一律允許」就按它）；需要你在對話裡親口同意的授權，腳本處理不了'));
        out.push(s3);
        return out;
    }
    // 面板開著時，輸入框打字／清空要即時反映到〔校正〕的停用狀態
    setInterval(() => {
        if (state.calibWait && (Date.now() - state.calibWait.t > 90000 || (state.last && state.last.calib && state.last.calib.idx > state.calibWait.idx))) { state.calibWait = null; renderPanel(); }
        if (panel) { const ed = document.querySelector(SEL.input); const t = !!(ed && ed.innerText.trim()); if (t !== panel.__typing) { panel.__typing = t; renderPanel(); } }
    }, 500);

    // ── 7. 視窗底部燈帶（Z-Library 工具箱的底部燈帶同一套做法）：紅 ≥80% > 黃 ≥70% > 藍 建議換串，一直呼吸 ──
    // 外層只管淡入淡出、內層只管上色與呼吸：呼吸會動 opacity，跟淡入淡出放同一個元素會互相打架。
    const STRIP = {
        blue:   { color: '#2979FF', white: 0.4,  alpha: 0.65 },
        yellow: { color: '#F2B705', white: 0.6,  alpha: 0.65 }, // Z-Library 沒有黃，新調（mockup 定案）
        red:    { color: '#FF0000', white: 0.28, alpha: 0.65 },
    };
    let strip = null;
    function renderStrip(kind) {
        if (!strip) {
            const st = document.createElement('style');
            st.textContent = '@keyframes ccmBreathe{0%,100%{opacity:.35}50%{opacity:1}}';
            (document.head || document.documentElement).append(st);
            strip = document.createElement('div');
            strip.className = 'ccm-strip';
            strip.style.cssText = 'position:fixed;left:0;bottom:0;width:100%;height:4px;z-index:2147483000;pointer-events:none;opacity:0;transition:opacity 180ms ease';
            strip.append(document.createElement('div'));
            document.body.append(strip);
        }
        strip.dataset.kind = kind || '';
        if (!kind) { strip.style.opacity = '0'; return; }
        const c = STRIP[kind], rgb = c.color.match(/\w\w/g).map(h => parseInt(h, 16)).join(',');
        strip.firstChild.style.cssText = 'height:100%;width:100%;background:' + c.color + ';animation:ccmBreathe 1.4s ease-in-out infinite;'
            + 'box-shadow:0 0 7px 1.4px rgba(255,255,255,' + c.white + '),0 0 9.8px 2.8px rgba(' + rgb + ',' + c.alpha + ')';
        strip.style.opacity = '1';
    }
    function paint(level) {
        // 依頁面底色判斷深淺（常駐介面跟網站一致：03 第①節）
        const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [255, 255, 255];
        const dark = (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) < 128;
        const C = {
            normal: dark ? ['#3a3a3a', '#e8e8e8', 'rgba(255,255,255,.16)'] : ['#f4f4f2', '#3d3d3a', 'rgba(0,0,0,.10)'],
            warn: dark ? ['#4a3a12', '#ffd37a', 'rgba(255,200,80,.45)'] : ['#fff3d6', '#7a4f00', 'rgba(200,140,0,.45)'],
            high: dark ? ['#4a1d1d', '#ffb3b3', 'rgba(255,120,120,.5)'] : ['#fde8e8', '#9b1c1c', 'rgba(200,40,40,.45)'],
        }[level];
        el.style.background = C[0]; el.style.color = C[1]; el.style.border = '1px solid ' + C[2];
    }

    // 換頁（單頁應用）時重新整理顯示
    let lastPath = '';
    setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; state.last = null; render(); if (CHAT_RE.test(lastPath)) scheduleRefresh(); } }, 1000);
    // ── 8. 送出時在訊息尾端附用量標記：[ctx 47%・47.2萬] ──
    // Claude 在 claude.ai 遠端工作階段看不到 hook、也送不了 /context；附在使用者訊息裡是它每輪唯一讀得到的地方（01 第⑫條）。
    // 做法：攔下送出（Enter、送出鈕）→ 游標移到尾端、新段落插入標記 → 下一格再按一次送出鈕（帶旗標放行）。
    // 不在攔截當下直接放行：ProseMirror 讀 DOM 變動是非同步的，同一個事件裡送出可能送到加標記前的內容。
    // 以 / 開頭的不加（/context 這類本機指令，加了會變成一般訊息）；已經有標記、還沒有估算值時也不加。
    const TAG_RE = /\[ctx \d+%・[\d.]+萬\]\s*$/;
    let passSend = false;
    function tagText() { const L = state.last; return L ? '[ctx ' + Math.round(L.pct * 100) + '%・' + (L.C / 1e4).toFixed(1) + '萬]' : ''; }
    function shouldTag(ed) {
        if (!CFG.TAG_ON_SEND || passSend || state.autoPending || !ed || !CHAT_RE.test(location.pathname)) return false;
        const t = ed.innerText.trim();
        return !!t && !t.startsWith('/') && !TAG_RE.test(t) && !!tagText();
    }
    function tagAndSend(ed) {
        ed.focus();
        const sel = getSelection(); sel.selectAllChildren(ed); sel.collapseToEnd();
        document.execCommand('insertText', false, '\n' + tagText());
        setTimeout(() => {
            const btn = document.querySelector(SEL.send);
            if (!btn) { state.err = '用量標記：找不到送出鈕（標記已加在輸入框，請手動送出）'; render(); return; }
            passSend = true; try { btn.click(); } finally { passSend = false; }
        }, 60);
    }
    document.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return; // 輸入法選字中的 Enter 不算送出
        const ed = e.target && e.target.closest && e.target.closest(SEL.input);
        if (!shouldTag(ed)) return;
        e.preventDefault(); e.stopImmediatePropagation();
        tagAndSend(ed);
    }, true);
    document.addEventListener('click', e => {
        const btn = e.target && e.target.closest && e.target.closest(SEL.send);
        if (!btn) return;
        const ed = document.querySelector(SEL.input);
        if (!shouldTag(ed)) return;
        e.preventDefault(); e.stopImmediatePropagation();
        tagAndSend(ed);
    }, true);

    // 框架重繪頁首後補插（節流）
    let mountTimer = null;
    new MutationObserver(() => {
        if (mountTimer) return;
        mountTimer = setTimeout(() => { mountTimer = null; try { const split = document.querySelector(SEL.titleSplit); if (split && (!el || !split.contains(el))) render(); } catch (e) { console.log('[ClaudeChatTools] 掛標籤失敗', e); } }, 300);
    }).observe(document, { childList: true, subtree: true }); // 觀察 document 本身：Chromium 在 document-start 時 documentElement 可能還是 null，observe 會丟例外、後面的程式整段不跑（測試實測）
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render, { once: true }); else render();
    console.log('[ClaudeChatTools] 用量模組已載入');
    })();

    // ════════ 模組二：/context 方格圖（原 claude-context-usage-grid v1.1.0）════════
    whenReady(function () {

  const CARD_CLASS = 'cug-card';
  const ROOT_ATTR = 'data-cug-root';
  const OPEN_ATTR = 'data-cug-open';   // 第二層：原始資料
  const EXP_ATTR = 'data-cug-expanded'; // 第一層：方格圖（v1.1.0 起預設收起）
  const CELLS = 100;
  const COMPACT_DROP_RATIO = 0.3; // Messages 比上一次少 30% 以上，視為可能已壓縮

  // 方格內的分類（依示意圖順序），deferred 不計入總量，另列
  const CATS = [
    { key: 'System prompt',            color: '#9a9690' },
    { key: 'System tools',             color: '#6e8fb8' },
    { key: 'MCP tools',                color: '#3bb3c3' },
    { key: 'MCP server instructions',  color: '#2a8f9c' },
    { key: 'Memory files',             color: '#e07a5f' },
    { key: 'Skills',                   color: '#e5a823' },
    { key: 'Messages',                 color: '#a98be0' },
    { key: 'Free space',               color: null, kind: 'free' },
    { key: 'Autocompact buffer',       color: null, kind: 'buffer' },
  ];

  // ---------- 解析 ----------

  function parseTokens(s) {
    const m = String(s).trim().match(/^~?([\d.,]+)\s*([km]?)$/i);
    if (!m) return NaN;
    const n = parseFloat(m[1].replace(/,/g, ''));
    const u = m[2].toLowerCase();
    return u === 'k' ? n * 1e3 : u === 'm' ? n * 1e6 : n;
  }

  function fmtTokens(n) {
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'm';
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  }

  // 文字解析：同時相容「渲染後的表格」（innerText 以 Tab 分隔）與「原始 Markdown」（以 | 分隔）
  function parseContextText(text) {
    const head = text.match(/Tokens:\**\s*([\d.,]+\s*[km]?)\s*\/\s*([\d.,]+\s*[km]?)\s*\(([\d.]+)%\)/i);
    if (!head) return null;
    const model = (text.match(/Model:\**\s*([^\s|]+)/i) || [])[1] || '';
    const start = text.search(/Estimated usage by category/i);
    if (start < 0) return null;
    const rest = text.slice(start);
    const end = rest.slice(1).search(/\n\s*#{0,3}\s*(MCP Tools|Skills|Memory files)\s*\n/i);
    const block = end >= 0 ? rest.slice(0, end + 1) : rest;

    const rows = {};
    for (const line of block.split('\n')) {
      const m = line.match(/^\s*\|?\s*([A-Za-z][A-Za-z ()]*?)\s*[|\t]\s*(~?[\d.,]+\s*[km]?)\s*[|\t]\s*([\d.]+)%/i);
      if (!m) continue;
      rows[m[1].trim()] = { tokens: parseTokens(m[2]), pct: parseFloat(m[3]), pctText: m[3] };
    }
    if (!rows['Free space']) return null;
    return {
      model,
      used: parseTokens(head[1]),
      total: parseTokens(head[2]),
      usedPct: parseFloat(head[3]),
      rows,
    };
  }

  // 最大餘數法分配 100 格；不到半格的分類不畫，只留在圖例
  function allocateCells(data) {
    const items = CATS.filter(c => data.rows[c.key]).map(c => {
      const exact = data.rows[c.key].pct;
      return { cat: c, exact, n: Math.floor(exact), rem: exact - Math.floor(exact) };
    });
    let left = CELLS - items.reduce((s, i) => s + i.n, 0);
    const order = items.slice().sort((a, b) => b.rem - a.rem);
    for (let i = 0; left > 0 && i < order.length; i++, left--) order[i].n++;
    for (let i = order.length - 1; left < 0 && i >= 0; i--) {
      if (order[i].n > 0) { order[i].n--; left++; }
    }
    return items;
  }

  // ---------- DOM 建構（不用 innerHTML，相容 Trusted Types） ----------

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function deltaSpan(cur, prev) {
    if (prev == null) return null;
    const d = cur - prev;
    if (Math.abs(d) < 50) return el('span', 'cug-delta cug-zero', '±0');
    return el('span', 'cug-delta ' + (d > 0 ? 'cug-up' : 'cug-down'), (d > 0 ? '+' : '−') + fmtTokens(Math.abs(d)));
  }

  function buildCard(data, prev, root) {
    const card = el('div', CARD_CLASS);
    // v1.1.0：/context 之後會由 claude-context-meter 自動送，每次都攤開會佔掉對話版面，所以預設只剩一顆按鈕（使用者定案）。
    // 兩層：〔顯示用量詳細資料〕→ 方格圖；方格圖底下〔顯示原始資料〕→ 原文。狀態記在 root 上，卡片重建時不會跑掉。
    const expand = el('button', 'cug-expand');
    expand.type = 'button';
    const detail = el('div', 'cug-detail');

    const header = el('div', 'cug-header');
    const title = el('div', 'cug-title');
    title.appendChild(el('span', 'cug-total', fmtTokens(data.used) + ' / ' + fmtTokens(data.total)));
    title.appendChild(el('span', 'cug-pct', data.usedPct + '%'));
    const dUsed = prev ? deltaSpan(data.used, prev.used) : null;
    if (dUsed) title.appendChild(dUsed);
    header.appendChild(title);
    if (data.model) header.appendChild(el('div', 'cug-model', data.model));
    detail.appendChild(header);

    if (prev && prev.rows['Messages'] && data.rows['Messages'] &&
        data.rows['Messages'].tokens < prev.rows['Messages'].tokens * (1 - COMPACT_DROP_RATIO)) {
      detail.appendChild(el('div', 'cug-note', '與上一次相比 Messages 大幅減少，中間可能發生過壓縮'));
    }

    const body = el('div', 'cug-body');
    const grid = el('div', 'cug-grid');
    for (const it of allocateCells(data)) {
      for (let i = 0; i < it.n; i++) {
        const cell = el('div', 'cug-cell' + (it.cat.kind ? ' cug-' + it.cat.kind : ''));
        if (it.cat.color) cell.style.background = it.cat.color;
        cell.title = it.cat.key;
        grid.appendChild(cell);
      }
    }
    body.appendChild(grid);

    const legend = el('div', 'cug-legend');
    for (const c of CATS) {
      const r = data.rows[c.key];
      if (!r) continue;
      const row = el('div', 'cug-row');
      const sw = el('span', 'cug-swatch' + (c.kind ? ' cug-' + c.kind : ''));
      if (c.color) sw.style.background = c.color;
      row.appendChild(sw);
      row.appendChild(el('span', 'cug-name', c.key));
      row.appendChild(el('span', 'cug-num', fmtTokens(r.tokens)));
      row.appendChild(el('span', 'cug-num cug-dim', r.pctText + '%'));
      const pr = prev && prev.rows[c.key];
      const d = pr ? deltaSpan(r.tokens, pr.tokens) : null;
      row.appendChild(d || el('span', 'cug-delta'));
      legend.appendChild(row);
    }
    const deferred = Object.keys(data.rows).filter(k => /deferred/i.test(k));
    if (deferred.length) {
      legend.appendChild(el('div', 'cug-foot',
        '未計入總量：' + deferred.map(k => k + ' ' + fmtTokens(data.rows[k].tokens)).join('、')));
    }
    body.appendChild(legend);
    detail.appendChild(body);

    const toggle = el('button', 'cug-toggle');
    toggle.type = 'button';
    const sync = () => {
      const exp = root.getAttribute(EXP_ATTR) === '1';
      const open = root.getAttribute(OPEN_ATTR) === '1';
      expand.textContent = exp ? '隱藏用量詳細資料' : '顯示用量詳細資料';
      toggle.textContent = open ? '隱藏原始資料' : '顯示原始資料';
    };
    expand.addEventListener('click', () => {
      const exp = root.getAttribute(EXP_ATTR) === '1';
      root.setAttribute(EXP_ATTR, exp ? '0' : '1');
      if (exp) root.setAttribute(OPEN_ATTR, '0'); // 收起第一層時第二層一起收
      sync();
    });
    toggle.addEventListener('click', () => {
      root.setAttribute(OPEN_ATTR, root.getAttribute(OPEN_ATTR) === '1' ? '0' : '1');
      sync();
    });
    detail.appendChild(toggle);
    card.appendChild(expand);
    card.appendChild(detail);
    card.cugSync = sync;
    return card;
  }

  // ---------- 找出 /context 回覆 ----------

  // 從「Context Usage」標題往上找，直到同一容器也含有分類表
  function findRoots() {
    const roots = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        return /^(#+\s*)?Context Usage$/.test(n.nodeValue.trim()) && !(n.parentElement && n.parentElement.closest('.' + CARD_CLASS))
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      let e = n.parentElement;
      for (let depth = 0; e && e !== document.body && depth < 8; depth++, e = e.parentElement) {
        const t = e.textContent;
        if (/Estimated usage by category/i.test(t) && /Free space/i.test(t)) {
          if (!roots.includes(e)) roots.push(e);
          break;
        }
      }
    }
    // 只留最內層的容器
    return roots.filter(r => !roots.some(o => o !== r && r.contains(o)));
  }

  const cache = new WeakMap(); // root → { text, data }

  function process() {
    const roots = findRoots();
    let prev = null;
    for (const root of roots) {
      const text = root.innerText || root.textContent;
      let entry = cache.get(root);
      if (!entry || entry.text !== text) {
        entry = { text, data: parseContextText(text) };
        cache.set(root, entry);
      }
      const data = entry.data;
      if (!data) continue;

      const prevKey = prev ? JSON.stringify(prev.rows) : '';
      const existing = root.querySelector(':scope > .' + CARD_CLASS);
      if (!existing || existing.dataset.prev !== prevKey) {
        if (existing) existing.remove();
        const card = buildCard(data, prev, root);
        card.dataset.prev = prevKey;
        root.insertBefore(card, root.firstChild);
      }
      root.setAttribute(ROOT_ATTR, '1');
      if (!root.hasAttribute(OPEN_ATTR)) root.setAttribute(OPEN_ATTR, '0');
      if (!root.hasAttribute(EXP_ATTR)) root.setAttribute(EXP_ATTR, '0');
      const card = root.querySelector(':scope > .' + CARD_CLASS);
      if (card && card.cugSync) card.cugSync();
      prev = data;
    }
  }

  // ---------- 樣式 ----------

  function injectStyle() {
    const css = `
[${ROOT_ATTR}][${OPEN_ATTR}="0"] > :not(.${CARD_CLASS}),
[${ROOT_ATTR}][${EXP_ATTR}="0"] > :not(.${CARD_CLASS}) { display: none !important; }
/* 收起時只剩按鈕：卡片不畫底色、框線、內距 */
[${ROOT_ATTR}][${EXP_ATTR}="0"] > .${CARD_CLASS} { background: transparent !important; border-color: transparent !important; box-shadow: none !important; padding: 0 !important; }
[${ROOT_ATTR}][${EXP_ATTR}="0"] > .${CARD_CLASS} .cug-detail { display: none; }
.${CARD_CLASS} {
  --cug-bg: #faf9f6; --cug-border: rgba(0,0,0,.10); --cug-fg: #2b2a28; --cug-dim: #85827c;
  --cug-empty: rgba(0,0,0,.14); --cug-up: #c2410c; --cug-down: #15803d;
  box-sizing: border-box; margin: 4px 0 12px; padding: 14px 16px 12px;
  background: var(--cug-bg); color: var(--cug-fg);
  border: 1px solid var(--cug-border); border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
  font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.${CARD_CLASS} * { box-sizing: border-box; }
html.dark .${CARD_CLASS}, html[data-mode="dark"] .${CARD_CLASS}, html[data-theme="dark"] .${CARD_CLASS} {
  --cug-bg: #2a2a2e; --cug-border: rgba(255,255,255,.16); --cug-fg: #ecebe8; --cug-dim: #9b9893;
  --cug-empty: rgba(255,255,255,.16); --cug-up: #fb923c; --cug-down: #4ade80;
  box-shadow: 0 2px 8px rgba(0,0,0,.35);
}
@media (prefers-color-scheme: dark) {
  html:not(.light):not([data-mode="light"]):not([data-theme="light"]) .${CARD_CLASS} {
    --cug-bg: #2a2a2e; --cug-border: rgba(255,255,255,.16); --cug-fg: #ecebe8; --cug-dim: #9b9893;
    --cug-empty: rgba(255,255,255,.16); --cug-up: #fb923c; --cug-down: #4ade80;
  }
}
.cug-header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.cug-title { display: flex; align-items: baseline; gap: 10px; }
.cug-total { font-size: 15px; font-weight: 600; }
.cug-pct, .cug-model, .cug-dim { color: var(--cug-dim); }
.cug-note { margin: -4px 0 10px; font-size: 12px; color: var(--cug-up); }
.cug-body { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
.cug-grid { display: grid; grid-template-columns: repeat(10, 18px); grid-auto-rows: 18px; gap: 4px; flex: none; }
.cug-cell { border-radius: 4px; }
.cug-free { border: 1px solid var(--cug-empty); background: transparent; }
.cug-buffer { border: 1px dashed var(--cug-dim);
  background: repeating-linear-gradient(45deg, transparent 0 3px, var(--cug-empty) 3px 5px) !important; }
.cug-legend { display: grid; grid-template-columns: 14px auto auto auto auto; column-gap: 10px; row-gap: 5px; align-items: center; min-width: 0; }
.cug-row { display: contents; }
.cug-swatch { width: 14px; height: 14px; border-radius: 3px; }
.cug-num { text-align: right; }
.cug-delta { text-align: right; font-size: 12px; min-width: 3em; }
.cug-up { color: var(--cug-up); }
.cug-down { color: var(--cug-down); }
.cug-zero { color: var(--cug-dim); }
.cug-foot { grid-column: 1 / -1; margin-top: 6px; font-size: 12px; color: var(--cug-dim); }
.cug-expand, .cug-toggle {
  margin-top: 12px; padding: 4px 10px; font: inherit; font-size: 12px; cursor: pointer;
  color: var(--cug-dim); background: transparent; border: 1px solid var(--cug-border); border-radius: 6px;
}
.cug-expand { margin-top: 0; }
[${ROOT_ATTR}][${EXP_ATTR}="1"] > .${CARD_CLASS} .cug-expand { margin-bottom: 12px; }
.cug-expand:hover, .cug-toggle:hover { color: var(--cug-fg); border-color: var(--cug-dim); }
`;
    const s = document.createElement('style');
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  // ---------- 啟動與監看 ----------

  injectStyle();
  // 節流：頁面持續變動時，最多每 500ms 仍保證處理一次（純 debounce 會被無限延後）
  let timer = 0;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = 0; process(); }, 500);
  };
  new MutationObserver(muts => {
    // 忽略自己插入卡片造成的變動
    for (const m of muts) {
      const t = m.target;
      if (t.nodeType === 1 && t.closest && t.closest('.' + CARD_CLASS)) continue;
      schedule();
      return;
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  process();
    });

    // ════════ 模組三：交接對話串（原 claude-chat-handover v1.2.0）════════
    whenReady(function () {

  const VERSION = TOOLS_VERSION;
  const TAG = '[CHO]';
  const log = (...a) => console.log(TAG, ...a);

  // 依賴 claude.ai DOM 的選擇器集中在這裡；網站改版只改這一份。（2026-11-11 實測結構）
  const SEL = {
    header: '[data-testid="chat-header"]',
    titleSplit: '[data-testid="session-title-split"]',
    titleBtn: 'h2 button',                           // aria-label =「<名稱>，重新命名工作階段」，點了直接進入改名
    moreBtn: 'button[aria-haspopup="menu"]',          // 標題旁的 ⌄
    renameMenuItem: '[data-testid="rename-session-trigger"]', // ⌄ 選單裡的「重新命名」（備援路徑）
    nameInput: 'input[data-testid="name-session"]',
    projectLink: 'a[href^="/project/"]',              // 只在 header 裡找，不碰側欄
    chatInput: '[data-testid="chat-input"]',          // contenteditable 編輯器
    sendBtn: ['button[data-testid="chat-input-send"]', '[data-cds-part="send-slot"] button'],
  };

  // 時間參數（ms）
  const POLL_MS = 200;               // 等待元素時的輪詢間隔
  const WAIT_ELEMENT_MS = 5000;      // 等一個元素出現的上限
  const WAIT_NEW_CHAT_MS = 30000;    // 送出後等網址變成新對話的上限
  const TITLE_CHANGED_STABLE_MS = 3000;  // 自動標題變過一次之後，要連續不變這麼久才算定案
  const TITLE_UNCHANGED_STABLE_MS = 20000; // 標題從頭到尾沒變時，等這麼久就當作定案
  const WAIT_TITLE_MAX_MS = 90000;   // 等自動標題的總上限
  const RECHECK_AFTER_RENAME_MS = 5000;  // 改完新對話名稱後，隔這麼久再確認沒被自動標題蓋掉
  const SYNC_THROTTLE_MS = 500;      // 掛按鈕的節流間隔（claude.ai DOM 一直有小變動，不能用 debounce，見 22 號第③節）

  const RESTORE_KEY = 'cho-restore'; // sessionStorage：還原舊名稱時，整頁回到舊對話後要做的事

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CHAT_PATH_RE = /^\/chat\/[0-9a-f-]{36}/;

  async function waitFor(fn, timeout = WAIT_ELEMENT_MS, what = '元素') {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error(`等不到${what}（${timeout / 1000} 秒）`);
      await sleep(POLL_MS);
    }
  }

  // ---------- 名稱規則 ----------
  // 去掉開頭所有 (old)；結尾 _V<數字> 才算版本號，沒有就當 _V1。
  function computeNames(current) {
    const base = current.replace(/^(\(old\)\s*)+/, '').trim();
    const m = base.match(/^(.*)_V(\d+)$/);
    const stem = m ? m[1] : base;
    const n = m ? parseInt(m[2], 10) : 1;
    return { oldName: `(old)${stem}_V${n}`, newName: `${stem}_V${n + 1}` };
  }

  // ---------- 讀頁面 ----------
  const q = (root, s) => (root ? root.querySelector(s) : null);
  const getSplit = () => document.querySelector(SEL.titleSplit);
  const getTitleBtn = () => q(getSplit(), SEL.titleBtn);
  const getTitle = () => {
    const b = getTitleBtn();
    return b ? b.textContent.trim() : '';
  };
  const getProjectLink = () => q(document.querySelector(SEL.header), SEL.projectLink);
  const findSendBtn = () => {
    for (const s of SEL.sendBtn) {
      const b = document.querySelector(s);
      if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') return b;
    }
    return null;
  };

  // ---------- 動作 ----------
  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }

  // React 管的 input：要用原生 setter 改值再發 input 事件，React 才認得。
  function setInputValue(input, v) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function renameCurrent(name) {
    if (getTitle() === name) return;
    let input = document.querySelector(SEL.nameInput);
    if (!input) {
      const tb = getTitleBtn();
      if (!tb) throw new Error('找不到標題按鈕');
      tb.click();
      input = await waitFor(() => document.querySelector(SEL.nameInput), 2000, '改名輸入框').catch(() => null);
    }
    if (!input) {
      // 備援：⌄ 選單 → 重新命名
      const more = q(getSplit(), SEL.moreBtn);
      if (!more) throw new Error('找不到標題旁的 ⌄ 按鈕');
      more.click();
      const item = await waitFor(() => document.querySelector(SEL.renameMenuItem), WAIT_ELEMENT_MS, '選單的「重新命名」');
      item.click();
      input = await waitFor(() => document.querySelector(SEL.nameInput), WAIT_ELEMENT_MS, '改名輸入框');
    }
    input.focus();
    setInputValue(input, name);
    pressEnter(input);
    try {
      await waitFor(() => getTitle() === name, WAIT_ELEMENT_MS, '標題變成新名稱');
    } catch (e) {
      // Enter 沒生效時，試一次失焦送出
      const still = document.querySelector(SEL.nameInput);
      if (still) still.blur();
      await waitFor(() => getTitle() === name, WAIT_ELEMENT_MS, `標題變成「${name}」`);
    }
  }

  const norm = (s) => s.replace(/\s+/g, '');

  // 選取編輯器全部內容再刪除：走編輯器自己的刪除流程（beforeinput），框架的內部狀態才會跟著清空。
  function clearEditor(ed) {
    ed.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete', false);
  }

  // 回傳輸入框原本的內容（沒有就是空字串）。原本的內容先存起來再清空，
  // 不然交接文字會接在使用者之前打了沒送出的字後面（2026-11-11 實測：殘留的 x 接在開頭）。
  async function fillComposer(text) {
    const ed = await waitFor(() => document.querySelector(SEL.chatInput), WAIT_ELEMENT_MS, '輸入框');
    ed.focus();
    const prevDraft = (ed.innerText || '').replace(/\n+$/, '').trim() ? (ed.innerText || '').replace(/\n+$/, '') : '';
    if (prevDraft) {
      log('輸入框原本有內容，先存起來再清空：', prevDraft.slice(0, 40));
      clearEditor(ed);
      await sleep(300);
      if (norm(ed.innerText || '')) throw new Error('清不掉輸入框原本的內容');
    }
    const head = norm(text).slice(0, 30);
    // 要「以交接文字開頭」才算成功；只檢查包含，殘留字接在前面時會誤判成功
    const ok = () => norm(ed.innerText || '').startsWith(head);
    // 1) 模擬貼上：編輯器框架自己處理貼上，最像使用者操作
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch (e) {
      log('模擬貼上失敗，改用 insertText：', e);
    }
    await sleep(300);
    if (!ok()) {
      // 2) 備援：insertText
      ed.focus();
      document.execCommand('insertText', false, text);
      await sleep(300);
    }
    if (!ok()) throw new Error('交接文字填不進輸入框');
    return { ed, prevDraft };
  }

  async function send(ed) {
    const btn = await waitFor(findSendBtn, 3000, '送出按鈕').catch(() => null);
    if (btn) btn.click();
    else {
      log('找不到送出按鈕，改按 Enter');
      pressEnter(ed);
    }
  }

  // 新對話送出後 Claude 會自動取標題；太早改名會被蓋掉。
  // 定案條件：標題變過一次且之後連續 TITLE_CHANGED_STABLE_MS 不變；或從頭到尾沒變滿 TITLE_UNCHANGED_STABLE_MS。
  async function waitTitleSettled(onTick) {
    const t0 = Date.now();
    let first = null, last = null, lastChange = Date.now(), changed = false;
    for (;;) {
      const t = getTitle();
      if (t) {
        if (first === null) { first = t; last = t; lastChange = Date.now(); }
        else if (t !== last) { last = t; lastChange = Date.now(); changed = true; }
        const still = Date.now() - lastChange;
        if (changed && still >= TITLE_CHANGED_STABLE_MS) return last;
        if (!changed && still >= TITLE_UNCHANGED_STABLE_MS) return last;
      }
      if (onTick) onTick(Math.round((Date.now() - t0) / 1000));
      if (Date.now() - t0 > WAIT_TITLE_MAX_MS) throw new Error('等自動標題超過 90 秒');
      await sleep(500);
    }
  }

  // ---------- 進度提示 ----------
  const theme = () => {
    const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [255, 255, 255];
    const lum = (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) / 255;
    return lum < 0.5
      ? { bg: '#2a2a2e', fg: '#f2f2f2', sub: '#b4b4b8', line: 'rgba(255,255,255,.16)', mask: 'rgba(0,0,0,.55)', ok: '#4ade80', err: '#f87171', btn: '#3a3a40', pri: '#d97757' }
      : { bg: '#ffffff', fg: '#1f1f1f', sub: '#6b6b6b', line: 'rgba(0,0,0,.12)', mask: 'rgba(0,0,0,.35)', ok: '#15803d', err: '#b91c1c', btn: '#f0f0ee', pri: '#c96442' };
  };

  let toastEl = null;
  function toast(lines, kind = 'info', actions = []) {
    const c = theme();
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'cho-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.style.cssText = `position:fixed;right:16px;bottom:16px;z-index:2147483600;max-width:420px;background:${c.bg};color:${c.fg};border:1px solid ${kind === 'err' ? c.err : kind === 'ok' ? c.ok : c.line};border-radius:12px;padding:12px 14px;font:14px/1.6 ${getComputedStyle(document.body).fontFamily};box-shadow:0 4px 16px rgba(0,0,0,.18)`;
    toastEl.replaceChildren();
    lines.forEach((l, i) => {
      const d = document.createElement('div');
      d.textContent = l;
      if (i === 0) d.style.cssText = `font-size:16px;color:${kind === 'err' ? c.err : kind === 'ok' ? c.ok : c.fg}`;
      else d.style.color = c.sub;
      toastEl.appendChild(d);
    });
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:8px';
    for (const [label, fn] of [...actions, ['關閉', () => { toastEl.remove(); toastEl = null; }]]) {
      const b = mkBtn(label, false, c);
      b.onclick = () => fn(b);
      row.appendChild(b);
    }
    toastEl.appendChild(row);
  }

  function mkBtn(label, primary, c) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = `font:14px ${getComputedStyle(document.body).fontFamily};padding:6px 14px;border-radius:8px;cursor:pointer;border:1px solid ${primary ? c.pri : c.line};background:${primary ? c.pri : c.btn};color:${primary ? '#fff' : c.fg}`;
    return b;
  }

  // ---------- 確認對話框 ----------
  function confirmDialog(info) {
    return new Promise((resolve) => {
      const c = theme();
      const ff = getComputedStyle(document.body).fontFamily;
      const mask = document.createElement('div');
      mask.className = 'cho-mask';
      mask.style.cssText = `position:fixed;inset:0;z-index:2147483640;background:${c.mask};display:flex;align-items:center;justify-content:center`;
      const box = document.createElement('div');
      box.className = 'cho-dialog';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.style.cssText = `width:520px;max-width:calc(100vw - 32px);background:${c.bg};color:${c.fg};border:1px solid ${c.line};border-radius:14px;padding:20px 24px;font:14px/1.6 ${ff};box-shadow:0 10px 40px rgba(0,0,0,.25)`;

      const h = document.createElement('div');
      h.textContent = '交接對話串';
      h.style.cssText = 'font-size:18px;margin-bottom:12px';
      box.appendChild(h);

      const row = (label, value, color) => {
        const r = document.createElement('div');
        r.style.cssText = 'margin-bottom:10px';
        const l = document.createElement('div');
        l.textContent = label;
        l.style.cssText = `font-size:13px;color:${c.sub}`;
        const v = document.createElement('div');
        v.style.cssText = `font-size:15px;color:${color || c.fg};white-space:pre-wrap;word-break:break-all`;
        v.textContent = value;
        r.append(l, v);
        box.appendChild(r);
        return v;
      };

      if (info.errors.length) {
        row('無法執行', info.errors.join('\n'), c.err);
      } else {
        row('舊對話串改名', info.oldName === info.current ? `${info.current}（已是這個名稱，不改）` : `${info.current}  →  ${info.oldName}`);
        row('新對話串（建立在「' + info.project + '」）', info.newName);
        row(`交接文字（共 ${info.lineCount} 行）`, info.preview, c.sub);
      }

      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:16px';
      const cancel = mkBtn('取消', false, c);
      const ok = mkBtn('確認', true, c);
      if (info.errors.length) { ok.disabled = true; ok.style.opacity = '.4'; ok.style.cursor = 'not-allowed'; }
      btns.append(cancel, ok);
      box.appendChild(btns);
      mask.appendChild(box);

      // 鎖背景捲動：收起捲軸、body 補捲軸寬（03 號第㉒節）
      const sbw = window.innerWidth - document.documentElement.clientWidth;
      const prev = [document.documentElement.style.overflow, document.body.style.paddingRight];
      document.documentElement.style.overflow = 'hidden';
      if (sbw > 0) document.body.style.paddingRight = sbw + 'px';

      const close = (v) => {
        document.removeEventListener('keydown', onKey, true);
        document.documentElement.style.overflow = prev[0];
        document.body.style.paddingRight = prev[1];
        mask.remove();
        resolve(v);
      };
      // Esc 一次只關這一層：捕獲階段處理並停止傳遞（03 號第⑮節）
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
        else if (e.key === 'Enter' && !info.errors.length) { e.preventDefault(); e.stopPropagation(); close(true); }
      };
      document.addEventListener('keydown', onKey, true);
      cancel.onclick = () => close(false);
      ok.onclick = () => { if (!info.errors.length) close(true); };
      mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(false); });
      document.body.appendChild(mask);
      (info.errors.length ? cancel : ok).focus();
    });
  }

  // ---------- 主流程 ----------
  let running = false;

  // given：從對話樹讀到的開場白（〔交接就緒〕下面的區塊）；有它就不讀剪貼簿。opt.auto：自動交接，不跳確認框。
  async function onHandoverClick(given, opt) {
    if (running) return;
    const auto = !!(opt && opt.auto);
    const M = TOOLS.meter;
    if (!given && M && M.state.handoffText) given = M.state.handoffText;
    const current = getTitle();
    const link = getProjectLink();
    const errors = [];
    let text = '';
    if (given) text = given;
    else {
      try {
        text = (await navigator.clipboard.readText()) || '';
      } catch (e) {
        errors.push('讀不到剪貼簿：' + (e && e.message ? e.message : e) + '（請允許網站讀取剪貼簿）');
      }
    }
    if (!errors.length && !text.trim()) errors.push(given ? '讀到的開場白是空的' : '剪貼簿是空的：請先複製交接文字');
    if (!current) errors.push('讀不到目前對話串的名稱');
    if (!link) errors.push('這個對話串不在 Project 裡（標題列沒有 Project 連結）');

    const names = current ? computeNames(current) : { oldName: '', newName: '' };
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const nonEmpty = lines.filter((l) => l.trim());
    const preview = nonEmpty.slice(0, 2).join('\n') + (nonEmpty.length > 2 ? '\n…' : '');
    const info = { current, ...names, project: link ? link.textContent.trim() : '', preview, lineCount: lines.length, errors };

    if (auto) { if (errors.length) { toast(['自動交接沒有執行', ...errors], 'err'); return; } }
    else if (!(await confirmDialog(info))) return;
    if (!auto && M) M.save('ahn', 0); // 手動交接：連續自動交接次數歸零（使用者定案）
    if (M) M.state.handoffText = null;
    running = true; refreshLabel();
    const oldUrl = location.href;
    let step = '';
    let oldRenamed = false;
    let prevDraft = ''; // 新對話輸入框原本的內容（貼上前清掉的）
    const draftLines = () => (prevDraft ? [`輸入框原本有內容（${prevDraft.length} 字），已先清掉再貼上`] : []);
    // 按鈕是使用者點的，navigator.clipboard.writeText 才不會被擋
    const draftActions = () => (prevDraft ? [['複製原本的輸入內容', (b) => {
      navigator.clipboard.writeText(prevDraft).then(() => { b.textContent = '已複製'; }, (e) => { b.textContent = '複製失敗'; log('複製失敗', e); });
    }]] : []);
    try {
      step = '1/4 舊對話串改名';
      toast([step, info.oldName]);
      await renameCurrent(info.oldName);
      oldRenamed = info.oldName !== current;
      log('舊對話串改名完成：', info.oldName);

      step = '2/4 前往 Project';
      toast([step, info.project]);
      const oldPath = location.pathname;
      getProjectLink().click();
      await waitFor(() => location.pathname.startsWith('/project/') && document.querySelector(SEL.chatInput), 15000, 'Project 頁面');

      step = '3/4 貼上交接文字並送出';
      toast([step]);
      const filled = await fillComposer(text);
      prevDraft = filled.prevDraft;
      await send(filled.ed);
      await waitFor(() => CHAT_PATH_RE.test(location.pathname) && location.pathname !== oldPath, WAIT_NEW_CHAT_MS, '新對話建立');
      log('新對話：', location.pathname);

      step = '4/4 新對話串改名';
      await waitFor(getTitleBtn, 15000, '新對話的標題');
      await waitTitleSettled((s) => toast([step, `等 Claude 自動取好標題…（${s} 秒）`]));
      await renameCurrent(info.newName);
      await sleep(RECHECK_AFTER_RENAME_MS);
      if (getTitle() !== info.newName) {
        log('名稱被蓋掉，再改一次：', getTitle());
        await renameCurrent(info.newName);
      }
      toast(['交接完成', `舊：${info.oldName}`, `新：${info.newName}`, ...draftLines()], 'ok', draftActions());
    } catch (e) {
      log('失敗於', step, e);
      const actions = draftActions();
      if (oldRenamed) {
        actions.push(['還原舊名稱', () => {
          try { sessionStorage.setItem(RESTORE_KEY, JSON.stringify({ url: oldUrl, name: current, ts: Date.now() })); } catch (_) {}
          location.href = oldUrl;
        }]);
      }
      toast([`卡在「${step}」`, String(e && e.message ? e.message : e), oldRenamed ? `舊對話串已改成「${info.oldName}」` : '舊對話串沒有被改動', ...draftLines()], 'err', actions);
    } finally {
      running = false; refreshLabel();
    }
  }

  // 「還原舊名稱」整頁回到舊對話後接著做
  async function resumeRestore() {
    let r = null;
    try { r = JSON.parse(sessionStorage.getItem(RESTORE_KEY) || 'null'); } catch (_) {}
    if (!r) return;
    if (Date.now() - r.ts > 120000 || location.href.split('#')[0] !== r.url.split('#')[0]) {
      sessionStorage.removeItem(RESTORE_KEY);
      return;
    }
    sessionStorage.removeItem(RESTORE_KEY);
    try {
      await waitFor(getTitleBtn, 15000, '標題');
      await renameCurrent(r.name);
      toast(['已還原舊名稱', r.name], 'ok');
    } catch (e) {
      toast(['還原失敗', String(e.message || e), `請手動改回「${r.name}」`], 'err');
    }
  }

  // ---------- 掛按鈕 ----------
  // 外觀從網站自己的標題按鈕複製（03 號第⑨節），深淺色、hover 跟著網站走。
  function ensureButton() {
    const split = getSplit();
    if (!split || !CHAT_PATH_RE.test(location.pathname)) return;
    if (split.querySelector('.cho-btn')) return;
    const tb = q(split, SEL.titleBtn);
    const more = q(split, SEL.moreBtn);
    if (!tb || !more) return;
    const b = tb.cloneNode(true);
    b.classList.add('cho-btn');
    b.removeAttribute('id');
    b.setAttribute('aria-label', '交接對話串');
    b.title = '把剪貼簿的交接文字開成同一個 Project 的新對話串';
    // 標題按鈕最內層放名稱文字的 span，換成按鈕文字
    const spans = [...b.querySelectorAll('span')].filter((s) => !s.children.length && s.textContent.trim());
    if (spans.length) spans[spans.length - 1].textContent = '交接對話串';
    else b.textContent = '交接對話串';
    b.style.marginLeft = '8px';
    b.style.flex = '0 0 auto';
    b.style.whiteSpace = 'nowrap';
    // 一開始就看得出是按鈕（使用者要求）：外框＋淡底色，顏色取文字色混出來，深淺色主題都通用
    b.style.border = '1px solid color-mix(in srgb, currentColor 35%, transparent)';
    b.style.background = 'color-mix(in srgb, currentColor 6%, transparent)';
    b.style.borderRadius = '8px';
    b.style.padding = '0 10px';
    b.style.boxSizing = 'border-box';
    b.style.display = 'inline-flex';
    b.style.alignItems = 'center'; // 固定高度後文字要垂直置中
    const mh = more.getBoundingClientRect().height;
    if (mh) b.style.height = Math.round(mh) + 'px'; // 跟 ⌄ 同高
    // 複製來源是可改名的標題按鈕，本身與內層 span 都帶 cursor:text（I 字形，2026-11-12 實測 computed style）。
    // 按鈕要顯示手指指標，內層 span 也要一起蓋掉，否則移到字上又變回 I 字形。
    for (const el of [b, ...b.querySelectorAll('*')]) el.style.cursor = 'pointer';
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onHandoverClick(); }, true);
    b.dataset.ready = '';
    // 用量標籤（browser-tools/claude-context-meter 的 .ccm-meter）也掛在 ⌄ 後面，順序固定為 ⌄ → 用量 → 交接；
    // 兩支腳本各自補插時才不會互換位置。
    const meter = more.nextElementSibling;
    (meter && meter.classList.contains('ccm-meter') ? meter : more).after(b);
  }

  let syncTimer = null;
  const sync = () => {
    if (syncTimer) return; // 節流：計時器已在倒數就不重設
    syncTimer = setTimeout(() => { syncTimer = null; try { ensureButton(); } catch (e) { log('掛按鈕失敗', e); } }, SYNC_THROTTLE_MS);
  };
  new MutationObserver(sync).observe(document.documentElement, { childList: true, subtree: true });
  sync();
  resumeRestore();

  // 測試用的進入點（不影響正常使用）
  // 交接鈕的三種樣子（mockup 8 區）：平常／收到〔交接就緒〕但自動交接關著 →「可以交接了」（藍）／執行中 →「交接中…」
  function refreshLabel() {
    const b = document.querySelector('.cho-btn'); if (!b) return;
    const M = TOOLS.meter, ready = !!(M && M.state.handoffText);
    const label = running ? '交接中…' : ready ? '可以交接了' : '交接對話串';
    const spans = [...b.querySelectorAll('span')].filter((x) => !x.children.length && x.textContent.trim());
    const tgt = spans.length ? spans[spans.length - 1] : b;
    if (tgt.textContent !== label) tgt.textContent = label;
    const want = ready && !running ? '1' : '';
    if ((b.dataset.ready || '') !== want) {
      b.dataset.ready = want;
      if (want) { b.style.background = '#2c84db'; b.style.color = '#ffffff'; b.style.border = '1px solid #2c84db'; }
      else { b.style.background = 'color-mix(in srgb, currentColor 6%, transparent)'; b.style.color = ''; b.style.border = '1px solid color-mix(in srgb, currentColor 35%, transparent)'; }
    }
  }
  setInterval(refreshLabel, 500);
  TOOLS.handover = { run: (text, o) => onHandoverClick(text, o) };
  window.__cho = { VERSION, computeNames };
  log(`v${VERSION} 已載入`);
    });

    // ════════ 模組四：自動允許授權（面板開關，預設關）════════
    // 只按 claude.ai 畫面上「允許／拒絕」成對出現的那組按鈕；有「一律允許」類的優先按它（使用者：允許一次要反覆按、拖慢速度）。
    // 選擇器還沒看過真實畫面（使用者尚未截圖），所以用文字比對＋旁邊要有「拒絕」類按鈕，避免按到別的「允許」。
    whenReady(function () {
        const ALLOW_ALL = /^(一律允許|永遠允許|總是允許|全部允許|允許全部|始終允許|Always allow|Allow always|Allow all|Allow for this (chat|session|conversation))/i;
        const ALLOW_ONE = /^(允許|允許一次|Allow|Allow once)$/i;
        const DENY = /拒絕|不允許|Deny|Don.t allow|Reject|Decline/i;
        const CHAT = /\/chat\/([0-9a-f-]{36})/;
        const OWN = '.ccm-panel,.cho-dialog,.cho-toast,.cug-card';
        const label = (b) => (b.innerText || b.textContent || '').trim();
        function scan() {
            const M = TOOLS.meter; if (!M || !M.opts().autoAllow) return;
            const cm = location.pathname.match(CHAT); if (!cm) return;
            for (const b of document.querySelectorAll('button')) {
                if (b.disabled || b.closest(OWN) || !b.offsetParent) continue;
                const t = label(b); if (!ALLOW_ALL.test(t) && !ALLOW_ONE.test(t)) continue;
                let box = b.parentElement;
                // 往上找最多 6 層、按鈕不超過 5 顆的容器：太大的容器（例如整頁）會把不相干的「允許」配到別處的「拒絕」
                for (let i = 0; box && i < 6; i++, box = box.parentElement) { const bs = box.querySelectorAll('button'); if (bs.length > 5) { box = null; break; } if ([...bs].some((x) => x !== b && DENY.test(label(x)))) break; }
                if (!box || box.dataset.cctDone) continue;
                const btns = [...box.querySelectorAll('button')].filter((x) => !x.disabled && x.offsetParent);
                const pick = btns.find((x) => ALLOW_ALL.test(label(x))) || btns.find((x) => ALLOW_ONE.test(label(x)));
                if (!pick) continue;
                box.dataset.cctDone = '1';
                const what = ((box.innerText || '').split('\n').map((x) => x.trim()).find((x) => x && !btns.some((y) => label(y) === x)) || '').slice(0, 40);
                pick.click();
                const key = 'allowlog:' + cm[1], logs = M.load(key, []);
                const d = new Date(), hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
                logs.push({ time: hm, what: label(pick) + '：' + what }); M.save(key, logs.slice(-50));
                console.log('[ClaudeChatTools] 自動允許：', label(pick), what);
            }
        }
        let tm = null;
        new MutationObserver(() => { if (tm) return; tm = setTimeout(() => { tm = null; try { scan(); } catch (e) { console.log('[ClaudeChatTools] 自動允許失敗', e); } }, 300); }).observe(document.body, { childList: true, subtree: true });
    });
})();
