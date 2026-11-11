<?php

namespace App\EventSubscriber;

use App\Exception\ApiException;
use App\Exception\NotImplementedException;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpKernel\Event\ExceptionEvent;
use Symfony\Component\HttpKernel\Exception\MethodNotAllowedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\KernelEvents;

/** Answers every error with the body of openapi.yaml: {"error": {"code", "message", "details"}}. */
final class ApiErrorSubscriber implements EventSubscriberInterface
{
    public function __construct(private readonly ?LoggerInterface $logger = null)
    {
    }

    public static function getSubscribedEvents(): array
    {
        return [KernelEvents::EXCEPTION => 'onException'];
    }

    public function onException(ExceptionEvent $event): void
    {
        $error = $event->getThrowable();
        $event->setResponse(match (true) {
            $error instanceof ApiException => self::answer($error->status, $error->errorCode, $error->getMessage(), $error->details),
            $error instanceof NotImplementedException => self::answer(501, 'not_implemented', $error->getMessage() ?: 'The logic of this operation is not written yet'),
            $error instanceof NotFoundHttpException => self::answer(404, 'not_found', 'No route matches this request'),
            $error instanceof MethodNotAllowedHttpException => self::answer(405, 'method_not_allowed', 'This path does not accept this method'),
            default => $this->unexpected($error),
        });
    }

    /** @param list<array{field: string, message: string}> $details */
    public static function answer(int $status, string $code, string $message, array $details = []): JsonResponse
    {
        $error = ['code' => $code, 'message' => $message];
        if ($details !== []) {
            $error['details'] = $details;
        }

        return new JsonResponse(['error' => $error], $status);
    }

    private function unexpected(\Throwable $error): JsonResponse
    {
        $this->logger?->error($error->getMessage(), ['exception' => $error]);

        return self::answer(500, 'internal_error', 'Something went wrong on the server');
    }
}
