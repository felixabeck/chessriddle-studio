---
id: engines
title: 国际象棋引擎与分析面板
summary: 安装或添加本地与云端引擎、配置 UCI 选项，并在棋盘上使用实时分析。
source: e18a17e22622746d
---

在 [[page:engines]] ({{label:SideBar.Engines}}) 页面管理您的国际象棋引擎。

要添加引擎，请在 [[page:engines]] 上点击 {{label:Common.AddNew}} 打开 {{label:Engines.Add.Title}}：
- {{label:Common.Download}}：使用 {{label:Common.Install}} 从目录安装预配置的引擎（例如 Stockfish）。
- {{label:Engines.Add.Cloud}}：使用 {{label:Common.Add}} 添加在线分析引擎（ChessDB 或 Lichess Cloud）。
- {{label:Common.Local}}：注册电脑上已有的 UCI 引擎可执行文件。

在 [[page:engines]] 中选择任意引擎进行配置。对于本地引擎，您可以编辑基本信息、设置默认 UCI 选项（如 Threads、Hash 和 MultiPV）、附加资源文件（如 Syzygy 残局库），点击 {{label:Engines.Settings.Reset}} 恢复默认值、{{label:Common.Duplicate}} 复制配置或 {{label:Common.Remove}} 移除引擎。对于云端引擎，您可以编辑名称和 {{label:Engines.Settings.NumOfLines}}。

在分析棋盘上，打开 {{label:Board.Tabs.Analysis}} 标签页并选择 {{label:Board.Analysis.Engines}}：
- 点击 {{label:Board.Analysis.SelectEngines}} 选择要加载到面板中的已安装引擎，或点击 {{label:Board.Analysis.ManageEngines}} 跳转到 [[page:engines]]。
- 点击引擎卡片上的 {{label:Board.Analysis.EnableEngine}} 或 {{label:Board.Analysis.DisableEngine}} 开始或暂停分析，加载了多个引擎时可使用 {{label:Board.Analysis.EnableAllEngines}}。
- 点击 {{label:Board.Analysis.CheckThreat}}（或按 {{label:Settings.Keybinds.Actions.TOGGLE_THREAT_MODE}} 快捷键）分析对手的威胁。
- 点击 {{label:Board.Analysis.Pin}} 将引擎评估条固定在标签页外部，或点击 {{label:Board.Analysis.EngineSettings}} 调整当前标签页的搜索限制和变化数量等设置。
- 按住 {{label:Board.Analysis.ReorderEngine}} 拖动引擎卡片以调整顺序。
- 打开 {{label:Board.Tabs.Analysis}} 中的 {{label:Board.Analysis.Logs}} 查看 UCI 引擎通信日志。

通过 [[setting:arrows]] ({{label:Settings.Arrows}}) 控制棋盘上的引擎箭头。本地引擎存储在 [[setting:engines-directory]] 所设定的文件夹中。
