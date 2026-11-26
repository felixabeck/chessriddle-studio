---
id: analysis-board
title: Analiz tahtası, varyasyonlar, yorumlar ve oklar
summary: Hamle girme, konum düzenleme, varyasyonları yönetme, yorum yazma, açıklama ekleme ve tahta üzerinde oklar çizme.
source: 2b161f5c0298e17a
---

[[page:new-tab]] üzerinden {{label:Home.Card.AnalysisBoard.Title}} öğesine tıklayarak veya [[page:library]] sayfasından kayıtlı bir oyun ya da repertuvar açarak bir analiz tahtası açın.

Taşları sürükleyerek veya tıklayarak hamle yapın ([[setting:move-method]] üzerinden yapılandırılır). Ayrıca SAN notasyonuyla hamle yazmak için [[setting:text-input]] ({{label:Settings.Inputs.TextInput}}) ayarını etkinleştirebilirsiniz. Hamleler arasında gezinmek için notasyonun altındaki hamle denetimlerini, ok tuşlarını veya fare tekerleğini ([[setting:scroll-moves]] etkinse) kullanın.

Tahtanın üzerindeki üst çubuk tahta eylemlerini sunar:
- {{label:Board.Action.PlayFromHere}}: geçerli konumdan bir oyun başlatın.
- Tahtayı çevir (`F`): tahtanın altındaki Beyaz ve Siyah yönünü değiştirin.
- Kaydet: oyunda kaydedilmemiş değişiklikler varsa ve otomatik kaydetme kapalıysa, kullanılamıyorsa (ör. taslak) veya başarısız olduysa görünür.
- {{label:Board.Action.More}}: {{label:Board.Database.Save}} (oyunu bir kütüphane dosyasına veya veritabanına kaydedin), {{label:Board.Action.TakeSnapshot}} (geçerli tahtanın görüntüsünü kaydedin) ve {{label:Board.Action.EditPosition}} (taşları yerleştirerek veya FEN’i düzenleyerek özel bir konum kurun) menüsünü açar.
- Geri alma, yineleme ve çizilen okları ya da kare vurgularını temizleme ([[setting:erase-drawables]] kapalıyken) [[settings-category:keybinds]] içindeki klavye kısayollarını kullanır.

Önceki bir konumdan farklı bir hamle oynamak yeni bir varyasyon oluşturur. Notasyondaki herhangi bir hamleye sağ tıklayarak {{label:Menu.PromoteVariation}}, {{label:Menu.PromoteToMainLine}}, {{label:Menu.CopyVariationPGN}}, {{label:Menu.DeleteMove}}, {{label:Menu.DeleteVariation}}, {{label:Menu.DeleteMovesAfter}}, {{label:Board.Action.PlayFromHere}}, {{label:Notation.AddDiagram}} veya {{label:Notation.MarkGameEndHere}} seçeneklerini kullanın. {{label:Notation.HideMoves}} için notasyon başlığındaki göz düğmesini; {{label:Notation.TableView}}, {{label:Notation.ShowComments}}, {{label:Notation.ShowDiagrams}} ve {{label:Notation.ShowVariations}} görünümlerini açıp kapatmak için {{label:Notation.ViewOptions}} menüsünü kullanın.

Hamlelere açıklama eklemek ve yorum yazmak için {{label:Board.Tabs.Annotate}} sekmesini açın. `!!`, `!`, `!?`, `?!`, `?` veya `??` sembollerini değiştirmek için bir hamle kalitesi sembolüne tıklayın (ya da 1 ile 6 arasındaki tuşlara basın); değerlendirme ve konumsal semboller için {{label:Annotate.ShowMore}} düğmesine tıklayın. Sembollerin altında biçimlendirilmiş yorumlar yazmak ve satır içi tahta diyagramlarını açıp kapatmak için zengin metin düzenleyicisini kullanın.

Ok çizmek ve kareleri vurgulamak için tahta üzerinde sağ tıklayıp sürükleyin (veya daire çizmek için bir kareye sağ tıklayın). Farklı renkler için değiştirici tuşları basılı tutun: {{label:Settings.Drawing.Red}} için Shift, {{label:Settings.Drawing.Blue}} için Alt, {{label:Settings.Drawing.Yellow}} için Shift+Alt, {{label:Settings.Drawing.Orange}} için Ctrl (macOS'ta Cmd) ve {{label:Settings.Drawing.Cyan}} için Ctrl+Alt (macOS'ta Cmd+Alt). Çizim listesinin tamamını [[settings-category:keybinds]] bölümünde görebilirsiniz.

{{label:Board.Tabs.Info}} sekmesi oyun başlıklarını, FEN'i, PGN metnini ve ağaç istatistiklerini gösterir; ayrıca çok oyunlu bir PGN dosyasındaki oyunlar arasında geçiş yapmanızı sağlar.

Analiz tahtasını düzenlemek için bir panel sekmesini ({{label:Board.Tabs.Analysis}}, {{label:Board.Analysis.Report}}, {{label:Board.Tabs.Database}}, {{label:Board.Tabs.Annotate}}, {{label:Board.Tabs.Coach}} veya {{label:Board.Tabs.Info}}) ya da bir motor kartının altı noktalı tutamacını sürükleyin ya da sekme çubuğu, notasyon başlığı veya bir panel alanının başlığındaki tutma düğmelerini kullanarak alanları önizlemeyle veya klavyeyle başka bir alanın yanına, üstüne veya altına yerleştirin. Bir paneli iki alanın üzerine yaymak için (örneğin {{label:Board.Tabs.Database}} panelini hem notasyonun hem sekmelerin üstüne yerleştirmek için) önce paneli bunlardan birinin üstüne koyun, ardından diğerini yanına taşıyın. Bir alanı geri göndermek için {{label:Board.Area.ReturnToTabs}} (veya motor penceresi için {{label:Board.Area.ReturnToEngines}}) düğmesini kullanın ya da alanı sekme listesinin üzerine sürükleyin; varsayılan düzeni geri yüklemek için [[setting:board-layout]] ({{label:Settings.BoardLayout.Reset}}) ayarını kullanın.

Sekmeleri gizlemek için, örneğin kullandığınız her panel kendi alanı olarak gösterildiğinde, sekme şeridinin sonundaki tutamacın altındaki {{label:Board.Area.HideTabs}} düğmesine tıklayın; komşu alanlar onların yerini alır. Sekmeler konumlarını ve boyutlarını korur: onları, sekmeler gizliyken notasyon başlığında görünen {{label:Board.Arrange.ShowTabs}} düğmesiyle, bir sekme kısayoluyla veya rapor oluşturarak yeniden gösterin. Sekmeler gizliyken geri döndürdüğünüz bir panel gizli sekmelere gider.
