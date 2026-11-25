---
id: databases
title: Veritabanları, gezgin, konum arama, oyuncular ve turnuvalar
summary: Oyun veritabanları ekleme veya indirme, referans veritabanı seçme, gezginde konum arama ve oyunları, oyuncuları ve turnuvaları inceleme.
source: d3afecf524059542
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
- Oyunları arayın ve sıralayın, bir oyunu önizleyin (önizleme, göz düğmesiyle hamleleri gizleyebilir, [[setting:hide-preview-moves]]) veya analiz tahtasında açın.
- {{label:Databases.Card.Players}} bölümünde bir oyuncu seçerek {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} ve {{label:Home.Personal.Openings}} ({{label:Databases.OpeningTree.Prepare}} düğmesine sahip etkileşimli açılış ağacı) sekmelerini ve ayrıca {{label:Databases.FIDE.Info}} üzerinden FIDE bilgilerini görüntüleyin.
- {{label:Databases.Settings.Events}} bölümünde turnuvaları ada göre arayın ve tarihe, oyuncu sayısına, oyun sayısına veya ortalama ELO'ya göre sıralayın.

Bir oyuncunun kartında oyunlarını repertuvar dosyalarınızla karşılaştırmak için {{label:Home.Personal.Preparation}} sekmesini açın:
- Rakibin rengini, {{label:Databases.OpeningTree.Since}} dönemini ve (bağlı çevrimiçi hesaplar varsa) {{label:Databases.OpeningTree.OverTheBoard}}, {{label:Databases.OpeningTree.Online}} veya {{label:Databases.Preparation.Both}} seçeneğini belirleyin. Karşılaştırmayı yeniden çalıştırmak için {{label:Databases.Preparation.Refresh}} düğmesine tıklayın.
- Rakibin yalnızca nadiren oynadığı varyantları ve boşlukları gizlemek için {{label:Databases.Preparation.MinGames}} değerini artırın; dosyanız bu varyantları katlar ve antrenman onları dışarıda bırakır.
- Rakibin oynadığı varyantları ve {{label:Databases.Preparation.GapsTitle}} listesini inceleyin. Repertuvar dosyanızı o konumda diğer yan varyantlar gizli olarak açmak için bir satıra tıklayın; notasyon başlığında {{label:Notation.PreparationOpponentLines}} ile {{label:Notation.PreparationAllLines}} arasında geçiş yapın.
- Bu varyantlar üzerinde süreli bir alıştırma başlatmak için {{label:Databases.Preparation.TrainLines}} düğmesine tıklayın; yanıtlarınız normal aralıklı tekrar programını günceller.
- Yalnızca Lichess veya Chess.com hesabı olan bir rakibe hazırlanmak için [[page:library]] içinde {{label:Library.OnlineOpponent}} düğmesine tıklayarak hesabını arayın, oyunlarını indirin ve kartını doğrudan {{label:Home.Personal.Preparation}} sekmesinde açın (aynı hesabı tekrar girdiğinizde yeniden indirmeden açılır).

Analiz tahtasında açılış gezginini kullanmak için {{label:Board.Tabs.Database}} sekmesini açın:
- {{label:Board.Database.Local}}, {{label:Board.Database.LichessAll}} ve {{label:Board.Database.LichessMaster}} arasında geçiş yapın (Lichess çevrimiçi gezginleri için [[page:accounts]] sayfasında oturum açılmış bir Lichess hesabı gerekir).
- {{label:Board.Database.Stats}} (hamle istatistikleri) ve {{label:Board.Database.Games}} (eşleşen oyunlar) görünümleri arasında geçiş yapın.
- Yerel veritabanları için iki veritabanını yan yana görmek üzere {{label:Board.Database.Compare}} düğmesine tıklayın veya {{label:Board.Database.Local.Exact}} ve {{label:Board.Database.Local.Partial}} konum aramaları (piyon yapısı araması için {{label:Board.Database.Local.SimilarStructure}} ve özel kalıplar için {{label:Fen.Empty}} dahil) arasında geçiş yapmak üzere {{label:Board.Database.Local.Position}} menüsünü açın.
- Gezgini tahtanın veya notasyonun üstüne ya da altına sabitlemek için {{label:Board.Database.Pin}}, sekmelere geri döndürmek için {{label:Board.Database.Unpin}} seçeneğini kullanın.
- {{label:Databases.OpeningTree.Prepare}} bir veritabanı oyuncusu için tahta açtığında gezgin referans veritabanınızı rakibin oyunlarının yanına ek bir sütun olarak ekler; gizlemek için {{label:Board.Database.RemoveReference}}, geri getirmek için {{label:Board.Database.ShowReference}} düğmesine tıklayın.
