"""Routes of books: HTTP in, service calls, HTTP out."""

from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from app.dependencies import get_book_service
from app.schemas.book import Book, BookCreate, BookPage, BookUpdate
from app.services.book import BookService

router = APIRouter(tags=["books"])


@router.get(
    "/books",
    response_model=BookPage,
    status_code=200,
    summary="List books",
    operation_id="listBooks",
)
def list_books(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    service: BookService = Depends(get_book_service),
) -> BookPage:
    """List books."""
    filters: dict[str, object] = {}
    items, total = service.list_books(filters, None, (page - 1) * size, size)
    return BookPage(items=[Book.model_validate(item) for item in items], total=total, page=page, size=size)


@router.get(
    "/books/{id}",
    response_model=Book,
    status_code=200,
    summary="Get a book",
    operation_id="getBook",
)
def get_book(
    id: UUID,
    service: BookService = Depends(get_book_service),
) -> Book:
    """Get a book."""
    return Book.model_validate(service.get_book(id))


@router.post(
    "/books",
    response_model=Book,
    status_code=201,
    summary="Create a book",
    operation_id="createBook",
)
def create_book(
    data: BookCreate,
    service: BookService = Depends(get_book_service),
) -> Book:
    """Create a book."""
    return Book.model_validate(service.create_book(data))


@router.put(
    "/books/{id}",
    response_model=Book,
    status_code=200,
    summary="Replace a book",
    operation_id="replaceBook",
)
def replace_book(
    id: UUID,
    data: BookCreate,
    service: BookService = Depends(get_book_service),
) -> Book:
    """Replace a book."""
    return Book.model_validate(service.replace_book(id, data))


@router.patch(
    "/books/{id}",
    response_model=Book,
    status_code=200,
    summary="Update part of a book",
    operation_id="updateBook",
)
def update_book(
    id: UUID,
    data: BookUpdate,
    service: BookService = Depends(get_book_service),
) -> Book:
    """Update part of a book."""
    return Book.model_validate(service.update_book(id, data))


@router.delete(
    "/books/{id}",
    status_code=204,
    summary="Delete a book",
    operation_id="deleteBook",
    response_class=Response,
)
def delete_book(
    id: UUID,
    service: BookService = Depends(get_book_service),
) -> Response:
    """Delete a book."""
    service.delete_book(id)
    return Response(status_code=204)
