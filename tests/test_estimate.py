# v0.5.0：估算從最近校正起算、壓縮後的 k、每漲 10% 自動校正、〔續做〕前校正太舊先校正、〔量用量〕。
# 用法：python3 test_estimate.py ../ClaudeChatTools.user.js [壞版名稱]（先 python3 server.py &）
import json,os,sys,urllib.request
from playwright.sync_api import sync_playwright
SRC=open(sys.argv[1],encoding='utf-8').read().replace('CTX_WAIT_MS: 30000','CTX_WAIT_MS: 2500')
MUT={  # 改壞版：每一條新規則各拿掉一次，對應的測試要 FAIL
 'old_formula':[('const C = calib ? calib.total + k * (estNow - calib.before) : fixed + k * estNow;','const C = fixed + k * estNow;'),
                ("const k = calib ? kc.k : (g && g.k ? g.k : CFG.DEFAULT_K);","const k = calib ? calib.k : (g && g.k ? g.k : CFG.DEFAULT_K);")],
 'every_low_is_cut':[("(c.messages < cals[i - 1].messages * CFG.COMPACT_DROP || (low(c) && !low(cals[i - 1])))","(c.messages < cals[i - 1].messages * CFG.COMPACT_DROP || low(c))")],
 'no_measure':[('        if (handleMeasure(cid, trunk)) return true;\n','')],
 'no_stale':[('(near || !calib || stale)','(near || !calib)')],
 'old_recheck':[('(calib && pct - calib.total / calib.win >= CFG.AUTO_RECHECK_STEP)','(calib && pct >= 0.65 && calib.total / calib.win < 0.60)')],
 'save_borrowed_k':[("kc.trusted ? { fixed: calib.fixed, k: kc.k,","true ? { fixed: calib.fixed, k: kc.k,")],
 'borrowed_default_k':[("{ ...(g || {}), fixed: calib.fixed,","{ ...(g || { k: CFG.DEFAULT_K }), fixed: calib.fixed,")],
}
if len(sys.argv)>2:
    for a,b in MUT[sys.argv[2]]: assert SRC.count(a)==1,a; SRC=SRC.replace(a,b)
CID='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';BASE='http://127.0.0.1:8767'
CTX=lambda tot,msg:'## Context Usage\n\n**Model:** x  \n**Tokens:** %s / 1m (40%%)\n\n| Category | Tokens | Percentage |\n|---|---|---|\n| Messages | %s | 26.9%% |\n'%(tot,msg)
def T(*ms):
    out=[];prev="00000000-0000-4000-8000-000000000000"
    for i,(snd,txt) in enumerate(ms):
        out.append({"uuid":"u%d"%i,"parent_message_uuid":prev,"sender":snd,"content":[{"type":"text","text":txt}],"attachments":[]});prev="u%d"%i
    return {"current_leaf_message_uuid":prev,"chat_messages":out}
def put(t): urllib.request.urlopen(urllib.request.Request(BASE+'/x',data=json.dumps(t).encode(),method='POST')).read()
X=lambda n:'a'*int(n*3.5)                      # n 個估算 token
Y=lambda n:'y'*int(n*3.5)
CAL=lambda tot,msg:(('human','/context'),('assistant',CTX(tot,msg)))
CONT='\n〔續做〕下一批：第②批；預估 5 萬；剩 2 批（含這批）'
res={}
def chk(k,v,info=''): res[k]=res.get(k,True) and bool(v); print('  ','PASS' if v else 'FAIL',k,info)
def page(p,name,tree,pre=''):
    put(tree);b=getattr(p,name).launch();pg=b.new_context().new_page()
    pg.goto(BASE+'/mode/x');put(tree);pg.add_init_script(SRC)
    if pre: pg.add_init_script(pre)
    pg.goto(BASE+'/chat/'+CID);pg.wait_for_timeout(4000);return b,pg
