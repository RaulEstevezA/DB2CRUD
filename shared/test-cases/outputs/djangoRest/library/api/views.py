"""Views of the API: HTTP in, service calls, HTTP out."""

from api.serializers import AuthorSerializer, BookSerializer
from api.services import AuthorService, BookService
from rest_framework import serializers
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView


class ListAuthorsQuery(serializers.Serializer):
    """Query parameters of list authors."""

    page = serializers.IntegerField(min_value=1, default=1)
    size = serializers.IntegerField(min_value=1, max_value=100, default=20)


class ListAuthorsView(APIView):
    """/authors"""

    # Who may call each method of this path
    rules = {
        "GET": [AllowAny()],
        "POST": [AllowAny()],
    }

    def get_permissions(self):  # type: ignore[no-untyped-def]
        return self.rules.get(self.request.method, [])

    def get(self, request: Request) -> Response:
        """List authors."""
        parameters = ListAuthorsQuery(data=request.query_params)
        parameters.is_valid(raise_exception=True)
        query = parameters.validated_data
        filters: dict[str, object] = {}
        items, total = AuthorService.list_authors(filters, None, (query["page"] - 1) * query["size"], query["size"])
        return Response({"items": AuthorSerializer(items, many=True).data, "total": total, "page": query["page"], "size": query["size"]}, status=200)

    def post(self, request: Request) -> Response:
        """Create an author."""
        serializer = AuthorSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(AuthorSerializer(AuthorService.create_author(dict(serializer.validated_data))).data, status=201)


class GetAuthorView(APIView):
    """/authors/{id}"""

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
        """Get an author."""
        return Response(AuthorSerializer(AuthorService.get_author(id)).data, status=200)

    def put(self, request: Request, id: str) -> Response:
        """Replace an author."""
        serializer = AuthorSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(AuthorSerializer(AuthorService.replace_author(id, dict(serializer.validated_data))).data, status=200)

    def patch(self, request: Request, id: str) -> Response:
        """Update part of an author."""
        serializer = AuthorSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        return Response(AuthorSerializer(AuthorService.update_author(id, dict(serializer.validated_data))).data, status=200)

    def delete(self, request: Request, id: str) -> Response:
        """Delete an author."""
        AuthorService.delete_author(id)
        return Response(status=204)


class ListBooksQuery(serializers.Serializer):
    """Query parameters of list books."""

    page = serializers.IntegerField(min_value=1, default=1)
    size = serializers.IntegerField(min_value=1, max_value=100, default=20)


class ListBooksView(APIView):
    """/books"""

    # Who may call each method of this path
    rules = {
        "GET": [AllowAny()],
        "POST": [AllowAny()],
    }

    def get_permissions(self):  # type: ignore[no-untyped-def]
        return self.rules.get(self.request.method, [])

    def get(self, request: Request) -> Response:
        """List books."""
        parameters = ListBooksQuery(data=request.query_params)
        parameters.is_valid(raise_exception=True)
        query = parameters.validated_data
        filters: dict[str, object] = {}
        items, total = BookService.list_books(filters, None, (query["page"] - 1) * query["size"], query["size"])
        return Response({"items": BookSerializer(items, many=True).data, "total": total, "page": query["page"], "size": query["size"]}, status=200)

    def post(self, request: Request) -> Response:
        """Create a book."""
        serializer = BookSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(BookSerializer(BookService.create_book(dict(serializer.validated_data))).data, status=201)


class GetBookView(APIView):
    """/books/{id}"""

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
        """Get a book."""
        return Response(BookSerializer(BookService.get_book(id)).data, status=200)

    def put(self, request: Request, id: str) -> Response:
        """Replace a book."""
        serializer = BookSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(BookSerializer(BookService.replace_book(id, dict(serializer.validated_data))).data, status=200)

    def patch(self, request: Request, id: str) -> Response:
        """Update part of a book."""
        serializer = BookSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        return Response(BookSerializer(BookService.update_book(id, dict(serializer.validated_data))).data, status=200)

    def delete(self, request: Request, id: str) -> Response:
        """Delete a book."""
        BookService.delete_book(id)
        return Response(status=204)
