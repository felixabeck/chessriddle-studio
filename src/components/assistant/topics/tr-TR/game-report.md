---
id: game-report
title: Oyun incelemesi ve rapor
summary: Doğruluk, değerlendirme ve süre grafiklerini, açılış ve repertuvar notlarını ve tahtadaki önemli anları görmek için oyunu yerel bir motorla analiz edin.
source: d1a4339820f36de2
---

Oyun raporu, ana varyanttaki her hamleyi yerel bir satranç motoruyla analiz eder ve sonuçları adım adım bir oyun incelemesine dönüştürür.

Rapor oluşturmak için analiz tahtasında bir oyun açın, {{label:Board.Analysis.Report}} sekmesine geçin ve {{label:Board.Analysis.GenerateReport}} düğmesine tıklayın (veya {{label:Settings.Keybinds.Actions.GENERATE_REPORT}} kısayoluna basın).

{{label:Board.Analysis.GenerateReport}} iletişim kutusunda:
- Yerel bir {{label:Common.Engine}} seçin. Yüklü motor yoksa [[page:engines]] sayfasından bir tane ekleyin.
- Hamle başına arama sınırını belirleyin (derinlik, süre veya düğüm sayısı).
- Hamleleri kalite simgeleriyle (`!!`, `!`, `!?`, `?!`, `?`, `??`) işaretlemek için {{label:Board.Analysis.MarkMoves}} seçeneğini açın.
- Notasyona daha iyi hamle varyantları eklemek için {{label:Board.Analysis.ShowVariations}} seçeneğini açın.
- Başvuru veritabanınızdan çıkan ilk hamleyi `N` ile işaretlemek için {{label:Board.Analysis.AnnotateNovelties}} seçeneğini açın. Bu seçenek, [[page:library]] içinde hazır bir başvuru veritabanının seçili olmasını gerektirir.
- Başlatmak için {{label:Board.Analysis.Analyze}} düğmesine tıklayın.

Rapor çalışırken ilerleme düğmesinden iptal edebilirsiniz. Ana varyantı düzenlemek de devam eden bir raporu iptal eder.

Tamamlandığında {{label:Board.Analysis.Report}} şunları gösterir:
- Motoru, arama sınırını ve tarihi gösteren sade bir başlık ve yanında küçük bir {{label:Board.Analysis.Report.Regenerate}} düğmesi. Tam genişlikteki {{label:Board.Analysis.GenerateReport}} düğmesi yalnızca güncel bir rapor olmadığında görünür.
- Oyun dengeli bir konumdan başladıysa puan tablosunun üzerinde tek cümlelik bir özet; dengesiz bir başlangıçta özet cümlesi gösterilmez.
- Oyuncu adlarını ve puanlarını, ana sayı olarak {{label:Board.Analysis.Accuracy}} değerini, {{label:Board.Analysis.Report.AverageLoss}} ölçütünü, oyun evrelerine göre doğruluğu ve sıfır değerleri soluklaştırılmış altı hamle kalitesi satırını içeren tek bir puan tablosu. Sıfır olmayan bir sayıya tıklamak o hamlelere atlar; herhangi bir etiketin üzerine gelmek veya klavyeyle odaklanmak o ölçütün neyi gösterdiğini açıklar.
- {{label:Board.Analysis.Report.Evaluation}} (sıfır çizgili) ve {{label:Board.Analysis.Report.WinChance}} arasında geçiş yapan bir grafik; her biri üzerine gelindiğinde veya klavyeyle odaklanıldığında açıklanır. Hamlelerin en az yarısında saat bilgisi varsa grafiğin altında bir {{label:Board.Analysis.Report.TimeUsage}} şeridi görünür; herhangi bir çubuğa tıklayarak o hamleye gidebilirsiniz.
- Açılış adını, varsa yeniliği (`N`) ve yalnızca kendi tarafınız için repertuvar notunu gösteren bir açılış ve repertuvar bölümü; tarafınız [[page:accounts]] içindeki bağlı Lichess, Chess.com veya takma ad hesaplarınızla oyuncu adı eşleşmesine göre, eşleşme yoksa tahtanın altındaki tarafa göre belirlenir (tahtayı çevirmek bu tarafı değiştirir). Repertuvardan nerede çıktığınızı (tıklamak o konuma oklarla odaklanır) veya nereye kadar takip ettiğinizi gösterir. Repertuvar dosyaları tam olarak okunamadıysa tek bir soluk satır gösterilir: {{label:Board.Analysis.Report.RepertoireIncomplete}}
- {{label:Board.Analysis.Report.KeyMoments}}: herhangi bir satıra tıklayarak hamleden önceki konuma gidin; böylece tahtadaki iki ok da (oynanan hamle ve daha iyi hamle) o kareden başlar. Aralarında gezinmek için {{label:Board.Analysis.Report.PreviousMoment}} ve {{label:Board.Analysis.Report.NextMoment}} düğmelerini kullanın ya da {{label:Board.Analysis.Report.FilterBoth}}, {{label:Board.Analysis.Report.FilterWhite}} veya {{label:Board.Analysis.Report.FilterBlack}} ile filtreleyin. Anlar ayrıca {{label:Board.Analysis.Report.Tag.TurningPoint}} veya {{label:Board.Analysis.Report.Tag.TimeTrouble}} gibi etiketleri ve motor varyantları kanıtladığında hata türünü de gösterir.
- `?!`, `?` ve `??` anlarında {{label:Board.Analysis.Report.Explain}} düğmesine tıklayarak o konuma odaklanın ve o anla ilgili bir soruyla {{label:Board.Tabs.Coach}} sekmesini açın. Yapay zekâ bağlantısı yapılandırılmadığında bu düğme gizlenir.

Oyunu sonradan düzenlerseniz, incelemeyi güncellemek için {{label:Board.Analysis.GenerateReport}} veya {{label:Board.Analysis.Report.Regenerate}} ile raporu yeniden oluşturun.
