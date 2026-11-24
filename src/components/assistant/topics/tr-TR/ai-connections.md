---
id: ai-connections
title: Coach ve yapay zekâ bağlantıları
summary: Analiz tahtasındaki Coach ve Assistant özelliklerini etkinleştirmek için bir yapay zekâ sağlayıcısı veya yerel model bağlayın.
source: eac73d15e14729e1
---

Yapay zekâ bağlantıları hem Coach (analiz tahtasında) hem de Assistant için çalışır. Bağlantılarınızı [[settings-category:coach]] ({{label:Settings.AI}}) altında yönetin.

Bağlantı eklemek için [[settings-category:coach]] içinde şu seçeneklerden birini seçin:
- {{label:Settings.Coach.SignIn.ChatGpt}}: tarayıcıda ChatGPT hesabınızla oturum açın.
- {{label:Settings.Coach.SignIn.Grok}}: bir cihaz kodu kullanarak Grok ile oturum açın (resmî olmayan).
- {{label:Settings.Coach.Connections.Add}}: OpenAI uyumlu bir temel adres ve isteğe bağlı bir API anahtarı girin. OpenAI, Google Gemini, DeepSeek, Qwen, OpenRouter, Ollama ve LM Studio için hazır ayarlar mevcuttur.

Anahtarlar ve oturum açma bilgileri bilgisayarınızın sistem anahtarlığında saklanır. En az bir bağlantı kaydedildiğinde Assistant, {{label:Menu.Help}} menüsünde ({{label:Menu.Help.Assistant}}) ve gezinme satırında ({{label:Navigation.Assistant}}) görünür.

Bağlantıyı, modeli ve akıl yürütme düzeyini [[setting:coach-model]] ({{label:Settings.Coach.Model}}) içinde seçin. Hem Coach hem de Assistant bu tek seçimle yanıt verir. Her iki panelde de {{label:Coach.Send}} yanındaki model düğmesi hangi modelin yanıt verdiğini gösterir ve aynı seçimi değiştirir; {{label:Coach.NewConversation}} hemen yanında yer alır.

Bir bağlantıyı doğrulamak ve kullanılabilir modellerini listelemek için {{label:Settings.Coach.Connection.Check}} düğmesini veya kaldırmak için {{label:Settings.Coach.Connection.Remove}} düğmesini kullanın.

Analiz tahtasında Coach özelliğini kullanmak için:
- {{label:Board.Tabs.Coach}} sekmesini açın (veya {{label:Settings.Keybinds.Actions.COACH_TAB}} kısayoluna basın).
- Coach, analiz varyantlarını doğrulamak için yerel bir satranç motoruna ihtiyaç duyar. Hangi motorun kullanılacağını [[setting:coach-engine]] ({{label:Settings.Coach.Engine}}) ayarından seçin veya [[page:engines]] ({{label:SideBar.Engines}}) sayfasından bir motor yükleyin.
- Geçerli konum hakkında sorular sorun. Bir bağlantıya ilk mesajı göndermeden önce Studio, gönderilen verileri (konum, geçerli oyunun PGN'i, motor analizi, seçiliyse referans veritabanı hamle istatistikleri ve eşleşen repertuvar hatları) listeleyen bir bildirim gösterir.
- Coach yanıtlarındaki hamle hatlarının üzerine gelerek veya tıklayarak oyunu değiştirmeden mini bir tahtada önizleyebilirsiniz. Bir hattı varyasyon olarak eklemek için yanındaki {{label:Coach.InsertLine}} düğmesine tıklayın.
