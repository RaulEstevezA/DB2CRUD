<?php

namespace App\Enums;

/** Values of Genre, with the value each one has in JSON. */
enum Genre: string
{
    case Novel = 'novel';
    case Essay = 'essay';
    case Poetry = 'poetry';
    case Science = 'science';
}
