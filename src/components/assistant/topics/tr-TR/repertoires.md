---
id: repertoires
title: Açılış repertuvarları
summary: Repertuvar oluşturma, referans veritabanına göre kapsam kurma, aralıklı tekrarla çalışma ve açık varyasyonları ve transpozisyonları takip etme.
source: 62b7ff51627518a7
---

Repertuvarlar, analiz tahtasına {{label:Board.Tabs.Practice}} sekmesini ekleyen Repertuvar türündeki PGN dosyalarıdır.

Repertuvar oluşturmak için [[page:new-tab]] sayfasını açın ve {{label:Home.Card.NewRepertoire.Title}} öğesine tıklayın (veya [[page:library]] içinde bir repertuvar dosyası oluşturun). Bir {{label:Common.Name}} girin, {{label:Common.WHITE}} veya {{label:Common.BLACK}} seçin ve {{label:Common.Create}} düğmesine tıklayın.

Repertuvarınızı {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Build}} altında oluşturun:
- Oluşturucunun hamle sıklıklarını ve kapsamı gösterebilmesi için [[page:library]] içinde bir {{label:Databases.Settings.ReferenceDatabase}} ayarlayın.
- Boş bir repertuvarda yerleşik {{label:Board.Practice.Build.Presets}} şablonlarından biriyle başlayabilir veya hamleleri tahtaya girebilirsiniz.
- {{label:Board.Practice.Build.SetAsStart}} düğmesini kullanarak (veya notasyondaki bir hamleye sağ tıklayıp {{label:Menu.MarkAsStart}} seçerek) repertuvarınızın başlangıç konumunu işaretleyin.
- Varyant eklemek veya izlemek için {{label:Board.Practice.Build.OpponentMoves}} ya da {{label:Board.Practice.Build.YourResponse}} içindeki hamlelere tıklayın. [[setting:repertoire-depth]] içinde belirlenen minimum oyun sayısının üzerindeki kapsanmamış rakip yanıtlarına atlamak için {{label:Board.Practice.Build.NextGap}} ve {{label:Board.Practice.Build.BiggestGap}} düğmelerini kullanın.

Repertuvarınızı {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Train}} altında çalışın:
- Tekrar zamanı gelen ve yeni konumları aralıklı tekrarla çalışmak için {{label:Board.Practice.StartPractice}} düğmesine veya repertuvardaki her konumu çalışmak için {{label:Board.Practice.PracticeFullRepertoire}} düğmesine tıklayın.
- Hazırladığınız hamleyi tahtada oynayın. Yanlış bir hamleden sonra takılırsanız {{label:Board.Practice.ShowMove}} düğmesine tıklayın.
- {{label:Board.Practice.ShowAll}} ile tüm kartları inceleyin, {{label:Board.Practice.ShowLogs}} ile geçmişi görün veya {{label:Common.Reset}} ile ilerlemeyi sıfırlayın.
- Tekrar zamanı gelmiş kartları olan repertuvarlar [[page:new-tab]] sayfasındaki {{label:Home.Library.Due}} filtresi altında da görünür.
- Aralıklı tekrar derecelendirmesini ve yeni kart sınırlarını [[settings-category:repertoire]] ([[setting:practice-grading]], [[setting:practice-new-per-session]]) içinde yapılandırın.

Analiz tahtasındaki notasyonda:
- Yalnızca bir hamle uzunluğundaki bir yan varyant, tamamlanmamış dalları fark edebilmeniz için {{label:Notation.OpenVariation}} olarak kesikli çerçeveyle gösterilir. Bir sonrakine atlamak için {{label:Settings.Keybinds.Actions.NEXT_OPEN_VARIATION}} kısayoluna basın.
- Bir konum aynı repertuvarın başka bir dalında da ortaya çıktığında hamlenin yanında bir {{label:Notation.Transposition}} simgesi görünür; diğer dala atlamak için bu simgeye tıklayın.
