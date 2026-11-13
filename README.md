# Claude 對話工具（claude-chat-tools）

claude.ai 的 Tampermonkey 腳本，三支合成一支：

- **上下文用量**：頁首顯示用量、詳細面板、視窗底部燈帶，送出訊息時附 `[ctx NN%・X萬]`
- **/context 方格圖**：把 /context 的輸出收成按鈕，點開是 10×10 方格
- **交接對話串**：按一下 → 請 Claude 歸檔並寫好開場白 → 自動舊串改名、同 Project 開新串、貼上送出、新串改名

- **估算怎麼校正**：從最近一次 /context 的實際量起算，之後新增的訊息才用估算。比上次校正多 10% 就自動再送一次 /context。偵測到對話被壓縮（訊息量比上次少 30% 以上），就不用壓縮後那次算出的係數，改用壓縮後兩次校正的差、壓縮前的校正或預設值（v0.5.0）
- **〔量用量〕**：Claude 需要準確用量時在最後一行寫〔量用量〕，腳本送 /context，再補送一則〔自動〕訊息把結果交給 Claude（v0.5.0）
- **自動續做**：Claude 一批做完在最後一行寫〔續做〕，腳本看用量自動回「繼續」或「停」（門檻 70～85%，預設 80%）；離門檻近、或上次校正後已多 10% 時先送 /context 校正，輸出出現後一定補送一則訊息
- **自動交接**（預設關）：停下後 Claude 寫好〔交接就緒〕，腳本自動開新對話串（連續最多 5 次，手動交接歸零）
- **自動允許授權**（預設關）：代按 claude.ai 畫面上的允許按鈕，有「一律允許」就按它，記錄在面板裡

設定都在點頁首用量標籤打開的面板裡。

## 安裝

裝好 Tampermonkey 後點：[ClaudeChatTools.user.js](https://raw.githubusercontent.com/bgtsai/claude-chat-tools/main/ClaudeChatTools.user.js)

裝好後請移除舊的三支：Claude 上下文用量、Claude /context 用量方格圖、Claude 交接對話串。
