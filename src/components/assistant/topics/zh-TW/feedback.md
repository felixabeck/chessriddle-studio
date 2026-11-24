---
id: feedback
title: 意見回饋、日誌、清除已儲存資料與更新
summary: 傳送回饋、開啟應用程式日誌、重新載入或清除已儲存資料、檢查應用程式版本資訊與安裝更新。
source: 8b0ca5aebb70e04f
---

使用 [[feedback]] ({{label:Menu.Help.SendFeedback}}) 直接向開發者回報問題、提出功能建議、給予讚賞或分享其他回饋。

您可以隨時從導覽列上的 {{label:Navigation.Feedback}} 按鈕，或透過 {{label:Menu.Help}} -> {{label:Menu.Help.SendFeedback}} 開啟意見回饋表單。

在意見回饋表單中，您可以選擇類型（{{label:Feedback.Type.Bug}}、{{label:Feedback.Type.Suggestion}}、{{label:Feedback.Type.Praise}} 或 {{label:Feedback.Type.Other}}）、撰寫訊息（10 至 5,000 個字元）、選填供回覆使用的電子郵件地址，並可選擇附加螢幕擷取畫面 ({{label:Feedback.TakeScreenshot}}) 或圖片 ({{label:Feedback.ChooseImage}})。您的應用程式版本與作業系統資訊會隨訊息一併傳送。

當 Assistant 為您準備好意見回饋草稿時，點擊 [[feedback]] 會開啟預先填入該草稿的表單。在您檢視文字並點擊 {{label:Feedback.Submit}} 之前，不會傳送任何內容。

疑難排解工具位於 [[settings-category:advanced]] ({{label:Settings.Advanced}})：
- **日誌**：開啟 [[setting:open-logs]] ({{label:Menu.Help.OpenLogs}}) 以開啟存放應用程式日誌檔案的資料夾。
- **重新載入**：開啟 [[setting:reload]] ({{label:Menu.View.Reload}}) 以重新載入應用程式視窗。
- **清除已儲存資料**：開啟 [[setting:clear-saved-data]] ({{label:Menu.Help.ClearSavedData}})，確認後即可重設已儲存的設定與工作階段資料。這不會刪除您的工作區 PGN 檔案或資料庫，若練習資料無法安全遷移則會遭到阻擋。

**應用程式版本與更新**：
- 透過 {{label:Menu.Help}} -> {{label:Menu.Help.About}}（在 macOS 上位於應用程式選單下），或在 [[page:settings]] 最底部查看已安裝版本、Tauri 版本與作業系統。
- Studio 會在啟動後自動檢查更新。有可用更新時，確認對話方塊會詢問是否下載並安裝。若您有未儲存的變更，重新啟動會延後至您儲存或重新啟動應用程式後進行。
