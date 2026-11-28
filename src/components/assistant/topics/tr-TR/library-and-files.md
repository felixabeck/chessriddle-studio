---
id: library-and-files
title: Dosyalar ve Kütüphane
summary: Çalışma alanı klasörü belirleme, PGN dosyaları oluşturup düzenleme, oyun açıp kaydetme ve çöp kutusunu yönetme.
source: c4c2624190fac7bb
---

[[page:library]] ({{label:SideBar.Library}}) sayfası çalışma alanı PGN dosyalarınızı (oyunlar, repertuvarlar, turnuvalar, bulmacalar ve diğer dosyalar) ve oyun veritabanlarınızı bir araya getirir.

Dosya oluşturmadan önce bir çalışma alanı klasörü seçin. Henüz bir klasör ayarlanmadıysa [[page:library]] sayfasında {{label:Files.ChooseFolder}} düğmesine tıklayın veya [[settings-category:directories]] altında [[setting:files-directory]] ({{label:Settings.Directories.Files}}) ayarını yapılandırın.

[[page:library]] sayfasında:
- Yeni bir PGN dosyası oluşturmak için {{label:Files.CreateFile}} düğmesine, dosyaları alt klasörlerde düzenlemek için {{label:Files.CreateFolder}} düğmesine tıklayın.
- Dosya türüne veya {{label:Library.GamesDatabase}} seçeneğine göre filtrelemek için {{label:Common.Search}} kutusunu ve {{label:Files.FileType}} açılır listesini kullanın.
- Oyunlarını önizlemek (önizleme, göz düğmesiyle hamleleri gizleyebilir, [[setting:hide-preview-moves]]), analiz tahtasında açmak veya {{label:Files.Rename}}, {{label:Files.Move}} ve {{label:Files.Trash}} işlemlerini uygulamak için bir dosya seçin.

Bir dosyayı analiz tahtasında düzenlerken:
- Değişiklikleri tahtanın üst çubuğundaki kaydet düğmesiyle (otomatik kaydetme kapalıyken, kullanılamıyorken veya başarısız olduğunda gösterilir), {{label:Menu.File}} -> {{label:Common.Save}} yoluyla veya {{label:Settings.Keybinds.Actions.SAVE_FILE}} kısayoluyla kaydedin.
- Açık dosyalardaki düzenlemelerin otomatik olarak kaydedilmesi için [[setting:auto-save]] ({{label:Settings.AutoSave}}) ayarını açın.
- Geçerli oyunu başka bir kütüphane dosyasına veya veritabanına kaydetmek için {{label:Menu.File}} -> {{label:Board.Database.Save}} (veya tahtanın üst çubuğundaki {{label:Board.Action.More}} -> {{label:Board.Database.Save}}) yolunu kullanın.

Bir dosyayı {{label:Files.Trash}} bölümüne taşımak onu hemen kalıcı olarak silmez. Bildirimdeki {{label:Common.Undo}} düğmesine hemen tıklayabilir veya bir dosyayı {{label:Files.Restore}}, {{label:Files.DeletePermanently}} ya da {{label:Files.EmptyTrash}} işlemleriyle yönetmek için [[page:library]] içindeki {{label:Files.Trash}} bölümüne kaydırabilirsiniz.

ChessRiddle hesabınız bağlıyken seçili PGN dosyalarını ve oyun veritabanlarını ChessRiddle üzerindeki özel Kütüphanenize senkronize etmek için [[page:library]] sayfasında {{label:Library.Sync.Action}} düğmesine tıklayın (en fazla 100 dosya, dosya başına 5 MB, 40.000 hamle ve 5.000 oyun). Düzenlemeler, ad değişiklikleri, seçim kaldırmalar ve silmeler otomatik olarak güncellenir; indirilen oyun geçmişleri yerel olarak kalır. Senkronizasyonu kapatırken ChessRiddle üzerindeki senkronize dosyaları tutabilir veya kaldırabilirsiniz.
