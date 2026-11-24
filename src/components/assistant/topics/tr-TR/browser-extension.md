---
id: browser-extension
title: Tarayıcı uzantısı ve oyun bağlantıları
summary: chessriddle-studio:// oyun bağlantılarını kullanarak Lichess ve Chess.com oyunlarını doğrudan Studio içinde açın.
source: 7059f7f7afa1559d
---

ChessRiddle Studio, tarayıcı uzantısı veya işletim sisteminiz tarafından gönderilen `chessriddle-studio://` oyun bağlantılarını işler.

Bir Lichess veya Chess.com oyunu için `chessriddle-studio://import?url=<game URL>` bağlantısı açıldığında:
- Studio, oyunun PGN'ini Lichess veya Chess.com üzerinden alır.
- Oyun yeni bir analiz sekmesinde açılır ve pencere tahtaya geçer.
- Oyun yüklenirken bir bildirim ilerlemeyi gösterir ve oyun alınamazsa hatayı bildirir.

macOS ve Windows'ta yükleyici `chessriddle-studio://` URL şemasını otomatik olarak kaydeder. Linux AppImage derlemelerinde Studio, tarayıcının bağlantıları uygulamaya aktarabilmesi için başlatıldığında `chessriddle-studio://` için bir masaüstü işleyicisi kaydeder.

Uzantı olmadan da herhangi bir Lichess veya Chess.com oyun URL'sini elle içe aktarabilirsiniz: [[page:new-tab]] sayfasını açın, {{label:Home.Card.ImportGame.Button}} düğmesine tıklayın, {{label:Import.Online}} seçeneğini seçin ve {{label:Import.GameURL}} bağlantısını yapıştırın.
