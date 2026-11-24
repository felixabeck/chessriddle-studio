---
id: feedback
title: Geri bildirim, kayıtlar, kaydedilmiş veriyi silme ve güncellemeler
summary: Geri bildirim gönderme, uygulama kayıtlarını açma, kaydedilmiş veriyi yeniden yükleme veya silme, uygulama sürüm bilgisini kontrol etme ve güncellemeleri yükleme.
source: 8b0ca5aebb70e04f
---

Bir hata bildirmek, özellik önermek, övgü göndermek veya diğer geri bildirimleri doğrudan geliştiriciyle paylaşmak için [[feedback]] ({{label:Menu.Help.SendFeedback}}) kullanın.

Geri bildirim formunu istediğiniz zaman gezinme satırındaki {{label:Navigation.Feedback}} düğmesinden veya {{label:Menu.Help}} -> {{label:Menu.Help.SendFeedback}} menüsünden açabilirsiniz.

Geri bildirim formunda bir tür seçebilir ({{label:Feedback.Type.Bug}}, {{label:Feedback.Type.Suggestion}}, {{label:Feedback.Type.Praise}} veya {{label:Feedback.Type.Other}}), bir mesaj yazabilir (10 ila 5.000 karakter), isteğe bağlı olarak yanıt için bir e-posta adresi girebilir ve isteğe bağlı olarak bir ekran görüntüsü ({{label:Feedback.TakeScreenshot}}) veya görüntü ({{label:Feedback.ChooseImage}}) ekleyebilirsiniz. Uygulama sürümünüz ve işletim sisteminiz mesajla birlikte gönderilir.

Assistant sizin için bir geri bildirim taslağı hazırladığında [[feedback]] bağlantısına tıklamak formu bu taslakla önceden doldurulmuş olarak açar. Siz metni gözden geçirip {{label:Feedback.Submit}} düğmesine tıklayana kadar hiçbir şey gönderilmez.

Sorun giderme araçları [[settings-category:advanced]] ({{label:Settings.Advanced}}) bölümünde yer alır:
- **Kayıtlar**: uygulama kayıt dosyalarını içeren klasörü açmak için [[setting:open-logs]] ({{label:Menu.Help.OpenLogs}}) öğesini açın.
- **Yenile**: uygulama penceresini yeniden yüklemek için [[setting:reload]] ({{label:Menu.View.Reload}}) öğesini açın.
- **Kaydedilmiş veriyi sil**: onayladıktan sonra kayıtlı ayarları ve oturum verilerini sıfırlamak için [[setting:clear-saved-data]] ({{label:Menu.Help.ClearSavedData}}) öğesini açın. Bu işlem çalışma alanı PGN dosyalarınızı veya veritabanlarınızı silmez ve çalışma verileri güvenli bir şekilde taşınamıyorsa engellenir.

**Uygulama sürümü ve güncellemeler**:
- Yüklü sürümü, Tauri sürümünü ve işletim sistemini {{label:Menu.Help}} -> {{label:Menu.Help.About}} (macOS'ta uygulama menüsü altında) üzerinden veya [[page:settings]] sayfasının en altında kontrol edin.
- Studio başlangıçtan sonra güncellemeleri otomatik olarak denetler. Bir güncelleme kullanılabilir olduğunda, bir onay iletişim kutusu indirilip yüklenmesini isteyip istemediğinizi sorar. Kaydedilmemiş değişiklikleriniz varsa, siz kaydedene veya uygulamayı yeniden başlatana kadar yeniden başlatma ertelenir.
