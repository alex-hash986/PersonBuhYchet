from datetime import UTC, datetime
from typing import Literal

from sqlalchemy import CheckConstraint, DateTime, Float, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

TransactionType = Literal["expense", "income"]


class Base(DeclarativeBase):
    pass


class Transaction(Base):
    __tablename__ = "transactions"
    __table_args__ = (
        CheckConstraint("type IN ('expense', 'income')", name="ck_transaction_type"),
        CheckConstraint("amount > 0", name="ck_transaction_amount"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    amount: Mapped[float] = mapped_column(Float)
    type: Mapped[TransactionType] = mapped_column(String(7))
    category: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(String(1000), default="")
    # SQLite stores a timezone-naive value. The application always writes UTC.
    created_at: Mapped[datetime] = mapped_column(
        DateTime, index=True, default=lambda: datetime.now(UTC).replace(tzinfo=None)
    )
    client_tx_id: Mapped[str | None] = mapped_column(String(128), unique=True)
