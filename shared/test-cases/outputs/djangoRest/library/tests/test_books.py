"""Tests of the books endpoints."""


from rest_framework.test import APITestCase

from tests.helpers import TEST_SETTINGS, authorize, book_payload, create_book


@TEST_SETTINGS
class BooksTests(APITestCase):
    """Every test starts with an empty database and a client allowed to call every endpoint."""

    def setUp(self) -> None:
        authorize(self.client)

    def test_create_book(self) -> None:
        payload = book_payload(self.client)
        response = self.client.post("/books", payload, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        created = response.json()
        self.assertIsNotNone(created["id"])
        self.assertEqual(created["title"], payload["title"])
        self.assertEqual(created["isbn"], payload["isbn"])
        self.assertEqual(created["genre"], payload["genre"])
        self.assertEqual(created["pages"], payload["pages"])
        self.assertEqual(created["available"], payload["available"])

    def test_create_book_without_title(self) -> None:
        payload = book_payload(self.client)
        del payload["title"]
        response = self.client.post("/books", payload, format="json")
        self.assertEqual(response.status_code, 400)
        error = response.json()["error"]
        self.assertEqual(error["code"], "validation_error")
        self.assertTrue(any(detail["field"] == "title" for detail in error["details"]))

    def test_get_book(self) -> None:
        created = create_book(self.client)
        key = created["id"]
        response = self.client.get(f"/books/{key}")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), created)

    def test_get_missing_book(self) -> None:
        response = self.client.get("/books/00000000-0000-0000-0000-000000000000")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "not_found")

    def test_list_books(self) -> None:
        create_book(self.client)
        create_book(self.client, variant=1)
        response = self.client.get("/books")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["total"], 2)
        self.assertEqual(response.json()["page"], 1)

    def test_list_books_by_page(self) -> None:
        create_book(self.client)
        create_book(self.client, variant=1)
        response = self.client.get("/books", {"page": 2, "size": 1})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["total"], 2)
        self.assertEqual(len(response.json()["items"]), 1)

    def test_list_books_rejects_a_bad_page(self) -> None:
        response = self.client.get("/books", {"page": 0})
        self.assertEqual(response.status_code, 400)

    def test_replace_book(self) -> None:
        created = create_book(self.client)
        key = created["id"]
        payload = book_payload(self.client, variant=1)
        response = self.client.put(f"/books/{key}", payload, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["title"], payload["title"])
        self.assertEqual(response.json()["isbn"], payload["isbn"])
        self.assertEqual(response.json()["genre"], payload["genre"])
        self.assertEqual(response.json()["pages"], payload["pages"])
        self.assertEqual(response.json()["available"], payload["available"])

    def test_update_book(self) -> None:
        created = create_book(self.client)
        key = created["id"]
        response = self.client.patch(f"/books/{key}", {"title": "title 2"}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["title"], "title 2")

    def test_update_book_rejects_null(self) -> None:
        created = create_book(self.client)
        key = created["id"]
        response = self.client.patch(f"/books/{key}", {"title": None}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_delete_book(self) -> None:
        created = create_book(self.client)
        key = created["id"]
        response = self.client.delete(f"/books/{key}")
        self.assertEqual(response.status_code, 204, response.content)
        self.assertEqual(self.client.get(f"/books/{key}").status_code, 404)
