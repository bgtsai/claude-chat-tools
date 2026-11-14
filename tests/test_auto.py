# 自動續做／交接就緒／自動允許授權／面板（v0.2.0）。用法：python3 test_auto.py ../ClaudeChatTools.user.js [壞版標記]
import re
import json,sys,urllib.request
from playwright.sync_api import sync_playwright
SRC=open(sys.argv[1]).read().replace('CTX_WAIT_MS: 30000','CTX_WAIT_MS: 2500')  # 測逾時用短一點
CID='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';BASE='http://127.0.0.1:8767'
CTX=lambda tot,msg:'## Context Usage\n\n**Model:** x  \n**Tokens:** %s / 1m (40%%)\n\n| Category | Tokens | Percentage |\n|---|---|---|\n| Messages | %s | 26.9%% |\n'%(tot,msg)
def T(*ms):
    out=[];prev="00000000-0000-4000-8000-000000000000"
    for i,(snd,txt,*tools) in enumerate(ms):
        c=[{"type":"text","text":txt}]+[{"type":"tool_use","input":{}} for _ in range(tools[0] if tools else 0)]
        out.append({"uuid":"u%d"%i,"parent_message_uuid":prev,"sender":snd,"content":c,"attachments":[]});prev="u%d"%i
    return {"current_leaf_message_uuid":prev,"chat_messages":out}
def put(t): urllib.request.urlopen(urllib.request.Request(BASE+'/x',data=json.dumps(t).encode(),method='POST')).read()
CONT=lambda est,left=2:'第③批好了。\n〔續做〕下一批：第④批；預估 %s 萬；剩 %d 批（含這批）'%(est,left)
def base(*extra): return T(('human','開始做'+'a'*350000),('human','/context'),('assistant',CTX('300k','150k')),*extra)
res={}
def chk(k,v,info=''): res[k]=res.get(k,True) and bool(v); print('  ','PASS' if v else 'FAIL',k,info)
def page(p,name,tree,opt=None,pre=''):
    put(tree);b=getattr(p,name).launch();ctx=b.new_context();pg=ctx.new_page()
    pg.goto(BASE+'/mode/x');put(tree)
    if opt is not None: pg.add_init_script("localStorage.setItem('ccm:opt',%s)"%json.dumps(json.dumps(opt)))
    pg.add_init_script(SRC)
    if pre: pg.add_init_script(pre)
    pg.goto(BASE+'/chat/'+CID);pg.wait_for_timeout(4000);return b,pg
