"""Tests of the products endpoints."""


from rest_framework.test import APITestCase

from tests.helpers import TEST_SETTINGS, authorize, create_product, product_payload


@TEST_SETTINGS
class ProductsTests(APITestCase):
    """Every test starts with an empty database and a client allowed to call every endpoint."""

    def setUp(self) -> None:
        authorize(self.client)

    def test_create_product(self) -> None:
        payload = product_payload(self.client)
        response = self.client.post("/products", payload, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        created = response.json()
        self.assertIsNotNone(created["id"])
        self.assertEqual(created["sku"], payload["sku"])
        self.assertEqual(created["name"], payload["name"])
        self.assertEqual(created["description"], payload["description"])
        self.assertEqual(created["active"], payload["active"])

    def test_create_product_without_sku(self) -> None:
        payload = product_payload(self.client)
        del payload["sku"]
        response = self.client.post("/products", payload, format="json")
        self.assertEqual(response.status_code, 400)
        error = response.json()["error"]
        self.assertEqual(error["code"], "validation_error")
        self.assertTrue(any(detail["field"] == "sku" for detail in error["details"]))

    def test_get_product(self) -> None:
        created = create_product(self.client)
        key = created["id"]
        response = self.client.get(f"/products/{key}")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), created)

    def test_get_missing_product(self) -> None:
        response = self.client.get("/products/999999")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "not_found")

    def test_list_products(self) -> None:
        create_product(self.client)
        create_product(self.client, variant=1)
        response = self.client.get("/products")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["total"], 2)
        self.assertEqual(response.json()["page"], 1)

    def test_list_products_by_page(self) -> None:
        create_product(self.client)
        create_product(self.client, variant=1)
        response = self.client.get("/products", {"page": 2, "size": 1})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["total"], 2)
        self.assertEqual(len(response.json()["items"]), 1)

    def test_list_products_rejects_a_bad_page(self) -> None:
        response = self.client.get("/products", {"page": 0})
        self.assertEqual(response.status_code, 400)

    def test_replace_product(self) -> None:
        created = create_product(self.client)
        key = created["id"]
        payload = product_payload(self.client, variant=1)
        response = self.client.put(f"/products/{key}", payload, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["sku"], payload["sku"])
        self.assertEqual(response.json()["name"], payload["name"])
        self.assertEqual(response.json()["description"], payload["description"])
        self.assertEqual(response.json()["active"], payload["active"])

    def test_update_product(self) -> None:
        created = create_product(self.client)
        key = created["id"]
        response = self.client.patch(f"/products/{key}", {"sku": "sku 2"}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["sku"], "sku 2")

    def test_update_product_rejects_null(self) -> None:
        created = create_product(self.client)
        key = created["id"]
        response = self.client.patch(f"/products/{key}", {"sku": None}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_delete_product(self) -> None:
        created = create_product(self.client)
        key = created["id"]
        response = self.client.delete(f"/products/{key}")
        self.assertEqual(response.status_code, 204, response.content)
        self.assertEqual(self.client.get(f"/products/{key}").status_code, 404)
