---
id: import-game
title: Oyun içe aktarma
summary: PGN dosyasından, yapıştırılan PGN metninden, Lichess veya Chess.com bağlantısından, FEN konumundan ya da el yazısı notasyon kağıdının fotoğraflarından veya PDF taramalarından oyun içe aktarın.
source: bf71b9a270c61e30
---

Bir oyunu veya konumu içe aktarmak için [[page:new-tab]] sayfasını açın ve {{label:Home.Card.ImportGame.Title}} iletişim kutusunu açmak üzere {{label:Home.Card.ImportGame.Button}} düğmesine tıklayın. Ayrıca {{label:Menu.File}} -> {{label:Menu.File.OpenFile}} yolunu (veya {{label:Settings.Keybinds.Actions.OPEN_FILE}} kısayolunu) kullanarak doğrudan bir PGN dosyası açabilirsiniz.

{{label:Home.Card.ImportGame.Title}} iletişim kutusunda seçeneklerden birini seçin:
- **PGN**: bilgisayarınızdan bir {{label:Common.PGNFile}} seçin veya metni {{label:Common.PGNGame}} alanına yapıştırın. [[page:library]] içindeki çalışma alanı klasörünüze bir kopya kaydetmek için {{label:Import.SaveToCollection}} kutusunu işaretleyin, ardından bir {{label:Common.Name}} girin ve bir {{label:Files.FileType}} seçin.
- **{{label:Import.Online}}**: oyunu indirip analiz tahtasında açmak için bir Lichess veya Chess.com {{label:Import.GameURL}} bağlantısı yapıştırın.
- **FEN**: o konumdan başlayan bir analiz tahtası açmak için bir FEN dizgesi yapıştırın.
- **{{label:Import.FromPhoto}}** (yapay zeka özellikleri kullanılabilir olduğunda): el yazısı bir notasyon kağıdının 1 ila 4 fotoğrafını veya PDF sayfasını yeni bir oyuna aktarın. Bunun için [[settings-category:coach]] ({{label:Settings.AI}}) altında en az bir yapay zeka bağlantısı gerekir.

PGN, {{label:Import.Online}} ve FEN için oyunu geçerli sekmeye yüklemek üzere {{label:Home.Card.ImportGame.Button}} düğmesine tıklayın.

**{{label:Import.FromPhoto}}** ile içe aktarmak için:
- {{label:Scoresheet.Intake.ChoosePhotos}}, {{label:Scoresheet.Intake.PasteFromClipboard}} (veya bölme açıkken Ctrl+V / Cmd+V) kullanarak ya da fotoğrafları veya PDF dosyalarını açık bölmeye sürükleyip bırakarak en fazla 4 JPEG, PNG veya WebP fotoğrafı ya da PDF sayfası ekleyin. Yapıştırma yalnızca fotoğraflarla çalışır. Her PDF sayfası bir fotoğraf sayılır; daha uzun bir PDF'nin ilk sayfaları kullanılır.
- Model düğmesinden veya [[setting:coach-model]] ({{label:Settings.Coach.Model}}) içinden yapay zeka bağlantısını ve görsel destekleyen modeli seçin.
- Başlatmak için {{label:Scoresheet.Read.Button}} düğmesine tıklayın. Bir bağlantıda ilk okumadan önce {{label:Scoresheet.Notice.Title}} seçilen fotoğrafların (oyuncu adları ve kağıtta yazılı diğer her şey dahil) o sağlayıcıya gönderildiğini, kamera konumu gibi üst verilerin önce temizlendiğini ve başka hiçbir verinin gönderilmediğini açıklar.
- Studio her hamleyi başlangıç konumundan standart satranç kurallarına göre kontrol eder ve oyunu tahtanın yanında {{label:Board.Tabs.Photo}} panelinin açık olduğu kaydedilmemiş yeni bir analiz sekmesinde açar.
- Şüpheli veya düzeltilen hamleler notasyonda belirsiz olarak işaretlenir. {{label:Board.Tabs.Photo}} panelinde bunlar arasında gezinin ve her hamleyi doğruladıkça {{label:Scoresheet.MarkAsChecked}} düğmesine tıklayın. Ortada bir hamleyi düzeltir veya durma noktasının ardından devam ederseniz kağıttaki sonraki yasal hamleleri oynatmak için {{label:Scoresheet.ContinueWithSheet}} düğmesine tıklayın. İşaretler her hamle düzeltilene veya doğrulandı olarak işaretlenene kadar kalır ve {{label:Board.Tabs.Photo}} paneli sekmelerden sürüklenip diğer paneller gibi yerleştirilebilir.
- Oyunu normal kaydetme akışıyla ({{label:Menu.File}} -> {{label:Common.Save}}, kaydet düğmesi veya {{label:Board.Database.Save}}) bir dosyaya veya veritabanına kaydedin.
- Studio, oyun içe aktarılır aktarılmaz fotoğrafları bu bilgisayarda saklar. Oyunu bir PGN dosyasına veya veritabanına kaydettiğinizde, oyun bunlara bir başvuru tutar; böylece oyun her açıldığında {{label:Board.Tabs.Photo}} paneli fotoğrafları yeniden gösterir. Fotoğraflar hiçbir zaman yüklenmez ve kütüphane senkronizasyonu bunları göndermez.
- Bir fotoğraf bu bilgisayarda yoksa (örneğin başka bir bilgisayardan kopyalanan bir PGN dosyasında), panel bunu bildirir ve {{label:Scoresheet.LoadPhotoAgain}} düğmesi fotoğrafı hiçbir yere göndermeden yeniden ekler.
- Studio’nun bildiği hiçbir oyun tarafından artık başvurusu kalmayan fotoğraflar bir gün sonra silinir; bu nedenle Studio dışına kopyalanan bir oyun yalnızca fotoğraflarına ait bir başvuru taşır.
