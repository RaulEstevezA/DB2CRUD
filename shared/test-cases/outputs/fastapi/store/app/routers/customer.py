"""Routes of customers: HTTP in, service calls, HTTP out."""

from fastapi import APIRouter, Depends, Query, Response

from app.dependencies import get_customer_service
from app.schemas.customer import Customer, CustomerCreate, CustomerPage, CustomerUpdate
from app.services.customer import CustomerService

router = APIRouter(tags=["customers"])


@router.get(
    "/customers",
    response_model=CustomerPage,
    status_code=200,
    summary="List customers",
    operation_id="listCustomers",
)
def list_customers(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    service: CustomerService = Depends(get_customer_service),
) -> CustomerPage:
    """List customers."""
    filters: dict[str, object] = {}
    items, total = service.list_customers(filters, None, (page - 1) * size, size)
    return CustomerPage(items=[Customer.model_validate(item) for item in items], total=total, page=page, size=size)


@router.get(
    "/customers/{id}",
    response_model=Customer,
    status_code=200,
    summary="Get a customer",
    operation_id="getCustomer",
)
def get_customer(
    id: int,
    service: CustomerService = Depends(get_customer_service),
) -> Customer:
    """Get a customer."""
    return Customer.model_validate(service.get_customer(id))


@router.post(
    "/customers",
    response_model=Customer,
    status_code=201,
    summary="Create a customer",
    operation_id="createCustomer",
)
def create_customer(
    data: CustomerCreate,
    service: CustomerService = Depends(get_customer_service),
) -> Customer:
    """Create a customer."""
    return Customer.model_validate(service.create_customer(data))


@router.put(
    "/customers/{id}",
    response_model=Customer,
    status_code=200,
    summary="Replace a customer",
    operation_id="replaceCustomer",
)
def replace_customer(
    id: int,
    data: CustomerCreate,
    service: CustomerService = Depends(get_customer_service),
) -> Customer:
    """Replace a customer."""
    return Customer.model_validate(service.replace_customer(id, data))


@router.patch(
    "/customers/{id}",
    response_model=Customer,
    status_code=200,
    summary="Update part of a customer",
    operation_id="updateCustomer",
)
def update_customer(
    id: int,
    data: CustomerUpdate,
    service: CustomerService = Depends(get_customer_service),
) -> Customer:
    """Update part of a customer."""
    return Customer.model_validate(service.update_customer(id, data))


@router.delete(
    "/customers/{id}",
    status_code=204,
    summary="Delete a customer",
    operation_id="deleteCustomer",
    response_class=Response,
)
def delete_customer(
    id: int,
    service: CustomerService = Depends(get_customer_service),
) -> Response:
    """Delete a customer."""
    service.delete_customer(id)
    return Response(status_code=204)
