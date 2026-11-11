"""Routes of orders: HTTP in, service calls, HTTP out."""

from fastapi import APIRouter, Depends, Query, Response

from app.dependencies import get_order_service
from app.schemas.order import Order, OrderCreate, OrderPage, OrderUpdate
from app.services.order import OrderService

router = APIRouter(tags=["orders"])


@router.get(
    "/orders",
    response_model=OrderPage,
    status_code=200,
    summary="List orders",
    operation_id="listOrders",
)
def list_orders(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    service: OrderService = Depends(get_order_service),
) -> OrderPage:
    """List orders."""
    filters: dict[str, object] = {}
    items, total = service.list_orders(filters, None, (page - 1) * size, size)
    return OrderPage(items=[Order.model_validate(item) for item in items], total=total, page=page, size=size)


@router.get(
    "/orders/{id}",
    response_model=Order,
    status_code=200,
    summary="Get an order",
    operation_id="getOrder",
)
def get_order(
    id: int,
    service: OrderService = Depends(get_order_service),
) -> Order:
    """Get an order."""
    return Order.model_validate(service.get_order(id))


@router.post(
    "/orders",
    response_model=Order,
    status_code=201,
    summary="Create an order",
    operation_id="createOrder",
)
def create_order(
    data: OrderCreate,
    service: OrderService = Depends(get_order_service),
) -> Order:
    """Create an order."""
    return Order.model_validate(service.create_order(data))


@router.put(
    "/orders/{id}",
    response_model=Order,
    status_code=200,
    summary="Replace an order",
    operation_id="replaceOrder",
)
def replace_order(
    id: int,
    data: OrderCreate,
    service: OrderService = Depends(get_order_service),
) -> Order:
    """Replace an order."""
    return Order.model_validate(service.replace_order(id, data))


@router.patch(
    "/orders/{id}",
    response_model=Order,
    status_code=200,
    summary="Update part of an order",
    operation_id="updateOrder",
)
def update_order(
    id: int,
    data: OrderUpdate,
    service: OrderService = Depends(get_order_service),
) -> Order:
    """Update part of an order."""
    return Order.model_validate(service.update_order(id, data))


@router.delete(
    "/orders/{id}",
    status_code=204,
    summary="Delete an order",
    operation_id="deleteOrder",
    response_class=Response,
)
def delete_order(
    id: int,
    service: OrderService = Depends(get_order_service),
) -> Response:
    """Delete an order."""
    service.delete_order(id)
    return Response(status_code=204)
