# Claude 對話工具（claude-chat-tools）

claude.ai 的 Tampermonkey 腳本，三支合成一支：

- **上下文用量**：頁首顯示用量、詳細面板、視窗底部燈帶，送出訊息時附 `[ctx NN%・X萬]`
- **/context 方格圖**：把 /context 的輸出收成按鈕，點開是 10×10 方格
- **交接對話串**：舊串改名、同 Project 開新串、貼上送出、新串改名

開發中：自動續做、自動交接、自動允許授權。

## 安裝

裝好 Tampermonkey 後點：[ClaudeChatTools.user.js](https://raw.githubusercontent.com/bgtsai/claude-chat-tools/main/ClaudeChatTools.user.js)

裝好後請移除舊的三支：Claude 上下文用量、Claude /context 用量方格圖、Claude 交接對話串。
