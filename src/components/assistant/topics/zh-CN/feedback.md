---
id: feedback
title: 反馈、日志、清除已保存的数据与更新
summary: 发送反馈、打开应用日志、重新加载或清除已保存的数据、查看应用版本信息以及安装更新。
source: 8b0ca5aebb70e04f
---

使用 [[feedback]] ({{label:Menu.Help.SendFeedback}}) 向开发者直接报告缺陷、提出功能建议、发送表扬或分享其他反馈。

您可以随时通过顶部导航栏中的 {{label:Navigation.Feedback}} 按钮或 {{label:Menu.Help}} -> {{label:Menu.Help.SendFeedback}} 打开反馈表单。

在反馈表单中，您可以选择类型（{{label:Feedback.Type.Bug}}、{{label:Feedback.Type.Suggestion}}、{{label:Feedback.Type.Praise}} 或 {{label:Feedback.Type.Other}}）、编写消息（10 到 5,000 个字符）、可选填用于回复的电子邮箱，并可选附带截屏 ({{label:Feedback.TakeScreenshot}}) 或图片 ({{label:Feedback.ChooseImage}})。您的应用版本和操作系统信息会随消息一并发送。

当 Assistant 为您起草反馈内容时，点击 [[feedback]] 会打开预填好该草稿的表单。在您审阅文本并点击 {{label:Feedback.Submit}} 之前，不会发送任何内容。

故障排除工具位于 [[settings-category:advanced]] ({{label:Settings.Advanced}}) 中：
- **日志**：打开 [[setting:open-logs]] ({{label:Menu.Help.OpenLogs}}) 以打开存放应用日志文件的文件夹。
- **重新加载**：打开 [[setting:reload]] ({{label:Menu.View.Reload}}) 以重新加载应用窗口。
- **清除已保存的数据**：打开 [[setting:clear-saved-data]] ({{label:Menu.Help.ClearSavedData}})，确认后即可重置已保存的设置和会话数据。这不会删除您的工作区 PGN 文件或数据库，如果练习数据无法安全迁移，此操作将被阻止。

**应用版本与更新**：
- 通过 {{label:Menu.Help}} -> {{label:Menu.Help.About}}（在 macOS 上位于应用程序菜单下）或在 [[page:settings]] 最底部查看已安装版本、Tauri 版本和操作系统。
- Studio 会在启动后自动检查更新。有可用更新时，确认对话框会询问是否下载并安装。如果您有未保存的更改，重启会推迟到您保存或重启应用之后。
