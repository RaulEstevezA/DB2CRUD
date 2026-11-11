"""Rules of each resource: what each operation checks and changes."""

from typing import Any

from api.models import Category, Item
from config.errors import NotFoundError


# JSON names of the fields of categories a list can be sorted by, and their ORM names
_SORT_FIELDS_CATEGORY = {"id": "id", "name": "name", "parentId": "parent_id"}


class CategoryService:
    """Rules of categories."""

    @staticmethod
    def find(key: Any) -> Category:
        try:
            return Category.objects.get(pk=key)
        except (Category.DoesNotExist, ValueError, TypeError) as error:
            raise NotFoundError("category") from error

    @staticmethod
    def list_categories(filters: dict[str, Any], sort: str | None, offset: int, limit: int | None) -> tuple[list[Category], int]:
        """List categories: `sort` is a JSON field name, with a leading "-" for descending order."""
        query = Category.objects.filter(**filters)
        if sort:
            field = _SORT_FIELDS_CATEGORY[sort.lstrip("-")]
            query = query.order_by(("-" if sort.startswith("-") else "") + field, "pk")
        total = query.count()
        items = query[offset : offset + limit] if limit is not None else query
        return list(items), total

    @staticmethod
    def get_category(key: Any) -> Category:
        """Get a category."""
        return CategoryService.find(key)

    @staticmethod
    def create_category(data: dict[str, Any]) -> Category:
        """Create a category."""
        return Category.objects.create(**data)

    @staticmethod
    def replace_category(key: Any, data: dict[str, Any]) -> Category:
        """Replace a category: every field the client may send takes the value of the body."""
        item = CategoryService.find(key)
        for field in ("name", "parent"):
            setattr(item, field, data.get(field))
        item.save()
        return item

    @staticmethod
    def update_category(key: Any, data: dict[str, Any]) -> Category:
        """Update part of a category: only the fields in the body change."""
        item = CategoryService.find(key)
        for field, value in data.items():
            setattr(item, field, value)
        item.save()
        return item

    @staticmethod
    def delete_category(key: Any) -> None:
        """Delete a category."""
        CategoryService.find(key).delete()


# JSON names of the fields of items a list can be sorted by, and their ORM names
_SORT_FIELDS_ITEM = {"id": "id", "name": "name", "price": "price", "supplierEmail": "supplier_email", "categoryId": "category_id", "stock": "stock"}


class ItemService:
    """Rules of items."""

    @staticmethod
    def find(key: Any) -> Item:
        try:
            return Item.objects.get(pk=key)
        except (Item.DoesNotExist, ValueError, TypeError) as error:
            raise NotFoundError("item") from error

    @staticmethod
    def list_items(filters: dict[str, Any], sort: str | None, offset: int, limit: int | None) -> tuple[list[Item], int]:
        """List items: `sort` is a JSON field name, with a leading "-" for descending order."""
        query = Item.objects.filter(**filters)
        if sort:
            field = _SORT_FIELDS_ITEM[sort.lstrip("-")]
            query = query.order_by(("-" if sort.startswith("-") else "") + field, "pk")
        total = query.count()
        items = query[offset : offset + limit] if limit is not None else query
        return list(items), total

    @staticmethod
    def get_item(key: Any) -> Item:
        """Get an item."""
        return ItemService.find(key)

    @staticmethod
    def create_item(data: dict[str, Any]) -> Item:
        """Create an item."""
        return Item.objects.create(**data)

    @staticmethod
    def replace_item(key: Any, data: dict[str, Any]) -> Item:
        """Replace an item: every field the client may send takes the value of the body."""
        item = ItemService.find(key)
        for field in ("name", "price", "supplier_email", "category", "stock"):
            setattr(item, field, data.get(field))
        item.save()
        return item

    @staticmethod
    def update_item(key: Any, data: dict[str, Any]) -> Item:
        """Update part of an item: only the fields in the body change."""
        item = ItemService.find(key)
        for field, value in data.items():
            setattr(item, field, value)
        item.save()
        return item

    @staticmethod
    def delete_item(key: Any) -> None:
        """Delete an item."""
        ItemService.find(key).delete()
