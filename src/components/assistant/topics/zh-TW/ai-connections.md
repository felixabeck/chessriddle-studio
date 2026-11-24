---
id: ai-connections
title: Coach 與 AI 連線
summary: 連線 AI 供應商或本機模型，以啟用分析棋盤上的 Coach 與 Assistant。
source: db8abb1b23f8812c
---

AI 連線同時驅動 Coach（在分析棋盤上）與 Assistant。在 [[settings-category:coach]] ({{label:Settings.AI}}) 中管理您的連線。

若要新增連線，請在 [[settings-category:coach]] 中選擇以下選項之一：
- {{label:Settings.Coach.SignIn.ChatGpt}}：在瀏覽器中使用您的 ChatGPT 帳戶登入。
- {{label:Settings.Coach.SignIn.Grok}}：使用裝置代碼登入 Grok（非官方方式）。
- {{label:Settings.Coach.Connections.Add}}：輸入相容於 OpenAI 的基礎網址及選填的 API 金鑰。內建 OpenAI、Google Gemini、DeepSeek、Qwen、OpenRouter、Ollama 與 LM Studio 的預設組態。

金鑰與登入憑證儲存在您電腦的系統鑰匙圈中。一旦儲存了至少一項連線，Assistant 便會出現在 {{label:Menu.Help}} 選單 ({{label:Menu.Help.Assistant}}) 與導覽列 ({{label:Navigation.Assistant}}) 中。

Coach 與 Assistant 共用相同的已選取連線、模型與推理強度。在連線上使用 {{label:Settings.Coach.Connection.Check}} 可驗證連線並列出可用模型，或使用 {{label:Settings.Coach.Connection.Remove}} 將其移除。

在分析棋盤上使用 Coach：
- 開啟 {{label:Board.Tabs.Coach}} 分頁（或按下 {{label:Settings.Keybinds.Actions.COACH_TAB}} 快捷鍵）。
- Coach 需要本機西洋棋引擎來驗證其分析變化。請在 [[setting:coach-engine]] ({{label:Settings.Coach.Engine}}) 中選擇它使用的引擎，或在 [[page:engines]] ({{label:SideBar.Engines}}) 中安裝引擎。
- 針對目前局面提問。在向某個連線發送第一則訊息前，Studio 會顯示提示，列出即將傳送的內容（局面、目前對局 PGN、引擎分析、若有選取則包含參考資料庫著法統計，以及相符的開局庫變化）。
- 將滑鼠移至或點擊 Coach 回覆中的著法變化，即可在不更動對局的情況下於迷你棋盤預覽。點擊變化旁的 {{label:Coach.InsertLine}} 可將其插入為變例。
