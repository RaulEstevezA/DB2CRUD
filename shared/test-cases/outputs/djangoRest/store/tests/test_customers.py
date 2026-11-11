"""Tests of the customers endpoints."""


from rest_framework.test import APITestCase

from tests.helpers import TEST_SETTINGS, authorize, create_customer, customer_payload


@TEST_SETTINGS
class CustomersTests(APITestCase):
    """Every test starts with an empty database and a client allowed to call every endpoint."""

    def setUp(self) -> None:
        authorize(self.client)

    def test_create_customer(self) -> None:
        payload = customer_payload(self.client)
        response = self.client.post("/customers", payload, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        created = response.json()
        self.assertIsNotNone(created["id"])
        self.assertEqual(created["name"], payload["name"])
        self.assertEqual(created["email"], payload["email"])
        self.assertEqual(created["phone"], payload["phone"])

    def test_create_customer_without_name(self) -> None:
        payload = customer_payload(self.client)
        del payload["name"]
        response = self.client.post("/customers", payload, format="json")
        self.assertEqual(response.status_code, 400)
        error = response.json()["error"]
        self.assertEqual(error["code"], "validation_error")
        self.assertTrue(any(detail["field"] == "name" for detail in error["details"]))

    def test_get_customer(self) -> None:
        created = create_customer(self.client)
        key = created["id"]
        response = self.client.get(f"/customers/{key}")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), created)

    def test_get_missing_customer(self) -> None:
        response = self.client.get("/customers/999999")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "not_found")

    def test_list_customers(self) -> None:
        create_customer(self.client)
        create_customer(self.client, variant=1)
        response = self.client.get("/customers")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["total"], 2)
        self.assertEqual(response.json()["page"], 1)

    def test_list_customers_by_page(self) -> None:
        create_customer(self.client)
        create_customer(self.client, variant=1)
        response = self.client.get("/customers", {"page": 2, "size": 1})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["total"], 2)
        self.assertEqual(len(response.json()["items"]), 1)

    def test_list_customers_rejects_a_bad_page(self) -> None:
        response = self.client.get("/customers", {"page": 0})
        self.assertEqual(response.status_code, 400)

    def test_replace_customer(self) -> None:
        created = create_customer(self.client)
        key = created["id"]
        payload = customer_payload(self.client, variant=1)
        response = self.client.put(f"/customers/{key}", payload, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["name"], payload["name"])
        self.assertEqual(response.json()["email"], payload["email"])
        self.assertEqual(response.json()["phone"], payload["phone"])

    def test_update_customer(self) -> None:
        created = create_customer(self.client)
        key = created["id"]
        response = self.client.patch(f"/customers/{key}", {"name": "name 2"}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["name"], "name 2")

    def test_update_customer_rejects_null(self) -> None:
        created = create_customer(self.client)
        key = created["id"]
        response = self.client.patch(f"/customers/{key}", {"name": None}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_delete_customer(self) -> None:
        created = create_customer(self.client)
        key = created["id"]
        response = self.client.delete(f"/customers/{key}")
        self.assertEqual(response.status_code, 204, response.content)
        self.assertEqual(self.client.get(f"/customers/{key}").status_code, 404)
