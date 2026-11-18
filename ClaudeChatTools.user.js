// ==UserScript==
// @name         Claude 對話工具
// @namespace    https://github.com/bgtsai/claude-chat-tools
// @version      0.7.0
// @description  claude.ai 對話工具：上下文用量（頁首標籤、詳細面板、底部燈帶、送出時附用量標記）、/context 方格圖、交接對話串、額度冷卻翻頁鐘（額度重置後補送沒送出的自動訊息）。合併自 claude-context-meter、claude-context-usage-grid、claude-chat-handover、cooldown-flipclock
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
    const TOOLS_VERSION = '0.7.0';
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
        K_READ: 0.1, K_WRITE: 1.25,   // 快取讀取／寫入相對正常價的比例（01 第⑫條）
        WARN_PCT: 0.70,               // 開始提醒的用量（黃）
        HIGH_PCT: 0.80,               // 紅：再往上可能來不及歸檔＋交接就被自動壓縮（96.7 萬壓縮 − 歸檔交接約 15 萬，推測值，待實測）
        WARN_STEP: 0.10,              // 之後每增加多少再提醒一次
        AUTO_CTX: true,               // 自動送 /context 校正
        AUTO_FIRST_MIN_MSGS: 2,       // 沒有校正點時，至少幾則訊息才送
        AUTO_RECHECK_STEP: 0.10,      // 估算比上次校正多出這麼多就再送一次 /context（v0.5.0；取代「65% 且上次 < 60%」）
        COMPACT_K_BELOW: 0.7,         // 校正點的 k（訊息 ÷ 之前的估算）低於這個 → 視為壓縮過（壓縮後實測 0.28，平常約 1.8）
        COMPACT_DROP: 0.7,            // 或訊息量少於上一次校正的這個比例 → 視為壓縮過（同方格圖的 30%）
        SLOPE_MIN_EST: 20000,         // 用兩次校正的差算 k 時，中間的估算至少要多這麼多
        CONT_MAX: 15,                 // 連續自動續做上限（可能在空轉）
        CONT_NEAR_PCT: 0.05,          // 加上下一批後離門檻不到這麼多 → 先送 /context 校正再判斷
        CTX_WAIT_MS: 30000,           // 代送 /context 後等輸出的上限；逾時照估算判斷並照送
        AUTO_HANDOFF_MAX: 5,          // 連續自動交接上限；手動交接歸零（使用者定案）
        TAG_ON_SEND: true,            // 送出訊息時在尾端附用量標記，讓 Claude 每輪讀得到（使用者定案，2026-11-12）
        REFRESH_THROTTLE_MS: 1500,
        RESEND_AFTER_RESET_MS: 30000, // 額度重置時間過後再等這麼久才補送（伺服器那邊的重置不一定準時）
        RESEND_RETRY_MS: 300000,      // 查了還沒恢復 → 這麼久之後再查
        RESEND_POLL_MS: 30000,        // 多久看一次有沒有待補送    // 同一輪結束常連續觸發好幾次，合併成一次（節流，不是防手震）
    };
    const LS = 'ccm:';                // localStorage 前綴（專案前綴，避免撞名）
    const SESSION_RE = /\/v1\/code\/sessions\/cse_[A-Za-z0-9]+/;
    const ORG_RE = /\/api\/organizations\/([0-9a-f-]{36})\//;
    const CHAT_RE = /\/chat\/([0-9a-f-]{36})/;
    const CTX_HEAD = '## Context' + ' Usage'; // 拆開寫：避免本檔被別的工具用文字搜尋時誤判
    const SEL = {
        input: '[data-testid="chat-input"]', send: 'button[data-testid="chat-input-send"], [data-cds-part="send-slot"] button', // 第二個是備援（同交接模組）
        titleSplit: '[data-testid="session-title-split"]', // 頁首「標題 ⌄」那一排（跟 claude-chat-handover 同一組選擇器）
        moreBtn: 'button[aria-haspopup="menu"]',          // 標題旁的 ⌄
    };

    const state = { orgId: null, last: null, err: null, autoPending: false };
    const curCid = () => (location.pathname.match(CHAT_RE) || [])[1] || '';
    TOOLS.meter = { state, opts: () => opts(), save: (k, v) => save(k, v), load: (k, d) => load(k, d),
        isWaiting: () => { const a = load('await:' + curCid(), 0); return a === 'manual' || a === 'suggest'; },
        // 手動交接：代送請求，記下「等〔交接就緒〕」；成功回 true
        // kind：manual＝使用者按交接鈕；suggest＝Claude 寫了〔建議交接〕、自動交接開著。兩者〔交接就緒〕後都接著開新串
        requestHandoff: async (kind) => {
            const cid = curCid(); if (!cid) return false;
            const ok = await fillSend(AUTO_PREFIX + '請歸檔、準備交接內容，完成後用〔交接就緒〕格式附上開場白。\n' + tagText(), '交接請求', { await: kind || 'manual' });
            if (ok) save('await:' + cid, kind || 'manual');
            return ok;
        } };
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

    // 之後新增訊息要乘的 k（v0.5.0）。壓縮會讓「訊息 ÷ 之前的估算」變得很小（2026-11-14 實測 0.28，平常約 1.8），
    // 拿它乘之後的成長會嚴重低估、70% 提醒變晚。偵測到壓縮就改用：壓縮後兩次校正的差 → 壓縮前的校正 → 其他對話串的校正 → 預設值
    // trusted：k 是量出來的（不是借來的），才可以存成其他對話串的參考
    function growthK(cals, g) {
        if (!cals.length) return { k: g && g.k ? g.k : CFG.DEFAULT_K, src: '', compacted: false, trusted: false };
        // 壓縮點：訊息量比上一次校正掉很多，或 k 從正常掉到偏低。壓縮後 k 會偏低好一陣子，「一直偏低」不算新的壓縮
        const low = c => c.k < CFG.COMPACT_K_BELOW;
        const cut = cals.map((c, i) => i === 0 ? low(c) : (c.messages < cals[i - 1].messages * CFG.COMPACT_DROP || (low(c) && !low(cals[i - 1]))));
        const s = cut.lastIndexOf(true), n = cals.length - 1, last = cals[n];
        if (s < 0) return { k: last.k, src: '此串校正', compacted: false, trusted: true };
        if (n > s) {
            const a = cals[s], dEst = last.before - a.before, dMsg = last.messages - a.messages;
            if (dEst >= CFG.SLOPE_MIN_EST && dMsg > 0) return { k: dMsg / dEst, src: '壓縮後兩次校正的差', compacted: true, trusted: true };
        }
        for (let j = s - 1; j >= 0; j--) {
            if (cut.slice(0, j + 1).lastIndexOf(true) < 0) return { k: cals[j].k, src: '壓縮前的校正', compacted: true, trusted: false };
        }
        if (g && g.k && g.k >= CFG.COMPACT_K_BELOW) return { k: g.k, src: '其他對話串的校正', compacted: true, trusted: false };
        return { k: CFG.DEFAULT_K, src: '預設值', compacted: true, trusted: false };
    }

    async function refresh() {
        const cm = location.pathname.match(CHAT_RE);
        if (!cm || !state.orgId) return;
        const cid = cm[1];
        const r = await origFetch('/api/organizations/' + state.orgId + '/chat_conversations/' + cid + '?tree=true&rendering_mode=messages&render_all_tools=true', { credentials: 'include' });
        if (!r.ok) { state.err = '對話樹 HTTP ' + r.status; render(); return; }
        const trunk = trunkOf(await r.json());
        state.leaf = trunk.length ? trunk[trunk.length - 1].uuid : ''; // 額度重置後補送前，比對對話有沒有往下走
        const per = trunk.map(msgTokens);
        const estNow = per.reduce((a, b) => a + b, 0);

        // 這串所有的 /context（依序）
        const cals = [];
        let acc = 0;
        for (let i = 0; i < trunk.length; i++) {
            const txt = (trunk[i].content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n');
            if (txt.startsWith(CTX_HEAD)) {
                const p = parseContext(txt);
                if (p) cals.push({ ...p, idx: i, before: acc, k: acc > 0 ? p.messages / acc : CFG.DEFAULT_K, fixed: p.total - p.messages });
            }
            acc += per[i];
        }
        const calib = cals.length ? cals[cals.length - 1] : null;
        const g = load('lastCalib', null);
        const kc = growthK(cals, g);
        // 借來的 k 不存：其他對話串只能拿到量出來的 k（沒有量過就不寫 k，讀的人用預設值）
        if (calib) save('lastCalib', kc.trusted ? { fixed: calib.fixed, k: kc.k, win: calib.win, at: Date.now() } : { ...(g || {}), fixed: calib.fixed, win: calib.win, at: Date.now() });
        const fixed = calib ? calib.fixed : (g ? g.fixed : CFG.DEFAULT_FIXED);
        const k = calib ? kc.k : (g && g.k ? g.k : CFG.DEFAULT_K);
        const win = calib ? calib.win : (g ? g.win : CFG.DEFAULT_WINDOW);
        // 有校正點：從最近一次 /context 的總量起算，只加之後新增的估算 × k（v0.5.0）。
        // 沒有壓縮過時跟舊算法（F ＋ k × 全部估算）代數上相同；壓縮過時舊算法會把壓縮前的訊息全算進去
        const C = calib ? calib.total + k * (estNow - calib.before) : fixed + k * estNow;

        const B = fixed + CFG.RULES_R + CFG.HANDOFF_H + CFG.WORK_W;
        const nStar = C > B ? (CFG.K_WRITE * B) / (CFG.K_READ * (C - B)) : Infinity;
        const pct = C / win;
        // v0.4.0：要不要換串由 Claude 判斷（腳本不知道下一階段要做多少）；舊版用寫死的「下一階段 15 輪」≥ N*，約 42% 就亮，不準（使用者定案 2026-11-13）
        const sug = suggestOf(trunk);
        const switchWorth = !!sug;

        state.last = { cid, t: Date.now(), C: Math.round(C), pct, win, fixed: Math.round(fixed), k: +k.toFixed(3), estNow: Math.round(estNow), msgs: trunk.length,
            calib: calib ? { total: calib.total, messages: calib.messages, idx: calib.idx, ago: trunk.length - 1 - calib.idx } : null,
            compacted: kc.compacted, kSrc: calib ? kc.src : '',
            source: calib ? '此對話串的 /context' : (g ? '其他對話串的校正' : '預設值'), B: Math.round(B), nStar, switchWorth, suggest: sug ? sug.reason : '' };
        const ci = contInfo(trunk);
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
            || (calib && pct - calib.total / calib.win >= CFG.AUTO_RECHECK_STEP);
        if (!need) return;
        const ed = document.querySelector(SEL.input);
        if (!ed || ed.innerText.trim()) return; // 使用者有沒送出的字就不動，下一輪再說
        const idx = calib ? calib.idx : -1;
        // v0.3.1：一般自動校正也要補送（使用者回報 2026-11-13：只送 /context、沒把結果交給 Claude）
        if (await sendContext('自動 /context')) { save('autoctx:' + cid, lastU); state.pendManual = { cid, idx, t: Date.now(), why: '自動校正' }; }
    }
    // 把一段文字填進輸入框並送出（/context、〔自動〕訊息共用）；輸入框有字時不送。成功回 true
    // v0.7.0：額度用完時不送、記成「待補送」（每串只留最後一則），額度重置後由 retryPending 補送；extra＝補送成功後要補做的事
    async function fillSend(text, who, extra, retry) {
        const C = TOOLS.cooldown, cid = curCid();
        if (C && cid && !retry && C.blocked()) { queuePend(cid, text, who, extra, '送出前就擋住'); return false; }
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
            if (ed.innerText.trim()) {
                // 送不出去：額度用完時 claude.ai 會把字留在輸入框（推測，待實機確認）→ 清掉、記成待補送
                if (C && cid && (C.blocked() || (await C.canSend()) === false)) { clearEd(ed); queuePend(cid, text, who, extra, '送出後沒清空'); C.markBlocked(); return false; }
                state.err = who + '：送出後輸入框沒清空'; return false;
            }
            if (C && cid) setTimeout(() => { if (C.blocked()) { state.blockedNote = { cid, t: Date.now(), who }; render(); } }, 1500); // 送出了但接著被擋：不補送（會重複），面板提示；不等，免得拖慢後面的流程
            return true;
        } finally { state.autoPending = false; render(); }
    }
    // ── 4e. 額度重置後補送（v0.7.0）──
    // 只補腳本自己送的訊息（〔自動〕、/context、交接請求）；使用者自己打的字被擋時留在輸入框，不動。
    // 補送前一定確認：額度真的回來了、對話還停在記下來那一則（中間沒有人送過東西）、輸入框是空的。只補一次，再被擋就重新排。
    function queuePend(cid, text, who, extra, why) {
        save('pend:' + cid, { text, who, extra: extra || null, after: state.leaf || '', t: Date.now(), why, next: 0 });
        console.log('[ClaudeChatTools] 額度用完，記成待補送：', who, why);
        render();
    }
    async function retryPending(force) {
        const cid = curCid(); if (!cid || state.autoPending || state.retrying) return;
        const pd = load('pend:' + cid, null); if (!pd) return;
        if (!opts().autoResend) return;
        const now = Date.now(), C = TOOLS.cooldown;
        const reset = C ? C.resetAt() : 0;
        if (!force && reset && now < reset * 1000 + CFG.RESEND_AFTER_RESET_MS) return;
        if (!force && pd.next && now < pd.next) return;
        state.retrying = true;
        try {
            const ok = C ? await C.canSend() : null;
            if (ok === false || (ok === null && C && C.blocked())) { pd.next = now + CFG.RESEND_RETRY_MS; save('pend:' + cid, pd); render(); return; }
            await refresh();
            if (pd.after && state.leaf && state.leaf !== pd.after) {
                localStorage.removeItem(LS + 'pend:' + cid);
                state.resendLog = { t: now, msg: '對話已經往下走，不補送：' + pd.text.split('\n')[0] }; render(); return;
            }
            const ed = document.querySelector(SEL.input);
            if (!ed || ed.innerText.trim()) { pd.next = now + 30000; save('pend:' + cid, pd); return; } // 使用者在打字：等一下再看
            const sent = await fillSend(pd.text, pd.who + '（補送）', pd.extra, true);
            const cur = load('pend:' + cid, null);
            if (sent) { if (cur && cur.t === pd.t) localStorage.removeItem(LS + 'pend:' + cid); }
            else if (cur && cur.t === pd.t) { cur.next = Date.now() + 30000; save('pend:' + cid, cur); } // 別的自動送出正在進行等原因沒送成：留著，等一下再試（送出時又被擋會由 fillSend 重記一筆）
            if (sent) {
                if (pd.extra && pd.extra.await) save('await:' + cid, pd.extra.await);
                if (pd.text === '/context') state.pendManual = { cid, idx: state.last && state.last.calib ? state.last.calib.idx : -1, t: Date.now(), why: '額度重置後補送' };
            }
            state.resendLog = { t: now, msg: (sent ? '已補送：' : '補送失敗：') + pd.text.split('\n')[0] };
            render();
        } finally { state.retrying = false; }
    }
    setInterval(() => { retryPending(false).catch(e => { state.err = 'resend: ' + e; }); }, CFG.RESEND_POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) retryPending(false).catch(() => {}); });
    window.__ccmRetry = retryPending; // 測試用
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
    const SUG_RE = /^〔建議交接〕(.*)$/;
    const MEASURE_RE = /^〔量用量〕/;   // v0.5.0：Claude 要準確用量時寫這行，腳本送 /context 再補送〔自動〕已校正用量（Claude 要求）
    const AUTO_PREFIX = '〔自動〕';
    const OPT_DEF = { thr: 0.80, onStop: 'handoff', autoHandoff: false, autoAllow: false, autoResend: true };
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
    // 最近一則 Claude 回覆（跳過 /context 的輸出：腳本常在回覆後代送 /context，輸出也是 assistant，會把建議蓋掉）的最後一行是〔建議交接〕
    function suggestOf(trunk) {
        for (let i = trunk.length - 1; i >= 0; i--) {
            const m = trunk[i]; if (m.sender !== 'assistant') continue;
            const t = textOf(m); if (!t.trim() || t.startsWith(CTX_HEAD)) continue;
            const sm = lastLine(t).match(SUG_RE);
            return sm ? { uuid: m.uuid, idx: i, reason: sm[1].trim() } : null;
        }
        return null;
    }
    // 自動交接開關的實際狀態（跟面板顯示一致：「停下來時」不是歸檔交接、或門檻 85% 時算關）
    const autoHandoffOn = o => o.autoHandoff && effOnStop(o) === 'handoff';
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
        let stop = null, kind = '';
        // 建議換串不在這裡判斷：Claude 判斷划算時直接寫〔建議交接〕代替〔續做〕（v0.4.0）
        if (after >= o.thr) { kind = 'thr'; stop = '現在 ' + P(L.pct) + '%，加上下一批約 ' + P(after) + '%，超過門檻 ' + P(o.thr) + '%。'; }
        else if (n >= CFG.CONT_MAX) { kind = 'max'; stop = '已經連續自動續做 ' + CFG.CONT_MAX + ' 次，可能在空轉。'; }
        const tail = note ? note : '';
        const msg = stop ? AUTO_PREFIX + '停：' + stop + tail + '\n' + stopLine2(kind) : AUTO_PREFIX + '繼續（第 ' + (n + 1) + ' 次）。' + tail;
        const ok = await fillSend(msg + '\n' + tagText(), '自動續做');
        if (ok && stop && kind !== 'max' && autoHandoffOn(o)) save('await:' + cid, 1);
        state.contLog = { t: Date.now(), msg: msg.split('\n')[0], ok };
    }
    // 回傳 true＝這一輪由續做流程處理（含要不要送 /context），一般的自動 /context 不再插手
    // 手動〔校正〕之後也補送一則（使用者定案 2026-11-13）：Claude 才能當下拿新數字判斷要不要換串，不必等使用者下一次開口
    function manualFollow(cid, calib) {
        const p = state.pendManual;
        if (!p || p.cid !== cid) return false;
        const got = calib && calib.idx > p.idx;
        if (!got && Date.now() - p.t <= CFG.CTX_WAIT_MS) {
            if (!state.pendTimer) state.pendTimer = setTimeout(() => { state.pendTimer = null; scheduleRefresh(); }, CFG.CTX_WAIT_MS + 500);
            return true;
        }
        state.pendManual = null;
        const why = p.why || '手動校正';
        fillSend(AUTO_PREFIX + (got ? '已校正用量（' + why + '）。' : '校正失敗，用估算（' + why + '）。') + '\n' + tagText(), '校正補送');
        return true;
    }
    // 最後一則 Claude 回覆的最後一行是〔量用量〕：送 /context，輸出出現後由 manualFollow 補送（同手動〔校正〕）；同一則只送一次
    function handleMeasure(cid, trunk) {
        const last = trunk[trunk.length - 1];
        if (!last || last.sender !== 'assistant' || !MEASURE_RE.test(lastLine(textOf(last)))) return false;
        if (load('meas:' + cid, '') === last.uuid) return true;
        const ed = document.querySelector(SEL.input);
        if (!ed || ed.innerText.trim()) return true;           // 使用者在打字：不動
        save('meas:' + cid, last.uuid);
        const idx = state.last && state.last.calib ? state.last.calib.idx : -1;
        sendContext('Claude 要求').then(ok => { if (ok) state.pendManual = { cid, idx, t: Date.now(), why: 'Claude 要求' }; });
        return true;
    }
    function autoFlow(cid, trunk, calib) {
        if (manualFollow(cid, calib)) return true;
        if (state.pendCont && state.pendCont.cid === cid) {
            const p = state.pendCont;
            const got = calib && calib.idx > p.info.idx;
            if (got || Date.now() - p.t > CFG.CTX_WAIT_MS) { state.pendCont = null; decide(cid, trunk, p.info, got ? '已校正用量。' : '（校正失敗，用估算）'); }
            else if (!state.pendTimer) state.pendTimer = setTimeout(() => { state.pendTimer = null; scheduleRefresh(); }, CFG.CTX_WAIT_MS + 500);
            return true;
        }
        const last = trunk[trunk.length - 1];
        if (last && last.sender === 'assistant') { const t = textOf(last), rm = t.match(READY_RE); if (rm) { handleReady(cid, last, t, rm); return true; } }
        if (handleSuggest(cid, trunk)) return true;
        if (handleMeasure(cid, trunk)) return true;
        const info = contInfo(trunk);
        if (!info) return false;
        if (load('cont:' + cid, '') === info.uuid) return true; // 同一則回覆只回一次
        const ed = document.querySelector(SEL.input);
        if (!ed || ed.innerText.trim()) return true;           // 使用者在打字：不動
        const L = state.last, o = opts();
        const near = L.pct + info.est / L.win >= o.thr - CFG.CONT_NEAR_PCT;
        const fresh = calib && calib.idx > lastUserIdx(trunk);
        const stale = calib && L.pct - calib.total / calib.win >= CFG.AUTO_RECHECK_STEP; // v0.5.0：上次校正後漲超過一步
        // 離門檻近、這串還沒有任何校正（新串量起點）、或上次校正太舊 → 先代送 /context，輸出出現後一定補送〔自動〕訊息（mockup 9 區）
        if ((near || !calib || stale) && !fresh && load('autoctx:' + cid, '') !== info.uuid) {
            save('autoctx:' + cid, info.uuid);
            state.pendCont = { cid, t: Date.now(), info };
            sendContext('續做校正').then(ok => { if (!ok && state.pendCont) { state.pendCont = null; decide(cid, trunk, info, '（校正失敗，用估算）'); } });
            return true;
        }
        decide(cid, trunk, info, '');
        return true;
    }

    // ── 4c. Claude 寫〔建議交接〕：自動交接開著 → 代送交接請求；關著 → 只亮標籤、藍燈、交接鈕「建議交接」（使用者定案 2026-11-13：只看開關，不看使用者在不在）──
    // 自動觸發也算進連續自動交接上限，避免 Claude 判斷錯誤時一直換串；同一則回覆只觸發一次
    function handleSuggest(cid, trunk) {
        const last = trunk[trunk.length - 1], sg = suggestOf(trunk);
        if (!sg || !last || last.uuid !== sg.uuid) return false;     // 只在 Claude 剛寫完這則時觸發
        const o = opts(), n = load('ahn', 0);
        if (!autoHandoffOn(o) || n >= CFG.AUTO_HANDOFF_MAX) return false;
        if (load('sug:' + cid, '') === sg.uuid || load('await:' + cid, 0)) return true;
        const ed = document.querySelector(SEL.input);
        if (!ed || ed.innerText.trim()) return true;                  // 使用者在打字：不動
        TOOLS.meter.requestHandoff('suggest').then(ok => { if (ok) { save('sug:' + cid, sg.uuid); save('ahn', n + 1); } });
        return true;
    }

    // ── 4d. 自動交接：讀〔交接就緒〕下面的程式碼區塊（不經剪貼簿）──
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
        const aw = load('await:' + cid, 0);
        if ((aw === 'manual' || aw === 'suggest') && TOOLS.handover) { save('await:' + cid, 0); TOOLS.handover.run(bm[1], { auto: true }); }
        else if (aw && o.autoHandoff && n < CFG.AUTO_HANDOFF_MAX && TOOLS.handover) {
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
            // v0.4.0：結論由 Claude 判斷（〔建議交接〕那一行）；回本輪數只是公式估計，留著當參考
            j.append('Claude 的建議：', Object.assign(document.createElement('b'), { textContent: L.switchWorth ? '建議換串' : '沒有建議' }));
            if (L.suggest) j.append(document.createElement('br'), L.suggest);
            j.append(document.createElement('br'), '換新對話串約 ' + (isFinite(L.nStar) ? Math.ceil(L.nStar) : '—') + ' 輪後回本（公式估計）');
            parts.push(j);
            const basis = row('', 'margin-top:8px;padding-top:8px;border-top:1px solid ' + line + ';color:' + dim);
            basis.append('校正：' + L.source + (L.calib ? '（' + L.calib.ago + ' 則訊息前）' : ''), document.createElement('br'),
                '固定部分 F ' + man(L.fixed) + '・係數 k ' + L.k + (L.compacted ? '（壓縮過，k 用' + L.kSrc + '）' : '') + '・v' + VERSION);
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
        b.addEventListener('click', () => {
            if (off) return;
            const cid = (location.pathname.match(CHAT_RE) || [])[1], idx = state.last && state.last.calib ? state.last.calib.idx : -1;
            sendContext('校正').then(ok => { if (ok && cid) state.pendManual = { cid, idx, t: Date.now() }; });
        });
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
        s1.append(div('margin-top:14px', '停下來時'), small('到門檻、連續自動 ' + CFG.CONT_MAX + ' 次都會停'));
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
        s3.append(small('授權卡出現時，自動送卡片上的快捷鍵（有「一律允許」就用它）；需要你在對話裡親口同意的授權，腳本處理不了'));
        out.push(s3);
        // 額度冷卻（v0.7.0：翻頁鐘併入＋重置後補送）
        const s4 = div('margin-top:12px;padding-top:12px;border-top:1px solid ' + line); s4.className = 'ccm-sec-cool';
        const pd = load('pend:' + cid, null), C = TOOLS.cooldown, rs = C ? C.resetAt() : 0;
        const hm = ep => { const x = new Date(ep * 1000); return (x.getMonth() + 1) + '/' + x.getDate() + ' ' + String(x.getHours()).padStart(2, '0') + ':' + String(x.getMinutes()).padStart(2, '0'); };
        const st4 = !pd ? '沒有待補送' : !o.autoResend ? '有 1 則沒送出（補送已關）' : rs * 1000 > Date.now() ? '待補送・' + hm(rs) + ' 後送' : '待補送・等額度恢復';
        s4.append(head('重置後補送', st4, toggle(d, o.autoResend, false, v => setOpt('autoResend', v), '額度重置後補送')));
        s4.append(small('額度用完時腳本自動送的訊息（〔自動〕、/context、交接請求）送不出去，等額度重置後再送一次；對話已經往下走就不送'));
        if (pd) s4.append(Object.assign(small('沒送出：' + pd.text.split('\n')[0].slice(0, 40)), { style: 'margin-top:6px;font-size:13px;line-height:18px;color:' + dim }));
        if (state.resendLog) s4.append(Object.assign(small(state.resendLog.msg.slice(0, 50)), { style: 'margin-top:6px;font-size:13px;line-height:18px;color:' + dim }));
        if (state.blockedNote && state.blockedNote.cid === cid) s4.append(Object.assign(small('訊息送出後才被擋住、沒有回覆：重置後請自己按重試', warnC), { style: 'margin-top:6px;font-size:13px;line-height:18px;color:' + warnC }));
        const ob = document.createElement('button'); ob.type = 'button'; ob.textContent = '開啟倒數'; ob.className = 'ccm-cool-open';
        ob.style.cssText = 'margin-top:10px;width:73px;height:28px;padding:0;border-radius:9px;font:inherit;font-size:13px;cursor:pointer;background:' + (d ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.05)') + ';border:1px solid ' + (d ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.08)') + ';color:inherit';
        ob.addEventListener('click', e => { e.stopPropagation(); if (C) C.open().then(m => { state.coolMsg = m || ''; renderPanel(); }); });
        s4.append(ob);
        if (state.coolMsg) s4.append(Object.assign(small(state.coolMsg, warnC), { style: 'margin-top:6px;font-size:13px;line-height:18px;color:' + warnC }));
        out.push(s4);
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
        if (info.request) row('接下來', '先請 Claude 歸檔、準備交接內容；它寫好開場白後，自動開新對話串並送出', c.sub);
        else row(`交接文字（共 ${info.lineCount} 行）`, info.preview, c.sub);
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
    // 手動按、還沒有開場白：先請 Claude 歸檔、準備交接；〔交接就緒〕出來後由用量模組接著自動開新串（使用者定案 2026-11-13，拿掉剪貼簿）
    const request = !given && !auto;
    const current = getTitle();
    const link = getProjectLink();
    const errors = [];
    const text = given || '';
    if (!request && !text.trim()) errors.push('讀到的開場白是空的');
    if (request && M && M.isWaiting()) errors.push('已經請 Claude 準備交接了，等它寫好〔交接就緒〕');
    if (!current) errors.push('讀不到目前對話串的名稱');
    if (!link) errors.push('這個對話串不在 Project 裡（標題列沒有 Project 連結）');

    const names = current ? computeNames(current) : { oldName: '', newName: '' };
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const nonEmpty = lines.filter((l) => l.trim());
    const preview = nonEmpty.slice(0, 2).join('\n') + (nonEmpty.length > 2 ? '\n…' : '');
    const info = { current, ...names, project: link ? link.textContent.trim() : '', preview, lineCount: lines.length, errors, request };

    if (auto) { if (errors.length) { toast(['自動交接沒有執行', ...errors], 'err'); return; } }
    else if (!(await confirmDialog(info))) return;
    if (!auto && M) M.save('ahn', 0); // 手動交接：連續自動交接次數歸零（使用者定案）
    if (request) {
      if (!M || !(await M.requestHandoff())) toast(['沒有送出交接請求', (M && M.state.err) || '輸入框有字或找不到送出鈕'], 'err');
      else toast(['已請 Claude 歸檔並準備交接', '寫好開場白後會自動開新對話串'], 'info');
      refreshLabel();
      return;
    }
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
  // 交接鈕的樣子（mockup 8 區）：平常／收到〔交接就緒〕但自動交接關著 →「可以交接了」（藍）／Claude 寫了〔建議交接〕→「建議交接」（藍）／執行中 →「交接中…」
  function refreshLabel() {
    const b = document.querySelector('.cho-btn'); if (!b) return;
    const M = TOOLS.meter, ready = !!(M && M.state.handoffText);
    const waiting = !!(M && M.isWaiting());
    const sug = !!(M && M.state.last && M.state.last.switchWorth); // Claude 寫了〔建議交接〕（v0.4.0）
    const label = running ? '交接中…' : ready ? '可以交接了' : waiting ? '交接準備中…' : sug ? '建議交接' : '交接對話串';
    const spans = [...b.querySelectorAll('span')].filter((x) => !x.children.length && x.textContent.trim());
    const tgt = spans.length ? spans[spans.length - 1] : b;
    if (tgt.textContent !== label) tgt.textContent = label;
    const want = (ready || (sug && !waiting)) && !running ? '1' : '';
    if ((b.dataset.ready || '') !== want) {
      b.dataset.ready = want;
      if (want) { b.style.background = '#2c84db'; b.style.color = '#ffffff'; b.style.border = '1px solid #2c84db'; }
      else { b.style.background = 'color-mix(in srgb, currentColor 6%, transparent)'; b.style.color = ''; b.style.border = '1px solid color-mix(in srgb, currentColor 35%, transparent)'; }
    }
  }
  setInterval(refreshLabel, 500);
  TOOLS.handover = { run: (text, o) => onHandoverClick(text, o) };
  window.__cho = { VERSION, computeNames, run: (t, o) => onHandoverClick(t, o) }; // run：測試用
  log(`v${VERSION} 已載入`);
    });

    // ════════ 模組五：額度冷卻翻頁鐘（原 bgtsai/browser-tools cooldown-flipclock v1.21.3，v0.7.0 併入）════════
    // 合併前跑在 Tampermonkey 沙盒（@grant unsafeWindow＋GM_ 存主題、GM_ 選單）；合併後跟其他模組一樣 @grant none：
    // 主題改存 localStorage「ccm:cfc:theme」，選單改成用量面板的〔開啟倒數〕。偵測照舊：額度提示元素＋用量端點的 resets_at。
    whenReady(function () {

  // 真正的頁面 window（跳脫 Tampermonkey 沙盒）。@grant unsafeWindow 會讓腳本跑在獨立沙盒，
  // 沙盒裡的 window 跟頁面實際的 window 是兩個不同物件——覆寫 fetch/XHR 這類要攔截「頁面自己呼叫」
  // 的內建函式，一定要用 unsafeWindow，用 window 只會覆寫到沙盒自己的副本，攔截不到頁面真正的請求。
  const target = window; // 合併後整支 @grant none：window 就是頁面的 window

  /* ------------------------------------------------------------
   * 使用者設定：直接改這裡
   * ------------------------------------------------------------ */
  // 翻頁鐘配色主題預設值："dark"（黑底白字）或 "light"（白底黑字）——
  // 這只是「還沒有任何持久化選擇時」的初始值，畫面上的膠囊開關切換後會覆蓋，並記住使用者的選擇。
  // 注意：主題只影響翻頁鐘本體的配色，全螢幕遮罩（蓋住頁面背景的那層）固定維持不透明黑色，不受這個設定影響。
  const CFC_THEME = "dark";
  const THEME_STORAGE_KEY = "ccm:cfc:theme";

  // 用量到這個百分比視為「這個視窗已經用盡」——沒有官方文件保證確切門檻，這是保守估計值。
  // 短週期（five_hour）跟長週期（seven_day）各自獨立一個參數，不共用同一個數字——
  // 兩個視窗的特性可能不一樣，之後如果只有其中一個誤判，可以只調那一個，不會互相牽動。
  const EXHAUST_THRESHOLD_SHORT = 97; // 短週期（five_hour）
  const EXHAUST_THRESHOLD_LONG = 97;  // 長週期（seven_day）

  // 合併前存在 Tampermonkey 的 GM_ 儲存（舊腳本自己的），合併後改存 localStorage：@grant none 沒有 GM_，舊的選擇讀不到，要重選一次
  function getCurrentTheme() {
    try { return localStorage.getItem(THEME_STORAGE_KEY) || CFC_THEME; } catch (e) { return CFC_THEME; }
  }
  function setCurrentTheme(theme) {
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch (e) { /* 存不了只影響下次的主題 */ }
  }

  /* ------------------------------------------------------------
   * 翻頁鐘核心：vendored from PButcher/flipdown v0.3.2 (MIT License)
   * https://github.com/PButcher/flipdown
   * 原始碼未修改（僅由 babel 編譯後的 dist/flipdown.min.js 直接內嵌），
   * 選擇這支函式庫的理由：純 JS/CSS、無外部相依、<11KB、CSS transition 驅動翻頁動畫。
   * 我們的客製化（顯示哪兩組欄位、全螢幕外殼）全部寫在下面的 CFC 命名空間裡，
   * 不碰這段原始碼本身，方便之後要更新上游版本時直接整段替換。
   * ------------------------------------------------------------ */
  /* eslint-disable */
  !(function () {
    "use strict";
    function _typeof(a) {
      return (
        (_typeof =
          "function" == typeof Symbol && "symbol" == typeof Symbol.iterator
            ? function (a) {
                return typeof a;
              }
            : function (a) {
                return a &&
                  "function" == typeof Symbol &&
                  a.constructor === Symbol &&
                  a !== Symbol.prototype
                  ? "symbol"
                  : typeof a;
              }),
        _typeof(a)
      );
    }
    function _classCallCheck(a, b) {
      if (!(a instanceof b))
        throw new TypeError("Cannot call a class as a function");
    }
    function _defineProperties(a, b) {
      for (var c, d = 0; d < b.length; d++)
        (c = b[d]),
          (c.enumerable = c.enumerable || !1),
          (c.configurable = !0),
          "value" in c && (c.writable = !0),
          Object.defineProperty(a, c.key, c);
    }
    function _createClass(a, b, c) {
      return b && _defineProperties(a.prototype, b), c && _defineProperties(a, c), a;
    }
    var FlipDown = (function () {
      var b = Math.floor;
      function a(b) {
        var c = 1 < arguments.length && void 0 !== arguments[1] ? arguments[1] : "flipdown",
          d = 2 < arguments.length && void 0 !== arguments[2] ? arguments[2] : {};
        if (
          (_classCallCheck(this, a),
          "number" != typeof b)
        )
          throw new Error(
            "FlipDown: Constructor expected unix timestamp, got ".concat(_typeof(b), " instead."),
          );
        "object" === _typeof(c) && ((d = c), (c = "flipdown")),
          (this.version = "0.3.2"),
          (this.initialised = !1),
          (this.now = this._getTime()),
          (this.epoch = b),
          (this.countdownEnded = !1),
          (this.hasEndedCallback = null),
          (this.element = document.getElementById(c)),
          (this.rotors = []),
          (this.rotorLeafFront = []),
          (this.rotorLeafRear = []),
          (this.rotorTops = []),
          (this.rotorBottoms = []),
          (this.countdown = null),
          (this.daysRemaining = 0),
          (this.clockValues = {}),
          (this.clockStrings = {}),
          (this.clockValuesAsString = []),
          (this.prevClockValuesAsString = []),
          (this.opts = this._parseOptions(d)),
          this._setOptions();
      }
      return (
        _createClass(a, [
          {
            key: "start",
            value: function a() {
              return (
                this.initialised || this._init(),
                (this.countdown = setInterval(this._tick.bind(this), 1e3)),
                this
              );
            },
          },
          {
            key: "ifEnded",
            value: function b(a) {
              return (
                (this.hasEndedCallback = function () {
                  a(), (this.hasEndedCallback = null);
                }),
                this
              );
            },
          },
          {
            key: "_getTime",
            value: function a() {
              return new Date().getTime() / 1e3;
            },
          },
          {
            key: "_hasCountdownEnded",
            value: function a() {
              return 0 > this.epoch - this.now
                ? ((this.countdownEnded = !0),
                  null != this.hasEndedCallback &&
                    (this.hasEndedCallback(), (this.hasEndedCallback = null)),
                  !0)
                : ((this.countdownEnded = !1), !1);
            },
          },
          {
            key: "_parseOptions",
            value: function c(a) {
              var b = ["Days", "Hours", "Minutes", "Seconds"];
              return (
                a.headings && 4 === a.headings.length && (b = a.headings),
                { theme: a.hasOwnProperty("theme") ? a.theme : "dark", headings: b }
              );
            },
          },
          {
            key: "_setOptions",
            value: function a() {
              this.element.classList.add("flipdown__theme-".concat(this.opts.theme));
            },
          },
          {
            key: "_init",
            value: function h() {
              (this.initialised = !0),
                (this.daysremaining = this._hasCountdownEnded()
                  ? 0
                  : b((this.epoch - this.now) / 86400).toString().length);
              for (
                var a = 2 >= this.daysremaining ? 2 : this.daysremaining, c = 0;
                c < a + 6;
                c++
              )
                this.rotors.push(this._createRotor(0));
              for (var d = [], c = 0; c < a; c++) d.push(this.rotors[c]);
              this.element.appendChild(this._createRotorGroup(d, 0));
              for (var e, f = a, c = 0; 3 > c; c++) {
                e = [];
                for (var g = 0; 2 > g; g++) e.push(this.rotors[f]), f++;
                this.element.appendChild(this._createRotorGroup(e, c + 1));
              }
              return (
                (this.rotorLeafFront = Array.prototype.slice.call(
                  this.element.getElementsByClassName("rotor-leaf-front"),
                )),
                (this.rotorLeafRear = Array.prototype.slice.call(
                  this.element.getElementsByClassName("rotor-leaf-rear"),
                )),
                (this.rotorTop = Array.prototype.slice.call(
                  this.element.getElementsByClassName("rotor-top"),
                )),
                (this.rotorBottom = Array.prototype.slice.call(
                  this.element.getElementsByClassName("rotor-bottom"),
                )),
                this._tick(),
                this._updateClockValues(!0),
                this
              );
            },
          },
          {
            key: "_createRotorGroup",
            value: function e(a, b) {
              var c = document.createElement("div");
              c.className = "rotor-group";
              var d = document.createElement("div");
              return (
                (d.className = "rotor-group-heading"),
                d.setAttribute("data-before", this.opts.headings[b]),
                c.appendChild(d),
                appendChildren(c, a),
                c
              );
            },
          },
          {
            key: "_createRotor",
            value: function h() {
              var a = 0 < arguments.length && void 0 !== arguments[0] ? arguments[0] : 0,
                b = document.createElement("div"),
                c = document.createElement("div"),
                d = document.createElement("figure"),
                e = document.createElement("figure"),
                f = document.createElement("div"),
                g = document.createElement("div");
              return (
                (b.className = "rotor"),
                (c.className = "rotor-leaf"),
                (d.className = "rotor-leaf-rear"),
                (e.className = "rotor-leaf-front"),
                (f.className = "rotor-top"),
                (g.className = "rotor-bottom"),
                (d.textContent = a),
                (f.textContent = a),
                (g.textContent = a),
                appendChildren(b, [c, f, g]),
                appendChildren(c, [d, e]),
                b
              );
            },
          },
          {
            key: "_tick",
            value: function c() {
              this.now = this._getTime();
              var a = 0 >= this.epoch - this.now ? 0 : this.epoch - this.now;
              (this.clockValues.d = b(a / 86400)),
                (a -= 86400 * this.clockValues.d),
                (this.clockValues.h = b(a / 3600)),
                (a -= 3600 * this.clockValues.h),
                (this.clockValues.m = b(a / 60)),
                (a -= 60 * this.clockValues.m),
                (this.clockValues.s = b(a)),
                this._updateClockValues(),
                this._onTick && this._onTick(),
                this._hasCountdownEnded();
            },
          },
          {
            key: "_updateClockValues",
            value: function e() {
              function a() {
                var a = this;
                this.rotorTop.forEach(function (b, c) {
                  b.textContent != a.clockValuesAsString[c] &&
                    (b.textContent = a.clockValuesAsString[c]);
                });
              }
              function b() {
                var a = this;
                this.rotorLeafRear.forEach(function (b, c) {
                  if (b.textContent != a.clockValuesAsString[c]) {
                    (b.textContent = a.clockValuesAsString[c]),
                      b.parentElement.classList.add("flipped");
                    var d = setInterval(
                      function () {
                        b.parentElement.classList.remove("flipped"), clearInterval(d);
                      }.bind(a),
                      500,
                    );
                  }
                });
              }
              var c = this,
                d = !!(0 < arguments.length && void 0 !== arguments[0]) && arguments[0];
              (this.clockStrings.d = pad(this.clockValues.d, 2)),
                (this.clockStrings.h = pad(this.clockValues.h, 2)),
                (this.clockStrings.m = pad(this.clockValues.m, 2)),
                (this.clockStrings.s = pad(this.clockValues.s, 2)),
                (this.clockValuesAsString = (
                  this.clockStrings.d + this.clockStrings.h + this.clockStrings.m + this.clockStrings.s
                ).split("")),
                this.rotorLeafFront.forEach(function (a, b) {
                  a.textContent = c.prevClockValuesAsString[b];
                }),
                this.rotorBottom.forEach(function (a, b) {
                  a.textContent = c.prevClockValuesAsString[b];
                }),
                d
                  ? (a.call(this), b.call(this))
                  : (setTimeout(a.bind(this), 650), setTimeout(b.bind(this), 500)),
                (this.prevClockValuesAsString = this.clockValuesAsString);
            },
          },
        ]),
        a
      );
    })();
    function pad(a, b) {
      return (a = a.toString()), a.length < b ? pad("0" + a, b) : a;
    }
    function appendChildren(a, b) {
      b.forEach(function (b) {
        a.appendChild(b);
      });
    }
    (window.__CFC_FlipDown = FlipDown);
  })();
  /* eslint-enable */

  /* ------------------------------------------------------------
   * 樣式：vendored from PButcher/flipdown src/flipdown.css (MIT License)，
   * 僅調整尺寸與配色以符合全螢幕呈現，翻頁動畫邏輯（transform/transition）未變動。
   * 另外加上我們自訂的全螢幕外殼樣式、以及「依 phase 隱藏兩組欄位」的規則。
   * ------------------------------------------------------------ */
  const style = document.createElement("style");
  style.textContent = `
    /* ===== 尺寸網格 =====
     * 全部尺寸／間距先在 1920px 寬的設計基準下敲定為 8px 網格的整數倍，
     * 再換算成 vw 讓整體跟著可視區域寬度等比縮放（不是寫死 px）。
     * --cfc-u 代表「1 個網格單位」= 8px（在 1920px 寬時），
     * 下面每個尺寸都寫成 calc(var(--cfc-u) * N)，N 即為「幾個 8px」，方便之後要調整網格基準時只改一個變數。
     * 換算：N(單位) × 8px ÷ 1920px × 100 = N × 0.41667vw
     */
    /* ===== vendored flipdown 主題（改為單一自訂配色，取消 dark/light 切換） ===== */
    #cfc-flipdown.flipdown {
      overflow: visible;
      display: inline-block;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-weight: 700;
    }
    #cfc-flipdown .rotor-group {
      position: relative;
      float: left;
      padding-right: var(--cfc-group-gap, calc(var(--cfc-u) * 15)); /* 120px 保底，JS 量測後會覆蓋成實際值 */
    }
    #cfc-flipdown .rotor-group:last-child { padding-right: 0; }
    #cfc-flipdown .rotor-group-heading:before {
      display: block;
      height: calc(var(--cfc-u) * 14); /* 112px */
      line-height: calc(var(--cfc-u) * 14);
      text-align: center;
      content: attr(data-before);
      font-size: calc(var(--cfc-u) * 3); /* 24px */
      letter-spacing: 0.2em;
      color: rgba(255,255,255,0.55);
      font-weight: 500;
    }
    #cfc-flipdown .rotor {
      position: relative;
      float: left;
      width: calc(var(--cfc-u) * 30);  /* 240px */
      height: calc(var(--cfc-u) * 44); /* 352px（÷2＝176px，整除 8px，翻頁上下半才會精準對齊） */
      margin: 0 calc(var(--cfc-u) * 2) 0 0; /* 16px */
      border-radius: calc(var(--cfc-u) * 3); /* 24px */
      font-size: calc(var(--cfc-u) * 32); /* 256px */
      text-align: center;
      perspective: calc(var(--cfc-u) * 100); /* 800px（原 288px）——加大透視距離，減少翻頁時「靠近放大」的畸變感 */
      transform-style: preserve-3d; /* 讓底層(rotor-top/bottom)跟翻動葉片都待在同一個 3D 座標系，
                                       前後關係由單一套規則決定，不會兩套機制打架 */
    }
    #cfc-flipdown .rotor:last-child { margin-right: 0; }
    #cfc-flipdown .rotor-top,
    #cfc-flipdown .rotor-bottom {
      overflow: hidden;
      position: absolute;
      width: calc(var(--cfc-u) * 30);  /* 240px */
      height: calc(var(--cfc-u) * 22); /* 176px */
      /* 統一 3D 空間：父層 .rotor 有 transform-style:preserve-3d，這裡跟葉片都待在同一個 3D 座標系，
         前後關係純粹由 Z 軸位置決定，不會出現「z-index 平面規則」跟「3D 深度」兩套機制同時作用、
         在動畫啟動瞬間判斷不一致而讓底層短暫穿透到葉片前面的情況。
         translateZ(0) 同時也解決了另一個問題：讓這裡跟葉片用同一種渲染路徑，
         文字的次像素落點一致，動畫結束切換顯示時不會往上跳一下。 */
      transform: translateZ(0);
    }
    #cfc-flipdown .rotor-leaf {
      z-index: 1;
      position: absolute;
      width: calc(var(--cfc-u) * 30);  /* 240px */
      height: calc(var(--cfc-u) * 44); /* 352px */
      transform-style: preserve-3d;
      transition: transform 0s;
    }
    #cfc-flipdown .rotor-leaf.flipped {
      transform: rotateX(-180deg);
      transition: all 0.5s ease-in-out;
    }
    #cfc-flipdown .rotor-leaf-front,
    #cfc-flipdown .rotor-leaf-rear {
      overflow: hidden;
      position: absolute;
      width: calc(var(--cfc-u) * 30);  /* 240px */
      height: calc(var(--cfc-u) * 22); /* 176px */
      margin: 0;
      transform: rotateX(0deg);
      backface-visibility: hidden;
      -webkit-backface-visibility: hidden;
    }
    #cfc-flipdown .rotor-leaf-front { line-height: calc(var(--cfc-u) * 44); border-radius: calc(var(--cfc-u) * 3) calc(var(--cfc-u) * 3) 0 0; }
    #cfc-flipdown .rotor-leaf-rear  { line-height: 0;     border-radius: 0 0 calc(var(--cfc-u) * 3) calc(var(--cfc-u) * 3); transform: rotateX(-180deg); }
    #cfc-flipdown .rotor-top    { line-height: calc(var(--cfc-u) * 44); border-radius: calc(var(--cfc-u) * 3) calc(var(--cfc-u) * 3) 0 0; }
    #cfc-flipdown .rotor-bottom {
      bottom: 0;
      line-height: 0;
      border-radius: 0 0 calc(var(--cfc-u) * 3) calc(var(--cfc-u) * 3);
      clip-path: inset(2px 0 0 0); /* 固定值，不隨翻頁狀態變動：裁掉文字反鋸齒邊緣殘留在裁切線上的淺色像素 */
    }
    /* .rotor 容器本身的底色改用下半色（而不是跟 rotor-top 共用上半色）——
       這樣 rotor-bottom 被 clip-path 挖空後，露出來的正好是 .rotor 自己的底色，
       顏色天生就對，不需要再疊一層東西去蓋，也不用擔心疊色塊的 z-index 堆疊順序 */
    #cfc-flipdown .rotor { color: var(--cfc-color-top-text); background-color: var(--cfc-color-bottom-bg); }
    #cfc-flipdown .rotor-top,
    #cfc-flipdown .rotor-leaf-front { color: var(--cfc-color-top-text); background-color: var(--cfc-color-top-bg); }
    #cfc-flipdown .rotor-bottom,
    #cfc-flipdown .rotor-leaf-rear  { color: var(--cfc-color-bottom-text); background-color: var(--cfc-color-bottom-bg); }
    #cfc-flipdown .rotor:after {
      /* 中線黑線：純色塊填滿，不用 border-top（避免旁邊 3D 旋轉造成的反鋸齒不穩定）。
         粗細 2px、往下偏移 1px，數值是使用者用可調面板實測確認的。
         層級用 translateZ 而不是 z-index——父層 .rotor 是 preserve-3d 的 3D 空間，
         前後關係由 Z 軸深度決定，z-index 在這裡不起作用（這是先前黑線會在動畫途中被葉片蓋住、
         動畫結束才「跳」回最上層的原因）。葉片是繞中線這條軸旋轉的，旋轉軸上的點 Z 值恆為 0，
         黑線剛好在中線，所以只要 2px 的正向 Z 就足以永遠保持在葉片前面；
         透視放大幅度 800/798≈1.0025，可以忽略。 */
      content: '';
      position: absolute;
      left: 0;
      top: calc(50% + 1px);
      width: calc(var(--cfc-u) * 30); /* 240px，跟 rotor 同寬 */
      height: 2px;
      transform: translateY(-50%) translateZ(2px);
      background-color: #000;
      pointer-events: none;
    }

    /* ===== 依 phase 隱藏兩組欄位（同一時間只顯示相鄰兩組） ===== */
    /* rotor-group 產生順序固定：1=天 2=時 3=分 4=秒 */
    #cfc-flipdown[data-phase="day-hour"] .rotor-group:nth-child(3),
    #cfc-flipdown[data-phase="day-hour"] .rotor-group:nth-child(4) { display: none; }
    #cfc-flipdown[data-phase="hour-min"] .rotor-group:nth-child(1),
    #cfc-flipdown[data-phase="hour-min"] .rotor-group:nth-child(4) { display: none; }
    #cfc-flipdown[data-phase="min-sec"] .rotor-group:nth-child(1),
    #cfc-flipdown[data-phase="min-sec"] .rotor-group:nth-child(2) { display: none; }

    /* 消除間距的規則原本只認 DOM 上真正的 :last-child（秒），但「目前可見的最後一組」
       在 day-hour/hour-min 這兩個 phase 底下分別是「時」「分」，DOM 結構上它們後面還接著被
       隱藏的欄位，並不是 :last-child，會被誤判成「還要留間距給下一組」，多出一段看不見、
       但確實占用版面寬度的空間，導致整體時鐘的可視內容被推歪、看起來不置中。
       這裡用 phase 選擇器精準指定「這個 phase 下真正可見的最後一組」，強制清除它的間距。 */
    #cfc-flipdown[data-phase="day-hour"] .rotor-group:nth-child(2),
    #cfc-flipdown[data-phase="hour-min"] .rotor-group:nth-child(3) { padding-right: 0; }

    /* ===== 兩組可見欄位之間的閃爍冒號 =====
     * 目的：分／秒以外的欄位（天+時、時+分）翻頁間隔可能長達一分鐘以上，
     * 畫面會有很長一段時間完全靜止，使用者容易誤以為卡住了；加一個每秒閃爍的冒號，
     * 模擬一般數位時鐘的效果，持續給視覺回饋。
     * 用 phase 選擇器精準指定「目前可見的第一組欄位」的 ::before/::after 當作上下兩個圓點，
     * 不用通用的 :not(:last-child) —— 那樣會選到「可見欄位」跟「已隱藏欄位」之間也畫一個冒號，
     * 因為 :last-child 是看 DOM 結構、不是看目前可見與否。
     * 大小／位置不用猜測值：由 JS 在畫面建立時實際量測目前生效的字型（可能被使用者的字型替換
     * 腳本蓋掉）畫出「:」字元的真實尺寸，再量測轉輪跟標題的實際渲染高度算出數字視覺中心，
     * 寫入下面這些 CSS 變數；這裡的數值只是量測失敗時的保底預設值。 */
    #cfc-flipdown[data-phase="day-hour"] .rotor-group:nth-child(1)::before,
    #cfc-flipdown[data-phase="day-hour"] .rotor-group:nth-child(1)::after,
    #cfc-flipdown[data-phase="hour-min"] .rotor-group:nth-child(2)::before,
    #cfc-flipdown[data-phase="hour-min"] .rotor-group:nth-child(2)::after,
    #cfc-flipdown[data-phase="min-sec"] .rotor-group:nth-child(3)::before,
    #cfc-flipdown[data-phase="min-sec"] .rotor-group:nth-child(3)::after {
      content: '';
      position: absolute;
      right: var(--cfc-colon-right, calc(var(--cfc-u) * 6.5));
      width: var(--cfc-colon-dot-size, calc(var(--cfc-u) * 2));
      height: var(--cfc-colon-dot-size, calc(var(--cfc-u) * 2));
      border-radius: 50%;
      background: var(--cfc-color-colon);
      pointer-events: none;
      transform: translateY(-50%); /* top 值代表圓心座標，這裡才會真正置中在那個座標上，不是用 top 當方塊上緣 */
      /* 閃爍用 CSS animation：交給瀏覽器合成執行緒跑，主執行緒忙碌時不會被延後、誤差也不會累積。
         起點由 JS 在每次 _tick（翻頁鐘跳秒的同一時刻）切換 class 來校準，見 flipdownInstance._onTick。
         為什麼要準備兩組名字不同、內容相同的動畫：瀏覽器只有在「動畫名稱真的改變」時才會從頭播放；
         之前試過用 CSS 變數把 animation-name 設成 none 再還原，那被當成同一個動畫的屬性變更，
         播放進度會繼續走、不會重啟，所以完全沒有達到對時的效果。 */
      animation: cfc-colon-blink-a 1s linear infinite;
    }
    #cfc-flipdown.cfc-colon-b[data-phase="day-hour"] .rotor-group:nth-child(1)::before,
    #cfc-flipdown.cfc-colon-b[data-phase="day-hour"] .rotor-group:nth-child(1)::after,
    #cfc-flipdown.cfc-colon-b[data-phase="hour-min"] .rotor-group:nth-child(2)::before,
    #cfc-flipdown.cfc-colon-b[data-phase="hour-min"] .rotor-group:nth-child(2)::after,
    #cfc-flipdown.cfc-colon-b[data-phase="min-sec"] .rotor-group:nth-child(3)::before,
    #cfc-flipdown.cfc-colon-b[data-phase="min-sec"] .rotor-group:nth-child(3)::after {
      animation-name: cfc-colon-blink-b;
    }
    /* 實際時序（讀 vendored 原始碼 _updateClockValues 確認）：_tick 觸發後，函式庫是用
       setTimeout(..., 500) 延遲半秒才加上 flipped class 開始翻頁動畫的。所以一輪 1 秒裡：
         0~500ms   ＝ 畫面靜止（動畫還沒開始）
         500~1000ms＝ 翻頁動畫進行中
       要「動畫進行中不亮、靜止時才亮」，就是前半亮、後半暗。
       （之前誤以為 _tick 觸發即動畫開始，把亮暗寫反了，才會一直是相反的結果。）
       用「49.99%/50% 相鄰兩個關鍵影格」做硬切，不用 steps()——steps(1,end) 會把整段壓成單一階段、
       讓中間的 50% 完全失效（整秒都停在起始值，最後一刻才跳）。
       兩組 keyframes 內容必須完全一樣，差別只在名稱，純粹是為了觸發「重新播放」。 */
    @keyframes cfc-colon-blink-a {
      0%      { opacity: 1; }
      49.99%  { opacity: 1; }
      50%     { opacity: 0.15; }
      100%    { opacity: 0.15; }
    }
    @keyframes cfc-colon-blink-b {
      0%      { opacity: 1; }
      49.99%  { opacity: 1; }
      50%     { opacity: 0.15; }
      100%    { opacity: 0.15; }
    }
    /* 有顯示秒數（min-sec）時冒號固定不亮：秒數本身每秒都在跳動，已經有足夠的「還在動」的回饋，
       閃爍只在天+時、時+分這兩個看不到秒數、畫面長時間靜止的 phase 才需要。 */
    #cfc-flipdown[data-phase="min-sec"] .rotor-group:nth-child(3)::before,
    #cfc-flipdown[data-phase="min-sec"] .rotor-group:nth-child(3)::after,
    #cfc-flipdown.cfc-colon-b[data-phase="min-sec"] .rotor-group:nth-child(3)::before,
    #cfc-flipdown.cfc-colon-b[data-phase="min-sec"] .rotor-group:nth-child(3)::after {
      animation: none;
      opacity: 0.15;
    }
    #cfc-flipdown[data-phase="day-hour"] .rotor-group:nth-child(1)::before,
    #cfc-flipdown[data-phase="hour-min"] .rotor-group:nth-child(2)::before,
    #cfc-flipdown[data-phase="min-sec"] .rotor-group:nth-child(3)::before {
      top: calc(var(--cfc-colon-center, calc(var(--cfc-u) * 36)) - var(--cfc-colon-half-gap, calc(var(--cfc-u) * 6)));
    }
    #cfc-flipdown[data-phase="day-hour"] .rotor-group:nth-child(1)::after,
    #cfc-flipdown[data-phase="hour-min"] .rotor-group:nth-child(2)::after,
    #cfc-flipdown[data-phase="min-sec"] .rotor-group:nth-child(3)::after {
      top: calc(var(--cfc-colon-center, calc(var(--cfc-u) * 36)) + var(--cfc-colon-half-gap, calc(var(--cfc-u) * 6)));
    }

    /* ===== 我們自己的全螢幕外殼 ===== */
    /* --cfc-u 定義在這一層（外殼），往下會自然繼承給 #cfc-flipdown，兩邊共用同一套網格 */
    #cfc-overlay {
      --cfc-u: 0.41667vw; /* 1 網格單位 = 8px（基準寬度 1920px） */
      /* 顏色變數。--cfc-color-top-*／--cfc-color-bottom-* 是疊在轉輪方塊上的顏色，
         .cfc-theme-light 會覆蓋這兩組；其餘（標題／冒號／關閉鈕）都疊在下面這個遮罩本身
         固定不透明黑色的背景上，不隨主題變動，兩個主題共用同一組淺色配色。 */
      --cfc-color-top-bg: #1c1c1e;
      --cfc-color-top-text: #f5f5f5;
      --cfc-color-bottom-bg: #262628; /* rotor-bottom / rotor-leaf-rear 共用底色 */
      --cfc-color-bottom-text: #e8e8e8;
      --cfc-color-title: rgba(255,255,255,0.7);
      --cfc-color-colon: rgba(255,255,255,0.85);
      --cfc-color-close-text: rgba(255,255,255,0.8);
      --cfc-color-close-border: rgba(255,255,255,0.25);
      --cfc-color-close-bg: rgba(255,255,255,0.06);
      --cfc-color-close-bg-hover: rgba(255,255,255,0.16);
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(10, 10, 12, 0.85); /* 固定不透明黑色，不隨主題改變 */
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: calc(var(--cfc-u) * 4); /* 32px */
      -webkit-backdrop-filter: blur(16px);
      backdrop-filter: blur(16px);
    }
    /* 淺色主題：整組色彩變數覆蓋成白底黑字，遮罩本身的 background（上面那行）刻意不在這裡覆蓋，
       維持固定不透明黑色。 */
    /* 淺色主題只覆蓋「疊在轉輪方塊上」的顏色（上下半的底色與文字色）——
       標題文字、冒號圓點、關閉鈕，這三個都疊在遮罩本身固定不透明黑色的背景上，
       不是疊在轉輪的彩色方塊上，所以不該跟著主題切換，維持原本給深色背景看的淺色配色。 */
    #cfc-overlay.cfc-theme-light {
      --cfc-color-top-bg: #f5f5f5;
      --cfc-color-top-text: #1c1c1e;
      --cfc-color-bottom-bg: #e3e3e5;
      --cfc-color-bottom-text: #333336;
    }
    #cfc-overlay .cfc-title {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: calc(var(--cfc-u) * 2); /* 16px */
      color: var(--cfc-color-title);
      letter-spacing: 0.05em;
    }
    /* 預覽模式（還有額度，不是真的用盡）：標題改綠色，跟真的用盡的樣式做出區別 */
    #cfc-overlay.cfc-preview .cfc-title {
      color: rgba(74, 222, 128, 0.9); /* 柔和的綠色 */
    }
    /* 重置時間文字：外殼的 flex gap 是對所有子元素一視同仁的固定值，但「標題→色塊」這段距離
       其實還隔著「時/分」標籤本身的高度（112px），「色塊→這段文字」中間沒有對應的東西，
       兩邊視覺間距天生不對稱。額外補上等於標籤高度的 margin-top，讓兩邊看起來一樣寬。 */
    #cfc-overlay .cfc-reset-time {
      margin-top: calc(var(--cfc-u) * 14); /* 112px，等於 .rotor-group-heading:before 的高度 */
    }
    #cfc-overlay .cfc-close {
      position: absolute;
      bottom: calc(var(--cfc-u) * 3); /* 24px */
      right: calc(var(--cfc-u) * 4);  /* 32px */
      width: calc(var(--cfc-u) * 6);  /* 48px */
      height: calc(var(--cfc-u) * 6); /* 48px */
      box-sizing: border-box; /* 跟膠囊一致，明確宣告不依賴頁面全域設定 */
      border-radius: 50%;
      border: 1px solid var(--cfc-color-close-border);
      background: var(--cfc-color-close-bg);
      color: var(--cfc-color-close-text);
      font-size: calc(var(--cfc-u) * 3.5); /* 28px，圖示放大，圓圈維持 48px 不變 */
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease;
    }
    #cfc-overlay .cfc-close:hover { background: var(--cfc-color-close-bg-hover); }

    /* 主題切換膠囊開關：日／月圖示，放在右上角。
       邊距對齊規則：右邊距跟關閉鈕的右邊距相同（calc(*4)）；上邊距的數值等於關閉鈕的下邊距（calc(*3)）。
       尺寸：高度比照關閉鈕（48px），維持 2:1 比例，寬度 96px。
       thumb（實心圓＋圖示）疊在最上層滑動，另一側用淺灰色的靜態圖示提示「切過去會變成什麼」——
       這是 mockup 裡驗證過沒問題的結構，直接套用，不要再自己重新設計。 */
    #cfc-overlay .cfc-theme-toggle {
      position: absolute;
      top: calc(var(--cfc-u) * 3);   /* 24px，數值等於關閉鈕的 bottom */
      right: calc(var(--cfc-u) * 4); /* 32px，跟關閉鈕的 right 相同 */
      width: calc(var(--cfc-u) * 12);  /* 96px */
      height: calc(var(--cfc-u) * 6); /* 48px，跟關閉鈕同高 */
      box-sizing: border-box;
      border-radius: calc(var(--cfc-u) * 6);
      border: 1px solid var(--cfc-color-close-border);
      background: var(--cfc-color-close-bg);
      cursor: pointer;
      padding: 0;
      transition: background 0.15s ease;
    }
    #cfc-overlay .cfc-theme-toggle:hover { background: var(--cfc-color-close-bg-hover); }
    #cfc-overlay .cfc-theme-toggle-thumb {
      position: absolute;
      top: 50%;
      left: var(--cfc-toggle-far, 51px); /* 預設（深色主題）：thumb 停在右側。用 JS 量測膠囊實際渲染尺寸算出來，不是猜的 */
      transform: translateY(-50%);
      z-index: 2;
      width: var(--cfc-toggle-dot, 38px);  /* 邊距歸零、直徑＝膠囊實際高度，JS 量測後套用 */
      height: var(--cfc-toggle-dot, 38px);
      border-radius: 50%;
      background: var(--cfc-color-close-text);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: left 0.2s ease;
    }
    #cfc-overlay .cfc-theme-toggle-thumb svg { width: 20px; height: 20px; }
    /* 淺色主題啟用時：thumb 滑到左側 */
    #cfc-overlay.cfc-theme-light .cfc-theme-toggle-thumb {
      left: 0;
    }
    #cfc-overlay .cfc-theme-toggle-thumb .cfc-theme-toggle-icon-sun,
    #cfc-overlay .cfc-theme-toggle-thumb .cfc-theme-toggle-icon-moon {
      color: #1c1c1e; /* 固定深色，thumb 本身是淺色實心圓，圖示要用深色才有對比 */
      opacity: 0;
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      transition: opacity 0.15s ease;
    }
    #cfc-overlay .cfc-theme-toggle-thumb .cfc-theme-toggle-icon-moon { opacity: 1; } /* 深色主題（預設）：thumb 顯示月亮 */
    #cfc-overlay.cfc-theme-light .cfc-theme-toggle-thumb .cfc-theme-toggle-icon-sun { opacity: 1; }
    #cfc-overlay.cfc-theme-light .cfc-theme-toggle-thumb .cfc-theme-toggle-icon-moon { opacity: 0; }
    /* 未選中那端：淺灰色靜態圖示，淡淡提示切過去會變成什麼 */
    #cfc-overlay .cfc-theme-toggle-ghost {
      position: absolute;
      top: 50%;
      left: 0; /* 預設（深色主題）：ghost 顯示在左側（太陽，代表切過去會變淺色），邊距歸零 */
      transform: translateY(-50%);
      z-index: 1;
      width: var(--cfc-toggle-dot, 38px);
      height: var(--cfc-toggle-dot, 38px);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--cfc-color-close-text);
      opacity: 0.28;
      pointer-events: none;
      transition: left 0.2s ease;
    }
    #cfc-overlay .cfc-theme-toggle-ghost svg { width: 20px; height: 20px; }
    #cfc-overlay.cfc-theme-light .cfc-theme-toggle-ghost {
      left: var(--cfc-toggle-far, 51px); /* 淺色主題啟用時：ghost 換到右側，顯示月亮（代表切回去會變深色） */
    }
    #cfc-overlay .cfc-theme-toggle-ghost .cfc-theme-toggle-icon-sun { display: block; } /* 深色主題（預設）：ghost 顯示太陽，代表切過去會變淺色 */
    #cfc-overlay.cfc-theme-light .cfc-theme-toggle-ghost .cfc-theme-toggle-icon-sun { display: none; }
    #cfc-overlay .cfc-theme-toggle-ghost .cfc-theme-toggle-icon-moon { display: none; }
    #cfc-overlay.cfc-theme-light .cfc-theme-toggle-ghost .cfc-theme-toggle-icon-moon { display: block; } /* 淺色主題啟用時：ghost 顯示月亮，代表切回去會變深色 */

    /* 常駐開啟按鈕：不在 #cfc-overlay 底下（overlay 關閉時會整個被移除），直接掛在 body 上。
       位置基準是右下角，實際位置 = 基準位置 + 可調偏移量（--cfc-reopen-offset-x/y，預設 0），
       要微調位置直接改這兩個變數即可，不用動其他數值。 */
    :root {
      --cfc-reopen-offset-x: -7px; /* 正值往左移，負值往右移（因為是往 right 方向疊加） */
      --cfc-reopen-offset-y: -12px; /* 正值往上移，負值往下移（因為是往 bottom 方向疊加） */
    }
    #cfc-reopen {
      position: fixed;
      bottom: calc(var(--cfc-u, 0.41667vw) * 3 + var(--cfc-reopen-offset-y)); /* 基準 24px + 偏移 */
      right: calc(var(--cfc-u, 0.41667vw) * 4 + var(--cfc-reopen-offset-x));  /* 基準 32px + 偏移 */
      z-index: 2147483647;
      width: calc(var(--cfc-u, 0.41667vw) * 6);  /* 48px，維持點擊熱區大小 */
      height: calc(var(--cfc-u, 0.41667vw) * 6); /* 48px */
      background: transparent;
      border: none;
      color: #333; /* 深灰色圖示，不再用圓形底色 */
      font-size: calc(var(--cfc-u, 0.41667vw) * 3); /* 24px */
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.85;
      transition: opacity 0.15s ease;
    }
    #cfc-reopen:hover { opacity: 1; }
    @media (max-width: 640px) {
      #cfc-reopen { width: 40px; height: 40px; font-size: 16px; }
    }

    /* 手機版維持固定 px（不繼續跟 vw 縮小）——窄螢幕上 vw 換算出來的字級會小到看不清楚，
       這裡改成一組獨立的、同樣是 8px 網格倍數的「下限尺寸」 */
    @media (max-width: 640px) {
      #cfc-flipdown .rotor { width: 48px; height: 80px; font-size: 48px; margin-right: 8px; }
      #cfc-flipdown .rotor-top, #cfc-flipdown .rotor-bottom,
      #cfc-flipdown .rotor-leaf, #cfc-flipdown .rotor-leaf-front,
      #cfc-flipdown .rotor-leaf-rear, #cfc-flipdown .rotor:after { width: 48px; }
      #cfc-flipdown .rotor-leaf { height: 80px; }
      #cfc-flipdown .rotor-top, #cfc-flipdown .rotor-leaf-front { line-height: 80px; }
      #cfc-flipdown .rotor-top, #cfc-flipdown .rotor-bottom,
      #cfc-flipdown .rotor-leaf-front, #cfc-flipdown .rotor-leaf-rear { height: 40px; }
      #cfc-flipdown .rotor-group { padding-right: var(--cfc-group-gap, 24px); }
      #cfc-flipdown .rotor-group-heading:before { font-size: 16px; height: 24px; line-height: 24px; }
      /* 同樣的置中修正：手機版也要清除「目前可見最後一組」的間距（見桌面版註解），
         冒號圓點大小/位置不用另外寫死，JS 量測時會讀到手機版當下實際生效的字型跟尺寸。 */
      #cfc-flipdown[data-phase="day-hour"] .rotor-group:nth-child(2),
      #cfc-flipdown[data-phase="hour-min"] .rotor-group:nth-child(3) { padding-right: 0; }
      #cfc-overlay .cfc-close { width: 40px; height: 40px; font-size: 16px; bottom: 16px; right: 16px; }
      #cfc-overlay .cfc-theme-toggle { top: 16px; right: 16px; }
      #cfc-overlay .cfc-title { font-size: 16px; }
      #cfc-overlay .cfc-reset-time { margin-top: 24px; }
      #cfc-overlay { gap: 24px; }
    }
  `;
  document.head.appendChild(style);

  /* ------------------------------------------------------------
   * CFC 命名空間：我們自己的邏輯（phase 判斷、全螢幕外殼、開關）
   * ------------------------------------------------------------ */
  const CFC = (() => {
    let overlayEl = null;
    let flipdownInstance = null;
    let phaseTimer = null;
    let lastEpoch = null; // 記錄目前倒數的目標時間，關閉後重新開啟時要沿用同一個目標，不能歸零重算
    let lastIsPreview = false; // 連同預覽模式狀態一起記住，重新開啟時樣式才不會跑掉
    let reopenBtn = null; // 常駐的重新開啟按鈕（不隨 overlay 一起被移除）

    // 相鄰兩組欄位的切換門檻：>=1天 顯示「天+時」；>=1小時 顯示「時+分」；否則「分+秒」
    // 這是直接切換（無翻頁動畫）——原因：翻頁鐘的物理結構是「固定位置的轉輪」，
    // 欄位整組消失/出現不是轉輪能表現的動作，只有同一位置的數字變化才適合翻頁。
    function computePhase(remainingSeconds) {
      if (remainingSeconds >= 86400) return "day-hour";
      if (remainingSeconds >= 3600) return "hour-min";
      return "min-sec";
    }

    function updatePhase(epochSeconds) {
      if (!flipdownInstance) return;
      const remaining = Math.max(0, epochSeconds - Date.now() / 1000);
      const phase = computePhase(remaining);
      const el = document.getElementById("cfc-flipdown");
      if (el && el.getAttribute("data-phase") !== phase) {
        el.setAttribute("data-phase", phase);
      }
    }

    function ensureReopenBtn() {
      if (reopenBtn) return reopenBtn;
      reopenBtn = document.createElement("button");
      reopenBtn.id = "cfc-reopen";
      reopenBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5l3 2"/></svg>';
      reopenBtn.setAttribute("aria-label", "開啟額度冷卻倒數畫面");
      reopenBtn.addEventListener("click", () => {
        if (lastEpoch != null && lastEpoch - Date.now() / 1000 > 0) {
          show(lastEpoch, lastIsPreview); // 有進行中的倒數，沿用原本目標時間跟模式，不重新計算
        } else if (typeof target.__cfcManualCheck === "function") {
          target.__cfcManualCheck(); // 沒有進行中的倒數，改成即時查詢（跟 GM 選單同一套邏輯，含用量確認）
        }
      });
      document.body.appendChild(reopenBtn);
      return reopenBtn;
    }
    ensureReopenBtn(); // 常駐按鈕，腳本載入時就建立、預設顯示，不等第一次關閉才出現

    function close() {
      if (phaseTimer) {
        clearInterval(phaseTimer);
        phaseTimer = null;
      }
      if (flipdownInstance && flipdownInstance.countdown) {
        clearInterval(flipdownInstance.countdown);
      }
      flipdownInstance = null;
      if (overlayEl) {
        overlayEl.remove();
        overlayEl = null;
      }
      ensureReopenBtn().style.display = "flex"; // 常駐按鈕，關閉全螢幕畫面後一律顯示
    }

    // epochSeconds：目標時間（unix timestamp，秒）
    // isPreview：true＝還有額度（手動查詢時用量未達門檻），顯示「預覽」樣式；false／省略＝真的額度用盡
    function show(epochSeconds, isPreview) {
      close(); // 避免重複開啟（close() 內部的「留重新開啟按鈕」判斷這裡也會跑到，等等再蓋掉）
      lastEpoch = epochSeconds;
      lastIsPreview = !!isPreview;
      if (reopenBtn) reopenBtn.style.display = "none"; // 畫面開啟中，不需要重新開啟按鈕

      overlayEl = document.createElement("div");
      overlayEl.id = "cfc-overlay";
      if (isPreview) overlayEl.classList.add("cfc-preview");
      if (getCurrentTheme() === "light") overlayEl.classList.add("cfc-theme-light");

      const title = document.createElement("div");
      title.className = "cfc-title";
      title.textContent = isPreview ? "距離本輪額度重置時間還剩餘" : "額度已用盡，等待恢復中";
      overlayEl.appendChild(title);

      const clockEl = document.createElement("div");
      clockEl.id = "cfc-flipdown";
      clockEl.className = "flipdown";
      overlayEl.appendChild(clockEl);

      // 重置時間顯示：沿用標題的樣式（cfc-title），外殼本身已經用 flex + gap 控制間距、
      // align-items:center 自動置中，不需要另外用 JS 量測寬度去手動置中。
      const resetTimeEl = document.createElement("div");
      resetTimeEl.className = "cfc-title cfc-reset-time";
      resetTimeEl.textContent = "額度重計時間 " + formatResetTime(epochSeconds);
      overlayEl.appendChild(resetTimeEl);

      // 主題切換膠囊：日／月圖示，點擊切換深色／淺色，選擇會持久記住
      const themeToggle = document.createElement("button");
      themeToggle.className = "cfc-theme-toggle";
      themeToggle.setAttribute("aria-label", "切換深色／淺色主題");
      themeToggle.innerHTML =
        '<span class="cfc-theme-toggle-ghost">' +
        '<svg class="cfc-theme-toggle-icon-sun" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>' +
        '<svg class="cfc-theme-toggle-icon-moon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>' +
        "</span>" +
        '<span class="cfc-theme-toggle-thumb">' +
        '<svg class="cfc-theme-toggle-icon-sun" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>' +
        '<svg class="cfc-theme-toggle-icon-moon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>' +
        "</span>";
      themeToggle.addEventListener("click", () => {
        const next = overlayEl.classList.toggle("cfc-theme-light") ? "light" : "dark";
        setCurrentTheme(next);
      });
      overlayEl.appendChild(themeToggle);

      const closeBtn = document.createElement("button");
      closeBtn.className = "cfc-close";
      closeBtn.textContent = "\u2715"; // ✕
      closeBtn.setAttribute("aria-label", "關閉");
      closeBtn.addEventListener("click", close);
      overlayEl.appendChild(closeBtn);

      document.body.appendChild(overlayEl);
      applyToggleMetrics(); // 量測膠囊實際渲染出來的高度，算出圓圈直徑（＝膠囊高度，邊距歸零）跟靠右停駐位置

      const FlipDown = window.__CFC_FlipDown;
      flipdownInstance = new FlipDown(epochSeconds, "cfc-flipdown", {
        theme: "dark", // 我們的 CSS 已覆蓋配色，這裡只是滿足函式庫必填參數
        headings: ["天", "時", "分", "秒"],
      }).start();
      flipdownInstance.ifEnded(() => {
        setTimeout(() => close(), 5000); // 倒數歸零＝額度已恢復，延遲 5 秒讓使用者看到 00:00:00 再自動關閉
      });

      // 除錯掛鉤：暴露實例本體，方便 Console 直接操控（例如降速測試時覆寫 _getTime）
      target.__cfcInstance = flipdownInstance;

      applyColonMetrics(); // DOM 已經建好，量測目前實際生效的字型跟版面尺寸，套到冒號的 CSS 變數

      updatePhase(epochSeconds);
      phaseTimer = setInterval(() => updatePhase(epochSeconds), 1000);

      // 冒號閃爍跟數字跳動同步：掛在函式庫內部的 _tick（跳秒的核心函式，我們在 vendored 原始碼裡
      // 加了這個掛鉤點）上，每次跳秒就在兩組動畫之間切換，強制從頭播放一次。
      // 為什麼要這樣做：animation 本身由瀏覽器合成執行緒跑、節奏穩定，但起點如果不校準，
      // 跟數字跳動的相對關係是隨機的；每秒切換一次動畫名稱，播放起點就永遠對齊跳秒的那一刻。
      flipdownInstance._onTick = () => {
        const el = document.getElementById("cfc-flipdown");
        if (el) el.classList.toggle("cfc-colon-b");
      };
    }

    // 冒號圓點的大小／位置不用猜測值：實際量測目前生效的字型（可能被使用者的字型替換腳本蓋掉）
    // 畫出「:」字元的真實尺寸，再量測轉輪跟標題的實際渲染高度算出數字視覺中心。只需要在畫面
    // 建立時量一次（不同 phase 之間轉輪本身尺寸不變，只是顯示/隱藏切換，不用每次 phase 切換都重量）。
    // 膠囊裡圓圈的直徑跟位置不用猜測值：量測膠囊實際渲染出來的 clientHeight（已經是瀏覽器算好的
    // 內部可用高度，不用自己再去扣邊框、猜 box-sizing 怎麼算），直徑＝這個值、邊距＝0（圓圈頂滿
    // 膠囊上下緣），靠右停駐位置＝膠囊實際寬度－直徑。
    // 格式化重置時間：YYYY年M月D日 星期X HH:MM，用瀏覽器本地時區（跟倒數計時本身用的時間基準一致）
    function formatResetTime(epochSeconds) {
      const d = new Date(epochSeconds * 1000);
      const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
      const pad2 = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${weekdays[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }

    function applyToggleMetrics() {
      const pill = document.querySelector(".cfc-theme-toggle");
      if (!pill) return;
      const dot = pill.clientHeight; // 內部可用高度（不含邊框），直徑對齊這個值，圓圈才會頂滿上下緣不溢出
      const far = pill.clientWidth - dot; // 內部可用寬度（不含邊框）減去直徑，才是正確的靠右停駐位置
      pill.style.setProperty("--cfc-toggle-dot", dot + "px");
      pill.style.setProperty("--cfc-toggle-far", far + "px");
    }

    function applyColonMetrics() {
      const flipEl = document.getElementById("cfc-flipdown");
      const rotorTop = flipEl && flipEl.querySelector(".rotor-top");
      const headingEl = flipEl && flipEl.querySelector(".rotor-group-heading");
      const rotorEl = flipEl && flipEl.querySelector(".rotor");
      if (!flipEl || !rotorTop || !headingEl || !rotorEl) return;

      const cs = getComputedStyle(rotorTop);
      const fontSizePx = parseFloat(cs.fontSize) || 256;

      let dotSize, halfGap;
      try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        ctx.font = `${cs.fontWeight} ${fontSizePx}px ${cs.fontFamily}`;
        const m = ctx.measureText(":");
        // 用緊貼字形墨水邊緣的量測值（actualBoundingBox），不是含左右留白的總佔位寬度（m.width）——
        // 冒號字元的總佔位寬度比「一顆圓點的實際直徑」大上一截，直接拿來當圓點直徑會量出過大的結果。
        const inkWidth = (m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight || 0);
        const ascent = m.actualBoundingBoxAscent || fontSizePx * 0.35;
        const descent = m.actualBoundingBoxDescent || fontSizePx * 0.05;
        dotSize = Math.max(2, Math.round(inkWidth || fontSizePx * 0.09));
        // halfGap＝圓心到垂直中心的距離。ascent+descent 量到的是整個冒號字形（兩點＋中間空隙）
        // 的外緣到外緣高度，要再扣掉半顆圓點的半徑，才會是「圓心」而不是「外緣」的位置。
        halfGap = Math.max(dotSize * 0.6, Math.round((ascent + descent) / 2 - dotSize / 2));
      } catch (e) {
        console.warn("[Claude額度冷卻翻頁鐘] 量測冒號字型失敗，改用保底預設值:", e);
        dotSize = Math.round(fontSizePx * 0.09);
        halfGap = Math.round(fontSizePx * 0.16);
      }

      // 標題高度 + 半個轉輪高度＝數字在 rotor-group 這個容器裡的實際垂直視覺中心
      const headingHeight = headingEl.getBoundingClientRect().height;
      const rotorHeight = rotorEl.getBoundingClientRect().height;
      const centerOffset = headingHeight + rotorHeight / 2;

      // 整體間距（rotor-group 的 padding-right）不再是寫死的網格值，改成跟著圓點大小走：
      // 圓點本身 + 左右各留一個圓點直徑當呼吸空間，跟著字型大小一起動態縮放。
      const groupGap = Math.round(dotSize * 3);
      const rightOffset = Math.round((groupGap - dotSize) / 2);

      flipEl.style.setProperty("--cfc-colon-dot-size", dotSize + "px");
      flipEl.style.setProperty("--cfc-colon-half-gap", halfGap + "px");
      flipEl.style.setProperty("--cfc-colon-center", centerOffset + "px");
      flipEl.style.setProperty("--cfc-colon-right", rightOffset + "px");
      flipEl.style.setProperty("--cfc-group-gap", groupGap + "px");
    }

    return { show, close };
  })();

  /* ------------------------------------------------------------
   * Phase 2：偵測額度用完 + 自動觸發
   * ------------------------------------------------------------ */

  // 已知限制：這兩個 class 是 Tailwind 產生的工具類名，UI 改版時很可能失效，
  // 且目前沒有更穩定的 data-testid / aria-label 可用（已實際用檢查器確認過 DOM 結構）。
  // 依使用者明確指示：只判斷這段結構「存在與否」，不比對裡面的文字內容。
  const LIMIT_SELECTOR = "div.min-w-0.break-words > div.text-sm";

  let orgId = null;
  let limitActive = false; // 避免同一次額度用完期間，元件持續存在時重複觸發
  let checkDebounceTimer = null;

  const _origFetch = target.fetch.bind(target);
  target.fetch = function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0] instanceof Request ? args[0].url : "";
    onApiActivity(url);
    return _origFetch(...args);
  };
  const _origXHROpen = target.XMLHttpRequest.prototype.open;
  target.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (typeof url === "string") onApiActivity(url);
    return _origXHROpen.call(this, method, url, ...rest);
  };

  // 每次攔截到 claude.ai 自己發出的 org-scoped API 請求（聊天、送出訊息等大多數請求都走這個路徑前綴），
  // 才 debounce 檢查一次 DOM——取代原本全頁面持續 MutationObserver（串流輸出文字時 DOM 幾乎每個字都在變動，
  // 那樣會被觸發得非常頻繁）。順便取得 orgId（只需要成功一次）。
  function onApiActivity(url) {
    if (!url) return;
    const m = url.match(/\/api\/organizations\/([0-9a-f-]{36})/i);
    if (!m) return;
    if (!orgId) orgId = m[1];
    if (checkDebounceTimer) clearTimeout(checkDebounceTimer);
    checkDebounceTimer = setTimeout(checkLimitDom, 600);
  }

  function checkLimitDom() {
    const exists = !!document.querySelector(LIMIT_SELECTOR);
    if (exists && !limitActive) {
      handleLimitDetected();
    } else if (!exists && limitActive) {
      handleLimitCleared();
    }
  }

  // 依序嘗試三個端點（沿用既有腳本驗證過的做法），同時取得「短期視窗」（five_hour）跟
  // 「長期視窗」（seven_day）兩者的 resets_at 與 utilization——實際能不能送出訊息，
  // 兩個視窗都要有餘額才行，所以判斷「什麼時候能用」時兩個都要看，不能只看其中一個。
  async function fetchWindowsData() {
    if (!orgId && TOOLS.meter && TOOLS.meter.state.orgId) orgId = TOOLS.meter.state.orgId; // 用量模組在 document-start 就抓到了
    if (!orgId) return null;
    const endpoints = [ // 合併後改相對網址：同一個網站，測試夾具也打得到
      `/api/organizations/${orgId}/usage`,
      `/api/organizations/${orgId}/rate_limit_status`,
      `/api/organizations/${orgId}/limits`,
    ];
    for (const url of endpoints) {
      try {
        const res = await _origFetch(url, { credentials: "include", headers: { Accept: "application/json" } });
        if (res.status === 404 || !res.ok) continue;
        const data = await res.json();
        const windows = {};
        if (data && data.five_hour) {
          windows.five_hour = { resets_at: data.five_hour.resets_at, utilization: data.five_hour.utilization };
        }
        if (data && data.seven_day) {
          windows.seven_day = { resets_at: data.seven_day.resets_at, utilization: data.seven_day.utilization };
        }
        if (!windows.five_hour && !windows.seven_day && data && Array.isArray(data.rate_limits)) {
          for (const item of data.rate_limits) {
            const label = String(item.window_duration || item.type || "").toLowerCase();
            if (/5h|five.?hour|session/.test(label)) {
              windows.five_hour = { resets_at: item.resets_at || item.reset_at, utilization: item.utilization };
            }
            if (/7d|seven.?day|week/.test(label)) {
              windows.seven_day = { resets_at: item.resets_at || item.reset_at, utilization: item.utilization };
            }
          }
        }
        if (windows.five_hour || windows.seven_day) return windows;
      } catch (e) {
        console.warn("[Claude額度冷卻翻頁鐘] 查詢用量失敗:", url, e);
      }
    }
    return null;
  }

  function toEpoch(resetsAt) {
    if (resetsAt == null) return null;
    const t = typeof resetsAt === "string" ? new Date(resetsAt).getTime() / 1000 : resetsAt;
    return Number.isNaN(t) ? null : t;
  }

  // 真的被擋住時使用：判斷哪個視窗真的用盡。只有一個用盡就回報那個；
  // 兩個都用盡，回報時間離現在比較遠的那個（因為兩個視窗都要有餘額才能真正送出訊息）。
  // 如果兩個視窗的用量資料都不明確（欄位缺失、門檻抓不準），保守回報較遠的那個，
  // 避免使用者提早重試又再次被擋。
  function pickBlockedEpoch(windows) {
    const fh = windows.five_hour;
    const sd = windows.seven_day;
    const fhExhausted = fh && fh.utilization != null && fh.utilization >= EXHAUST_THRESHOLD_SHORT;
    const sdExhausted = sd && sd.utilization != null && sd.utilization >= EXHAUST_THRESHOLD_LONG;
    const fhEpoch = fh ? toEpoch(fh.resets_at) : null;
    const sdEpoch = sd ? toEpoch(sd.resets_at) : null;
    if (fhExhausted && sdExhausted) {
      const candidates = [fhEpoch, sdEpoch].filter((v) => v != null);
      return candidates.length ? Math.max(...candidates) : null;
    }
    if (fhExhausted && fhEpoch != null) return fhEpoch;
    if (sdExhausted && sdEpoch != null) return sdEpoch;
    const candidates = [fhEpoch, sdEpoch].filter((v) => v != null);
    return candidates.length ? Math.max(...candidates) : null;
  }

  // 還有額度時（預覽模式）優先回報短期視窗；短期視窗沒有 resets_at（用量 0% 時 API 回 null）
  // 就退回長期視窗，避免手動開啟時跳「沒有 resets_at」錯誤。
  function pickPreviewEpoch(windows) {
    const fh = windows.five_hour;
    const sd = windows.seven_day;
    const fhEpoch = fh ? toEpoch(fh.resets_at) : null;
    if (fhEpoch != null) return fhEpoch;
    return sd ? toEpoch(sd.resets_at) : null;
  }

  async function handleLimitDetected() {
    if (limitActive) return;
    limitActive = true;
    const windows = await fetchWindowsData();
    const epoch = windows ? pickBlockedEpoch(windows) : null;
    if (epoch != null) {
      saveReset(epoch);
      CFC.show(epoch, false);
    } else {
      console.warn("[Claude額度冷卻翻頁鐘] 偵測到額度用完，但取不到 resets_at，未顯示倒數畫面");
    }
  }

  function handleLimitCleared() {
    limitActive = false;
  }
  const RESET_KEY = "ccm:cfc:reset";   // 最近一次擋住時的重置時間（epoch 秒）；重新整理頁面也還在

  const limitFallbackTimer = setInterval(checkLimitDom, 60000); // 保底輪詢：避免提示出現當下剛好沒有任何 API 活動被攔截到而漏抓

  // 頁面載入當下也檢查一次，避免腳本注入時額度剛好已經用完、錯過第一次觸發
  checkLimitDom();

  // 手動觸發共用邏輯：查兩個視窗的資料，任一視窗用量到各自門檻就視為「真的用盡」，
  // 回報邏輯照 pickBlockedEpoch；否則視為「還有額度」，走 pickPreviewEpoch（預覽模式）。
  // 踩過的坑：原本只看短期視窗，5 小時 0%（resets_at=null）＋7 天 100% 時被判成預覽，
  // 又只讀短期視窗的 null，結果跳出「沒有 resets_at」錯誤。
  async function manualCheckAndShow() {
    const windows = await fetchWindowsData();
    if (!windows) {
      return "查不到用量資料：還沒抓到組織編號，等對話載入完再按一次"; // 合併後不跳 alert（會卡住頁面），改寫在面板上
    }
    const fh = windows.five_hour;
    const sd = windows.seven_day;
    const fhExhausted = !!(fh && fh.utilization != null && fh.utilization >= EXHAUST_THRESHOLD_SHORT);
    const sdExhausted = !!(sd && sd.utilization != null && sd.utilization >= EXHAUST_THRESHOLD_LONG);
    const looksBlocked = fhExhausted || sdExhausted;
    const epoch = looksBlocked ? pickBlockedEpoch(windows) : pickPreviewEpoch(windows);
    if (epoch == null) {
      return "查得到用量資料，但沒有重置時間";
    }
    limitActive = looksBlocked; // 合併前一律設 true：預覽時也被當成「擋住」，補送會以為還在冷卻
    if (looksBlocked) saveReset(epoch);
    CFC.show(epoch, !looksBlocked);
    return "";
  }
  target.__cfcManualCheck = manualCheckAndShow; // 讓 CFC 常駐按鈕（定義在檔案較前面、作用域不同）也能呼叫同一套邏輯

  // 手動觸發機制：萬一自動偵測失效（例如選擇器跟著 UI 改版失效），
  // 使用者可以從 Tampermonkey 圖示選單手動叫出倒數畫面，不用等自動偵測。
  // 合併後：Tampermonkey 選單（GM_registerMenuCommand）改成用量面板「額度冷卻」那一段的〔開啟倒數〕

  // ---- Phase 1 測試用掛鉤：Console 執行 __cfcTest(秒數) 立即開出假倒數 ----
  target.__cfcTest = function (secondsFromNow) {
    const epoch = Date.now() / 1000 + Number(secondsFromNow || 90);
    CFC.show(epoch);
  };
  target.__cfcClose = CFC.close;

  // 給其他模組用（用量模組的「額度重置後補送」）：重置時間、現在是不是擋住、查用量
  function saveReset(epoch) { try { localStorage.setItem(RESET_KEY, JSON.stringify(epoch)); } catch (e) { /* 存不了只少一個提示 */ } }
  function loadReset() { try { return JSON.parse(localStorage.getItem(RESET_KEY) || "0") || 0; } catch (e) { return 0; } }
  TOOLS.cooldown = {
    blocked: () => limitActive || !!document.querySelector(LIMIT_SELECTOR),
    resetAt: loadReset,
    // 實際查一次用量端點：兩個視窗都沒到門檻＝可以送；查不到回 null（不知道）
    canSend: async () => {
      const w = await fetchWindowsData();
      if (!w) return null;
      const used = (x, th) => !!(x && x.utilization != null && x.utilization >= th);
      const ok = !used(w.five_hour, EXHAUST_THRESHOLD_SHORT) && !used(w.seven_day, EXHAUST_THRESHOLD_LONG);
      if (!ok) { const e = pickBlockedEpoch(w); if (e != null) saveReset(e); }
      return ok;
    },
    markBlocked: () => { if (!limitActive) handleLimitDetected(); },
    open: manualCheckAndShow,
  };
  console.log("[ClaudeChatTools] 額度冷卻翻頁鐘已載入（測試：__cfcTest(秒數)）");
    });

    // ════════ 模組四：自動允許授權（面板開關，預設關）════════
    // 只按 claude.ai 畫面上「允許／拒絕」成對出現的那組按鈕；有「一律允許」類的優先按它（使用者：允許一次要反覆按、拖慢速度）。
    // 選擇器還沒看過真實畫面（使用者尚未截圖），所以用文字比對＋旁邊要有「拒絕」類按鈕，避免按到別的「允許」。
    whenReady(function () {
        const ALLOW_ALL = /^(一律允許此網站|一律允許|永遠允許|總是允許|全部允許|允許全部|始終允許|Always allow|Allow always|Allow all|Allow for this (chat|session|conversation))/i;
        const ALLOW_ONE = /^(允許|允許一次|Allow|Allow once)$/i;   // 比對 label() 的第一行
        const DENY = /拒絕|不允許|Deny|Don.t allow|Reject|Decline/i;
        const CHAT = /\/(?:chat|code)\/([\w-]{20,})/;
        const OWN = '.ccm-panel,.cho-dialog,.cho-toast,.cug-card';
        // 按鈕文字後面接著快捷鍵提示（「允許一次\nCtrl\n回车键 (⏎)\nEnter」），只取第一行
        const label = (b) => ((b.innerText || b.textContent || '').trim().split('\n')[0] || '').trim();
        // 授權卡可能是固定定位：offsetParent 會是 null，改用 getClientRects
        const shown = (b) => b && !b.disabled && b.getClientRects().length > 0;
        const DENY_SEL = 'button[aria-keyshortcuts="Escape"]';
        // v0.6.0：claude.ai 授權卡不接受 click() 也不接受模擬滑鼠（2026-11-14 實測：滑鼠 0.6 秒後卡片還在），只接受快捷鍵（卡片 aria-keyshortcuts：一律允許 Control+Shift+Enter、允許一次 Control+Enter）。
        // 送一次、等 0.6 秒看卡片有沒有消失；沒消失就記「代按失敗」、不再重試這張卡（不檢查 isTrusted，事件照收）。
        const gone = (box, pick) => !box.isConnected || !pick.isConnected || !shown(pick);
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        function keys(b) {
            const ks = (b.getAttribute('aria-keyshortcuts') || 'Control+Enter').split('+');
            const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true, ctrlKey: ks.includes('Control'), shiftKey: ks.includes('Shift'), altKey: ks.includes('Alt'), metaKey: ks.includes('Meta') };
            b.focus && b.focus();
            const t = document.activeElement || document;   // 只送一次：會冒泡到 document，兩邊都送會觸發兩次（可能按到下一張卡）
            t.dispatchEvent(new KeyboardEvent('keydown', o)); t.dispatchEvent(new KeyboardEvent('keyup', o));
        }
        async function done(box, pick, cm, M) {
            box.dataset.cctDone = '1';
            let up = box, what = '';
            // 往上找到第一段「不是按鈕」的文字（授權卡的說明，例如要讀哪個網站）
            for (let i = 0; up && i < 6 && !what; i++, up = up.parentElement) {
                const c = up.cloneNode(true); c.querySelectorAll('button').forEach(x => x.remove());
                what = (c.textContent || '').replace(/\s+/g, ' ').trim();
            }
            const name = label(pick);
            let how = '';
            try { keys(pick); } catch (e) { console.log('[ClaudeChatTools] 自動允許失敗', e); }
            await wait(600);
            if (gone(box, pick)) how = '快捷鍵';
            const key = 'allowlog:' + cm[1], logs = M.load(key, []);
            const d = new Date(), hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
            logs.push({ time: hm, what: name + '（' + (how || '代按失敗') + '）：' + what.slice(0, 40) }); M.save(key, logs.slice(-50));
            console.log('[ClaudeChatTools] 自動允許：', name, how || '代按失敗（卡片沒有消失）', what);
        }
        function scan() {
            const M = TOOLS.meter; if (!M || !M.opts().autoAllow) return;
            const cm = location.pathname.match(CHAT); if (!cm) return;
            // v0.5.2：照真實授權卡（2026-11-14 錄到）用屬性找：[data-approval-allow] 裡有「一律允許此網站」（含 [data-approval-lasting]）與「允許一次」（button[data-approval-primary]），旁邊的拒絕鈕 aria-keyshortcuts=Escape
            for (const g of document.querySelectorAll('[data-approval-allow]')) {
                if (g.closest(OWN)) continue;
                let box = g; for (let i = 0; box && i < 3 && !box.querySelector(DENY_SEL); i++) box = box.parentElement;
                if (!box || !box.querySelector(DENY_SEL) || box.dataset.cctDone) continue;
                const lasting = (box.querySelector('[data-approval-lasting]') || {}).closest?.('button');
                const pick = [lasting, box.querySelector('button[data-approval-primary]')].find(shown);
                if (pick) done(box, pick, cm, M);
            }
            // 備援：舊的文字比對（屬性改名時）
            for (const b of document.querySelectorAll('button')) {
                if (!shown(b) || b.closest(OWN) || b.closest('[data-approval-allow]')) continue;
                const t = label(b); if (!ALLOW_ALL.test(t) && !ALLOW_ONE.test(t)) continue;
                let box = b.parentElement;
                // 往上找最多 6 層、按鈕不超過 5 顆的容器：太大的容器（例如整頁）會把不相干的「允許」配到別處的「拒絕」
                for (let i = 0; box && i < 6; i++, box = box.parentElement) { const bs = box.querySelectorAll('button'); if (bs.length > 5) { box = null; break; } if ([...bs].some((x) => x !== b && DENY.test(label(x)))) break; }
                if (!box || box.dataset.cctDone) continue;
                const btns = [...box.querySelectorAll('button')].filter(shown);
                const pick = btns.find((x) => ALLOW_ALL.test(label(x))) || btns.find((x) => ALLOW_ONE.test(label(x)));
                if (pick) done(box, pick, cm, M);
            }
        }
        let tm = null;
        new MutationObserver(() => { if (tm) return; tm = setTimeout(() => { tm = null; try { scan(); } catch (e) { console.log('[ClaudeChatTools] 自動允許失敗', e); } }, 300); }).observe(document.body, { childList: true, subtree: true });
    });
})();
