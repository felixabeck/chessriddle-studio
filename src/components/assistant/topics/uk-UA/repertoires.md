---
id: repertoires
title: Дебютні репертуари
summary: Створення репертуару, імпорт PGN, формування покриття за довідковою базою, тренування з інтервальним повторенням і відстеження незавершених варіантів, транспозицій та позначок перевірки.
source: db00ec0860d0fa31
---

Репертуари — це файли PGN із типом «Репертуар», які додають до дошки аналізу вкладку {{label:Board.Tabs.Practice}}.

Щоб створити репертуар, відкрийте [[page:new-tab]] та натисніть {{label:Home.Card.NewRepertoire.Title}} (або створіть файл репертуару в [[page:library]]). Введіть {{label:Common.Name}}, виберіть {{label:Common.WHITE}} або {{label:Common.BLACK}}, за бажання виберіть або вставте PGN у розділі {{label:Home.Card.NewRepertoire.FromPgn}} та натисніть {{label:Common.Create}}. Ви також можете імпортувати PGN через {{label:Home.Card.ImportGame.Title}}, увімкнувши {{label:Import.SaveToCollection}} і вибравши тип {{label:Files.FileType.Repertoire}}.

Будуйте свій репертуар у {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Build}}:
- Натисніть {{label:Board.Practice.Build.ImportPgn}}, щоб об’єднати файл PGN або вставлені партії з відкритим репертуаром (працює як із довідковою базою, так і без неї).
- Укажіть {{label:Databases.Settings.ReferenceDatabase}} у [[page:library]], щоб конструктор показував частоту ходів і покриття.
- У порожньому репертуарі можна почати з одного з вбудованих шаблонів {{label:Board.Practice.Build.Presets}} або ввести ходи на дошці.
- Позначте початкову позицію вашого репертуару за допомогою {{label:Board.Practice.Build.SetAsStart}} (або клацніть правою кнопкою по ходу в нотації й виберіть {{label:Menu.MarkAsStart}}).
- Натискайте ходи в {{label:Board.Practice.Build.OpponentMoves}} або {{label:Board.Practice.Build.YourResponse}}, щоб додавати чи переглядати лінії. Використовуйте {{label:Board.Practice.Build.NextGap}} і {{label:Board.Practice.Build.BiggestGap}}, щоб переходити до непокритих відповідей суперника з кількістю партій вище порога [[setting:repertoire-depth]].

Тренуйте свій репертуар у {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Train}}:
- Натисніть {{label:Board.Practice.StartPractice}}, щоб тренувати прострочені й нові позиції за допомогою інтервального повторення, або {{label:Board.Practice.PracticeFullRepertoire}}, щоб відпрацьовувати всі позиції репертуару.
- Зіграйте підготовлений хід на дошці. Якщо застрягли після неправильного ходу, натисніть {{label:Board.Practice.ShowMove}}.
- Переглядайте всі картки через {{label:Board.Practice.ShowAll}}, історію через {{label:Board.Practice.ShowLogs}} або скидайте прогрес кнопкою {{label:Common.Reset}}.
- Репертуари з картками до повторення також з’являються у фільтрі {{label:Home.Library.Due}} на сторінці [[page:new-tab]].
- Налаштуйте оцінювання інтервального повторення та ліміти нових карток у [[settings-category:repertoire]] ([[setting:practice-grading]], [[setting:practice-new-per-session]]).

У нотації на дошці аналізу:
- Побічна лінія завдовжки лише в один хід обводиться пунктирною рамкою як {{label:Notation.OpenVariation}}, щоб ви помічали незавершені гілки. Натисніть комбінацію клавіш {{label:Settings.Keybinds.Actions.NEXT_OPEN_VARIATION}}, щоб перейти до наступної такої гілки.
- Коли позиція трапляється в іншій гілці того самого репертуару, поруч із ходом з’являється значок {{label:Notation.Transposition}}; натисніть на нього, щоб перейти до іншої гілки.
- Якщо імпортований PGN містить іншу відповідь для вашої сторони, імпортований хід додається як варіант і позначається як {{label:Notation.ReviewMove}}. Клацніть правою кнопкою по ходу та виберіть {{label:Menu.MarkAsReviewed}}, щоб зняти позначку.
