---
id: ai-connections
title: Coach 与 AI 连接
summary: 连接 AI 提供商或本地模型，以启用分析棋盘上的 Coach 和 Assistant。
source: db8abb1b23f8812c
---

AI 连接同时为 Coach（分析棋盘上）和 Assistant 提供支持。在 [[settings-category:coach]] ({{label:Settings.AI}}) 中管理您的连接。

要添加连接，请在 [[settings-category:coach]] 中选择以下选项之一：
- {{label:Settings.Coach.SignIn.ChatGpt}}：在浏览器中使用您的 ChatGPT 账户登录。
- {{label:Settings.Coach.SignIn.Grok}}：使用设备码登录 Grok（非官方方式）。
- {{label:Settings.Coach.Connections.Add}}：输入兼容 OpenAI 的基础地址和可选 API 密钥。内置 OpenAI、Google Gemini、DeepSeek、Qwen、OpenRouter、Ollama 和 LM Studio 的预设。

密钥和登录凭据保存在您电脑的系统钥匙串中。保存至少一个连接后，Assistant 就会出现在 {{label:Menu.Help}} 菜单 ({{label:Menu.Help.Assistant}}) 和顶部导航栏 ({{label:Navigation.Assistant}}) 中。

Coach 和 Assistant 共用同一个选定连接、模型和推理强度。使用连接上的 {{label:Settings.Coach.Connection.Check}} 验证连接并列出可用模型，或使用 {{label:Settings.Coach.Connection.Remove}} 将其移除。

要在分析棋盘上使用 Coach：
- 打开 {{label:Board.Tabs.Coach}} 标签页（或按 {{label:Settings.Keybinds.Actions.COACH_TAB}} 快捷键）。
- Coach 需要一个本地国际象棋引擎来验证其分析变化。在 [[setting:coach-engine]] ({{label:Settings.Coach.Engine}}) 中选择它使用的引擎，或在 [[page:engines]] ({{label:SideBar.Engines}}) 中安装引擎。
- 针对当前局面提问。在向某个连接发送第一条消息前，Studio 会显示一条提示，列出将发送的数据（局面、当前对局 PGN、引擎分析、如已选择则包含参考数据库着法统计，以及匹配的开局库变化）。
- 悬停或点击 Coach 回答中的着法变化，即可在不改变对局的情况下于迷你棋盘上预览。点击变化旁的 {{label:Coach.InsertLine}} 可将其作为变例插入。
