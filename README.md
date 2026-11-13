# Claude 對話工具（claude-chat-tools）

claude.ai 的 Tampermonkey 腳本，三支合成一支：

- **上下文用量**：頁首顯示用量、詳細面板、視窗底部燈帶，送出訊息時附 `[ctx NN%・X萬]`
- **/context 方格圖**：把 /context 的輸出收成按鈕，點開是 10×10 方格
- **交接對話串**：舊串改名、同 Project 開新串、貼上送出、新串改名

- **自動續做**：Claude 一批做完在最後一行寫〔續做〕，腳本看用量自動回「繼續」或「停」（門檻 70～85%，預設 80%）；離門檻近時先送 /context 校正，輸出出現後一定補送一則訊息
- **自動交接**（預設關）：停下後 Claude 寫好〔交接就緒〕，腳本自動開新對話串（連續最多 5 次，手動交接歸零）
- **自動允許授權**（預設關）：代按 claude.ai 畫面上的允許按鈕，有「一律允許」就按它，記錄在面板裡

設定都在點頁首用量標籤打開的面板裡。

## 安裝

裝好 Tampermonkey 後點：[ClaudeChatTools.user.js](https://raw.githubusercontent.com/bgtsai/claude-chat-tools/main/ClaudeChatTools.user.js)

裝好後請移除舊的三支：Claude 上下文用量、Claude /context 用量方格圖、Claude 交接對話串。
