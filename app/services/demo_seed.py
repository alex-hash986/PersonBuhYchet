from datetime import UTC, datetime, time, timedelta

from ..schemas import OfflineTransactionCreate

# Oldest to newest. Each row is one operation on a different calendar day.
DEMO_TRANSACTIONS = (
    (85_000, "income", "Зарплата", "Зарплата за месяц"),
    (2_340.80, "expense", "Продукты", "Покупки на неделю"),
    (420, "expense", "Кафе и рестораны", "Кофе и завтрак"),
    (3_150, "expense", "Транспорт и авто", "Заправка на АЗС"),
    (5_870.45, "expense", "Жильё и ЖКХ", "Квартплата и коммунальные услуги"),
    (499, "expense", "Подписки", "Подписка на музыку"),
    (1_250, "expense", "Здоровье", "Лекарства в аптеке"),
    (18_500, "income", "Другое", "Оплата фриланс-проекта"),
    (1_860.30, "expense", "Продукты", "Овощи, крупы и молочные продукты"),
    (1_340, "expense", "Кафе и рестораны", "Ужин с друзьями"),
    (2_780, "expense", "Транспорт и авто", "Заправка перед поездкой"),
    (799, "expense", "Подписки", "Оплата облачного хранилища"),
    (2_200, "expense", "Здоровье", "Приём у стоматолога"),
    (975.60, "expense", "Продукты", "Хлеб, фрукты и продукты к ужину"),
)


def demo_transactions() -> list[OfflineTransactionCreate]:
    now = datetime.now(UTC)
    return [
        OfflineTransactionCreate(
            amount=amount,
            type=kind,
            category=category,
            description=description,
            created_at=min(
                now,
                datetime.combine(
                    now.date() - timedelta(days=len(DEMO_TRANSACTIONS) - index),
                    time(hour=9),
                    tzinfo=UTC,
                ),
            ),
            client_tx_id=f"demo-tx-{index}",
        )
        for index, (amount, kind, category, description) in enumerate(DEMO_TRANSACTIONS, start=1)
    ]
