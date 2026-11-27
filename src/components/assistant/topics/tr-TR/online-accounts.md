---
id: online-accounts
title: Çevrimiçi hesaplar ve rakip hazırlığı
summary: Lichess ve Chess.com hesapları ekleyin, oyunlarınızı indirin ve bir rakibin açılışlarını incelemek için çevrimiçi hesapları veritabanı oyuncularına bağlayın.
source: 5288fb0320fbe939
---

Lichess ve Chess.com hesaplarınızı [[page:accounts]] ({{label:SideBar.Accounts}}) sayfasından yönetin.

Hesap eklemek için:
1. [[page:accounts]] sayfasında {{label:Home.Accounts.Add}} düğmesine tıklayın.
2. Birden fazla hesabı tek bir oyuncu profilinde gruplamak için isteğe bağlı olarak bir {{label:Home.Accounts.PlayerName}} girin veya seçin.
3. {{label:Home.Accounts.Website}} altında Lichess veya Chess.com seçin ve {{label:Home.Accounts.Username}} değerini girin.
4. Lichess için isteğe bağlı olarak OAuth ile oturum açmak üzere {{label:Home.Accounts.LoginWithBrowser}} kutusunu işaretleyin. Oturum açmak daha hızlı oyun indirmelerini ve analiz tahtasındaki Lichess çevrimiçi açılış gezginlerini açar.
5. {{label:Common.Add}} düğmesine tıklayın.

[[page:accounts]] sayfasındaki her hesap kartında:
- Puanlarınızı ve istatistiklerinizi yenilemek için {{label:Home.Accounts.UpdateStats}} düğmesine tıklayın.
- Oyunlarınızı yerel bir veritabanına indirmek için indirme düğmesine tıklayın (sonraki indirmeler yalnızca son indirmeden bu yana oynanan yeni oyunları alır).
- Hesabı kaldırmak için {{label:Home.Accounts.RemoveAccount}} düğmesine tıklayın.
- Oyunlar indirildikten sonra [[page:accounts]] sayfasının sağ tarafı kişisel istatistiklerinizi ({{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} ve {{label:Home.Personal.Openings}}) gösterir.

Bir veritabanından rakibin çevrimiçi açılışlarını incelemek için:
1. [[page:library]] içinden bir veritabanı açın ve {{label:Databases.Card.Players}} sekmesine geçin.
2. Oyuncu kartını açmak için bir oyuncu seçin.
3. Bu oyuncuya bir veya daha fazla Lichess ya da Chess.com kullanıcı adı bağlamak için {{label:Databases.Opponent.Add}} düğmesine tıklayın.
4. {{label:Databases.OpeningTree.Since}} ve {{label:Databases.Opponent.TimeControls}} ile filtrelemek veya {{label:Databases.Opponent.RemoveGames}} ya da {{label:Databases.Opponent.Unlink}} uygulamak için {{label:Databases.Opponent.Manage}} düğmesine tıklayın.
5. Çevrimiçi oyunlarını getirmek için {{label:Databases.Opponent.Download}} (veya {{label:Databases.Opponent.Update}}) düğmesine tıklayın.
6. Rakibin oyunları gezginde sabitlenmiş şekilde bir analiz tahtası açmak için oyuncu kartının sekmelerinden ({{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}}, {{label:Home.Personal.Preparation}} veya {{label:Home.Personal.Openings}}) {{label:Databases.OpeningTree.Prepare}} düğmesine tıklayın; masa başı ve çevrimiçi açılış ağacını incelemek, renge ve {{label:Databases.OpeningTree.Since}} aralığına göre filtrelemek ve belirli bir hat seçmek için önce {{label:Home.Personal.Openings}} sekmesini açın.
