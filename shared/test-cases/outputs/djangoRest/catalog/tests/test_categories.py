"""Tests of the categories endpoints."""


from rest_framework.test import APITestCase

from tests.helpers import TEST_SETTINGS, authorize, category_payload, create_category


@TEST_SETTINGS
class CategoriesTests(APITestCase):
    """Every test starts with an empty database and a client allowed to call every endpoint."""

    def setUp(self) -> None:
        authorize(self.client)

    def test_create_category(self) -> None:
        payload = category_payload(self.client)
        response = self.client.post("/categories", payload, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        created = response.json()
        self.assertIsNotNone(created["id"])
        self.assertEqual(created["name"], payload["name"])

    def test_create_category_without_name(self) -> None:
        payload = category_payload(self.client)
        del payload["name"]
        response = self.client.post("/categories", payload, format="json")
        self.assertEqual(response.status_code, 400)
        error = response.json()["error"]
        self.assertEqual(error["code"], "validation_error")
        self.assertTrue(any(detail["field"] == "name" for detail in error["details"]))

    def test_get_category(self) -> None:
        created = create_category(self.client)
        key = created["id"]
        response = self.client.get(f"/categories/{key}")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), created)

    def test_get_missing_category(self) -> None:
        response = self.client.get("/categories/999999")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "not_found")

    def test_list_categories(self) -> None:
        create_category(self.client)
        create_category(self.client, variant=1)
        response = self.client.get("/categories")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["total"], 2)
        self.assertEqual(response.json()["page"], 1)

    def test_list_categories_by_page(self) -> None:
        create_category(self.client)
        create_category(self.client, variant=1)
        response = self.client.get("/categories", {"page": 2, "size": 1})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["total"], 2)
        self.assertEqual(len(response.json()["items"]), 1)

    def test_list_categories_rejects_a_bad_page(self) -> None:
        response = self.client.get("/categories", {"page": 0})
        self.assertEqual(response.status_code, 400)

    def test_replace_category(self) -> None:
        created = create_category(self.client)
        key = created["id"]
        payload = category_payload(self.client, variant=1)
        response = self.client.put(f"/categories/{key}", payload, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["name"], payload["name"])

    def test_update_category(self) -> None:
        created = create_category(self.client)
        key = created["id"]
        response = self.client.patch(f"/categories/{key}", {"name": "name 2"}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["name"], "name 2")

    def test_update_category_rejects_null(self) -> None:
        created = create_category(self.client)
        key = created["id"]
        response = self.client.patch(f"/categories/{key}", {"name": None}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_delete_category(self) -> None:
        created = create_category(self.client)
        key = created["id"]
        response = self.client.delete(f"/categories/{key}")
        self.assertEqual(response.status_code, 204, response.content)
        self.assertEqual(self.client.get(f"/categories/{key}").status_code, 404)