sent=lambda pg:pg.evaluate('window.__sent||[]')
poke=lambda pg:(pg.evaluate("fetch('/v1/code/sessions/cse_TEST')"),pg.wait_for_timeout(3500))
with sync_playwright() as p:
  for name in ['chromium','firefox']:
    print(name)
    b,pg=page(p,name,base(('assistant',CONT(5))))
    s=sent(pg);chk('繼續',len(s)==1 and s[0].startswith('〔自動〕繼續（第 1 次）。') and '[ctx ' in s[0],s)
    poke(pg);chk('同一則只回一次',len(sent(pg))==1,sent(pg));b.close()
    b,pg=page(p,name,base(('assistant',CONT(60))))
    s=sent(pg);chk('到門檻停',len(s)==1 and s[0].startswith('〔自動〕停：現在 ') and '超過門檻 80%' in s[0] and '先歸檔，再準備交接內容，然後停下來等我。' in s[0],s);b.close()
    b,pg=page(p,name,base(('assistant',CONT(60))),opt={'thr':0.85})
    s=sent(pg);chk('85% 只記草稿',len(s)==1 and '記好草稿與進度' in s[0] and '超過門檻 85%' in s[0],s);b.close()
    many=[x for i in range(15) for x in (('assistant',CONT(1,9)),('human','〔自動〕繼續（第 %d 次）。'%(i+1)))]
    b,pg=page(p,name,base(*many,('assistant',CONT(1,9))),opt={'onStop':'archive'})
    s=sent(pg);chk('連續上限',len(s)==1 and '已經連續自動續做 15 次' in s[0] and '記好草稿與進度' in s[0],s);b.close()
    b,pg=page(p,name,base(('assistant',CONT(5))),pre="document.addEventListener('DOMContentLoaded',()=>{document.querySelector('[data-testid=chat-input]').innerText='打到一半'})")
    chk('打字中不送',sent(pg)==[],sent(pg));b.close()
    # 離門檻近、沒有新校正 → 先 /context，輸出出現後補送
    t0=T(('human','a'*350000),('human','/context'),('assistant',CTX('300k','150k')),('human','做吧'),('assistant',CONT(48)))
    b,pg=page(p,name,t0)
    s=sent(pg);chk('近門檻先送 /context',s==['/context'],s)
    put(T(*[(m['sender'],m['content'][0]['text']) for m in t0['chat_messages']],('human','/context'),('assistant',CTX('700k','550k'))));poke(pg)
    s=sent(pg);chk('/context 後補送',len(s)==2 and s[1].startswith('〔自動〕') and '已校正用量。' in s[1],s);b.close()
    b,pg=page(p,name,t0);pg.wait_for_timeout(3500);poke(pg)
    s=sent(pg);chk('/context 逾時照送',len(s)==2 and '（校正失敗，用估算）' in s[1],s);b.close()
    # 交接就緒
    op='讀完 01 之後：接續 X。'
    rdy=lambda n:'寫好了。\n〔交接就緒〕開場白 %d 字\n```\n%s\n```'%(n,op)
    b,pg=page(p,name,base(('assistant',rdy(len(op)))),opt={'autoHandoff':True},pre="localStorage.setItem('ccm:await:%s','1')"%CID)
    chk('自動交接有啟動',pg.evaluate("!!document.querySelector('.cho-toast')&&document.querySelector('.cho-toast').innerText.includes('自動交接沒有執行')"));b.close()
    b,pg=page(p,name,base(('assistant',rdy(len(op)+1))),opt={'autoHandoff':True},pre="localStorage.setItem('ccm:await:%s','1')"%CID)
    chk('字數不對不動作',pg.evaluate("!document.querySelector('.cho-toast')&&window.__ccm.err&&window.__ccm.err.includes('交接就緒')"));b.close()
    b,pg=page(p,name,base(('assistant',rdy(len(op)))))
    chk('關著亮「可以交接了」',pg.evaluate("document.querySelector('.cho-btn').textContent.trim()")=='可以交接了');b.close()
    # 手動交接：await=manual 時，自動交接開關關著也接著開新串；等待中按鈕顯示「交接準備中…」
    b,pg=page(p,name,base(('assistant',rdy(len(op)))),pre="localStorage.setItem('ccm:await:%s','\"manual\"')"%CID)
    chk('手動交接請求後自動接續',pg.evaluate("!!document.querySelector('.cho-toast')&&document.querySelector('.cho-toast').innerText.includes('自動交接沒有執行')"));b.close()
    b,pg=page(p,name,base(('assistant','做中')),pre="localStorage.setItem('ccm:await:%s','\"manual\"')"%CID)
    chk('等待中按鈕文字',pg.evaluate("document.querySelector('.cho-btn').textContent.trim()")=='交接準備中…',pg.evaluate("document.querySelector('.cho-btn').textContent.trim()"));b.close()
    # 自動允許
    box="document.addEventListener('DOMContentLoaded',()=>{const d=document.createElement('div');d.innerHTML='<p>Claude 要讀取 bgtsai/x</p><button onclick=\"window.__c=(window.__c||[]).concat(1)\">允許一次</button><button onclick=\"window.__c=(window.__c||[]).concat(2)\">一律允許</button><button>拒絕</button>';document.body.append(d);const e=document.createElement('div');e.innerHTML='<button onclick=\"window.__c=(window.__c||[]).concat(9)\">Allow</button>';document.body.append(e)})"
    b,pg=page(p,name,base(),opt={'autoAllow':True},pre=box)
    chk('優先按一律允許、沒有拒絕鈕的不按',pg.evaluate('window.__c||[]')==[2],pg.evaluate('window.__c||[]'))
    chk('記錄',pg.evaluate("JSON.parse(localStorage.getItem('ccm:allowlog:%s')||'[]').length"%CID)==1);b.close()
    b,pg=page(p,name,base(),pre=box)
    chk('預設關不按',pg.evaluate('window.__c||[]')==[]);b.close()
    # v0.5.2：照真實授權卡（固定定位、按鈕文字帶快捷鍵提示、用 data-approval-* 屬性）
    real="document.addEventListener('DOMContentLoaded',()=>{const d=document.createElement('div');d.style.cssText='position:fixed;bottom:0;left:0';d.innerHTML='<div><p>Claude 想讀取 www.example.com</p><div><span><span><button type=\"button\" aria-keyshortcuts=\"Escape\" data-approval-variant=\"secondary\" onclick=\"window.__c=(window.__c||[]).concat(0)\">拒絕<kbd style=\\\"display:block\\\">Esc</kbd></button></span></span><div data-approval-allow=\"\"><button type=\"button\" aria-keyshortcuts=\"Control+Shift+Enter\" onclick=\"window.__c=(window.__c||[]).concat(2)\"><span data-approval-digit=\"2\" data-approval-lasting=\"\">一律允許此網站</span><kbd style=\\\"display:block\\\">Ctrl</kbd><kbd style=\\\"display:block\\\">Enter</kbd></button><button type=\"button\" data-approval-primary=\"\" aria-keyshortcuts=\"Control+Enter\" onclick=\"window.__c=(window.__c||[]).concat(1)\"><span data-approval-digit=\"3\">允許一次</span><kbd style=\\\"display:block\\\">Ctrl</kbd><kbd style=\\\"display:block\\\">Enter</kbd></button></div></div></div>';document.body.append(d)})"
    b,pg=page(p,name,base(),opt={'autoAllow':True},pre=real)
    lg=pg.evaluate("JSON.parse(localStorage.getItem('ccm:allowlog:%s')||'[]')"%CID)
    chk('真實授權卡：按一律允許此網站一次',pg.evaluate('window.__c||[]')==[2] and len(lg)==1 and '一律允許此網站' in lg[0]['what'] and 'example.com' in lg[0]['what'],[pg.evaluate('window.__c||[]'),lg]);b.close()
    real1=re.sub(r'<button[^>]*Control\+Shift\+Enter.*?</button>','',real)
    assert real1!=real
    b,pg=page(p,name,base(),opt={'autoAllow':True},pre=real1)
    chk('真實授權卡：沒有一律允許就按允許一次',pg.evaluate('window.__c||[]')==[1],pg.evaluate('window.__c||[]'));b.close()
    b,pg=page(p,name,base(),opt={'allowRec':True},pre=box)
    pg.wait_for_timeout(800);r=pg.evaluate("JSON.parse(localStorage.getItem('ccm:allowrec')||'[]')")
    chk('錄製：只錄不按',pg.evaluate('window.__c||[]')==[] and len(r)==4 and '一律允許' in r[1]['box'] and r[1]['url'].startswith('/'),[len(r),pg.evaluate('window.__c||[]')]);b.close()
    # 手動〔校正〕後也補送
    b,pg=page(p,name,base(('assistant','好')))
    pg.click('#ccm-badge');pg.wait_for_timeout(300);pg.click('.ccm-calib');pg.wait_for_timeout(2500)
    s0=sent(pg);put(base(('assistant','好'),('human','/context'),('assistant',CTX('420k','260k'))));poke(pg)
    s=sent(pg);chk('手動校正後補送',s0==['/context'] and len(s)==2 and s[1].startswith('〔自動〕已校正用量（手動校正）。') and '[ctx 42%' in s[1],s);b.close()
    b,pg=page(p,name,base(('assistant','好')))
    pg.click('#ccm-badge');pg.wait_for_timeout(300);pg.click('.ccm-calib');pg.wait_for_timeout(3500);poke(pg);pg.wait_for_timeout(4000)
    s=sent(pg);chk('手動校正逾時照送',len(s)==2 and '校正失敗，用估算（手動校正）' in s[1],s);b.close()
    # 一般自動校正（還沒校正過）後也補送（v0.3.1）
    t1=T(('human','開始做'),('assistant','好'))
    b,pg=page(p,name,t1)
    s0=sent(pg);put(T(('human','開始做'),('assistant','好'),('human','/context'),('assistant',CTX('200k','80k'))));poke(pg)
    s=sent(pg);chk('自動校正後補送',s0==['/context'] and len(s)==2 and s[1].startswith('〔自動〕已校正用量（自動校正）。') and '[ctx ' in s[1],s);b.close()
    # 〔建議交接〕（v0.4.0）：只看自動交接開關；腳本不再用公式自己判斷
    SUG='第②批好了。\n〔建議交接〕目前 50%，下一階段約 40 次工具呼叫，換新對話串約 12 次後回本。'
    hi=lambda *x:T(('human','開始做'+'a'*350000),('human','/context'),('assistant',CTX('500k','350k')),*x)   # 50%：舊公式會判「建議換」
    btn="document.querySelector('.cho-btn').textContent.trim()"
    b,pg=page(p,name,hi(('assistant','好')))
    chk('沒有〔建議交接〕不亮藍燈',pg.evaluate("!document.querySelector('.ccm-strip')||!document.querySelector('.ccm-strip').dataset.kind") and '建議換串' not in pg.inner_text('#ccm-badge'),pg.inner_text('#ccm-badge'));b.close()
    b,pg=page(p,name,hi(('assistant',SUG)))
    chk('開關關：只亮按鈕不代送',sent(pg)==[] and pg.evaluate(btn)=='建議交接' and '建議換串' in pg.inner_text('#ccm-badge') and pg.evaluate("document.querySelector('.ccm-strip').dataset.kind")=='blue',[sent(pg),pg.evaluate(btn)]);b.close()
    b,pg=page(p,name,hi(('assistant',SUG)),opt={'autoHandoff':True})
    s=sent(pg);poke(pg);s2=sent(pg)
    chk('開關開：代送交接請求、只送一次',len(s)==1 and s[0].startswith('〔自動〕請歸檔、準備交接內容') and s2==s and pg.evaluate("[localStorage.getItem('ccm:await:%s'),localStorage.getItem('ccm:ahn')]"%CID)==['"suggest"','1'] and pg.evaluate(btn)=='交接準備中…',[s2,pg.evaluate(btn)]);b.close()
    b,pg=page(p,name,hi(('assistant',SUG),('human','/context'),('assistant',CTX('510k','360k'))),opt={'autoHandoff':True})
    chk('/context 輸出蓋不掉建議、但不會晚一則才觸發',sent(pg)==[] and '建議換串' in pg.inner_text('#ccm-badge'),sent(pg));b.close()
    b,pg=page(p,name,hi(('assistant',SUG)),opt={'autoHandoff':True},pre="localStorage.setItem('ccm:ahn','5')")
    chk('連續自動交接上限：不代送',sent(pg)==[] and pg.evaluate(btn)=='建議交接',sent(pg));b.close()
    b,pg=page(p,name,hi(('assistant',SUG)),opt={'autoHandoff':True,'onStop':'archive'})
    chk('停下來時不是歸檔交接：開關算關',sent(pg)==[],sent(pg));b.close()
    op2='讀完 01 之後：接續 Y。'
    b,pg=page(p,name,base(('assistant','寫好了。\n〔交接就緒〕開場白 %d 字\n```\n%s\n```'%(len(op2),op2))),pre="localStorage.setItem('ccm:await:%s','\"suggest\"')"%CID)
    chk('suggest 請求後〔交接就緒〕接著開新串',pg.evaluate("!!document.querySelector('.cho-toast')&&document.querySelector('.cho-toast').innerText.includes('自動交接沒有執行')"));b.close()
    # 面板
    b,pg=page(p,name,base(('assistant','好')))
    pg.click('#ccm-badge');pg.wait_for_timeout(300)
    chk('面板三段',pg.evaluate("['.ccm-sec-cont','.ccm-sec-handoff','.ccm-sec-allow'].every(x=>document.querySelector('.ccm-panel '+x))"))
    pg.click('.ccm-sec-cont .ccm-seg button[data-v="0.85"]');pg.wait_for_timeout(300)
    chk('85% 停用歸檔選項',pg.evaluate("[...document.querySelectorAll('.ccm-sec-cont .ccm-seg')[1].querySelectorAll('button')].map(x=>x.getAttribute('aria-disabled')||'')")==['','true','true'])
    chk('85% 時自動交接停用',pg.evaluate("document.querySelector('.ccm-sec-handoff [role=switch]').getAttribute('aria-disabled')")=='true')
    pg.screenshot(path='/tmp/auto_panel_%s.png'%name,clip={'x':0,'y':0,'width':500,'height':700});b.close()
print('全部通過' if all(res.values()) else '有失敗')
