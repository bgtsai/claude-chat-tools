"""模擬頁回歸測試：python3 tests/test_handover.py [chromium|firefox|webkit ...]
截圖輸出到 tests/shots/。真實 claude.ai 的送出與自動標題只能實機確認。"""
import json, pathlib, sys, time
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
SCRIPT = (ROOT.parent / 'ClaudeChatTools.user.js').read_text(encoding='utf-8')
MOCK = (ROOT / 'mock_handover.html').read_text(encoding='utf-8')
SHOTS = ROOT / 'shots'; SHOTS.mkdir(exist_ok=True)
OLD = 'https://claude.ai/chat/c5d4d1cb-b313-4674-be05-527b63d04d61'
CLIP = '請 clone GitHub repo bgtsai/claude-knowledge-base\n第二行說明\n第三行\n讀完 01 之後：接續 X 專案'

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail)); print(('PASS ' if cond else 'FAIL ') + name, detail)

def new_page(browser, clip=CLIP, opts=None):
    ctx = browser.new_context(viewport={'width': 1200, 'height': 700})
    ctx.route('https://claude.ai/**', lambda r: r.fulfill(status=200, content_type='text/html', body=MOCK))
    ctx.add_init_script('sessionStorage.setItem("mockOpts", %s);' % json.dumps(json.dumps(opts or {})))
    # 剪貼簿：三種引擎都用同一個替身，避免權限差異
    ctx.add_init_script('Object.defineProperty(navigator,"clipboard",{value:{readText:()=>Promise.resolve(%s),writeText:(t)=>{window.__copied=t;return Promise.resolve()}}});' % json.dumps(clip))
    ctx.add_init_script('document.addEventListener("DOMContentLoaded",()=>{%s});' % SCRIPT)  # 模擬 document-idle 之後才跑
    page = ctx.new_page()
    page.on('console', lambda m: m.text.startswith('[CHO]') and print('   ', m.text))
    page.goto(OLD)
    return ctx, page

def title(page):
    return page.eval_on_selector('[data-testid=session-title-split] h2 button', 'b=>b.textContent.trim()')