last=lambda pg:pg.evaluate('window.__ccm.last')
sent=lambda pg:pg.evaluate('window.__sent||[]')
poke=lambda pg:(pg.evaluate("fetch('/v1/code/sessions/cse_TEST')"),pg.wait_for_timeout(3500))
gk=lambda pg:pg.evaluate("(JSON.parse(localStorage.getItem('ccm:lastCalib')||'null')||{}).k")
with sync_playwright() as p:
  for name in (os.environ.get('ENGINES') or 'chromium firefox').split():   # 改壞版反證時可只跑一個引擎
    print(name)
    # 1. 沒壓縮：跟舊算法一樣（k＝訊息÷之前的估算）
    b,pg=page(p,name,T(('human',X(100000)),*CAL('300k','150k'),('assistant',Y(10000))));L=last(pg)
    chk('沒壓縮 k 不變',abs(L['k']-1.5)<0.01 and not L['compacted'] and 315000<L['C']<316000,[L['k'],L['C']]);b.close()
    # 2. 壓縮後第一次校正：沿用壓縮前的 k，從新總量起算；借來的 k 不存成其他串的參考
    t2=(('human',X(100000)),*CAL('300k','150k'),('human',X(100000)),*CAL('250k','60k'))
    b,pg=page(p,name,T(*t2,('assistant',Y(10000))));L=last(pg)
    chk('壓縮後沿用壓縮前的 k',abs(L['k']-1.5)<0.01 and L['compacted'] and L['kSrc']=='壓縮前的校正' and 265000<L['C']<266000,[L['k'],L['kSrc'],L['C']])
    chk('借來的 k 不存',gk(pg) is None,gk(pg));b.close()
    # 3. 壓縮後又校正一次：用兩次校正的差（壓縮後 k 一直偏低不算新的壓縮）
    b,pg=page(p,name,T(*t2,('human',X(100000)),*CAL('400k','210k'),('assistant',Y(10000))));L=last(pg)
    chk('壓縮後兩次校正的差',abs(L['k']-1.5)<0.01 and L['kSrc']=='壓縮後兩次校正的差' and abs((gk(pg) or 0)-1.5)<0.01,[L['k'],L['kSrc'],gk(pg)]);b.close()
    # 4. 沒有壓縮前的校正：其他對話串的 k → 預設值
    t4=T(('human',X(200000)),*CAL('200k','60k'),('assistant',Y(10000)))
    b,pg=page(p,name,t4);L=last(pg)
    chk('預設值',abs(L['k']-1.82)<0.01 and L['kSrc']=='預設值',[L['k'],L['kSrc']]);b.close()
    b,pg=page(p,name,t4,pre="localStorage.setItem('ccm:lastCalib',JSON.stringify({fixed:140000,k:2.0,win:1e6}))");L=last(pg)
    chk('其他對話串的 k',abs(L['k']-2.0)<0.01 and L['kSrc']=='其他對話串的校正',[L['k'],L['kSrc']]);b.close()
    # 5. 自動校正：比上次校正多 10% 才送
    b,pg=page(p,name,T(('human',X(100000)),*CAL('300k','150k'),('assistant',Y(70000))))
    chk('漲 10% 自動校正',sent(pg)==['/context'],sent(pg));b.close()
    b,pg=page(p,name,T(('human',X(100000)),*CAL('300k','150k'),('assistant',Y(60000))))
    chk('漲不到 10% 不送',sent(pg)==[],sent(pg));b.close()
    # 6. 〔續做〕：上次校正太舊（漲超過 10%）→ 先 /context
    b,pg=page(p,name,T(('human',X(100000)),*CAL('300k','150k'),('human','做吧'),('assistant',Y(70000)+CONT)))
    chk('續做前校正太舊先校正',sent(pg)==['/context'],sent(pg));b.close()
    # 7. 〔量用量〕：送 /context，輸出出現後補送，只送一次
    t7=(('human',X(100000)),*CAL('300k','150k'),('assistant','好。\n〔量用量〕剛壓縮過'))
    b,pg=page(p,name,T(*t7));s0=sent(pg)
    put(T(*t7,*CAL('320k','160k')));poke(pg);s=sent(pg);poke(pg)
    chk('〔量用量〕送 /context 再補送',s0==['/context'] and len(s)==2 and s[1].startswith('〔自動〕已校正用量（Claude 要求）。') and '[ctx 32%' in s[1] and sent(pg)==s,s);b.close()
    b,pg=page(p,name,T(*t7),pre="document.addEventListener('DOMContentLoaded',()=>{document.querySelector('[data-testid=chat-input]').innerText='打到一半'})")
    chk('〔量用量〕打字中不送',sent(pg)==[],sent(pg));b.close()
print('全部通過' if all(res.values()) else '有失敗')
