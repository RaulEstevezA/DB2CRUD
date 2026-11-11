"""Routes of authors: HTTP in, service calls, HTTP out."""

from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from app.dependencies import get_author_service
from app.schemas.author import Author, AuthorCreate, AuthorPage, AuthorUpdate
from app.services.author import AuthorService

router = APIRouter(tags=["authors"])


@router.get(
    "/authors",
    response_model=AuthorPage,
    status_code=200,
    summary="List authors",
    operation_id="listAuthors",
)
def list_authors(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    service: AuthorService = Depends(get_author_service),
) -> AuthorPage:
    """List authors."""
    filters: dict[str, object] = {}
    items, total = service.list_authors(filters, None, (page - 1) * size, size)
    return AuthorPage(items=[Author.model_validate(item) for item in items], total=total, page=page, size=size)


@router.get(
    "/authors/{id}",
    response_model=Author,
    status_code=200,
    summary="Get an author",
    operation_id="getAuthor",
)
def get_author(
    id: UUID,
    service: AuthorService = Depends(get_author_service),
) -> Author:
    """Get an author."""
    return Author.model_validate(service.get_author(id))


@router.post(
    "/authors",
    response_model=Author,
    status_code=201,
    summary="Create an author",
    operation_id="createAuthor",
)
def create_author(
    data: AuthorCreate,
    service: AuthorService = Depends(get_author_service),
) -> Author:
    """Create an author."""
    return Author.model_validate(service.create_author(data))


@router.put(
    "/authors/{id}",
    response_model=Author,
    status_code=200,
    summary="Replace an author",
    operation_id="replaceAuthor",
)
def replace_author(
    id: UUID,
    data: AuthorCreate,
    service: AuthorService = Depends(get_author_service),
) -> Author:
    """Replace an author."""
    return Author.model_validate(service.replace_author(id, data))


@router.patch(
    "/authors/{id}",
    response_model=Author,
    status_code=200,
    summary="Update part of an author",
    operation_id="updateAuthor",
)
def update_author(
    id: UUID,
    data: AuthorUpdate,
    service: AuthorService = Depends(get_author_service),
) -> Author:
    """Update part of an author."""
    return Author.model_validate(service.update_author(id, data))


@router.delete(
    "/authors/{id}",
    status_code=204,
    summary="Delete an author",
    operation_id="deleteAuthor",
    response_class=Response,
)
def delete_author(
    id: UUID,
    service: AuthorService = Depends(get_author_service),
) -> Response:
    """Delete an author."""
    service.delete_author(id)
    return Response(status_code=204)
