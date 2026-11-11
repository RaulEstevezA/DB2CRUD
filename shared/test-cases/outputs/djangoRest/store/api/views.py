"""Views of the API: HTTP in, service calls, HTTP out."""

from api.serializers import CustomerSerializer, OrderSerializer, ProductSerializer
from api.services import CustomerService, OrderService, ProductService
from rest_framework import serializers
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView


class ListCustomersQuery(serializers.Serializer):
    """Query parameters of list customers."""

    page = serializers.IntegerField(min_value=1, default=1)
    size = serializers.IntegerField(min_value=1, max_value=100, default=20)


class ListCustomersView(APIView):
    """/customers"""

    # Who may call each method of this path
    rules = {
        "GET": [AllowAny()],
        "POST": [AllowAny()],
    }

    def get_permissions(self):  # type: ignore[no-untyped-def]
        return self.rules.get(self.request.method, [])

    def get(self, request: Request) -> Response:
        """List customers."""
        parameters = ListCustomersQuery(data=request.query_params)
        parameters.is_valid(raise_exception=True)
        query = parameters.validated_data
        filters: dict[str, object] = {}
        items, total = CustomerService.list_customers(filters, None, (query["page"] - 1) * query["size"], query["size"])
        return Response({"items": CustomerSerializer(items, many=True).data, "total": total, "page": query["page"], "size": query["size"]}, status=200)

    def post(self, request: Request) -> Response:
        """Create a customer."""
        serializer = CustomerSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(CustomerSerializer(CustomerService.create_customer(dict(serializer.validated_data))).data, status=201)


class GetCustomerView(APIView):
    """/customers/{id}"""

    # Who may call each method of this path
    rules = {
        "GET": [AllowAny()],
        "PUT": [AllowAny()],
        "PATCH": [AllowAny()],
        "DELETE": [AllowAny()],
    }

    def get_permissions(self):  # type: ignore[no-untyped-def]
        return self.rules.get(self.request.method, [])

    def get(self, request: Request, id: str) -> Response:
        """Get a customer."""
        return Response(CustomerSerializer(CustomerService.get_customer(id)).data, status=200)

    def put(self, request: Request, id: str) -> Response:
        """Replace a customer."""
        serializer = CustomerSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(CustomerSerializer(CustomerService.replace_customer(id, dict(serializer.validated_data))).data, status=200)

    def patch(self, request: Request, id: str) -> Response:
        """Update part of a customer."""
        serializer = CustomerSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        return Response(CustomerSerializer(CustomerService.update_customer(id, dict(serializer.validated_data))).data, status=200)

    def delete(self, request: Request, id: str) -> Response:
        """Delete a customer."""
        CustomerService.delete_customer(id)
        return Response(status=204)


class ListProductsQuery(serializers.Serializer):
    """Query parameters of list products."""

    page = serializers.IntegerField(min_value=1, default=1)
    size = serializers.IntegerField(min_value=1, max_value=100, default=20)


class ListProductsView(APIView):
    """/products"""

    # Who may call each method of this path
    rules = {
        "GET": [AllowAny()],
        "POST": [AllowAny()],
    }

    def get_permissions(self):  # type: ignore[no-untyped-def]
        return self.rules.get(self.request.method, [])

    def get(self, request: Request) -> Response:
        """List products."""
        parameters = ListProductsQuery(data=request.query_params)
        parameters.is_valid(raise_exception=True)
        query = parameters.validated_data
        filters: dict[str, object] = {}
        items, total = ProductService.list_products(filters, None, (query["page"] - 1) * query["size"], query["size"])
        return Response({"items": ProductSerializer(items, many=True).data, "total": total, "page": query["page"], "size": query["size"]}, status=200)

    def post(self, request: Request) -> Response:
        """Create a product."""
        serializer = ProductSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(ProductSerializer(ProductService.create_product(dict(serializer.validated_data))).data, status=201)


class GetProductView(APIView):
    """/products/{id}"""

    # Who may call each method of this path
    rules = {
        "GET": [AllowAny()],
        "PUT": [AllowAny()],
        "PATCH": [AllowAny()],
        "DELETE": [AllowAny()],
    }

    def get_permissions(self):  # type: ignore[no-untyped-def]
        return self.rules.get(self.request.method, [])

    def get(self, request: Request, id: str) -> Response:
        """Get a product."""
        return Response(ProductSerializer(ProductService.get_product(id)).data, status=200)

    def put(self, request: Request, id: str) -> Response:
        """Replace a product."""
        serializer = ProductSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(ProductSerializer(ProductService.replace_product(id, dict(serializer.validated_data))).data, status=200)

    def patch(self, request: Request, id: str) -> Response:
        """Update part of a product."""
        serializer = ProductSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        return Response(ProductSerializer(ProductService.update_product(id, dict(serializer.validated_data))).data, status=200)

    def delete(self, request: Request, id: str) -> Response:
        """Delete a product."""
        ProductService.delete_product(id)
        return Response(status=204)


class ListOrdersQuery(serializers.Serializer):
    """Query parameters of list orders."""

    page = serializers.IntegerField(min_value=1, default=1)
    size = serializers.IntegerField(min_value=1, max_value=100, default=20)


class ListOrdersView(APIView):
    """/orders"""

    # Who may call each method of this path
    rules = {
        "GET": [AllowAny()],
        "POST": [AllowAny()],
    }

    def get_permissions(self):  # type: ignore[no-untyped-def]
        return self.rules.get(self.request.method, [])

    def get(self, request: Request) -> Response:
        """List orders."""
        parameters = ListOrdersQuery(data=request.query_params)
        parameters.is_valid(raise_exception=True)
        query = parameters.validated_data
        filters: dict[str, object] = {}
        items, total = OrderService.list_orders(filters, None, (query["page"] - 1) * query["size"], query["size"])
        return Response({"items": OrderSerializer(items, many=True).data, "total": total, "page": query["page"], "size": query["size"]}, status=200)

    def post(self, request: Request) -> Response:
        """Create an order."""
        serializer = OrderSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(OrderSerializer(OrderService.create_order(dict(serializer.validated_data))).data, status=201)


class GetOrderView(APIView):
    """/orders/{id}"""

    # Who may call each method of this path
    rules = {
        "GET": [AllowAny()],
        "PUT": [AllowAny()],
        "PATCH": [AllowAny()],
        "DELETE": [AllowAny()],
    }

    def get_permissions(self):  # type: ignore[no-untyped-def]
        return self.rules.get(self.request.method, [])

    def get(self, request: Request, id: str) -> Response:
        """Get an order."""
        return Response(OrderSerializer(OrderService.get_order(id)).data, status=200)

    def put(self, request: Request, id: str) -> Response:
        """Replace an order."""
        serializer = OrderSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(OrderSerializer(OrderService.replace_order(id, dict(serializer.validated_data))).data, status=200)

    def patch(self, request: Request, id: str) -> Response:
        """Update part of an order."""
        serializer = OrderSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        return Response(OrderSerializer(OrderService.update_order(id, dict(serializer.validated_data))).data, status=200)

    def delete(self, request: Request, id: str) -> Response:
        """Delete an order."""
        OrderService.delete_order(id)
        return Response(status=204)
