"""Entry point: `python -m db2crud` or the `db2crud` command."""


def main() -> None:
    from .ui.app import run

    raise SystemExit(run())


if __name__ == "__main__":
    main()
