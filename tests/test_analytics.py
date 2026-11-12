import codecs
import csv
import io
import json
import unittest
from contextlib import ExitStack
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from openai import AsyncOpenAI
from openpyxl import load_workbook
from pydantic import SecretStr
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import database, main
from app.services import ai_advisor


class AnalyticsTests(unittest.TestCase):
    def setUp(self):
        stack = self.enterContext(ExitStack())
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        stack.enter_context(patch.object(main, "engine", engine))
        stack.enter_context(patch.object(database, "engine", engine))
        stack.enter_context(patch.object(
            database, "session_factory", async_sessionmaker(engine, expire_on_commit=False)
        ))
        stack.enter_context(patch.object(ai_advisor.settings, "openai_api_key", SecretStr("")))
        self.client = stack.enter_context(TestClient(main.app))

    def add(self, amount, kind, category, day, description=""):
        response = self.client.post("/api/transactions", json={
            "amount": amount, "type": kind, "category": category,
            "created_at": day + "T00:00:00Z", "description": description,
        })
        self.assertEqual(response.status_code, 201, response.text)

    def seed(self):
        self.add(1000, "income", "Зарплата", "2026-09-30")
        self.add(90, "expense", "Продукты", "2026-09-30", "=1+1")
        self.add(10, "expense", "Транспорт и авто", "2026-10-01")

    def test_excel_sheets_totals_and_text(self):
        self.seed()
        response = self.client.get("/api/export/excel")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-disposition"], 'attachment; filename="smartbudget_report.xlsx"')
        workbook = load_workbook(io.BytesIO(response.content), data_only=True)
        self.assertEqual(workbook.sheetnames, ["Операции", "По категориям", "По месяцам"])
        operations = workbook["Операции"]
        self.assertEqual([cell.value for cell in operations[1]], ["Дата", "Тип", "Категория", "Описание", "Сумма"])
        self.assertEqual([operations[f"E{index}"].value for index in (2, 3, 4, 5)], [-10, -90, 1000, 900])
        self.assertEqual(operations["D3"].value, "=1+1")
        self.assertEqual(operations["D3"].data_type, "s")
        self.assertEqual(operations.freeze_panes, "A2")
        self.assertEqual(operations.auto_filter.ref, "A1:E4")
        categories = list(workbook["По категориям"].values)
        self.assertEqual(categories[1:], [("Продукты", 90, 0, 0.9), ("Транспорт и авто", 10, 0, 0.1), ("Зарплата", 0, 1000, 0)])
        self.assertEqual(list(workbook["По месяцам"].values)[1:], [
            ("2026-09", 1000, 90, 910), ("2026-10", 0, 10, -10),
        ])

    def test_csv_bom_locale_and_filters(self):
        self.seed()
        response = self.client.get("/api/export/csv", params={
            "date_from": "2026-09-30", "date_to": "2026-09-30", "type": "expense",
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-disposition"], 'attachment; filename="smartbudget_report.csv"')
        self.assertTrue(response.content.startswith(codecs.BOM_UTF8))
        rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig")), delimiter=";"))
        self.assertEqual(rows, [
            ["Дата", "Тип", "Категория", "Описание", "Сумма"],
            ["30.09.2026 00:00:00", "Расход", "Продукты", "'=1+1", "-90,0"],
        ])

    def test_export_timestamp_filter_and_empty_report(self):
        self.seed()
        result = self.client.get("/api/export/excel", params={
            "start_at": "2026-10-01T06:59:00+07:00", "category": "Транспорт и авто",
        })
        workbook = load_workbook(io.BytesIO(result.content), data_only=True)
        self.assertEqual(workbook["Операции"]["E3"].value, -10)
        empty = self.client.get("/api/export/excel", params={"date_from": "2027-01-01"})
        workbook = load_workbook(io.BytesIO(empty.content), data_only=True)
        self.assertEqual(workbook["Операции"]["E2"].value, 0)
        invalid = self.client.get("/api/export/csv", params={
            "date_from": "2026-10-01", "date_to": "2026-09-30",
        })
        self.assertEqual(invalid.status_code, 422)

    def test_insights_fallback_with_period_and_spike(self):
        self.seed()
        self.add(180, "expense", "Продукты", "2026-10-02")
        result = self.client.post("/api/analytics/insights", json={"filters": {"date_from": "2026-09-30"}})
        self.assertEqual(result.status_code, 200, result.text)
        data = result.json()
        self.assertEqual(data["parsed_by"], "fallback")
        self.assertEqual(len(data["observations"]), 4)
        self.assertIn("28,0%", data["observations"][0])
        self.assertIn("Продукты", data["observations"][1])
        self.assertIn("02.10.2026", data["observations"][2])
        self.assertIn("27,00 ₽", data["observations"][3])

    def mock_openai(self, handler):
        stack = self.enterContext(ExitStack())
        stack.enter_context(patch.object(ai_advisor.settings, "openai_api_key", SecretStr("mock-key")))
        stack.enter_context(patch.object(ai_advisor.settings, "openai_model", "proxy-audit-model"))
        stack.enter_context(patch.object(ai_advisor.settings, "openai_base_url", "https://proxy.test/v1"))

        def make_client(**options):
            return AsyncOpenAI(
                **options, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
            )

        stack.enter_context(patch.object(ai_advisor, "AsyncOpenAI", side_effect=make_client))

    def test_insights_mock_uses_selected_transactions(self):
        self.seed()
        observations = ["Транспорт — крупнейшая статья.", "В выборке нет доходов.", "Сравните тарифы."]
        def handler(request):
            self.assertEqual(str(request.url), "https://proxy.test/v1/chat/completions")
            body = json.loads(request.content)
            self.assertEqual(body["model"], "proxy-audit-model")
            self.assertEqual(body["response_format"]["type"], "json_schema")
            summary = json.loads(body["messages"][-1]["content"])
            self.assertEqual(summary["transaction_count"], 1)
            self.assertEqual(summary["expense_rub"], "30.5")
            return httpx.Response(200, json={
                "id": "chatcmpl-audit", "object": "chat.completion", "created": 0, "model": "proxy-audit-model",
                "choices": [{"index": 0, "finish_reason": "stop", "message": {
                    "role": "assistant", "content": json.dumps({"observations": observations}),
                }}],
            })

        self.mock_openai(handler)
        response = self.client.post("/api/analytics/insights", json={"transactions": [{
            "amount": 30.5, "type": "expense", "category": "Транспорт и авто",
            "created_at": "2026-10-01T12:00:00+07:00",
        }]})
        self.assertEqual(response.json(), {"observations": observations, "parsed_by": "ai"})

    def test_insights_timeout_and_api_failure(self):
        self.seed()
        for timeout in (False, True):
            with self.subTest(timeout=timeout):
                def handler(request):
                    if timeout:
                        raise httpx.ReadTimeout("test timeout", request=request)
                    return httpx.Response(503, json={"error": {"message": "test error"}})

                self.mock_openai(handler)
                response = self.client.post("/api/analytics/insights", json={})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["parsed_by"], "fallback")
