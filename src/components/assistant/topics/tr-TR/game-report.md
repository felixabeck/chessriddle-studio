---
id: game-report
title: Oyun raporu
summary: Doğruluk oranını, değerlendirme grafiğini, önemli anları ve hamle sınıflandırmalarını görmek için otomatik motor incelemesi çalıştırın.
source: b69aae8a4fe0f417
---

Oyun raporu, ana varyanttaki her hamleyi yerel bir satranç motoruyla analiz eder ve oyunun doğruluk oranını ve hatalarını özetler.

Rapor oluşturmak için analiz tahtasında bir oyun açın, {{label:Board.Analysis.Report}} sekmesine geçin ve {{label:Board.Analysis.GenerateReport}} düğmesine tıklayın (veya {{label:Settings.Keybinds.Actions.GENERATE_REPORT}} kısayoluna basın).

{{label:Board.Analysis.GenerateReport}} iletişim kutusunda:
- Yerel bir {{label:Common.Engine}} seçin. Yüklü motor yoksa [[page:engines]] üzerinden ekleyin.
- Hamle başına arama sınırını (derinlik, süre veya düğüm sayısı) ayarlayın.
- Hamleleri kalite sembolleriyle işaretlemek için {{label:Board.Analysis.MarkMoves}} seçeneğini açın.
- Daha iyi hamle varyasyonlarını notasyona eklemek için {{label:Board.Analysis.ShowVariations}} seçeneğini açın.
- Referans veritabanınızdan çıkan ilk hamleyi işaretlemek için {{label:Board.Analysis.AnnotateNovelties}} seçeneğini açın. Bu seçenek, [[page:library]] içinde seçilmiş hazır bir referans veritabanı gerektirir.
- Başlatmak için {{label:Board.Analysis.Analyze}} düğmesine tıklayın.

Rapor çalışırken ilerleme düğmesinden iptal edebilirsiniz. Ana varyantı düzenlemek, devam eden raporu iptal eder.

Tamamlandığında {{label:Board.Analysis.Report}} sekmesi şunları gösterir:
- {{label:Common.WHITE}} ve {{label:Common.BLACK}} için doğruluk yüzdeleri ve ortalama santipiyon kaybı (ACPL).
- Oyun boyunca değerlendirme grafiği.
- {{label:Board.Analysis.Report.KeyMoments}}: değerlendirme sıçramalarını ve daha iyi hamleleri gösteren işaretli hamlelerin tıklanabilir listesi.
- Bir sayıya tıklandığında ilgili hamlelere atlayan hamle kalitesi dağılım tablosu.

Oyunu sonradan düzenlerseniz yeni bir analiz çalıştırmak için {{label:Board.Analysis.RegenerateReport}} düğmesine tıklayın.
