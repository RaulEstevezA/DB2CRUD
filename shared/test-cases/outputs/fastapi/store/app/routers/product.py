"""Routes of products: HTTP in, service calls, HTTP out."""

from fastapi import APIRouter, Depends, Query, Response

from app.dependencies import get_product_service
from app.schemas.product import Product, ProductCreate, ProductPage, ProductUpdate
from app.services.product import ProductService

router = APIRouter(tags=["products"])


@router.get(
    "/products",
    response_model=ProductPage,
    status_code=200,
    summary="List products",
    operation_id="listProducts",
)
def list_products(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    service: ProductService = Depends(get_product_service),
) -> ProductPage:
    """List products."""
    filters: dict[str, object] = {}
    items, total = service.list_products(filters, None, (page - 1) * size, size)
    return ProductPage(items=[Product.model_validate(item) for item in items], total=total, page=page, size=size)


@router.get(
    "/products/{id}",
    response_model=Product,
    status_code=200,
    summary="Get a product",
    operation_id="getProduct",
)
def get_product(
    id: int,
    service: ProductService = Depends(get_product_service),
) -> Product:
    """Get a product."""
    return Product.model_validate(service.get_product(id))


@router.post(
    "/products",
    response_model=Product,
    status_code=201,
    summary="Create a product",
    operation_id="createProduct",
)
def create_product(
    data: ProductCreate,
    service: ProductService = Depends(get_product_service),
) -> Product:
    """Create a product."""
    return Product.model_validate(service.create_product(data))


@router.put(
    "/products/{id}",
    response_model=Product,
    status_code=200,
    summary="Replace a product",
    operation_id="replaceProduct",
)
def replace_product(
    id: int,
    data: ProductCreate,
    service: ProductService = Depends(get_product_service),
) -> Product:
    """Replace a product."""
    return Product.model_validate(service.replace_product(id, data))


@router.patch(
    "/products/{id}",
    response_model=Product,
    status_code=200,
    summary="Update part of a product",
    operation_id="updateProduct",
)
def update_product(
    id: int,
    data: ProductUpdate,
    service: ProductService = Depends(get_product_service),
) -> Product:
    """Update part of a product."""
    return Product.model_validate(service.update_product(id, data))


@router.delete(
    "/products/{id}",
    status_code=204,
    summary="Delete a product",
    operation_id="deleteProduct",
    response_class=Response,
)
def delete_product(
    id: int,
    service: ProductService = Depends(get_product_service),
) -> Response:
    """Delete a product."""
    service.delete_product(id)
    return Response(status_code=204)
