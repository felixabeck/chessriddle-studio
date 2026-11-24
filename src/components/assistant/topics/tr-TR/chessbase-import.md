---
id: chessbase-import
title: ChessBase'ten veritabanı içe aktarma
summary: Bir ChessBase veritabanını PGN olarak dışa aktarın ve Studio veritabanına dönüştürün.
source: d7f599a811a0afb0
---

ChessRiddle Studio, ChessBase `.cbh` veya `.cbv` dosyalarını doğrudan okumaz. Bunun yerine önce ChessBase veritabanınızı PGN olarak dışa aktarın ve ardından PGN dosyasını bir Studio veritabanına dönüştürün.

Bir dosya seçicide ChessBase dosyası seçerseniz Studio otomatik olarak {{label:ChessBaseGuide.Title}} penceresini açar. Bu pencereyi [[page:library]] sayfasındaki {{label:Library.AddDatabase}} içindeki rehber bağlantısından da açabilirsiniz.

ChessBase'ten içe aktarmak için şu adımları izleyin:
1. Veritabanını ChessBase'te açın ve dışa aktarmak istediğiniz oyunları seçin.
2. Seçilen oyunları ChessBase'te `.pgn` dosyası olarak dışa aktarın veya kaydedin.
3. Studio'da [[page:library]] sayfasını açın, {{label:Library.AddDatabase}} düğmesine tıklayın, {{label:Common.Local}} sekmesine geçin, dışa aktarılan `.pgn` dosyasını seçin, bir {{label:Common.Name}} verin ve {{label:Databases.Add.Convert}} düğmesine tıklayın.

Dönüştürme tamamlandığında veritabanı [[page:library]] içinde görünür; burada oyunlarını, oyuncularını ve turnuvalarını inceleyebilir veya {{label:Databases.Settings.ReferenceDatabase}} olarak ayarlayabilirsiniz.
