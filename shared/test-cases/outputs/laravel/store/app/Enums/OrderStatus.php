<?php

namespace App\Enums;

/** Values of OrderStatus, with the value each one has in JSON. */
enum OrderStatus: string
{
    case Pending = 'pending';
    case Paid = 'paid';
    case Shipped = 'shipped';
    case Cancelled = 'cancelled';
}
