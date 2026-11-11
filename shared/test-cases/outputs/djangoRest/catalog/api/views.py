"""Views of the API: HTTP in, service calls, HTTP out."""

from api.serializers import CategorySerializer, ItemSerializer
from api.services import CategoryService, ItemService
from rest_framework import serializers
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView


class ListCategoriesQuery(serializers.Serializer):
    """Query parameters of list categories."""

    page = serializers.IntegerField(min_value=1, default=1)
    size = serializers.IntegerField(min_value=1, max_value=100, default=20)


class ListCategoriesView(APIView):
    """/categories"""

    # Who may call each method of this path
    rules = {
        "GET": [AllowAny()],
        "POST": [AllowAny()],
    }

    def get_permissions(self):  # type: ignore[no-untyped-def]
        return self.rules.get(self.request.method, [])

    def get(self, request: Request) -> Response:
        """List categories."""
        parameters = ListCategoriesQuery(data=request.query_params)
        parameters.is_valid(raise_exception=True)
        query = parameters.validated_data
        filters: dict[str, object] = {}
        items, total = CategoryService.list_categories(filters, None, (query["page"] - 1) * query["size"], query["size"])
        return Response({"items": CategorySerializer(items, many=True).data, "total": total, "page": query["page"], "size": query["size"]}, status=200)

    def post(self, request: Request) -> Response:
        """Create a category."""
        serializer = CategorySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(CategorySerializer(CategoryService.create_category(dict(serializer.validated_data))).data, status=201)


class GetCategoryView(APIView):
    """/categories/{id}"""

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
        """Get a category."""
        return Response(CategorySerializer(CategoryService.get_category(id)).data, status=200)

    def put(self, request: Request, id: str) -> Response:
        """Replace a category."""
        serializer = CategorySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(CategorySerializer(CategoryService.replace_category(id, dict(serializer.validated_data))).data, status=200)

    def patch(self, request: Request, id: str) -> Response:
        """Update part of a category."""
        serializer = CategorySerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        return Response(CategorySerializer(CategoryService.update_category(id, dict(serializer.validated_data))).data, status=200)

    def delete(self, request: Request, id: str) -> Response:
        """Delete a category."""
        CategoryService.delete_category(id)
        return Response(status=204)


class ListItemsQuery(serializers.Serializer):
    """Query parameters of list items."""

    page = serializers.IntegerField(min_value=1, default=1)
    size = serializers.IntegerField(min_value=1, max_value=100, default=20)


class ListItemsView(APIView):
    """/items"""

    # Who may call each method of this path
    rules = {
        "GET": [AllowAny()],
        "POST": [AllowAny()],
    }

    def get_permissions(self):  # type: ignore[no-untyped-def]
        return self.rules.get(self.request.method, [])

    def get(self, request: Request) -> Response:
        """List items."""
        parameters = ListItemsQuery(data=request.query_params)
        parameters.is_valid(raise_exception=True)
        query = parameters.validated_data
        filters: dict[str, object] = {}
        items, total = ItemService.list_items(filters, None, (query["page"] - 1) * query["size"], query["size"])
        return Response({"items": ItemSerializer(items, many=True).data, "total": total, "page": query["page"], "size": query["size"]}, status=200)

    def post(self, request: Request) -> Response:
        """Create an item."""
        serializer = ItemSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(ItemSerializer(ItemService.create_item(dict(serializer.validated_data))).data, status=201)


class GetItemView(APIView):
    """/items/{id}"""

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
        """Get an item."""
        return Response(ItemSerializer(ItemService.get_item(id)).data, status=200)

    def put(self, request: Request, id: str) -> Response:
        """Replace an item."""
        serializer = ItemSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(ItemSerializer(ItemService.replace_item(id, dict(serializer.validated_data))).data, status=200)

    def patch(self, request: Request, id: str) -> Response:
        """Update part of an item."""
        serializer = ItemSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        return Response(ItemSerializer(ItemService.update_item(id, dict(serializer.validated_data))).data, status=200)

    def delete(self, request: Request, id: str) -> Response:
        """Delete an item."""
        ItemService.delete_item(id)
        return Response(status=204)
