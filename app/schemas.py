from datetime import UTC, datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints

from .models import TransactionType

ClientTransactionId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)]
TransactionAmount = Annotated[float, Field(gt=0, allow_inf_nan=False, strict=True)]
ParseSource = Literal["ai", "fallback"]
ParsedCategory = Literal[
    "Продукты",
    "Кафе и рестораны",
    "Транспорт и авто",
    "Жильё и ЖКХ",
    "Здоровье",
    "Одежда",
    "Развлечения",
    "Подписки",
    "Зарплата",
    "Переводы/Возвраты",
    "Другое",
]


def as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    try:
        return value.astimezone(UTC)
    except OverflowError as exc:
        raise ValueError("Datetime is outside the supported UTC range") from exc


class TransactionCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    amount: TransactionAmount
    type: TransactionType
    category: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=1000)
    created_at: Annotated[AwareDatetime, AfterValidator(as_utc)] | None = None
    client_tx_id: ClientTransactionId | None = None

    def insert_values(self) -> dict:
        values = self.model_dump(exclude_none=True)
        if self.created_at is not None:
            values["created_at"] = self.created_at.replace(tzinfo=None)
        return values


class OfflineTransactionCreate(TransactionCreate):
    client_tx_id: ClientTransactionId


class TransactionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    amount: float
    type: TransactionType
    category: str
    description: str
    created_at: Annotated[datetime, AfterValidator(as_utc)]
    client_tx_id: str | None


class TransactionSyncRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    transactions: list[OfflineTransactionCreate] = Field(max_length=500)


class TransactionSyncResponse(BaseModel):
    created: list[TransactionRead]
    skipped_client_tx_ids: list[str]


class ParsedTransaction(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    amount: TransactionAmount
    type: TransactionType
    category: ParsedCategory
    description: str = Field(max_length=1000)


class TransactionParseRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    text: str = Field(min_length=1, max_length=4000)


class TransactionParseResponse(BaseModel):
    transactions: list[ParsedTransaction]
    parsed_by: ParseSource


class TransactionQuickAddRequest(TransactionParseRequest):
    client_tx_id_prefix: str = Field(min_length=1, max_length=120)


class TransactionQuickAddResponse(BaseModel):
    created: list[TransactionRead]
    parsed_by: ParseSource
