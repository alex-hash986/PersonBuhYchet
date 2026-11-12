from collections.abc import Iterator
from datetime import UTC
from io import BytesIO
from typing import Annotated

from fastapi import APIRouter, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict

from ..database import Session
from ..services.ai_advisor import AuditResult, InsightTransaction, analyze_budget
from ..services.export_service import build_csv, build_excel
from ..transaction_query import TransactionFilters, filtered_transactions

router = APIRouter(prefix="/api", tags=["analytics"])
ExportFilters = Annotated[TransactionFilters, Query()]


class InsightsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    filters: TransactionFilters | None = None
    transactions: list[InsightTransaction] | None = None


def _download(output: BytesIO, extension: str, media_type: str) -> StreamingResponse:
    def chunks() -> Iterator[bytes]:
        with output:
            while chunk := output.read(64 * 1024):
                yield chunk

    return StreamingResponse(
        chunks(), media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="smartbudget_report.{extension}"',
                 "Cache-Control": "no-store"},
    )


@router.get("/export/excel", response_class=StreamingResponse)
async def export_excel(session: Session, filters: ExportFilters):
    rows = (await session.scalars(filtered_transactions(filters))).all()
    output = await run_in_threadpool(build_excel, rows)
    return _download(output, "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@router.get("/export/csv", response_class=StreamingResponse)
async def export_csv(session: Session, filters: ExportFilters):
    rows = (await session.scalars(filtered_transactions(filters))).all()
    output = await run_in_threadpool(build_csv, rows)
    return _download(output, "csv", "text/csv")


@router.post("/analytics/insights", response_model=AuditResult)
async def insights(payload: InsightsRequest, session: Session):
    transactions = payload.transactions
    if transactions is None:
        rows = (await session.scalars(filtered_transactions(payload.filters or TransactionFilters()))).all()
        transactions = [
            InsightTransaction(
                amount=row.amount, type=row.type, category=row.category,
                created_at=row.created_at.replace(tzinfo=UTC),
            )
            for row in rows
        ]
        await session.rollback()
    return await analyze_budget(transactions)
