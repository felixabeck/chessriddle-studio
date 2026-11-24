---
id: repertoires
title: Дебютні репертуари
summary: Створення репертуару, формування покриття за довідковою базою, тренування з інтервальним повторенням і відстеження незавершених варіантів та транспозицій.
source: 62b7ff51627518a7
---

Репертуари — це файли PGN із типом «Репертуар», які додають до дошки аналізу вкладку {{label:Board.Tabs.Practice}}.

Щоб створити репертуар, відкрийте [[page:new-tab]] та натисніть {{label:Home.Card.NewRepertoire.Title}} (або створіть файл репертуару в [[page:library]]). Введіть {{label:Common.Name}}, виберіть {{label:Common.WHITE}} або {{label:Common.BLACK}} та натисніть {{label:Common.Create}}.

Будуйте свій репертуар у {{label:Board.Tabs.Practice}} -> {{label:Board.Practice.Build}}:
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
