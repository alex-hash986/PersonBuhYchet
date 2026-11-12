from datetime import date
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Response, status
from sqlalchemy import delete
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import Session
from ..models import Transaction, TransactionType
from ..schemas import (
    TransactionCreate,
    TransactionParseRequest,
    TransactionParseResponse,
    TransactionQuickAddRequest,
    TransactionQuickAddResponse,
    TransactionRead,
    TransactionSyncRequest,
    TransactionSyncResponse,
)
from ..services.ai_parser import parse_text
from ..services.demo_seed import demo_transactions
from ..transaction_query import TransactionFilters, filtered_transactions

router = APIRouter(prefix="/api/transactions", tags=["transactions"])


async def insert_transaction(
    session: AsyncSession, payload: TransactionCreate
) -> Transaction | None:
    statement = (
        insert(Transaction)
        .values(**payload.insert_values())
        .on_conflict_do_nothing(index_elements=[Transaction.client_tx_id])
        .returning(Transaction)
    )
    return (await session.scalars(statement)).one_or_none()


@router.get("", response_model=list[TransactionRead])
async def list_transactions(
    session: Session,
    date_from: date | None = None,
    date_to: date | None = None,
    type: TransactionType | None = None,
):
    filters = TransactionFilters(date_from=date_from, date_to=date_to, type=type)
    return (await session.scalars(filtered_transactions(filters))).all()


@router.post(
    "", response_model=TransactionRead, status_code=status.HTTP_201_CREATED,
    responses={409: {"description": "client_tx_id already exists"}},
)
async def create_transaction(payload: TransactionCreate, session: Session):
    async with session.begin():
        transaction = await insert_transaction(session, payload)
        if transaction is None:
            raise HTTPException(status_code=409, detail="client_tx_id already exists")
    return transaction


async def sync_batch(payload: TransactionSyncRequest, session: AsyncSession) -> TransactionSyncResponse:
    created = []
    skipped_client_tx_ids = []
    async with session.begin():
        for item in payload.transactions:
            transaction = await insert_transaction(session, item)
            if transaction is None:
                skipped_client_tx_ids.append(item.client_tx_id)
            else:
                created.append(TransactionRead.model_validate(transaction))
    return TransactionSyncResponse(created=created, skipped_client_tx_ids=skipped_client_tx_ids)


@router.post("/sync", response_model=TransactionSyncResponse)
async def sync_transactions(payload: TransactionSyncRequest, session: Session):
    return await sync_batch(payload, session)


@router.post("/seed-demo", response_model=TransactionSyncResponse)
async def seed_demo(session: Session):
    return await sync_batch(TransactionSyncRequest(transactions=demo_transactions()), session)


@router.post("/parse", response_model=TransactionParseResponse)
async def preview_transactions(payload: TransactionParseRequest):
    return await parse_text(payload.text)


@router.post(
    "/quick-add",
    response_model=TransactionQuickAddResponse,
    status_code=status.HTTP_201_CREATED,
    responses={
        200: {"model": TransactionQuickAddResponse, "description": "No transactions created"},
        409: {"description": "Generated client_tx_id already exists"},
    },
)
async def quick_add_transactions(
    payload: TransactionQuickAddRequest, session: Session, response: Response
):
    parsed = await parse_text(payload.text)
    created = []
    async with session.begin():
        for index, item in enumerate(parsed.transactions, start=1):
            transaction = await insert_transaction(session, TransactionCreate(
                **item.model_dump(), client_tx_id=f"{payload.client_tx_id_prefix}:{index}"
            ))
            if transaction is None:
                # The first ID identifies a previously stored batch.
                if index == 1:
                    break
                raise HTTPException(status_code=409, detail="Generated client_tx_id already exists")
            created.append(TransactionRead.model_validate(transaction))
    if not created:
        response.status_code = status.HTTP_200_OK
    return TransactionQuickAddResponse(created=created, parsed_by=parsed.parsed_by)


@router.delete(
    "/{transaction_id}", status_code=status.HTTP_204_NO_CONTENT, response_class=Response,
    responses={404: {"description": "Transaction not found"}},
)
async def delete_transaction(
    transaction_id: Annotated[int, Path(gt=0, le=2**63 - 1)], session: Session
):
    statement = delete(Transaction).where(Transaction.id == transaction_id).returning(Transaction.id)
    async with session.begin():
        if await session.scalar(statement) is None:
            raise HTTPException(status_code=404, detail="Transaction not found")
