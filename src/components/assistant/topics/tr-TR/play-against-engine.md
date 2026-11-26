---
id: play-against-engine
title: Motora karşı oynama
summary: Yerel bir motora veya başka bir insana karşı oyun yapılandırma, zaman kontrollerini ve açılış kitaplarını ayarlama ve herhangi bir konumdan oynama.
source: 83458071f9a1e481
---

Bir oyun başlatmak için [[page:new-tab]] sayfasını açın ve {{label:Home.Card.PlayChess.Button}} düğmesine tıklayın. Ayrıca tahtanın üst çubuğundaki {{label:Board.Action.PlayFromHere}} düğmesine tıklayarak veya notasyondaki bir hamleye sağ tıklayarak analiz tahtasındaki herhangi bir konumdan oynayabilirsiniz.

Oyuna başlamadan önce:
- Her taraf için {{label:Board.Opponent.Human}} (bir adla birlikte) veya {{label:Common.Engine}} ([[page:engines]] üzerinden yüklü bir motor seçip oyun içi UCI seçeneklerini ayarlayın) seçin.
- Beyaz ve Siyah tarafları değiştirmek için {{label:Board.Action.ChangeColors}} düğmesine tıklayın.
- {{label:Board.Opponent.TimeSettings}} altında {{label:GoMode.Time}} ({{label:GoMode.Time}} ve {{label:Board.Opponent.Increment}} ile) veya {{label:Board.Opponent.Unlimited}} seçin. Her iki tarafta aynı saat ayarlarını kullanmak için {{label:Board.Opponent.SameTimeControl}} kutusunu işaretleyin.
- İsteğe bağlı olarak {{label:Board.Opponent.EnableOpeningBook}} kutusunu işaretleyin, bir {{label:Board.Opponent.OpeningBookFile}} seçin ve {{label:Board.Opponent.OpeningBookMaxPlies}} değerini ayarlayın.
- Özel bir konumdan oynamak istiyorsanız başlamadan önce tahtanın üst çubuğundaki {{label:Board.Action.More}} menüsünden {{label:Board.Action.EditPosition}} seçeneğini kullanın (veya `E` tuşuna basın).
- Başlamak için {{label:Board.Opponent.StartGame}} düğmesine tıklayın.

Oyun sırasında:
- Motora karşı insan olarak oynarken ön hamleler (premove) etkindir.
- Son hamlenizi geri almak için tahtanın üst çubuğundaki {{label:Board.Action.TakeBack}} düğmesini kullanın.
- Oyunu sonlandırmak için {{label:Board.Opponent.Resign}} (veya motor-motora maçta {{label:Board.Opponent.Abort}}) düğmesine tıklayın.
- Sekmeyi analiz moduna geçirmek için istediğiniz zaman {{label:Board.Analysis.Analyze}} düğmesine veya motor kayıtlarını incelemek için {{label:Board.Analysis.Logs}} düğmesine tıklayın.
- Oyun bittiğinde yeni bir oyun kurmak için {{label:Home.NewGame}} düğmesine tıklayın.