def run(bname, p):
    b = getattr(p, bname).launch()
    tag = bname
    # 1) 名稱規則
    ctx, page = new_page(b)
    page.wait_for_selector('.cho-btn', timeout=5000)
    cases = {'自動交接對話串': ('(old)自動交接對話串_V1', '自動交接對話串_V2'),
             '(old)語音輸入法_V5': ('(old)語音輸入法_V5', '語音輸入法_V6'),
             'Kindle 越狱 Calibre WiFi 插件_V2': ('(old)Kindle 越狱 Calibre WiFi 插件_V2', 'Kindle 越狱 Calibre WiFi 插件_V3'),
             '(old)(old)X_V9': ('(old)X_V9', 'X_V10'),
             '自動交接對話串_1': ('(old)自動交接對話串_1_V1', '自動交接對話串_1_V2')}
    for k, (o, n) in cases.items():
        r = page.evaluate('k=>window.__cho.computeNames(k)', k)
        check(f'{tag} 名稱 {k}', r == {'oldName': o, 'newName': n}, str(r))
    # 2) 按鈕在 ⌄ 後面、同一列
    pos = page.evaluate('''()=>{const m=document.querySelector('[data-testid=session-title-split] button[aria-haspopup]').getBoundingClientRect();
      const c=document.querySelector('.cho-btn').getBoundingClientRect();return {gap:c.left-m.right,dy:Math.abs((c.top+c.bottom)/2-(m.top+m.bottom)/2),txt:document.querySelector('.cho-btn').textContent.trim()}}''')
    bd = page.eval_on_selector('.cho-btn', 'b=>{const s=getComputedStyle(b);return [s.borderTopWidth,s.borderTopStyle,s.backgroundColor]}')
    check(f'{tag} 按鈕有外框與底色', bd[0] == '1px' and bd[1] == 'solid' and bd[2] not in ('rgba(0, 0, 0, 0)', 'transparent'), str(bd))
    check(f'{tag} 按鈕位置', 0 <= pos['gap'] <= 12 and pos['dy'] <= 1 and pos['txt'] == '交接對話串', str(pos))
    cur = page.eval_on_selector('.cho-btn', 'b=>[b,...b.querySelectorAll("*")].map(e=>getComputedStyle(e).cursor)')
    check(f'{tag} 按鈕與內層都是手指指標', cur and all(c == 'pointer' for c in cur), str(cur))
    # 2b) 有用量標籤（.ccm-meter）時順序固定 ⌄ → 用量 → 交接
    order = page.evaluate('''async()=>{const m=document.querySelector('[data-testid=session-title-split] button[aria-haspopup]');
      const t=document.createElement('span');t.className='ccm-meter';t.textContent='29%';m.after(t);document.querySelector('.cho-btn').remove();
      for(let i=0;i<40&&!document.querySelector('.cho-btn');i++)await new Promise(r=>setTimeout(r,50));
      const r=[m.nextElementSibling?.className.includes('ccm-meter'),m.nextElementSibling?.nextElementSibling?.classList.contains('cho-btn')];t.remove();return r}''')
    check(f'{tag} 順序 ⌄→用量→交接', order == [True, True], str(order))
    page.screenshot(path=str(SHOTS / f'{tag}_1_button.png'), clip={'x': 0, 'y': 0, 'width': 600, 'height': 60})
    # 3) 對話框內容
    page.click('.cho-btn')
    page.wait_for_selector('.cho-dialog')
    txt = page.inner_text('.cho-dialog')
    check(f'{tag} 對話框內容', '(old)自動交接對話串_V1' in txt and '自動交接對話串_V2' in txt and '第二行說明' in txt and '第三行' not in txt and '共 4 行' in txt, txt.replace('\n', ' | '))
    page.screenshot(path=str(SHOTS / f'{tag}_2_dialog.png'))
    # Esc 取消
    page.keyboard.press('Escape')
    check(f'{tag} Esc 關閉', page.query_selector('.cho-mask') is None)
    # 4) 全流程
    page.click('.cho-btn'); page.wait_for_selector('.cho-dialog'); page.click('.cho-dialog button:has-text("確認")')
    t0 = time.time()
    page.wait_for_selector('.cho-toast:has-text("交接完成")', timeout=40000)
    names = page.evaluate('()=>window.__mock.names')
    check(f'{tag} 舊對話改名', names.get('c5d4d1cb-b313-4674-be05-527b63d04d61') == '(old)自動交接對話串_V1', str(names))
    check(f'{tag} 新對話改名（沒被自動標題蓋掉）', title(page) == '自動交接對話串_V2' and names.get('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') == '自動交接對話串_V2', title(page))
    sent = page.evaluate('()=>window.__mock.sent')
    check(f'{tag} 送出的文字完整', sent and sent.replace('\n', '').replace(' ', '') == CLIP.replace('\n', '').replace(' ', ''), repr(sent))
    check(f'{tag} 新對話上也有按鈕', page.query_selector('.cho-btn') is not None)
    page.screenshot(path=str(SHOTS / f'{tag}_3_done.png'))
    print(f'    全流程 {time.time()-t0:.1f} 秒')
    ctx.close()
    # 5) 剪貼簿空的
    ctx, page = new_page(b, clip='  ')
    page.wait_for_selector('.cho-btn'); page.click('.cho-btn'); page.wait_for_selector('.cho-dialog')
    dis = page.eval_on_selector('.cho-dialog button:has-text("確認")', 'b=>b.disabled')
    check(f'{tag} 空剪貼簿擋下', dis and '剪貼簿是空的' in page.inner_text('.cho-dialog'))
    page.screenshot(path=str(SHOTS / f'{tag}_4_empty.png'))
    ctx.close()
    # 6) 中途失敗 → 還原舊名稱（整頁回舊對話）
    ctx, page = new_page(b, opts={'noEditor': True})
    page.wait_for_selector('.cho-btn'); page.click('.cho-btn'); page.wait_for_selector('.cho-dialog'); page.click('.cho-dialog button:has-text("確認")')
    page.wait_for_selector('.cho-toast:has-text("卡在")', timeout=20000)
    page.screenshot(path=str(SHOTS / f'{tag}_5_fail.png'))
    page.click('.cho-toast button:has-text("還原舊名稱")')
    page.wait_for_selector('.cho-toast:has-text("已還原舊名稱")', timeout=20000)
    check(f'{tag} 還原舊名稱', title(page) == '自動交接對話串', title(page))
    ctx.close()
    # 7) 輸入框原本有字：先存起來、清空再貼，完成後可以複製回來
    ctx, page = new_page(b, opts={'draft': '之前打了沒送出的字 x'})
    page.wait_for_selector('.cho-btn'); page.click('.cho-btn'); page.wait_for_selector('.cho-dialog'); page.click('.cho-dialog button:has-text("確認")')
    page.wait_for_selector('.cho-toast:has-text("交接完成")', timeout=40000)
    sent = page.evaluate('()=>window.__mock.sent')
    check(f'{tag} 殘留草稿被清掉', sent and '沒送出' not in sent and sent.replace('\n','').replace(' ','') == CLIP.replace('\n','').replace(' ',''), repr(sent))
    page.screenshot(path=str(SHOTS / f'{tag}_7_done_draft.png'))
    page.click('.cho-toast button:has-text("複製原本的輸入內容")')
    page.wait_for_selector('.cho-toast button:has-text("已複製")')
    check(f'{tag} 複製回原本的草稿', page.evaluate('()=>window.__copied') == '之前打了沒送出的字 x', repr(page.evaluate('()=>window.__copied')))
    ctx.close()
    # 8) 深色
    ctx, page = new_page(b, opts={'dark': True})
    page.wait_for_selector('.cho-btn'); page.click('.cho-btn'); page.wait_for_selector('.cho-dialog')
    page.screenshot(path=str(SHOTS / f'{tag}_6_dialog_dark.png'))
    page.keyboard.press('Escape')
    page.screenshot(path=str(SHOTS / f'{tag}_8_button_dark.png'), clip={'x': 0, 'y': 0, 'width': 600, 'height': 60})
    ctx.close()
    b.close()

if __name__ == '__main__':
    with sync_playwright() as p:
        for bn in (sys.argv[1:] or ['chromium', 'firefox', 'webkit']):
            run(bn, p)
    bad = [r for r in results if not r[1]]
    print(f'\n{len(results)-len(bad)}/{len(results)} 通過')
    sys.exit(1 if bad else 0)
