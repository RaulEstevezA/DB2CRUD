"""Routes of items: HTTP in, service calls, HTTP out."""

from fastapi import APIRouter, Depends, Query, Response

from app.dependencies import get_item_service
from app.schemas.item import Item, ItemCreate, ItemPage, ItemUpdate
from app.services.item import ItemService

router = APIRouter(tags=["items"])


@router.get(
    "/items",
    response_model=ItemPage,
    status_code=200,
    summary="List items",
    operation_id="listItems",
)
def list_items(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    service: ItemService = Depends(get_item_service),
) -> ItemPage:
    """List items."""
    filters: dict[str, object] = {}
    items, total = service.list_items(filters, None, (page - 1) * size, size)
    return ItemPage(items=[Item.model_validate(item) for item in items], total=total, page=page, size=size)


@router.get(
    "/items/{id}",
    response_model=Item,
    status_code=200,
    summary="Get an item",
    operation_id="getItem",
)
def get_item(
    id: int,
    service: ItemService = Depends(get_item_service),
) -> Item:
    """Get an item."""
    return Item.model_validate(service.get_item(id))


@router.post(
    "/items",
    response_model=Item,
    status_code=201,
    summary="Create an item",
    operation_id="createItem",
)
def create_item(
    data: ItemCreate,
    service: ItemService = Depends(get_item_service),
) -> Item:
    """Create an item."""
    return Item.model_validate(service.create_item(data))


@router.put(
    "/items/{id}",
    response_model=Item,
    status_code=200,
    summary="Replace an item",
    operation_id="replaceItem",
)
def replace_item(
    id: int,
    data: ItemCreate,
    service: ItemService = Depends(get_item_service),
) -> Item:
    """Replace an item."""
    return Item.model_validate(service.replace_item(id, data))


@router.patch(
    "/items/{id}",
    response_model=Item,
    status_code=200,
    summary="Update part of an item",
    operation_id="updateItem",
)
def update_item(
    id: int,
    data: ItemUpdate,
    service: ItemService = Depends(get_item_service),
) -> Item:
    """Update part of an item."""
    return Item.model_validate(service.update_item(id, data))


@router.delete(
    "/items/{id}",
    status_code=204,
    summary="Delete an item",
    operation_id="deleteItem",
    response_class=Response,
)
def delete_item(
    id: int,
    service: ItemService = Depends(get_item_service),
) -> Response:
    """Delete an item."""
    service.delete_item(id)
    return Response(status_code=204)
