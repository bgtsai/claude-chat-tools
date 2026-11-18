# v0.7.0：額度冷卻翻頁鐘併入＋額度重置後補送。用法：python3 test_cool.py ../ClaudeChatTools.user.js
import json,sys,time,urllib.request
from playwright.sync_api import sync_playwright
SRC=open(sys.argv[1]).read()
CID='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';BASE='http://127.0.0.1:8767'
CTX=lambda tot,msg:'## Context Usage\n\n**Model:** x  \n**Tokens:** %s / 1m (40%%)\n\n| Category | Tokens | Percentage |\n|---|---|---|\n| Messages | %s | 26.9%% |\n'%(tot,msg)
def T(*ms):
    out=[];prev="00000000-0000-4000-8000-000000000000"
    for i,(snd,txt) in enumerate(ms):
        out.append({"uuid":"u%d"%i,"parent_message_uuid":prev,"sender":snd,"content":[{"type":"text","text":txt}],"attachments":[]});prev="u%d"%i
    return {"current_leaf_message_uuid":prev,"chat_messages":out}
def post(path,body): urllib.request.urlopen(urllib.request.Request(BASE+path,data=body.encode(),method='POST')).read()
put=lambda t:post('/x',json.dumps(t))
USE=lambda u:post('/usage',json.dumps({"five_hour":{"resets_at":"2020-01-01T00:00:00Z","utilization":u},"seven_day":{"resets_at":"2020-01-02T00:00:00Z","utilization":10}}))
CONT='第③批好了。\n〔續做〕下一批：第④批；預估 1 萬；剩 2 批（含這批）'
TREE=T(('human','開始做'),('human','/context'),('assistant',CTX('300k','150k')),('assistant',CONT))
LIMIT="document.addEventListener('DOMContentLoaded',()=>{const a=document.createElement('div');a.className='min-w-0 break-words';a.id='lim';a.innerHTML='<div class=\"text-sm\">已達用量上限</div>';document.body.append(a)});"
res={}
def chk(k,v,info=''): res[k]=res.get(k,True) and bool(v); print('  ','PASS' if v else 'FAIL',k,info)
def page(p,name,tree,pre='',opt=None):
    put(tree);b=getattr(p,name).launch();pg=b.new_context().new_page()
    pg.goto(BASE+'/mode/x');put(tree)
    if opt is not None: pg.add_init_script("localStorage.setItem('ccm:opt',%s)"%json.dumps(json.dumps(opt)))
    pg.add_init_script(SRC)
    if pre: pg.add_init_script(pre)
    pg.goto(BASE+'/chat/'+CID);pg.wait_for_timeout(4000);return b,pg
sent=lambda pg:pg.evaluate('window.__sent||[]')
pend=lambda pg:pg.evaluate("JSON.parse(localStorage.getItem('ccm:pend:%s')||'null')"%CID)
def unblock(pg): pg.evaluate("document.getElementById('lim')&&document.getElementById('lim').remove();localStorage.setItem('ccm:cfc:reset','1')")
with sync_playwright() as p:
  for name in ['chromium','firefox']:
    print(name); USE(100)
    # 1 冷卻中：〔續做〕不送，記成待補送
    b,pg=page(p,name,TREE,LIMIT)
    pd=pend(pg)
    chk('冷卻中不送',sent(pg)==[],sent(pg)); chk('記成待補送',pd and pd['text'].startswith('〔自動〕') and pd['after']=='u3',pd)
    # 2 還沒恢復（用量 100%）：不補送、排下一次
    unblock(pg); pg.evaluate('window.__ccmRetry(true)'); pg.wait_for_timeout(2500)
    chk('用量還沒恢復不補送',sent(pg)==[] and (pend(pg) or {}).get('next',0)>0,sent(pg))
    # 3 恢復：補送一次、清掉待補送
    USE(5); pg.evaluate('window.__ccmRetry(true)'); pg.wait_for_timeout(4500)
    s=sent(pg); chk('恢復後補送',len(s)==1 and s[0].startswith('〔自動〕'),s); chk('補送後清掉',pend(pg) is None)
    pg.evaluate('window.__ccmRetry(true)'); pg.wait_for_timeout(2000); chk('只補一次',len(sent(pg))==1,sent(pg)); b.close()
    # 4 重置時間還沒到：不補送
    USE(5); b,pg=page(p,name,TREE,LIMIT)
    pg.evaluate("document.getElementById('lim').remove();localStorage.setItem('ccm:cfc:reset',String(Date.now()/1000+3600))"); pg.evaluate('window.__ccmRetry(false)'); pg.wait_for_timeout(2500)
    chk('重置時間還沒到不送',sent(pg)==[] and pend(pg) is not None,sent(pg)); b.close()
    # 5 對話已經往下走：不補送、丟掉
    b,pg=page(p,name,TREE,LIMIT); unblock(pg)
    put(T(('human','開始做'),('human','/context'),('assistant',CTX('300k','150k')),('assistant',CONT),('human','我自己回了'),('assistant','好，我接著做。')))
    pg.evaluate('window.__ccmRetry(true)'); pg.wait_for_timeout(3500)
    chk('對話往下走不補送',not [x for x in sent(pg) if x.startswith('〔自動〕')] and pend(pg) is None,sent(pg)); b.close()
    # 6 開關關：不補送
    b,pg=page(p,name,TREE,LIMIT,opt={'autoResend':False}); unblock(pg); pg.evaluate('window.__ccmRetry(true)'); pg.wait_for_timeout(3000)
    chk('補送關著不送',sent(pg)==[] and pend(pg) is not None,sent(pg)); b.close()
    # 7 送出後輸入框沒清空、用量 100%：清掉輸入框、記成待補送
    USE(100)
    NOSEND="document.addEventListener('DOMContentLoaded',()=>{const b=document.querySelector('[data-testid=chat-input-send]');b.onclick=()=>{}})"
    b,pg=page(p,name,TREE,NOSEND); pg.wait_for_timeout(2000)
    pd=pend(pg); chk('送不出去記成待補送',pd and pd['why']=='送出後沒清空',pd)
    chk('輸入框清掉',pg.evaluate("document.querySelector('[data-testid=chat-input]').innerText.trim()")=='')
    b.close()
    # 8 翻頁鐘＋面板
    USE(100); b,pg=page(p,name,T(('human','x'),('assistant','好')))
    pg.evaluate("window.__cfcTest(90)"); pg.wait_for_timeout(800)
    chk('翻頁鐘開得起來',pg.evaluate("!!document.getElementById('cfc-overlay')"))
    pg.evaluate("window.__cfcClose()")
    chk('主題存 localStorage（沒有 GM_）','GM_getValue' not in SRC and 'ccm:cfc:theme' in SRC)
    pg.click('#ccm-badge');pg.wait_for_timeout(300)
    chk('面板有額度冷卻一段',pg.evaluate("!!document.querySelector('.ccm-panel .ccm-sec-cool [role=switch]')&&document.querySelector('.ccm-sec-cool [role=switch]').getAttribute('aria-checked')==='true'"))
    pg.click('.ccm-cool-open');pg.wait_for_timeout(1500)
    chk('〔開啟倒數〕查用量後開出倒數',pg.evaluate("!!document.getElementById('cfc-overlay')"))
    pg.screenshot(path='/tmp/cool_%s.png'%name);b.close()
print('全部通過' if all(res.values()) else '有失敗')
