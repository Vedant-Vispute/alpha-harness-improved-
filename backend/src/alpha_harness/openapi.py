"""Print the API's OpenAPI schema, the source the frontend's generated types are built from.

    uv run python -m alpha_harness.openapi > openapi.json

Builds the app without its lifespan, so nothing opens a database or reaches BRAIN.
"""

import json
import sys

from .main import app


def main() -> None:
    json.dump(app.openapi(), sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
