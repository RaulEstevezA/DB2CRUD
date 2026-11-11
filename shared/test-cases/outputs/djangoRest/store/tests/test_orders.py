"""Tests of the orders endpoints."""


from rest_framework.test import APITestCase

from tests.helpers import TEST_SETTINGS, authorize, create_order, order_payload


@TEST_SETTINGS
class OrdersTests(APITestCase):
    """Every test starts with an empty database and a client allowed to call every endpoint."""

    def setUp(self) -> None:
        authorize(self.client)

    def test_create_order(self) -> None:
        payload = order_payload(self.client)
        response = self.client.post("/orders", payload, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        created = response.json()
        self.assertIsNotNone(created["id"])
        self.assertEqual(created["status"], payload["status"])
        self.assertEqual(created["notes"], payload["notes"])

    def test_create_order_without_lines(self) -> None:
        payload = order_payload(self.client)
        del payload["lines"]
        response = self.client.post("/orders", payload, format="json")
        self.assertEqual(response.status_code, 400)
        error = response.json()["error"]
        self.assertEqual(error["code"], "validation_error")
        self.assertTrue(any(detail["field"] == "lines" for detail in error["details"]))

    def test_get_order(self) -> None:
        created = create_order(self.client)
        key = created["id"]
        response = self.client.get(f"/orders/{key}")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), created)

    def test_get_missing_order(self) -> None:
        response = self.client.get("/orders/999999")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "not_found")

    def test_list_orders(self) -> None:
        create_order(self.client)
        create_order(self.client, variant=1)
        response = self.client.get("/orders")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["total"], 2)
        self.assertEqual(response.json()["page"], 1)

    def test_list_orders_by_page(self) -> None:
        create_order(self.client)
        create_order(self.client, variant=1)
        response = self.client.get("/orders", {"page": 2, "size": 1})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["total"], 2)
        self.assertEqual(len(response.json()["items"]), 1)

    def test_list_orders_rejects_a_bad_page(self) -> None:
        response = self.client.get("/orders", {"page": 0})
        self.assertEqual(response.status_code, 400)

    def test_replace_order(self) -> None:
        created = create_order(self.client)
        key = created["id"]
        payload = order_payload(self.client, variant=1)
        response = self.client.put(f"/orders/{key}", payload, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["status"], payload["status"])
        self.assertEqual(response.json()["notes"], payload["notes"])

    def test_update_order(self) -> None:
        created = create_order(self.client)
        key = created["id"]
        response = self.client.patch(f"/orders/{key}", {"total": 2}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["total"], 2)

    def test_update_order_rejects_null(self) -> None:
        created = create_order(self.client)
        key = created["id"]
        response = self.client.patch(f"/orders/{key}", {"total": None}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_delete_order(self) -> None:
        created = create_order(self.client)
        key = created["id"]
        response = self.client.delete(f"/orders/{key}")
        self.assertEqual(response.status_code, 204, response.content)
        self.assertEqual(self.client.get(f"/orders/{key}").status_code, 404)
