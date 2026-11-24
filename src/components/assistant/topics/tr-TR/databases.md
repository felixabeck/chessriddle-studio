---
id: databases
title: Veritabanları, gezgin, konum arama, oyuncular ve turnuvalar
summary: Oyun veritabanları ekleme veya indirme, referans veritabanı seçme, gezginde konum arama ve oyunları, oyuncuları ve turnuvaları inceleme.
source: 48c72137fadc1768
---

Veritabanları PGN dosyalarınızla birlikte [[page:library]] ({{label:SideBar.Library}}) içinde yer alır ve [[setting:databases-directory]] konumunda saklanır.

Bir veritabanı eklemek için [[page:library]] sayfasını açın ve {{label:Library.AddDatabase}} düğmesine tıklayın:
- {{label:Databases.Add.Web}}: katalogdan seçilmiş oyun veritabanlarını indirin.
- {{label:Common.Local}}: yerel bir PGN dosyası seçin (`.pgn.zst` veya `.pgn.bz2` dahil), bir {{label:Common.Name}} ve isteğe bağlı {{label:Common.Description}} girin ve {{label:Databases.Add.Convert}} düğmesine tıklayın.

Yönetmek için [[page:library]] içinde bir veritabanı seçin:
- Gezgin, repertuvar oluşturucu, oyun raporu yenilikleri ve Coach için varsayılan referans veritabanı yapmak amacıyla {{label:Databases.Settings.ReferenceDatabase}} kutusunu işaretleyin.
- Daha hızlı aramalar için arama indeksleri oluşturmak veya kaldırmak üzere {{label:Databases.Settings.Indexed}} seçeneğini işaretleyin.
- Veritabanı tablo görünümünü açmak için {{label:Databases.Settings.Explore}} düğmesine tıklayın.
- {{label:Databases.Settings.Actions}} altında PGN dosyaları eklemek için {{label:Databases.Settings.AddGames}}, PGN olarak dışa aktarmak için {{label:Databases.Settings.ExportPGN}} veya veritabanını silmek için {{label:Common.Delete}} seçeneğini kullanın.
- {{label:Databases.Settings.AdvancedTools}} altında yinelenen oyuncu kayıtlarını birleştirmek için {{label:Databases.Settings.MergePlayers}} ya da oyunları temizlemek için {{label:Databases.Settings.RemoveDup}} ve {{label:Databases.Settings.RemoveEmpty}} seçeneklerini kullanın.

Veritabanı tablo görünümünde {{label:Common.Games}}, {{label:Databases.Card.Players}} ve {{label:Databases.Settings.Events}} (turnuvalar) arasında geçiş yapın:
- Oyunları arayın ve sıralayın, bir oyunu önizleyin veya analiz tahtasında açın.
- {{label:Databases.Card.Players}} bölümünde bir oyuncu seçerek {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} ve {{label:Home.Personal.Openings}} ({{label:Databases.OpeningTree.Prepare}} düğmesine sahip etkileşimli açılış ağacı) sekmelerini ve ayrıca {{label:Databases.FIDE.Info}} üzerinden FIDE bilgilerini görüntüleyin.
- {{label:Databases.Settings.Events}} bölümünde turnuvaları ada göre arayın ve tarihe, oyuncu sayısına, oyun sayısına veya ortalama ELO'ya göre sıralayın.

Analiz tahtasında açılış gezginini kullanmak için {{label:Board.Tabs.Database}} sekmesini açın:
- {{label:Board.Database.Local}}, {{label:Board.Database.LichessAll}} ve {{label:Board.Database.LichessMaster}} arasında geçiş yapın (Lichess çevrimiçi gezginleri için [[page:accounts]] sayfasında oturum açılmış bir Lichess hesabı gerekir).
- {{label:Board.Database.Stats}} (hamle istatistikleri) ve {{label:Board.Database.Games}} (eşleşen oyunlar) görünümleri arasında geçiş yapın.
- Yerel veritabanları için iki veritabanını yan yana görmek üzere {{label:Board.Database.Compare}} düğmesine tıklayın veya {{label:Board.Database.Local.Exact}} ve {{label:Board.Database.Local.Partial}} konum aramaları (piyon yapısı araması için {{label:Board.Database.Local.SimilarStructure}} ve özel kalıplar için {{label:Fen.Empty}} dahil) arasında geçiş yapmak üzere {{label:Board.Database.Local.Position}} menüsünü açın.
- Gezgini tahtanın veya notasyonun üstüne ya da altına sabitlemek için {{label:Board.Database.Pin}}, sekmelere geri döndürmek için {{label:Board.Database.Unpin}} seçeneğini kullanın.
