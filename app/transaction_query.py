from datetime import date, datetime, time

from fastapi import HTTPException
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from sqlalchemy import select

from .models import Transaction, TransactionType
from .schemas import as_utc


class TransactionFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date_from: date | None = None
    date_to: date | None = None
    type: TransactionType | None = None
    category: str | None = Field(default=None, max_length=100)
    start_at: AwareDatetime | None = None


def filtered_transactions(filters: TransactionFilters):
    if filters.date_from and filters.date_to and filters.date_from > filters.date_to:
        raise HTTPException(status_code=422, detail="date_from must be on or before date_to")

    statement = select(Transaction).order_by(Transaction.created_at.desc(), Transaction.id.desc())
    if filters.date_from is not None:
        statement = statement.where(Transaction.created_at >= datetime.combine(filters.date_from, time.min))
    if filters.date_to is not None:
        statement = statement.where(Transaction.created_at <= datetime.combine(filters.date_to, time.max))
    if filters.start_at is not None:
        try:
            start_at = as_utc(filters.start_at).replace(tzinfo=None)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        statement = statement.where(Transaction.created_at >= start_at)
    if filters.type is not None:
        statement = statement.where(Transaction.type == filters.type)
    if filters.category is not None:
        statement = statement.where(Transaction.category == filters.category)
    return statement
