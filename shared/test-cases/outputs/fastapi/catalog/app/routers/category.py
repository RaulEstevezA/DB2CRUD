"""Routes of categories: HTTP in, service calls, HTTP out."""

from fastapi import APIRouter, Depends, Query, Response

from app.dependencies import get_category_service
from app.schemas.category import Category, CategoryCreate, CategoryPage, CategoryUpdate
from app.services.category import CategoryService

router = APIRouter(tags=["categories"])


@router.get(
    "/categories",
    response_model=CategoryPage,
    status_code=200,
    summary="List categories",
    operation_id="listCategories",
)
def list_categories(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    service: CategoryService = Depends(get_category_service),
) -> CategoryPage:
    """List categories."""
    filters: dict[str, object] = {}
    items, total = service.list_categories(filters, None, (page - 1) * size, size)
    return CategoryPage(items=[Category.model_validate(item) for item in items], total=total, page=page, size=size)


@router.get(
    "/categories/{id}",
    response_model=Category,
    status_code=200,
    summary="Get a category",
    operation_id="getCategory",
)
def get_category(
    id: int,
    service: CategoryService = Depends(get_category_service),
) -> Category:
    """Get a category."""
    return Category.model_validate(service.get_category(id))


@router.post(
    "/categories",
    response_model=Category,
    status_code=201,
    summary="Create a category",
    operation_id="createCategory",
)
def create_category(
    data: CategoryCreate,
    service: CategoryService = Depends(get_category_service),
) -> Category:
    """Create a category."""
    return Category.model_validate(service.create_category(data))


@router.put(
    "/categories/{id}",
    response_model=Category,
    status_code=200,
    summary="Replace a category",
    operation_id="replaceCategory",
)
def replace_category(
    id: int,
    data: CategoryCreate,
    service: CategoryService = Depends(get_category_service),
) -> Category:
    """Replace a category."""
    return Category.model_validate(service.replace_category(id, data))


@router.patch(
    "/categories/{id}",
    response_model=Category,
    status_code=200,
    summary="Update part of a category",
    operation_id="updateCategory",
)
def update_category(
    id: int,
    data: CategoryUpdate,
    service: CategoryService = Depends(get_category_service),
) -> Category:
    """Update part of a category."""
    return Category.model_validate(service.update_category(id, data))


@router.delete(
    "/categories/{id}",
    status_code=204,
    summary="Delete a category",
    operation_id="deleteCategory",
    response_class=Response,
)
def delete_category(
    id: int,
    service: CategoryService = Depends(get_category_service),
) -> Response:
    """Delete a category."""
    service.delete_category(id)
    return Response(status_code=204)
