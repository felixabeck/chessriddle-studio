---
id: engines
title: Satranç motorları ve analiz paneli
summary: Yerel ve bulut motorları yükleme veya ekleme, UCI seçeneklerini yapılandırma ve tahta üzerinde canlı analiz kullanma.
source: f40b5fdf8e5c15a0
---

Satranç motorlarınızı [[page:engines]] ({{label:SideBar.Engines}}) sayfasından yönetin.

Motor eklemek için [[page:engines]] sayfasında {{label:Common.AddNew}} düğmesine tıklayarak {{label:Engines.Add.Title}} penceresini açın:
- {{label:Common.Download}}: katalogdan önceden yapılandırılmış bir motoru (örneğin Stockfish) {{label:Common.Install}} ile yükleyin.
- {{label:Engines.Add.Cloud}}: çevrimiçi analiz motorlarını (ChessDB veya Lichess Cloud) {{label:Common.Add}} ile ekleyin.
- {{label:Common.Local}}: bilgisayarınızda zaten bulunan bir UCI motoru yürütülebilir dosyasını kaydedin.

Yapılandırmak için [[page:engines]] sayfasında herhangi bir motoru seçin. Yerel motorlar için genel ayrıntıları düzenleyebilir, varsayılan UCI seçeneklerini (Threads, Hash ve MultiPV gibi) ayarlayabilir, Syzygy oyunsonu tabloları gibi kaynak dosyalar ekleyebilir, varsayılanlara dönmek için {{label:Engines.Settings.Reset}}, yapılandırmayı kopyalamak için {{label:Common.Duplicate}} veya kaldırmak için {{label:Common.Remove}} düğmelerine tıklayabilirsiniz. Bulut motorları için adı ve {{label:Engines.Settings.NumOfLines}} ayarını düzenleyebilirsiniz.

Analiz tahtasında {{label:Board.Tabs.Analysis}} sekmesini açın:
- Panelde hangi yüklü motorların çalıştırılacağını seçmek için {{label:Board.Analysis.SelectEngines}} düğmesine veya [[page:engines]] sayfasına geçmek için {{label:Board.Analysis.ManageEngines}} düğmesine tıklayın.
- Analizi başlatmak veya duraklatmak için motor kartındaki {{label:Board.Analysis.EnableEngine}} ya da {{label:Board.Analysis.DisableEngine}} düğmesine tıklayın veya alt satırdaki {{label:Board.Analysis.EnableAllEngines}} düğmesini kullanın.
- Rakibin tehdidini analiz etmek için {{label:Board.Analysis.CheckThreat}} düğmesine tıklayın (veya {{label:Settings.Keybinds.Actions.TOGGLE_THREAT_MODE}} kısayoluna basın).
- Karttaki varyant seçiciden 1 ile 5 arasında varyant seçin veya arama sınırı ve UCI seçenekleri gibi sekmeye özel ayarlar için {{label:Board.Analysis.EngineSettings}} düğmesine tıklayın.
- Bir motor kartını altı noktalı tutamacından ({{label:Board.Analysis.ReorderEngine}}) sürükleyerek sırasını değiştirin ya da kendi penceresi olarak tahtaya çıkarın; klavyeyle taşımak için tutamaca tıklayın. Geri döndürmek için {{label:Board.Area.ReturnToEngines}} düğmesine tıklayın veya pencereyi sekme listesinin (ya da {{label:Board.Tabs.Analysis}} başlığının) üzerine sürükleyin.
- Bir motor hata verdiğinde, UCI iletişimini incelemek için {{label:Board.Analysis.RetryEngine}} yanındaki {{label:Board.Analysis.Logs}} düğmesine tıklayın. Çalışan bir motorda aynı düğme kartındaki {{label:Board.Analysis.EngineSettings}} altında bulunur.

Tahta üzerindeki motor oklarını [[setting:arrows]] ({{label:Settings.Arrows}}) ile denetleyin. Yerel motorlar [[setting:engines-directory]] konumunda ayarlanan klasörde saklanır.
