import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from .config import settings
from .database import Session, engine, init_db
from .routers import analytics, transactions

logger = logging.getLogger(__name__)
static_dir = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    try:
        await init_db()
        yield
    finally:
        await engine.dispose()


app = FastAPI(title="SmartBudget PWA", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)
app.include_router(transactions.router)
app.include_router(analytics.router)
app.mount("/static", StaticFiles(directory=static_dir), name="static")


@app.exception_handler(SQLAlchemyError)
async def handle_database_error(request: Request, exc: SQLAlchemyError) -> JSONResponse:
    logger.error("Database operation failed for %s (%s)", request.url.path, type(exc).__name__)
    return JSONResponse(status_code=500, content={"detail": "Database operation failed"})


@app.get("/api/health")
async def health(session: Session):
    try:
        await session.execute(text("SELECT 1"))
    except SQLAlchemyError as exc:
        logger.error("Database health check failed (%s)", type(exc).__name__)
        return JSONResponse(status_code=503, content={"status": "unavailable"})
    return {"status": "ok"}


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(static_dir / "index.html")


@app.get("/manifest.json", include_in_schema=False)
async def web_manifest():
    return FileResponse(static_dir / "manifest.json", media_type="application/manifest+json")


@app.get("/sw.js", include_in_schema=False)
async def service_worker():
    return FileResponse(
        static_dir / "sw.js",
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache"},
    )
