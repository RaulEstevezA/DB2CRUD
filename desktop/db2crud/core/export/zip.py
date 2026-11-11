"""A zip file of the generated project, stored without compression and dated 1980-01-01, so the same files
always give the same bytes. Mirrors web/src/core/export/zip.ts byte for byte."""

import struct
import zlib

# 1980-01-01 00:00, the earliest date a zip can hold: the content does not depend on when it was made
_TIME = 0
_DATE = (1 << 5) | 1
# Names are UTF-8
_UTF8 = 0x0800


def create_zip(files: list[dict]) -> bytes:
    """A zip of files given as {"name", "content"}, in that order."""
    entries = [(file["name"].encode("utf-8"), file["content"].encode("utf-8")) for file in files]
    local = bytearray()
    central = bytearray()
    for name, data in entries:
        crc = zlib.crc32(data) & 0xFFFFFFFF
        header = len(local)
        local += struct.pack(
            "<IHHHHHIIIHH", 0x04034B50, 20, _UTF8, 0, _TIME, _DATE, crc, len(data), len(data), len(name), 0
        )
        local += name + data
        central += struct.pack(
            "<IHHHHHHIIIHHHHHII",
            0x02014B50,
            20,
            20,
            _UTF8,
            0,
            _TIME,
            _DATE,
            crc,
            len(data),
            len(data),
            len(name),
            0,
            0,
            0,
            0,
            0,
            header,
        )
        central += name
    end = struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(entries), len(entries), len(central), len(local), 0)
    return bytes(local + central + end)
