from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import database, main


def test_seed_demo_is_idempotent():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    with (
        patch.object(main, "engine", engine),
        patch.object(database, "engine", engine),
        patch.object(database, "session_factory", sessions),
        TestClient(main.app) as client,
    ):
        today = datetime.now(UTC).date()
        first = client.post("/api/transactions/seed-demo")
        assert first.status_code == 200
        created = first.json()["created"]
        ids = [f"demo-tx-{index}" for index in range(1, 15)]
        assert [row["client_tx_id"] for row in created] == ids
        assert first.json()["skipped_client_tx_ids"] == []
        assert [row["type"] for row in created].count("income") == 2
        days = [datetime.fromisoformat(row["created_at"]).date() for row in created]
        assert days == [days[-1] - timedelta(days=index) for index in range(13, -1, -1)]
        assert today <= days[-1] <= datetime.now(UTC).date()

        second = client.post("/api/transactions/seed-demo")
        assert second.status_code == 200
        assert second.json() == {"created": [], "skipped_client_tx_ids": ids}
        assert client.get("/api/transactions").json() == list(reversed(created))
