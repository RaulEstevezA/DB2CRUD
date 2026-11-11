"""Tests of the authors endpoints."""


from rest_framework.test import APITestCase

from tests.helpers import TEST_SETTINGS, author_payload, authorize, create_author


@TEST_SETTINGS
class AuthorsTests(APITestCase):
    """Every test starts with an empty database and a client allowed to call every endpoint."""

    def setUp(self) -> None:
        authorize(self.client)

    def test_create_author(self) -> None:
        payload = author_payload(self.client)
        response = self.client.post("/authors", payload, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        created = response.json()
        self.assertIsNotNone(created["id"])
        self.assertEqual(created["name"], payload["name"])

    def test_create_author_without_name(self) -> None:
        payload = author_payload(self.client)
        del payload["name"]
        response = self.client.post("/authors", payload, format="json")
        self.assertEqual(response.status_code, 400)
        error = response.json()["error"]
        self.assertEqual(error["code"], "validation_error")
        self.assertTrue(any(detail["field"] == "name" for detail in error["details"]))

    def test_get_author(self) -> None:
        created = create_author(self.client)
        key = created["id"]
        response = self.client.get(f"/authors/{key}")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), created)

    def test_get_missing_author(self) -> None:
        response = self.client.get("/authors/00000000-0000-0000-0000-000000000000")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "not_found")

    def test_list_authors(self) -> None:
        create_author(self.client)
        create_author(self.client, variant=1)
        response = self.client.get("/authors")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["total"], 2)
        self.assertEqual(response.json()["page"], 1)

    def test_list_authors_by_page(self) -> None:
        create_author(self.client)
        create_author(self.client, variant=1)
        response = self.client.get("/authors", {"page": 2, "size": 1})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["total"], 2)
        self.assertEqual(len(response.json()["items"]), 1)

    def test_list_authors_rejects_a_bad_page(self) -> None:
        response = self.client.get("/authors", {"page": 0})
        self.assertEqual(response.status_code, 400)

    def test_replace_author(self) -> None:
        created = create_author(self.client)
        key = created["id"]
        payload = author_payload(self.client, variant=1)
        response = self.client.put(f"/authors/{key}", payload, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["name"], payload["name"])

    def test_update_author(self) -> None:
        created = create_author(self.client)
        key = created["id"]
        response = self.client.patch(f"/authors/{key}", {"name": "name 2"}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["name"], "name 2")

    def test_update_author_rejects_null(self) -> None:
        created = create_author(self.client)
        key = created["id"]
        response = self.client.patch(f"/authors/{key}", {"name": None}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_delete_author(self) -> None:
        created = create_author(self.client)
        key = created["id"]
        response = self.client.delete(f"/authors/{key}")
        self.assertEqual(response.status_code, 204, response.content)
        self.assertEqual(self.client.get(f"/authors/{key}").status_code, 404)
