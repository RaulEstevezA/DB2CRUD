"""Which repository and service each request uses. Change the implementations here."""

from fastapi import Depends, Request

from app.repositories.category import CategoryRepository
from app.repositories.item import ItemRepository
from app.services.category import CategoryService
from app.services.item import ItemService


def get_category_repository(request: Request) -> CategoryRepository:
    """The storage of categories."""
    return request.app.state.repositories["category"]


def get_category_service(
    repository: CategoryRepository = Depends(get_category_repository),
) -> CategoryService:
    """The service of categories, with the storage of the resources it refers to."""
    return CategoryService(repository)


def get_item_repository(request: Request) -> ItemRepository:
    """The storage of items."""
    return request.app.state.repositories["item"]


def get_item_service(
    repository: ItemRepository = Depends(get_item_repository),
    categories: CategoryRepository = Depends(get_category_repository),
) -> ItemService:
    """The service of items, with the storage of the resources it refers to."""
    return ItemService(repository, categories)
