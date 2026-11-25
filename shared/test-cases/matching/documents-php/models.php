<?php

namespace Shop\Models;

enum Level: string
{
    case Basic = 'basic';
    case Gold = 'gold';
}

enum LineStatus: string
{
    case Pending = 'pending';
    case Sent = 'sent';
}

class Location
{
    public float $latitude;
    public float $longitude;
}

final class Address
{
    public function __construct(
        public string $street,
        public string $zipCode,
        public ?Location $location,
    ) {
    }
}

class Customer
{
    public string $id;
    public string $email;
    public ?Level $level;
    public \DateTimeImmutable $since;
    public Address $address;
    /** @var list<string> */
    public array $tags;
}

class Discount
{
    private string $reason;
    private float $percent;

    public function getReason(): string { return $this->reason; }
    public function setReason(string $reason): void { $this->reason = $reason; }
    public function getPercent(): float { return $this->percent; }
    public function setPercent(float $percent): void { $this->percent = $percent; }
}

class OrderLine
{
    public ?string $id;
    public string $sku;
    public int $quantity;
    public string $price;
    public ?LineStatus $status;
    /** @var list<Discount> */
    public array $discounts;
}

class Shipping
{
    public string $carrier;
    public \DateTimeImmutable $sentOn;
}

class Order
{
    public string $id;
    public string $code;
    /** @var list<OrderLine> */
    public array $lines;
    public ?Shipping $shipping;
}

class Parcel
{
    public float $weight;
    public string $size;
    public bool $fragile;
}

class Shipment
{
    public string $id;
    public Parcel $parcel;
    /** @var list<string> */
    public array $stops;
}
