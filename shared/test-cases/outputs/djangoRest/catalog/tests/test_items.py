"""Tests of the items endpoints."""


from rest_framework.test import APITestCase

from tests.helpers import TEST_SETTINGS, authorize, create_item, item_payload


@TEST_SETTINGS
class ItemsTests(APITestCase):
    """Every test starts with an empty database and a client allowed to call every endpoint."""

    def setUp(self) -> None:
        authorize(self.client)

    def test_create_item(self) -> None:
        payload = item_payload(self.client)
        response = self.client.post("/items", payload, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        created = response.json()
        self.assertIsNotNone(created["id"])
        self.assertEqual(created["name"], payload["name"])
        self.assertEqual(created["stock"], payload["stock"])

    def test_create_item_without_name(self) -> None:
        payload = item_payload(self.client)
        del payload["name"]
        response = self.client.post("/items", payload, format="json")
        self.assertEqual(response.status_code, 400)
        error = response.json()["error"]
        self.assertEqual(error["code"], "validation_error")
        self.assertTrue(any(detail["field"] == "name" for detail in error["details"]))

    def test_get_item(self) -> None:
        created = create_item(self.client)
        key = created["id"]
        response = self.client.get(f"/items/{key}")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), created)

    def test_get_missing_item(self) -> None:
        response = self.client.get("/items/999999")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "not_found")

    def test_list_items(self) -> None:
        create_item(self.client)
        create_item(self.client, variant=1)
        response = self.client.get("/items")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["total"], 2)
        self.assertEqual(response.json()["page"], 1)

    def test_list_items_by_page(self) -> None:
        create_item(self.client)
        create_item(self.client, variant=1)
        response = self.client.get("/items", {"page": 2, "size": 1})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["total"], 2)
        self.assertEqual(len(response.json()["items"]), 1)

    def test_list_items_rejects_a_bad_page(self) -> None:
        response = self.client.get("/items", {"page": 0})
        self.assertEqual(response.status_code, 400)

    def test_replace_item(self) -> None:
        created = create_item(self.client)
        key = created["id"]
        payload = item_payload(self.client, variant=1)
        response = self.client.put(f"/items/{key}", payload, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["name"], payload["name"])
        self.assertEqual(response.json()["stock"], payload["stock"])

    def test_update_item(self) -> None:
        created = create_item(self.client)
        key = created["id"]
        response = self.client.patch(f"/items/{key}", {"name": "name 2"}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["name"], "name 2")

    def test_update_item_rejects_null(self) -> None:
        created = create_item(self.client)
        key = created["id"]
        response = self.client.patch(f"/items/{key}", {"name": None}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_delete_item(self) -> None:
        created = create_item(self.client)
        key = created["id"]
        response = self.client.delete(f"/items/{key}")
        self.assertEqual(response.status_code, 204, response.content)
        self.assertEqual(self.client.get(f"/items/{key}").status_code, 404)
