import json
import unittest
from contextlib import ExitStack
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from openai import AsyncOpenAI
from pydantic import SecretStr
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import database, main
from app.services import ai_parser

TEXT = "взял кофе за 350, заправил машину на 2500 и пришла зарплата 80000"
AI_RESULT = [
    {"amount": 350, "type": "expense", "category": "Кафе и рестораны", "description": "кофе"},
    {"amount": 2500, "type": "expense", "category": "Транспорт и авто", "description": "заправка"},
    {"amount": 80000, "type": "income", "category": "Зарплата", "description": "зарплата"},
]


class ParserTests(unittest.IsolatedAsyncioTestCase):
    async def test_fallback_without_key(self):
        with patch.object(ai_parser.settings, "openai_api_key", SecretStr("")):
            with patch.object(ai_parser, "AsyncOpenAI") as client:
                result = await ai_parser.parse_transactions_from_text("кофе 350,50; 2 500 бензин")
        client.assert_not_called()
        self.assertEqual([row["amount"] for row in result], [350.5, 2500])
        self.assertEqual([row["description"] for row in result], ["кофе", "бензин"])
        self.assertTrue(all(
            (row["category"], row["type"], row["parsed_by"]) == ("Другое", "expense", "fallback")
            for row in result
        ))


class TransactionAPITests(unittest.TestCase):
    def setUp(self):
        stack = self.enterContext(ExitStack())
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        stack.enter_context(patch.object(main, "engine", engine))
        stack.enter_context(patch.object(database, "engine", engine))
        stack.enter_context(patch.object(
            database, "session_factory", async_sessionmaker(engine, expire_on_commit=False)
        ))
        stack.enter_context(patch.object(ai_parser.settings, "openai_api_key", SecretStr("")))
        self.client = stack.enter_context(TestClient(main.app))

    def mock_openai(self, handler):
        stack = self.enterContext(ExitStack())
        stack.enter_context(patch.object(ai_parser.settings, "openai_api_key", SecretStr("mock-key")))
        stack.enter_context(patch.object(ai_parser.settings, "openai_model", "proxy-model"))
        stack.enter_context(patch.object(ai_parser.settings, "openai_base_url", "https://proxy.test/v1"))

        def make_client(**options):
            return AsyncOpenAI(
                **options, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
            )

        stack.enter_context(patch.object(ai_parser, "AsyncOpenAI", side_effect=make_client))

    def test_structured_output_preview_and_save(self):
        def handler(request):
            self.assertEqual(str(request.url), "https://proxy.test/v1/chat/completions")
            body = json.loads(request.content)
            self.assertEqual(body["model"], "proxy-model")
            self.assertEqual(body["messages"][-1], {"role": "user", "content": TEXT})
            self.assertEqual(body["response_format"]["type"], "json_schema")
            self.assertTrue(body["response_format"]["json_schema"]["strict"])
            return httpx.Response(200, json={
                "id": "chatcmpl-test",
                "object": "chat.completion",
                "created": 0,
                "model": "proxy-model",
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": json.dumps({"transactions": AI_RESULT}),
                    },
                }],
            })

        self.mock_openai(handler)
        preview = self.client.post("/api/transactions/parse", json={"text": TEXT})
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.json(), {"transactions": AI_RESULT, "parsed_by": "ai"})
        self.assertEqual(self.client.get("/api/transactions").json(), [])

        payload = {"text": TEXT, "client_tx_id_prefix": "batch"}
        saved = self.client.post("/api/transactions/quick-add", json=payload)
        self.assertEqual(saved.status_code, 201)
        self.assertEqual(saved.json()["parsed_by"], "ai")
        self.assertEqual(
            [row["client_tx_id"] for row in saved.json()["created"]],
            ["batch:1", "batch:2", "batch:3"],
        )
        retry = self.client.post("/api/transactions/quick-add", json=payload)
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json()["created"], [])
        self.assertEqual(len(self.client.get("/api/transactions").json()), 3)

    def test_no_key_and_empty_parse(self):
        parsed = self.client.post("/api/transactions/parse", json={"text": "без сумм"})
        self.assertEqual(parsed.json(), {"transactions": [], "parsed_by": "fallback"})
        saved = self.client.post("/api/transactions/quick-add", json={
            "text": "кофе 350", "client_tx_id_prefix": "offline",
        })
        self.assertEqual(saved.status_code, 201)
        self.assertEqual(saved.json()["parsed_by"], "fallback")
        self.assertEqual(saved.json()["created"][0]["amount"], 350)
        self.assertEqual(self.client.post("/api/transactions/parse", json={"text": "  "}).status_code, 422)

    def test_openai_error_and_timeout(self):
        for timeout in (False, True):
            with self.subTest(timeout=timeout):
                def handler(request):
                    if timeout:
                        raise httpx.ReadTimeout("mock timeout", request=request)
                    return httpx.Response(503, json={"error": {"message": "mock error"}})

                self.mock_openai(handler)
                response = self.client.post("/api/transactions/parse", json={"text": TEXT})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["parsed_by"], "fallback")
                self.assertEqual(
                    [row["amount"] for row in response.json()["transactions"]], [350, 2500, 80000]
                )

    def test_quick_add_rolls_back_on_id_conflict(self):
        self.assertEqual(self.client.post("/api/transactions", json={
            "amount": 20, "type": "expense", "category": "Другое", "client_tx_id": "collision:2",
        }).status_code, 201)
        response = self.client.post("/api/transactions/quick-add", json={
            "text": "кофе 350, такси 550", "client_tx_id_prefix": "collision",
        })
        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            [row["client_tx_id"] for row in self.client.get("/api/transactions").json()],
            ["collision:2"],
        )
