<?php

namespace App;

use Symfony\Bundle\FrameworkBundle\Kernel\MicroKernelTrait;
use Symfony\Component\HttpKernel\Kernel as BaseKernel;

/** The application: bundles from config/bundles.php, configuration from config/packages/ and config/services.yaml. */
final class Kernel extends BaseKernel
{
    use MicroKernelTrait;
}
